import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { deleteCacheByPrefix } from '../responseCache.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

const MODERATOR_ROLES = ['OWNER', 'MODERATOR'] as const;
const entityIdSchema = z.string().trim().min(1).max(191);
const reasonSchema = z.string().trim().min(3).max(500);

export const moderationSessionListSchema = z
  .object({
    webinarId: entityIdSchema.optional(),
  })
  .strict();

export const messageModerationSchema = z
  .object({
    action: z.enum(['HIDE', 'RESTORE']),
    reason: reasonSchema,
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export const registrationChatAccessSchema = z
  .object({
    action: z.enum(['BLOCK', 'RESTORE']),
    reason: reasonSchema,
  })
  .strict();

type ModerationTransaction = Prisma.TransactionClient;

export function moderationUnavailable(): never {
  throw new AppError(404, 'Объект модерации не найден', undefined, 'moderation_object_not_found');
}

export async function requireCurrentModeratorMembership(
  db: Pick<PrismaClient, 'organizationMembership'>,
  context: TenantContext,
) {
  requireTenantRole(context, MODERATOR_ROLES);
  const membership = await db.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: [...MODERATOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true, role: true },
  });
  if (!membership) {
    throw new AppError(403, 'Требуются права модератора или владельца', undefined, 'moderation_permission_denied');
  }
  return membership;
}

function publicMessageType(message: { messageType: string | null; kind: string }) {
  if (message.messageType) return message.messageType;
  if (message.kind === 'user' || message.kind === 'participant') return 'PARTICIPANT';
  if (message.kind === 'moderator') return 'MODERATOR';
  if (['prepared_question', 'agent_question', 'scripted_user'].includes(message.kind)) return 'PREPARED_QUESTION';
  if (message.kind === 'ai_manager' || message.kind === 'ai_moderator') return 'AI_MODERATOR';
  return 'SYSTEM';
}

export async function writeModerationAudit(
  tx: ModerationTransaction,
  context: TenantContext,
  action: string,
  entityType: string,
  entityId: string,
  beforeJson: Prisma.InputJsonValue,
  afterJson: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: {
      userId: context.userId,
      organizationId: context.organizationId,
      correlationId: context.correlationId,
      action,
      entityType,
      entityId,
      beforeJson,
      afterJson,
    },
  });
}

