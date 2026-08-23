import crypto from 'node:crypto';
import { Prisma, type PrismaClient, type TelegramManagerCallbackAction } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env.js';
import { AppError } from '../http.js';
import { createCorrelationId } from '../requestContext.js';
import { createAccessToken, hashToken } from '../tokens.js';
import { buildManagerTelegramStartUrl } from '../telegram.js';
import { requireTenantRole, type TenantContext } from './context.js';

const MANAGER_BINDING_TTL_MS = 15 * 60 * 1000;
const CALLBACK_DEFAULT_TTL_MS = 15 * 60 * 1000;
const MANAGER_ROLES = ['OWNER', 'CRM_MANAGER'] as const;
const idSchema = z.string().trim().min(1).max(191);
const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/);
const chatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/);
const providerIdSchema = z.string().trim().min(1).max(191);
const callbackDataSchema = z.string().regex(/^tm1:[a-z0-9]{20,32}:[A-Za-z0-9_-]{16}$/);
const bindingPayloadSchema = z.string().regex(/^mgr_[A-Za-z0-9_-]{43}$/);
const safeReasonSchema = z.string().trim().min(3).max(500);
const callbackInputSchema = z
  .object({
    bindingId: idSchema,
    registrationId: idSchema,
    crmContactId: idSchema,
    action: z.enum(['ACCEPT_CONTACT', 'CHANGE_STAGE', 'MARK_HOT', 'CREATE_TASK']),
    payload: z.unknown().optional(),
    idempotencyKey: idempotencyKeySchema,
    expiresInMinutes: z.number().int().min(1).max(60).optional(),
  })
  .strict();
const stagePayloadSchema = z
  .object({ stageId: idSchema, reason: z.string().trim().min(3).max(1_000).optional() })
  .strict();
const hotPayloadSchema = z.object({ reason: safeReasonSchema }).strict();
const taskPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
    dueAt: z.coerce.date(),
    reminderAt: z.coerce.date(),
  })
  .strict()
  .refine(value => value.reminderAt <= value.dueAt, { message: 'Reminder must not be after due date' });

type TelegramBotTransaction = Prisma.TransactionClient;

function bindingUnavailable(): never {
  throw new AppError(404, 'Привязка Telegram недоступна', undefined, 'telegram_manager_binding_unavailable');
}

function callbackUnavailable() {
  return {
    accepted: false as const,
    replayed: false,
    code: 'telegram_manager_callback_unavailable',
    message: 'Действие недоступно или срок кнопки истёк.',
  };
}

function callbackSecret() {
  if (env.TELEGRAM_CALLBACK_SECRET) return env.TELEGRAM_CALLBACK_SECRET;
  if (env.NODE_ENV !== 'production') return env.ADMIN_COOKIE_SECRET;
  throw new Error('TELEGRAM_CALLBACK_SECRET is required for manager callbacks');
}

export function hashTelegramManagerChatId(chatIdInput: unknown) {
  const chatId = chatIdSchema.parse(chatIdInput);
  return crypto.createHmac('sha256', env.IP_HASH_SECRET).update(`telegram-manager-chat:v1:${chatId}`).digest('hex');
}

function signCallbackRecord(record: {
  id: string;
  organizationId: string;
  webinarId: string;
  webinarSessionId: string;
  action: TelegramManagerCallbackAction;
  expiresAt: Date;
}) {
  return crypto
    .createHmac('sha256', callbackSecret())
    .update(
      [
        record.id,
        record.organizationId,
        record.webinarId,
        record.webinarSessionId,
        record.action,
        record.expiresAt.toISOString(),
      ].join('|'),
    )
    .digest('base64url')
    .slice(0, 16);
}

function timingSafeTextEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function callbackDataFor(record: Parameters<typeof signCallbackRecord>[0]) {
  return `tm1:${record.id}:${signCallbackRecord(record)}`;
}

function bindingProjection(binding: {
  id: string;
  membershipId: string;
  status: string;
  chatId: string | null;
  claimedAt: Date | null;
  confirmedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  membership?: { role: string; user: { displayName: string | null } };
}) {
  return {
    id: binding.id,
    membershipId: binding.membershipId,
    managerName: binding.membership?.user.displayName ?? null,
    managerRole: binding.membership?.role ?? null,
    status: binding.status,
    chatHint: binding.chatId ? `***${binding.chatId.slice(-4)}` : null,
    claimedAt: binding.claimedAt,
    confirmedAt: binding.confirmedAt,
    revokedAt: binding.revokedAt,
    createdAt: binding.createdAt,
  };
}

