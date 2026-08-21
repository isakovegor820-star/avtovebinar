import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';
import { idempotencyKeySchema, webinarIdSchema } from './webinarContent.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const;
const EDITABLE_CONTENT_STATUSES = ['DRAFT', 'NEEDS_REVIEW'] as const;
const SCENARIO_COMMAND_LOCK_NAMESPACE = 7_106_009_023n;

const scenarioMessageSchema = z
  .object({
    offsetSeconds: z.number().int().min(0).max(10_800),
    kind: z.enum(['PREPARED_QUESTION', 'MODERATOR_NOTICE', 'AUTHOR_PROMPT']),
    text: z.string().trim().min(1).max(1_000),
    authorLabel: z.string().trim().min(2).max(120),
  })
  .strict();

export const saveChatScenarioSchema = z.object({ messages: z.array(scenarioMessageSchema).max(500) }).strict();

type ScenarioTransaction = Prisma.TransactionClient;

const scenarioInclude = {
  messages: { orderBy: { orderIndex: 'asc' as const } },
} satisfies Prisma.ChatScenarioInclude;

type ScenarioWithMessages = Prisma.ChatScenarioGetPayload<{ include: typeof scenarioInclude }>;

function webinarUnavailable(): never {
  throw new AppError(404, 'Вебинар не найден', undefined, 'webinar_not_found');
}

function scenarioUnavailable(): never {
  throw new AppError(404, 'Сценарий не найден', undefined, 'chat_scenario_not_found');
}

async function requireCurrentCreatorMembership(
  db: Pick<PrismaClient, 'organizationMembership'>,
  context: TenantContext,
) {
  requireTenantRole(context, CREATOR_ROLES);
  const membership = await db.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: [...CREATOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { role: true },
  });
  if (!membership) {
    throw new AppError(403, 'Требуются права автора или владельца', undefined, 'creator_permission_denied');
  }
  return membership.role;
}

function scopedWebinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

async function requireScopedWebinar(
  db: Pick<PrismaClient, 'webinar'>,
  context: TenantContext,
  role: OrganizationMembershipRole,
  webinarId: string,
) {
  const webinar = await db.webinar.findFirst({
    where: scopedWebinarWhere(context, role, webinarId),
    select: { id: true, contentStatus: true, syntheticDisclosure: true },
  });
  if (!webinar) webinarUnavailable();
  return webinar;
}