export async function listModerationSessions(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
) {
  const query = moderationSessionListSchema.parse(input);
  await requireCurrentModeratorMembership(db, context);
  const sessions = await db.webinarSession.findMany({
    where: {
      organizationId: context.organizationId,
      ...(query.webinarId ? { webinarId: query.webinarId } : {}),
    },
    orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
    take: 50,
    select: {
      id: true,
      webinarId: true,
      title: true,
      scheduledAt: true,
      timezone: true,
      lifecycleStatus: true,
      webinar: { select: { title: true } },
    },
  });
  const sessionIds = sessions.map(session => session.id);
  const [messageCounts, hiddenCounts, blockedCounts] = sessionIds.length
    ? await Promise.all([
        db.webinarChatMessage.groupBy({
          by: ['webinarSessionId'],
          where: { organizationId: context.organizationId, webinarSessionId: { in: sessionIds } },
          _count: { _all: true },
        }),
        db.webinarChatMessage.groupBy({
          by: ['webinarSessionId'],
          where: {
            organizationId: context.organizationId,
            webinarSessionId: { in: sessionIds },
            hiddenAt: { not: null },
          },
          _count: { _all: true },
        }),
        db.registration.groupBy({
          by: ['webinarSessionId'],
          where: {
            organizationId: context.organizationId,
            webinarSessionId: { in: sessionIds },
            chatBannedAt: { not: null },
          },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];
  const countMap = (rows: Array<{ webinarSessionId: string; _count: { _all: number } }>) =>
    new Map(rows.map(row => [row.webinarSessionId, row._count._all]));
  const messages = countMap(messageCounts);
  const hidden = countMap(hiddenCounts);
  const blocked = countMap(blockedCounts);

  return sessions.map(session => ({
    id: session.id,
    webinarId: session.webinarId,
    webinarTitle: session.webinar.title,
    title: session.title,
    scheduledAt: session.scheduledAt,
    timezone: session.timezone,
    lifecycleStatus: session.lifecycleStatus,
    messageCount: messages.get(session.id) ?? 0,
    hiddenCount: hidden.get(session.id) ?? 0,
    blockedRegistrationCount: blocked.get(session.id) ?? 0,
  }));
}

export async function listModerationMessages(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  await requireCurrentModeratorMembership(db, context);
  const session = await db.webinarSession.findFirst({
    where: { id: sessionId, organizationId: context.organizationId },
    select: { id: true, webinarId: true, title: true, scheduledAt: true, timezone: true },
  });
  if (!session) moderationUnavailable();

  const messages = await db.webinarChatMessage.findMany({
    where: {
      organizationId: context.organizationId,
      webinarId: session.webinarId,
      webinarSessionId: session.id,
    },
    orderBy: [{ visibleAt: 'desc' }, { createdAt: 'desc' }],
    take: 250,
    include: {
      registration: {
        select: {
          id: true,
          chatBannedAt: true,
          chatBannedReason: true,
        },
      },
      hiddenByMembership: { select: { user: { select: { displayName: true } } } },
    },
  });

  return {
    session,
    messages: messages.map(message => ({
      id: message.id,
      registrationId: message.registrationId,
      type: publicMessageType(message),
      authorName: message.authorName,
      authorRole: message.authorRole,
      message: message.message,
      isSynthetic: message.isSynthetic,
      visibleAt: message.visibleAt,
      hiddenAt: message.hiddenAt,
      hiddenReason: message.hiddenReason,
      hiddenBy: message.hiddenByMembership?.user.displayName ?? null,
      moderationRevision: message.moderationRevision,
      registrationChatBlockedAt: message.registration?.chatBannedAt ?? null,
      registrationChatBlockedReason: message.registration?.chatBannedReason ?? null,
    })),
  };
}

export async function moderateChatMessage(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  messageIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const messageId = entityIdSchema.parse(messageIdInput);
  const command = messageModerationSchema.parse(input);
  const result = await db.$transaction(async tx => {
    await requireCurrentModeratorMembership(tx as unknown as PrismaClient, context);
    const message = await tx.webinarChatMessage.findFirst({
      where: {
        id: messageId,
        webinarSessionId: sessionId,
        organizationId: context.organizationId,
        webinarSession: { organizationId: context.organizationId },
      },
      select: {
        id: true,
        webinarSessionId: true,
        hiddenAt: true,
        hiddenReason: true,
        hiddenByMembershipId: true,
        moderationRevision: true,
      },
    });
    if (!message) moderationUnavailable();
    if (message.moderationRevision !== command.expectedRevision) {
      throw new AppError(409, 'Сообщение уже изменено другим модератором', undefined, 'moderation_revision_conflict');
    }
    if (command.action === 'HIDE' && message.hiddenAt) {
      throw new AppError(409, 'Сообщение уже скрыто', undefined, 'message_already_hidden');
    }
    if (command.action === 'RESTORE' && !message.hiddenAt) {
      throw new AppError(409, 'Сообщение уже доступно', undefined, 'message_already_visible');
    }

    const updated = await tx.webinarChatMessage.update({
      where: { id: message.id },
      data:
        command.action === 'HIDE'
          ? {
              hiddenAt: new Date(),
              hiddenReason: command.reason,
              hiddenByMembershipId: context.membershipId,
              moderationRevision: { increment: 1 },
            }
          : {
              hiddenAt: null,
              hiddenReason: null,
              hiddenByMembershipId: null,
              moderationRevision: { increment: 1 },
            },
      select: { id: true, hiddenAt: true, hiddenReason: true, moderationRevision: true },
    });
    await writeModerationAudit(
      tx,
      context,
      command.action === 'HIDE' ? 'chat.message.hidden' : 'chat.message.restored',
      'webinar_chat_message',
      message.id,
      {
        hiddenAt: message.hiddenAt?.toISOString() ?? null,
        moderationRevision: message.moderationRevision,
      },
      {
        hiddenAt: updated.hiddenAt?.toISOString() ?? null,
        moderationRevision: updated.moderationRevision,
        reason: command.reason,
      },
    );
    return { message: updated, webinarSessionId: message.webinarSessionId };
  });
  deleteCacheByPrefix(`webinar-chat-real:${result.webinarSessionId}:`);
  return result.message;
}

export async function moderateRegistrationChatAccess(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  registrationIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const registrationId = entityIdSchema.parse(registrationIdInput);
  const command = registrationChatAccessSchema.parse(input);
  const result = await db.$transaction(async tx => {
    await requireCurrentModeratorMembership(tx as unknown as PrismaClient, context);
    const registration = await tx.registration.findFirst({
      where: {
        id: registrationId,
        webinarSessionId: sessionId,
        organizationId: context.organizationId,
        webinarSession: { organizationId: context.organizationId },
      },
      select: { id: true, webinarSessionId: true, chatBannedAt: true, chatBannedReason: true },
    });
    if (!registration) moderationUnavailable();
    if (command.action === 'BLOCK' && registration.chatBannedAt) {
      throw new AppError(409, 'Чат регистрации уже заблокирован', undefined, 'registration_chat_already_blocked');
    }
    if (command.action === 'RESTORE' && !registration.chatBannedAt) {
      throw new AppError(409, 'Чат регистрации уже доступен', undefined, 'registration_chat_already_available');
    }
    const updated = await tx.registration.update({
      where: { id: registration.id },
      data:
        command.action === 'BLOCK'
          ? {
              chatBannedAt: new Date(),
              chatBannedReason: command.reason,
              chatBannedByMembershipId: context.membershipId,
            }
          : { chatBannedAt: null, chatBannedReason: null, chatBannedByMembershipId: null },
      select: { id: true, chatBannedAt: true, chatBannedReason: true },
    });
    await writeModerationAudit(
      tx,
      context,
      command.action === 'BLOCK' ? 'chat.registration.blocked' : 'chat.registration.restored',
      'registration',
      registration.id,
      { chatBannedAt: registration.chatBannedAt?.toISOString() ?? null },
      {
        chatBannedAt: updated.chatBannedAt?.toISOString() ?? null,
        reason: command.reason,
      },
    );
    return { registration: updated, webinarSessionId: registration.webinarSessionId };
  });
  deleteCacheByPrefix(`webinar-chat-real:${result.webinarSessionId}:`);
  return result.registration;
}