async function createBotEvent(
  tx: TelegramBotTransaction,
  input: {
    organizationId: string;
    webinarId?: string;
    webinarSessionId?: string;
    registrationId?: string;
    crmContactId?: string;
    membershipId?: string;
    managerBindingId?: string;
    managerCallbackId?: string;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
    eventType: string;
    correlationId: string;
    providerMessageId?: string;
    dedupKey?: string;
    status: string;
    metadata?: Record<string, string | number | boolean | null>;
    occurredAt: Date;
  },
) {
  await tx.telegramBotEvent.create({
    data: {
      organizationId: input.organizationId,
      webinarId: input.webinarId,
      webinarSessionId: input.webinarSessionId,
      registrationId: input.registrationId,
      crmContactId: input.crmContactId,
      membershipId: input.membershipId,
      managerBindingId: input.managerBindingId,
      managerCallbackId: input.managerCallbackId,
      botIdentity: 'MANAGER',
      direction: input.direction,
      eventType: input.eventType,
      correlationId: input.correlationId,
      providerMessageId: input.providerMessageId,
      dedupKey: input.dedupKey,
      status: input.status,
      metadataJson: input.metadata as Prisma.InputJsonValue | undefined,
      occurredAt: input.occurredAt,
    },
  });
}

async function requireCurrentOwner(tx: TelegramBotTransaction, context: TenantContext) {
  const owner = await tx.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!owner) throw new AppError(403, 'Требуются права владельца организации', undefined, 'tenant_owner_required');
}

export async function createTelegramManagerBinding(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const { membershipId } = z.object({ membershipId: idSchema }).strict().parse(input);
  const rawToken = createAccessToken();
  const startPayload = `mgr_${rawToken}`;
  const startUrl = buildManagerTelegramStartUrl(startPayload);
  if (!startUrl) {
    throw new AppError(503, 'Manager bot identity is not configured', undefined, 'telegram_manager_bot_unconfigured');
  }
  const expiresAt = new Date(now.getTime() + MANAGER_BINDING_TTL_MS);
  const correlationId = context.correlationId || createCorrelationId('telegram_binding');

  return db.$transaction(async tx => {
    await requireCurrentOwner(tx, context);
    const membership = await tx.organizationMembership.findFirst({
      where: {
        id: membershipId,
        organizationId: context.organizationId,
        role: { in: [...MANAGER_ROLES] },
        status: 'ACTIVE',
        user: { kind: 'HUMAN', status: 'ACTIVE' },
      },
      include: { user: { select: { displayName: true } } },
    });
    if (!membership) bindingUnavailable();
    const existing = await tx.telegramManagerChatBinding.findFirst({
      where: {
        organizationId: context.organizationId,
        membershipId,
        status: { in: ['PENDING_CHAT', 'PENDING_OWNER', 'ACTIVE'] },
      },
      include: { membership: { include: { user: { select: { displayName: true } } } } },
    });
    if (existing) {
      throw new AppError(
        409,
        'Для менеджера уже есть незавершённая или активная привязка',
        undefined,
        'telegram_manager_binding_exists',
      );
    }

    const binding = await tx.telegramManagerChatBinding.create({
      data: {
        organizationId: context.organizationId,
        membershipId,
        requestedByUserId: context.userId,
        tokens: { create: { tokenHash: hashToken(rawToken), expiresAt } },
      },
      include: { membership: { include: { user: { select: { displayName: true } } } } },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId,
        action: 'telegram.manager_binding.requested',
        entityType: 'telegram_manager_chat_binding',
        entityId: binding.id,
        afterJson: { membershipId, expiresAt: expiresAt.toISOString(), status: binding.status },
      },
    });
    await createBotEvent(tx, {
      organizationId: context.organizationId,
      membershipId,
      managerBindingId: binding.id,
      direction: 'INTERNAL',
      eventType: 'manager_binding_requested',
      correlationId,
      dedupKey: `manager-binding:${binding.id}:requested`,
      status: 'pending_chat',
      occurredAt: now,
    });
    return {
      binding: bindingProjection(binding),
      expiresAt,
      startUrl,
    };
  });
}