async function lockWebinar(tx: ScenarioTransaction, context: TenantContext, webinarId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "webinars"
    WHERE "id" = ${webinarId} AND "organization_id" = ${context.organizationId}
    FOR UPDATE
  `;
  if (rows.length !== 1) webinarUnavailable();
}

async function lockScenarioCommand(
  tx: ScenarioTransaction,
  organizationId: string,
  action: string,
  idempotencyKey: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${organizationId}:${action}:${idempotencyKey}`}, ${SCENARIO_COMMAND_LOCK_NAMESPACE})
    )
  `;
}

function scenarioProjection(scenario: ScenarioWithMessages) {
  return {
    id: scenario.id,
    version: scenario.version,
    status: scenario.status,
    approvedAt: scenario.approvedAt,
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
    messages: scenario.messages.map(message => ({
      id: message.id,
      orderIndex: message.orderIndex,
      offsetSeconds: message.offsetSeconds,
      kind: message.kind,
      text: message.text,
      authorLabel: message.authorLabel,
      isSynthetic: true as const,
    })),
  };
}

async function latestScenario(db: Pick<PrismaClient, 'chatScenario'>, context: TenantContext, webinarId: string) {
  return db.chatScenario.findFirst({
    where: { organizationId: context.organizationId, webinarId },
    orderBy: { version: 'desc' },
    include: scenarioInclude,
  });
}

async function writeScenarioAudit(
  tx: ScenarioTransaction,
  context: TenantContext,
  action: string,
  scenarioId: string,
  beforeJson: Prisma.InputJsonValue | undefined,
  afterJson: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: {
      userId: context.userId,
      organizationId: context.organizationId,
      correlationId: context.correlationId,
      action,
      entityType: 'chat_scenario',
      entityId: scenarioId,
      beforeJson,
      afterJson,
    },
  });
}

export async function getCreatorChatScenario(db: PrismaClient, context: TenantContext, webinarIdInput: unknown) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const role = await requireCurrentCreatorMembership(db, context);
  await requireScopedWebinar(db, context, role, webinarId);
  const scenario = await latestScenario(db, context, webinarId);
  return scenario ? scenarioProjection(scenario) : null;
}

export async function saveCreatorChatScenario(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const data = saveChatScenarioSchema.parse(input);
  return db.$transaction(async tx => {
    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const webinar = await requireScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (!EDITABLE_CONTENT_STATUSES.includes(webinar.contentStatus as (typeof EDITABLE_CONTENT_STATUSES)[number])) {
      throw new AppError(409, 'Сценарий нельзя изменить в текущем статусе', undefined, 'webinar_not_editable');
    }

    const previous = await latestScenario(tx as unknown as PrismaClient, context, webinarId);
    let scenarioId: string;
    let version: number;
    if (previous?.status === 'DRAFT') {
      scenarioId = previous.id;
      version = previous.version;
      await tx.chatScenarioMessage.deleteMany({
        where: { scenarioId, organizationId: context.organizationId },
      });
      await tx.chatScenario.update({ where: { id: scenarioId }, data: { updatedAt: new Date() } });
    } else {
      version = (previous?.version ?? 0) + 1;
      const created = await tx.chatScenario.create({
        data: {
          organizationId: context.organizationId,
          webinarId,
          version,
          status: 'DRAFT',
          createdById: context.userId,
        },
      });
      scenarioId = created.id;
    }

    if (data.messages.length > 0) {
      await tx.chatScenarioMessage.createMany({
        data: data.messages.map((message, orderIndex) => ({
          organizationId: context.organizationId,
          scenarioId,
          orderIndex,
          offsetSeconds: message.offsetSeconds,
          kind: message.kind,
          text: message.text,
          authorLabel: message.authorLabel,
          isSynthetic: true,
        })),
      });
    }
    await tx.webinar.update({
      where: { id: webinarId },
      data: { scenarioStatus: 'DRAFT', contentVersion: { increment: 1 } },
    });
    const scenario = await tx.chatScenario.findUniqueOrThrow({ where: { id: scenarioId }, include: scenarioInclude });
    await writeScenarioAudit(
      tx,
      context,
      'chat_scenario.saved',
      scenarioId,
      previous
        ? { version: previous.version, status: previous.status, messageCount: previous.messages.length }
        : undefined,
      { webinarId, version, status: 'DRAFT', messageCount: data.messages.length },
    );
    return scenarioProjection(scenario);
  });
}

export async function publishCreatorChatScenario(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  idempotencyKeyInput: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const idempotencyKey = idempotencyKeySchema.parse(idempotencyKeyInput);
  const action = 'publish_scenario';
  return db.$transaction(async tx => {
    await lockScenarioCommand(tx, context.organizationId, action, idempotencyKey);
    const prior = await tx.webinarCommand.findUnique({
      where: {
        organizationId_action_idempotencyKey: {
          organizationId: context.organizationId,
          action,
          idempotencyKey,
        },
      },
    });
    if (prior && prior.webinarId !== webinarId) {
      throw new AppError(409, 'Idempotency key уже использован', undefined, 'idempotency_key_reused');
    }

    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const webinar = await requireScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (prior) {
      const replay = await tx.chatScenario.findFirst({
        where: { id: prior.resultStatus, webinarId, organizationId: context.organizationId },
        include: scenarioInclude,
      });
      if (!replay) scenarioUnavailable();
      return { scenario: scenarioProjection(replay), replayed: true };
    }
    if (!EDITABLE_CONTENT_STATUSES.includes(webinar.contentStatus as (typeof EDITABLE_CONTENT_STATUSES)[number])) {
      throw new AppError(409, 'Сценарий нельзя опубликовать в текущем статусе', undefined, 'webinar_not_editable');
    }
    if (!webinar.syntheticDisclosure) {
      throw new AppError(
        409,
        'Добавьте маркировку подготовленных сообщений',
        undefined,
        'chat_scenario_disclosure_required',
      );
    }
    const draft = await tx.chatScenario.findFirst({
      where: { organizationId: context.organizationId, webinarId, status: 'DRAFT' },
      orderBy: { version: 'desc' },
      include: scenarioInclude,
    });
    if (!draft) scenarioUnavailable();
    if (draft.messages.length === 0) {
      throw new AppError(409, 'Добавьте хотя бы одно сообщение', undefined, 'chat_scenario_empty');
    }
    const approvedAt = new Date();
    const scenario = await tx.chatScenario.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', approvedById: context.userId, approvedAt },
      include: scenarioInclude,
    });
    await tx.webinar.update({
      where: { id: webinarId },
      data: { scenarioStatus: 'PUBLISHED', contentVersion: { increment: 1 } },
    });
    await tx.webinarCommand.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        requestedById: context.userId,
        action,
        idempotencyKey,
        resultStatus: scenario.id,
      },
    });
    await writeScenarioAudit(
      tx,
      context,
      'chat_scenario.published',
      scenario.id,
      { version: draft.version, status: 'DRAFT', messageCount: draft.messages.length },
      { webinarId, version: scenario.version, status: 'PUBLISHED', messageCount: scenario.messages.length },
    );
    return { scenario: scenarioProjection(scenario), replayed: false };
  });
}