export async function listTelegramManagerBindings(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, ['OWNER']);
  const bindings = await db.telegramManagerChatBinding.findMany({
    where: { organizationId: context.organizationId },
    include: { membership: { include: { user: { select: { displayName: true } } } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return bindings.map(bindingProjection);
}

export async function claimTelegramManagerBinding(
  db: PrismaClient,
  input: {
    startPayload: unknown;
    chatId: unknown;
    providerMessageId: unknown;
    correlationId?: string;
  },
  now = new Date(),
) {
  const startPayload = bindingPayloadSchema.parse(input.startPayload);
  const chatId = chatIdSchema.parse(input.chatId);
  const providerMessageId = providerIdSchema.parse(input.providerMessageId);
  const tokenHash = hashToken(startPayload.slice(4));
  const correlationId = input.correlationId ?? createCorrelationId('telegram_manager_start');

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "telegram_manager_chat_binding_tokens" WHERE "token_hash" = ${tokenHash} FOR UPDATE`;
    const token = await tx.telegramManagerChatBindingToken.findUnique({
      where: { tokenHash },
      include: {
        binding: {
          include: {
            organization: { select: { status: true } },
            membership: { include: { user: { select: { id: true, status: true, kind: true } } } },
          },
        },
      },
    });
    if (!token || token.consumedAt || token.invalidatedAt || token.binding.status !== 'PENDING_CHAT') return null;
    if (token.expiresAt <= now) {
      await tx.telegramManagerChatBindingToken.update({ where: { id: token.id }, data: { invalidatedAt: now } });
      await tx.telegramManagerChatBinding.updateMany({
        where: { id: token.bindingId, status: 'PENDING_CHAT' },
        data: { status: 'EXPIRED' },
      });
      return null;
    }
    const membership = token.binding.membership;
    if (
      token.binding.organization.status !== 'ACTIVE' ||
      membership.status !== 'ACTIVE' ||
      !MANAGER_ROLES.includes(membership.role as (typeof MANAGER_ROLES)[number]) ||
      membership.user.status !== 'ACTIVE' ||
      membership.user.kind !== 'HUMAN'
    ) {
      return null;
    }
    const chatIdHash = hashTelegramManagerChatId(chatId);
    const conflictingChat = await tx.telegramManagerChatBinding.findFirst({
      where: {
        organizationId: token.binding.organizationId,
        chatIdHash,
        status: { in: ['PENDING_OWNER', 'ACTIVE'] },
        id: { not: token.binding.id },
      },
      select: { id: true },
    });
    if (conflictingChat) return null;

    await tx.telegramManagerChatBindingToken.update({ where: { id: token.id }, data: { consumedAt: now } });
    const binding = await tx.telegramManagerChatBinding.update({
      where: { id: token.binding.id },
      data: { status: 'PENDING_OWNER', chatId, chatIdHash, claimedAt: now },
    });
    await createBotEvent(tx, {
      organizationId: binding.organizationId,
      membershipId: binding.membershipId,
      managerBindingId: binding.id,
      direction: 'INBOUND',
      eventType: 'manager_binding_chat_claimed',
      correlationId,
      providerMessageId,
      dedupKey: `manager-binding:${binding.id}:claimed`,
      status: 'pending_owner',
      occurredAt: now,
    });
    await tx.auditLog.create({
      data: {
        userId: membership.user.id,
        organizationId: binding.organizationId,
        correlationId,
        action: 'telegram.manager_binding.chat_claimed',
        entityType: 'telegram_manager_chat_binding',
        entityId: binding.id,
        beforeJson: { status: 'PENDING_CHAT' },
        afterJson: { status: binding.status, providerMessageId },
      },
    });
    return {
      bindingId: binding.id,
      organizationId: binding.organizationId,
      membershipId: binding.membershipId,
      status: binding.status,
      correlationId,
    };
  });
}

export async function recordTelegramManagerOutboundEvent(
  db: PrismaClient,
  input: {
    organizationId: string;
    membershipId: string;
    bindingId: string;
    correlationId: string;
    providerMessageId?: string | null;
    eventType: 'manager_binding_claim_acknowledged' | 'manager_binding_claim_rejected';
    status: 'logged' | 'sent';
  },
  now = new Date(),
) {
  await db.telegramBotEvent.create({
    data: {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      managerBindingId: input.bindingId,
      botIdentity: 'MANAGER',
      direction: 'OUTBOUND',
      eventType: input.eventType,
      correlationId: input.correlationId,
      providerMessageId: input.providerMessageId || null,
      dedupKey: `manager-binding:${input.bindingId}:${input.eventType}`,
      status: input.status,
      occurredAt: now,
    },
  });
}

export async function confirmTelegramManagerBinding(
  db: PrismaClient,
  context: TenantContext,
  bindingIdInput: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const bindingId = idSchema.parse(bindingIdInput);
  return db.$transaction(async tx => {
    await requireCurrentOwner(tx, context);
    await tx.$queryRaw`SELECT "id" FROM "telegram_manager_chat_bindings" WHERE "id" = ${bindingId} AND "organization_id" = ${context.organizationId} FOR UPDATE`;
    const binding = await tx.telegramManagerChatBinding.findFirst({
      where: { id: bindingId, organizationId: context.organizationId },
      include: {
        membership: { include: { user: { select: { displayName: true, status: true, kind: true } } } },
      },
    });
    if (!binding) bindingUnavailable();
    if (binding.status === 'ACTIVE') return { binding: bindingProjection(binding), replayed: true };
    if (
      binding.status !== 'PENDING_OWNER' ||
      binding.membership.status !== 'ACTIVE' ||
      !MANAGER_ROLES.includes(binding.membership.role as (typeof MANAGER_ROLES)[number]) ||
      binding.membership.user.status !== 'ACTIVE' ||
      binding.membership.user.kind !== 'HUMAN'
    ) {
      bindingUnavailable();
    }
    const updated = await tx.telegramManagerChatBinding.update({
      where: { id: binding.id },
      data: { status: 'ACTIVE', confirmedByUserId: context.userId, confirmedAt: now },
      include: { membership: { include: { user: { select: { displayName: true } } } } },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'telegram.manager_binding.confirmed',
        entityType: 'telegram_manager_chat_binding',
        entityId: binding.id,
        beforeJson: { status: binding.status },
        afterJson: { status: updated.status, membershipId: updated.membershipId },
      },
    });
    await createBotEvent(tx, {
      organizationId: context.organizationId,
      membershipId: updated.membershipId,
      managerBindingId: updated.id,
      direction: 'INTERNAL',
      eventType: 'manager_binding_confirmed',
      correlationId: context.correlationId,
      dedupKey: `manager-binding:${updated.id}:confirmed`,
      status: 'active',
      occurredAt: now,
    });
    return { binding: bindingProjection(updated), replayed: false };
  });
}

export async function revokeTelegramManagerBinding(
  db: PrismaClient,
  context: TenantContext,
  bindingIdInput: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const bindingId = idSchema.parse(bindingIdInput);
  return db.$transaction(async tx => {
    await requireCurrentOwner(tx, context);
    await tx.$queryRaw`SELECT "id" FROM "telegram_manager_chat_bindings" WHERE "id" = ${bindingId} AND "organization_id" = ${context.organizationId} FOR UPDATE`;
    const binding = await tx.telegramManagerChatBinding.findFirst({
      where: { id: bindingId, organizationId: context.organizationId },
      include: { membership: { include: { user: { select: { displayName: true } } } } },
    });
    if (!binding) bindingUnavailable();
    if (binding.status === 'REVOKED') return { binding: bindingProjection(binding), replayed: true };
    const updated = await tx.telegramManagerChatBinding.update({
      where: { id: binding.id },
      data: { status: 'REVOKED', revokedByUserId: context.userId, revokedAt: now },
      include: { membership: { include: { user: { select: { displayName: true } } } } },
    });
    await tx.telegramManagerChatBindingToken.updateMany({
      where: { bindingId: binding.id, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.telegramManagerCallback.updateMany({
      where: { bindingId: binding.id, organizationId: context.organizationId, status: 'PENDING' },
      data: { status: 'REJECTED', consumedAt: now, resultCode: 'manager_binding_revoked' },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'telegram.manager_binding.revoked',
        entityType: 'telegram_manager_chat_binding',
        entityId: binding.id,
        beforeJson: { status: binding.status },
        afterJson: { status: updated.status, membershipId: updated.membershipId },
      },
    });
    await createBotEvent(tx, {
      organizationId: context.organizationId,
      membershipId: updated.membershipId,
      managerBindingId: updated.id,
      direction: 'INTERNAL',
      eventType: 'manager_binding_revoked',
      correlationId: context.correlationId,
      dedupKey: `manager-binding:${updated.id}:revoked`,
      status: 'revoked',
      occurredAt: now,
    });
    return { binding: bindingProjection(updated), replayed: false };
  });
}

function normalizeCallbackPayload(action: TelegramManagerCallbackAction, payload: unknown) {
  if (action === 'ACCEPT_CONTACT') {
    z.null().optional().parse(payload);
    return Prisma.JsonNull;
  }
  if (action === 'CHANGE_STAGE') return stagePayloadSchema.parse(payload) as Prisma.InputJsonValue;
  if (action === 'MARK_HOT') return hotPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  const task = taskPayloadSchema.parse(payload);
  return {
    title: task.title,
    priority: task.priority,
    dueAt: task.dueAt.toISOString(),
    reminderAt: task.reminderAt.toISOString(),
  } satisfies Prisma.InputJsonObject;
}

export async function createTelegramManagerCallback(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, MANAGER_ROLES);
  const data = callbackInputSchema.parse(input);
  const payloadJson = normalizeCallbackPayload(data.action, data.payload);
  const expiresAt = new Date(now.getTime() + (data.expiresInMinutes ?? CALLBACK_DEFAULT_TTL_MS / 60_000) * 60_000);
  const correlationId = context.correlationId || createCorrelationId('telegram_callback');

  return db.$transaction(async tx => {
    const binding = await tx.telegramManagerChatBinding.findFirst({
      where: {
        id: data.bindingId,
        organizationId: context.organizationId,
        status: 'ACTIVE',
        membership: {
          status: 'ACTIVE',
          role: { in: [...MANAGER_ROLES] },
          user: { kind: 'HUMAN', status: 'ACTIVE' },
        },
      },
    });
    const registration = await tx.registration.findFirst({
      where: {
        id: data.registrationId,
        organizationId: context.organizationId,
        crmContactId: data.crmContactId,
        webinarId: { not: null },
        status: 'registered',
        webinarSession: { lifecycleStatus: { not: 'CANCELLED' } },
      },
      include: { crmContact: true, webinarSession: true },
    });
    if (!binding || !registration?.crmContact || registration.crmContact.archivedAt) bindingUnavailable();
    if (
      registration.webinarId !== registration.webinarSession.webinarId ||
      registration.organizationId !== registration.webinarSession.organizationId
    ) {
      bindingUnavailable();
    }
    if (data.action === 'CHANGE_STAGE') {
      const stageId = stagePayloadSchema.parse(data.payload).stageId;
      const stage = await tx.cRMStage.findFirst({
        where: {
          id: stageId,
          organizationId: context.organizationId,
          pipelineId: registration.crmContact.pipelineId,
          status: 'ACTIVE',
        },
      });
      if (!stage) bindingUnavailable();
    }
    const duplicate = await tx.telegramManagerCallback.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId: context.organizationId, idempotencyKey: data.idempotencyKey },
      },
    });
    if (duplicate) {
      if (
        duplicate.bindingId !== binding.id ||
        duplicate.registrationId !== registration.id ||
        duplicate.crmContactId !== registration.crmContact.id ||
        duplicate.action !== data.action
      ) {
        throw new AppError(
          409,
          'Idempotency key is already used',
          undefined,
          'telegram_manager_callback_idempotency_conflict',
        );
      }
      return {
        callbackId: duplicate.id,
        callbackData: callbackDataFor(duplicate),
        expiresAt: duplicate.expiresAt,
        replayed: true,
      };
    }
    const callback = await tx.telegramManagerCallback.create({
      data: {
        organizationId: context.organizationId,
        bindingId: binding.id,
        membershipId: binding.membershipId,
        crmContactId: registration.crmContact.id,
        registrationId: registration.id,
        webinarId: registration.webinarSession.webinarId,
        webinarSessionId: registration.webinarSession.id,
        action: data.action,
        payloadJson,
        idempotencyKey: data.idempotencyKey,
        expiresAt,
        correlationId,
      },
    });
    await createBotEvent(tx, {
      organizationId: callback.organizationId,
      webinarId: callback.webinarId,
      webinarSessionId: callback.webinarSessionId,
      registrationId: callback.registrationId,
      crmContactId: callback.crmContactId,
      membershipId: callback.membershipId,
      managerBindingId: callback.bindingId,
      managerCallbackId: callback.id,
      direction: 'INTERNAL',
      eventType: 'manager_callback_issued',
      correlationId,
      dedupKey: `manager-callback:${callback.id}:issued`,
      status: 'pending',
      metadata: { action: callback.action },
      occurredAt: now,
    });
    return { callbackId: callback.id, callbackData: callbackDataFor(callback), expiresAt, replayed: false };
  });
}

function resultMessage(code: string) {
  const messages: Record<string, string> = {
    contact_accepted: 'Контакт закреплён за вами.',
    contact_already_accepted: 'Контакт уже закреплён за вами.',
    stage_changed: 'Этап контакта обновлён.',
    stage_unchanged: 'Этот этап уже установлен.',
    hot_marked: 'Контакт отмечен как горячий.',
    task_created: 'Задача создана.',
  };
  return messages[code] ?? 'Действие выполнено.';
}

export async function executeTelegramManagerCallback(
  db: PrismaClient,
  input: {
    callbackData: unknown;
    chatId: unknown;
    providerCallbackId: unknown;
  },
  now = new Date(),
) {
  const parsedData = callbackDataSchema.safeParse(input.callbackData);
  const parsedChat = chatIdSchema.safeParse(input.chatId);
  const parsedProviderId = providerIdSchema.safeParse(input.providerCallbackId);
  if (!parsedData.success || !parsedChat.success || !parsedProviderId.success) return callbackUnavailable();
  const [, callbackId, submittedSignature] = parsedData.data.split(':');
  const existing = await db.telegramManagerCallback.findUnique({ where: { id: callbackId } });
  if (!existing || !timingSafeTextEqual(signCallbackRecord(existing), submittedSignature)) return callbackUnavailable();
  const chatIdHash = hashTelegramManagerChatId(parsedChat.data);

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "telegram_manager_callbacks" WHERE "id" = ${callbackId} FOR UPDATE`;
    const callback = await tx.telegramManagerCallback.findUnique({
      where: { id: callbackId },
      include: {
        binding: true,
        membership: { include: { user: true, organization: true } },
        crmContact: { include: { stage: true } },
        registration: true,
      },
    });
    if (!callback || !timingSafeTextEqual(signCallbackRecord(callback), submittedSignature))
      return callbackUnavailable();
    if (callback.status === 'COMPLETED') {
      return {
        accepted: true as const,
        replayed: true,
        code: callback.resultCode ?? 'completed',
        message: resultMessage(callback.resultCode ?? 'completed'),
      };
    }
    if (callback.status !== 'PENDING') return callbackUnavailable();
    if (callback.expiresAt <= now) {
      await tx.telegramManagerCallback.update({
        where: { id: callback.id },
        data: { status: 'EXPIRED', consumedAt: now, resultCode: 'callback_expired' },
      });
      return callbackUnavailable();
    }
    const membership = callback.membership;
    const trustedScope =
      callback.binding.status === 'ACTIVE' &&
      callback.binding.chatIdHash === chatIdHash &&
      callback.binding.membershipId === callback.membershipId &&
      membership.status === 'ACTIVE' &&
      MANAGER_ROLES.includes(membership.role as (typeof MANAGER_ROLES)[number]) &&
      membership.user.kind === 'HUMAN' &&
      membership.user.status === 'ACTIVE' &&
      membership.organization.status === 'ACTIVE' &&
      callback.registration.organizationId === callback.organizationId &&
      callback.registration.webinarId === callback.webinarId &&
      callback.registration.webinarSessionId === callback.webinarSessionId &&
      callback.registration.crmContactId === callback.crmContactId &&
      callback.registration.status === 'registered' &&
      callback.crmContact.organizationId === callback.organizationId &&
      callback.crmContact.archivedAt === null;
    if (!trustedScope) return callbackUnavailable();

    let resultCode: string;
    let createdTaskId: string | undefined;
    if (callback.action === 'ACCEPT_CONTACT') {
      resultCode =
        callback.crmContact.ownerMembershipId === membership.id ? 'contact_already_accepted' : 'contact_accepted';
      if (resultCode === 'contact_accepted') {
        await tx.cRMContact.update({
          where: { id: callback.crmContact.id },
          data: { ownerMembershipId: membership.id, legacyAssignedManagerId: null },
        });
      }
    } else if (callback.action === 'CHANGE_STAGE') {
      const payload = stagePayloadSchema.parse(callback.payloadJson);
      const target = await tx.cRMStage.findFirst({
        where: {
          id: payload.stageId,
          organizationId: callback.organizationId,
          pipelineId: callback.crmContact.pipelineId,
          status: 'ACTIVE',
        },
      });
      if (!target || (target.semanticCategory === 'LOST' && !payload.reason)) return callbackUnavailable();
      resultCode = target.id === callback.crmContact.stageId ? 'stage_unchanged' : 'stage_changed';
      if (resultCode === 'stage_changed') {
        await tx.cRMContact.update({ where: { id: callback.crmContact.id }, data: { stageId: target.id } });
        await tx.cRMStageTransition.create({
          data: {
            organizationId: callback.organizationId,
            contactId: callback.crmContact.id,
            pipelineId: callback.crmContact.pipelineId,
            fromStageId: callback.crmContact.stageId,
            toStageId: target.id,
            actorUserId: membership.userId,
            reason: payload.reason,
            source: 'telegram_manager_bot',
            correlationId: callback.correlationId,
            occurredAt: now,
          },
        });
        await tx.registration.updateMany({
          where: { organizationId: callback.organizationId, crmContactId: callback.crmContact.id },
          data: { crmStatus: target.code },
        });
      }
    } else if (callback.action === 'MARK_HOT') {
      const payload = hotPayloadSchema.parse(callback.payloadJson);
      resultCode = 'hot_marked';
      await tx.cRMContact.update({
        where: { id: callback.crmContact.id },
        data: {
          manualHot: true,
          manualHotReason: payload.reason,
          manualHotByMembershipId: membership.id,
          manualHotAt: now,
          manualHotSource: 'telegram_manager_bot',
        },
      });
    } else {
      const payload = taskPayloadSchema.parse(callback.payloadJson);
      resultCode = 'task_created';
      const task = await tx.cRMTask.create({
        data: {
          organizationId: callback.organizationId,
          contactId: callback.crmContact.id,
          assigneeMembershipId: membership.id,
          createdByUserId: membership.userId,
          title: payload.title,
          priority: payload.priority,
          dueAt: payload.dueAt,
          reminderAt: payload.reminderAt,
        },
      });
      createdTaskId = task.id;
    }

    await tx.cRMContactEvent.create({
      data: {
        organizationId: callback.organizationId,
        contactId: callback.crmContact.id,
        type: `telegram_${callback.action.toLowerCase()}`,
        source: 'telegram_manager_bot',
        sourceEntityType: 'telegram_manager_callback',
        sourceEntityId: callback.id,
        webinarId: callback.webinarId,
        webinarSessionId: callback.webinarSessionId,
        registrationId: callback.registrationId,
        actorUserId: membership.userId,
        correlationId: callback.correlationId,
        dedupKey: `telegram-manager-callback:${callback.id}`,
        occurredAt: now,
        metadataJson: { action: callback.action, resultCode, createdTaskId: createdTaskId ?? null },
      },
    });
    await tx.telegramManagerCallback.update({
      where: { id: callback.id },
      data: {
        status: 'COMPLETED',
        consumedAt: now,
        providerCallbackId: parsedProviderId.data,
        resultCode,
        createdTaskId,
      },
    });
    await createBotEvent(tx, {
      organizationId: callback.organizationId,
      webinarId: callback.webinarId,
      webinarSessionId: callback.webinarSessionId,
      registrationId: callback.registrationId,
      crmContactId: callback.crmContactId,
      membershipId: callback.membershipId,
      managerBindingId: callback.bindingId,
      managerCallbackId: callback.id,
      direction: 'INBOUND',
      eventType: 'manager_callback_completed',
      correlationId: callback.correlationId,
      providerMessageId: parsedProviderId.data,
      dedupKey: `manager-callback:${callback.id}:completed`,
      status: 'completed',
      metadata: { action: callback.action, resultCode },
      occurredAt: now,
    });
    await tx.auditLog.create({
      data: {
        userId: membership.userId,
        organizationId: callback.organizationId,
        correlationId: callback.correlationId,
        action: `telegram.manager_callback.${callback.action.toLowerCase()}`,
        entityType: 'crm_contact',
        entityId: callback.crmContact.id,
        beforeJson: {
          stageId: callback.crmContact.stageId,
          ownerMembershipId: callback.crmContact.ownerMembershipId,
          manualHot: callback.crmContact.manualHot,
        },
        afterJson: { resultCode, callbackId: callback.id, createdTaskId: createdTaskId ?? null },
      },
    });
    return { accepted: true as const, replayed: false, code: resultCode, message: resultMessage(resultCode) };
  });
}
