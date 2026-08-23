import crypto from 'node:crypto';
import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { isValidIanaTimezone, localDateKeyAt, localDateTimeToUtc } from '../sessionScheduling.js';
import { requireTenantRole, type TenantContext } from './context.js';
import { getCrmDeliveryOverview } from './crmDelivery.js';

const CRM_READ_ROLES = [
  'OWNER',
  'CRM_MANAGER',
  'ANALYST',
  'AUDITOR',
] as const satisfies readonly OrganizationMembershipRole[];
const CRM_WRITE_ROLES = ['OWNER', 'CRM_MANAGER'] as const satisfies readonly OrganizationMembershipRole[];
const CRM_OWNER_ROLES = ['OWNER'] as const satisfies readonly OrganizationMembershipRole[];
const CRM_LOCK_NAMESPACE = 1_406_211_400;
const CRM_SCORE_SIGNALS = [
  { code: 'registration', label: 'Регистрация', points: 10 },
  { code: 'room_entered', label: 'Вход в комнату', points: 15 },
  { code: 'viewed_50_percent', label: 'Просмотрено не менее 50%', points: 25 },
  { code: 'question', label: 'Задан вопрос', points: 25 },
  { code: 'cta', label: 'Нажата CTA и отправлена заявка', points: 35 },
] as const;
type CRMScoreSignalCode = (typeof CRM_SCORE_SIGNALS)[number]['code'];
const CRM_TAG_COLOR_TOKENS = ['slate', 'blue', 'teal', 'amber', 'red', 'violet'] as const;

const TEMPLATE_STAGES = [
  { code: 'new', name: 'Новый', semanticCategory: 'OPEN' as const, orderIndex: 10 },
  { code: 'qualified', name: 'Квалифицирован', semanticCategory: 'OPEN' as const, orderIndex: 20 },
  { code: 'contacted', name: 'Связались', semanticCategory: 'OPEN' as const, orderIndex: 30 },
  { code: 'consultation_scheduled', name: 'Консультация назначена', semanticCategory: 'OPEN' as const, orderIndex: 40 },
  { code: 'offer_sent', name: 'Предложение отправлено', semanticCategory: 'OPEN' as const, orderIndex: 50 },
  { code: 'won', name: 'Успешно', semanticCategory: 'WON' as const, orderIndex: 60 },
  { code: 'lost', name: 'Потерян', semanticCategory: 'LOST' as const, orderIndex: 70 },
  { code: 'not_target', name: 'Не целевой', semanticCategory: 'LOST' as const, orderIndex: 80 },
] as const;

const ASPB_LEGACY_STAGES = [
  { code: 'consultation', name: 'Консультация', semanticCategory: 'OPEN' as const, orderIndex: 110 },
  { code: 'transferred_to_aspb', name: 'Передан в АСПБ', semanticCategory: 'OPEN' as const, orderIndex: 120 },
  { code: 'contract_pending', name: 'Договор на согласовании', semanticCategory: 'OPEN' as const, orderIndex: 130 },
  { code: 'contract_signed', name: 'Договор подписан', semanticCategory: 'OPEN' as const, orderIndex: 140 },
  { code: 'payout_due', name: 'Ожидает выплату', semanticCategory: 'OPEN' as const, orderIndex: 150 },
  { code: 'paid', name: 'Выплачен', semanticCategory: 'WON' as const, orderIndex: 160 },
] as const;

const idSchema = z.string().trim().min(1).max(191);
const listContactsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
    search: z.string().trim().min(2).max(120).optional(),
    webinarId: idSchema.optional(),
    sessionId: idSchema.optional(),
    stageId: idSchema.optional(),
    managerId: idSchema.optional(),
    activity: z.enum(['registered', 'entered', 'viewed', 'question', 'cta', 'email', 'telegram', 'note']).optional(),
    source: z.string().trim().min(1).max(120).optional(),
    hasQuestion: z.enum(['true', 'false']).optional(),
    hasCta: z.enum(['true', 'false']).optional(),
    queue: z.enum(['today', 'overdue', 'without_task']).optional(),
  })
  .strict();

const transitionContactStageSchema = z
  .object({
    stageId: idSchema,
    reason: z.string().trim().min(3).max(1_000).optional(),
  })
  .strict();

const createStageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    semanticCategory: z.enum(['OPEN', 'WON', 'LOST']),
  })
  .strict();

const updateStageSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    position: z.number().int().min(0).max(500).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'At least one stage change is required' });

const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const taskPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const taskStatusSchema = z.enum(['OPEN', 'COMPLETED', 'CANCELLED']);
const taskDescriptionSchema = z.string().trim().max(4_000).nullable().optional();

const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: taskDescriptionSchema,
    assigneeMembershipId: idSchema,
    priority: taskPrioritySchema,
    dueLocal: localDateTimeSchema,
    reminderLocal: localDateTimeSchema,
  })
  .strict();

const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: taskDescriptionSchema,
    assigneeMembershipId: idSchema.optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
    dueLocal: localDateTimeSchema.optional(),
    reminderLocal: localDateTimeSchema.optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'At least one task change is required' });

const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/);
const scoringPointsSchema = z
  .object({
    registration: z.number().int().min(0).max(100),
    roomEntered: z.number().int().min(0).max(100),
    viewed50Percent: z.number().int().min(0).max(100),
    question: z.number().int().min(0).max(100),
    cta: z.number().int().min(0).max(100),
  })
  .strict();
const activateScoringVersionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    hotThreshold: z.number().int().min(0).max(10_000),
    points: scoringPointsSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
const manualHotSchema = z
  .object({
    mode: z.enum(['HOT', 'NOT_HOT', 'AUTOMATIC']),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
const tagColorSchema = z.enum(CRM_TAG_COLOR_TOKENS);
const createTagSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    colorToken: tagColorSchema,
  })
  .strict();
const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    colorToken: tagColorSchema.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'At least one tag change is required' });

const crmContactFiltersSchema = listContactsQuerySchema.omit({ page: true, pageSize: true });
const bulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ASSIGN_MANAGER'), assigneeMembershipId: idSchema }).strict(),
  z.object({ type: z.literal('CREATE_TASK'), task: createTaskSchema }).strict(),
  z
    .object({
      type: z.literal('CHANGE_STAGE'),
      stageId: idSchema,
      reason: z.string().trim().min(3).max(1_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal('ADD_TAG'), tagId: idSchema }).strict(),
]);
const bulkPreviewSchema = z
  .object({
    mode: z.literal('PREVIEW'),
    filters: crmContactFiltersSchema.default({}),
    action: bulkActionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
const bulkExecuteSchema = z.object({ mode: z.literal('EXECUTE'), previewId: idSchema }).strict();
const exportContactsSchema = z.object({ filters: crmContactFiltersSchema.default({}) }).strict();
const CRM_BULK_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const CRM_BULK_MAX_CONTACTS = 1_000;
const CRM_EXPORT_MAX_CONTACTS = 10_000;

type CRMTransaction = Prisma.TransactionClient;

function contactUnavailable(): never {
  throw new AppError(404, 'CRM contact not found', undefined, 'crm_contact_not_found');
}

function stageUnavailable(): never {
  throw new AppError(404, 'CRM stage not found', undefined, 'crm_stage_not_found');
}

function taskUnavailable(): never {
  throw new AppError(404, 'CRM task not found', undefined, 'crm_task_not_found');
}

function tagUnavailable(): never {
  throw new AppError(404, 'CRM tag not found', undefined, 'crm_tag_not_found');
}

function normalizeTagName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function isMaskedRole(context: TenantContext) {
  return context.role === 'ANALYST' || context.role === 'AUDITOR';
}

function hasCrmExportPermission(context: TenantContext) {
  if (!context.permissions || typeof context.permissions !== 'object' || Array.isArray(context.permissions))
    return false;
  const crm = (context.permissions as Record<string, unknown>).crm;
  return Boolean(
    crm && typeof crm === 'object' && !Array.isArray(crm) && (crm as Record<string, unknown>).export === true,
  );
}

function maskName(value: string | null) {
  if (!value) return null;
  return `${value.slice(0, 1)}***`;
}

function maskEmail(value: string | null) {
  if (!value) return null;
  const [local, domain] = value.split('@');
  return local && domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

function maskPhone(value: string | null) {
  if (!value) return null;
  return `***${value.replace(/\D/g, '').slice(-4)}`;
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 18 ? `+${digits}` : null;
}

function nextDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, 12)).toISOString().slice(0, 10);
}

function queueBounds(now: Date, timezone: string) {
  if (!isValidIanaTimezone(timezone)) {
    throw new AppError(503, 'CRM timezone is unavailable', undefined, 'crm_timezone_invalid');
  }
  const localDate = localDateKeyAt(now, timezone);
  return {
    localDate,
    start: localDateTimeToUtc(localDate, '00:00', timezone),
    end: localDateTimeToUtc(nextDateKey(localDate), '00:00', timezone),
  };
}

function parseTaskLocalDateTime(value: string, timezone: string) {
  const [dateKey, timeKey] = value.split('T');
  try {
    return localDateTimeToUtc(dateKey, timeKey, timezone);
  } catch {
    throw new AppError(
      400,
      'Дата задачи не существует в timezone организации',
      undefined,
      'crm_task_local_time_invalid',
    );
  }
}

function assertReminderOrder(reminderAt: Date, dueAt: Date) {
  if (reminderAt.getTime() > dueAt.getTime()) {
    throw new AppError(400, 'Напоминание должно быть не позже срока задачи', undefined, 'crm_task_reminder_after_due');
  }
}

async function lockCrmScope(tx: CRMTransaction, organizationId: string, suffix: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`crm:${organizationId}:${suffix}`}, ${CRM_LOCK_NAMESPACE})
    )
  `;
}

function configuredScoreRules(points: z.infer<typeof scoringPointsSchema>) {
  const configured = {
    registration: points.registration,
    room_entered: points.roomEntered,
    viewed_50_percent: points.viewed50Percent,
    question: points.question,
    cta: points.cta,
  } satisfies Record<CRMScoreSignalCode, number>;
  return CRM_SCORE_SIGNALS.map(signal => ({
    code: signal.code,
    label: signal.label,
    points: configured[signal.code],
  }));
}

function scoringRuleSetProjection(ruleSet: any) {
  return {
    id: ruleSet.id,
    version: ruleSet.version,
    name: ruleSet.name,
    status: ruleSet.status,
    hotThreshold: ruleSet.hotThreshold,
    activatedAt: ruleSet.activatedAt,
    rules: [...(ruleSet.rules || [])]
      .sort(
        (left, right) =>
          CRM_SCORE_SIGNALS.findIndex(signal => signal.code === left.code) -
          CRM_SCORE_SIGNALS.findIndex(signal => signal.code === right.code),
      )
      .map(rule => ({ code: rule.code, label: rule.label, points: rule.points })),
  };
}

async function ensureDefaultCrmScoringRuleSet(tx: CRMTransaction, organizationId: string, now = new Date()) {
  await lockCrmScope(tx, organizationId, 'scoring-model');
  const active = await tx.cRMScoringRuleSet.findFirst({
    where: { organizationId, status: 'ACTIVE' },
    include: { rules: true },
  });
  if (active) return active;

  const latest = await tx.cRMScoringRuleSet.aggregate({
    where: { organizationId },
    _max: { version: true },
  });
  const ruleSet = await tx.cRMScoringRuleSet.create({
    data: {
      organizationId,
      version: (latest._max.version || 0) + 1,
      name: 'Базовая модель',
      hotThreshold: 60,
      rules: { create: CRM_SCORE_SIGNALS.map(signal => ({ ...signal })) },
    },
  });
  return tx.cRMScoringRuleSet.update({
    where: { id: ruleSet.id },
    data: { status: 'ACTIVE', activatedAt: now },
    include: { rules: true },
  });
}

export async function recordCrmScoreSignalForRegistration(
  tx: CRMTransaction,
  registrationId: string,
  signalCode: CRMScoreSignalCode,
  sourceEntityType: string,
  sourceEntityId: string,
  occurredAt = new Date(),
) {
  const registration = await tx.registration.findUnique({
    where: { id: registrationId },
    select: { organizationId: true, crmContactId: true },
  });
  if (!registration?.organizationId || !registration.crmContactId) return null;
  await ensureDefaultCrmScoringRuleSet(tx, registration.organizationId, occurredAt);
  const dedupKey = `score:${signalCode}:${sourceEntityType}:${sourceEntityId}`;
  return tx.cRMScoreFactor.upsert({
    where: {
      organizationId_dedupKey: {
        organizationId: registration.organizationId,
        dedupKey,
      },
    },
    create: {
      organizationId: registration.organizationId,
      contactId: registration.crmContactId,
      signalCode,
      sourceEntityType,
      sourceEntityId,
      dedupKey,
      occurredAt,
    },
    update: {},
  });
}

function bootstrapStages(organizationId: string) {
  return organizationId === 'org_aspb' ? [...TEMPLATE_STAGES, ...ASPB_LEGACY_STAGES] : [...TEMPLATE_STAGES];
}

async function ensureDefaultPipeline(tx: CRMTransaction, organizationId: string) {
  await lockCrmScope(tx, organizationId, 'bootstrap');
  const existing = await tx.cRMPipeline.findFirst({
    where: { organizationId, isDefault: true, status: 'ACTIVE' },
    include: { stages: { orderBy: { orderIndex: 'asc' } } },
  });
  if (existing) return existing;

  return tx.cRMPipeline.create({
    data: {
      organizationId,
      name: organizationId === 'org_aspb' ? 'Партнёрская воронка АСПБ' : 'Основная воронка',
      isDefault: true,
      stages: {
        create: bootstrapStages(organizationId).map(stage => ({ ...stage, isProtected: true })),
      },
    },
    include: { stages: { orderBy: { orderIndex: 'asc' } } },
  });
}

async function ensureStageForLegacyCode(
  tx: CRMTransaction,
  pipeline: Awaited<ReturnType<typeof ensureDefaultPipeline>>,
  code: string,
) {
  const existing = pipeline.stages.find(stage => stage.code === code);
  if (existing) return existing;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(code)) {
    throw new AppError(409, 'Legacy CRM status requires migration review', undefined, 'crm_legacy_status_invalid');
  }
  const maximum = pipeline.stages.reduce((value, stage) => Math.max(value, stage.orderIndex), 0);
  return tx.cRMStage.create({
    data: {
      organizationId: pipeline.organizationId,
      pipelineId: pipeline.id,
      code,
      name: code,
      semanticCategory:
        code === 'paid' || code === 'won' ? 'WON' : code === 'lost' || code === 'not_target' ? 'LOST' : 'OPEN',
      orderIndex: maximum + 10,
      isProtected: true,
    },
  });
}

export async function linkVerifiedRegistrationToCrm(tx: CRMTransaction, registrationId: string, now = new Date()) {
  const registration = await tx.registration.findUnique({
    where: { id: registrationId },
    include: { lead: true },
  });
  if (
    !registration ||
    !registration.organizationId ||
    !registration.webinarId ||
    registration.status !== 'registered' ||
    !registration.emailVerifiedAt
  ) {
    return null;
  }

  const pipeline = await ensureDefaultPipeline(tx, registration.organizationId);
  const registrationStage = await ensureStageForLegacyCode(tx, pipeline, registration.crmStatus);
  await lockCrmScope(tx, registration.organizationId, `lead:${registration.leadId}`);
  let contact = await tx.cRMContact.findUnique({
    where: {
      organizationId_legacyLeadId: {
        organizationId: registration.organizationId,
        legacyLeadId: registration.leadId,
      },
    },
  });
  const created = !contact;
  if (!contact) {
    contact = await tx.cRMContact.create({
      data: {
        organizationId: registration.organizationId,
        pipelineId: pipeline.id,
        stageId: registrationStage.id,
        legacyLeadId: registration.leadId,
        emailNormalized: registration.lead.email.trim().toLowerCase(),
        phoneNormalized: normalizePhone(registration.lead.phone),
        displayName: registration.lead.name.trim() || null,
        source: registration.lead.source,
        legacyAssignedManagerId: registration.assignedManagerId,
        nextContactAt: registration.nextContactAt,
      },
    });
  } else {
    contact = await tx.cRMContact.update({
      where: { id: contact.id },
      data: {
        emailNormalized: registration.lead.email.trim().toLowerCase(),
        phoneNormalized: normalizePhone(registration.lead.phone),
        displayName: registration.lead.name.trim() || null,
        source: registration.lead.source,
      },
    });
  }

  await tx.registration.update({ where: { id: registration.id }, data: { crmContactId: contact.id } });
  await tx.cRMContactEvent.upsert({
    where: {
      organizationId_dedupKey: {
        organizationId: registration.organizationId,
        dedupKey: `registration:${registration.id}`,
      },
    },
    create: {
      organizationId: registration.organizationId,
      contactId: contact.id,
      type: 'registration',
      source: 'registration_activation',
      sourceEntityType: 'registration',
      sourceEntityId: registration.id,
      webinarId: registration.webinarId,
      webinarSessionId: registration.webinarSessionId,
      registrationId: registration.id,
      dedupKey: `registration:${registration.id}`,
      occurredAt: now,
      metadataJson: { accessPolicy: registration.accessPolicy },
    },
    update: {},
  });
  await recordCrmScoreSignalForRegistration(
    tx,
    registration.id,
    'registration',
    'registration',
    registration.id,
    registration.registeredAt,
  );
  if (created) {
    await tx.cRMStageTransition.create({
      data: {
        organizationId: registration.organizationId,
        contactId: contact.id,
        pipelineId: pipeline.id,
        toStageId: registrationStage.id,
        reason: registrationStage.semanticCategory === 'LOST' ? 'Imported from verified registration' : null,
        source: 'registration_activation',
        occurredAt: now,
      },
    });
  }
  return contact;
}

function activityRegistrationWhere(
  context: TenantContext,
  activity: z.infer<typeof listContactsQuerySchema>['activity'],
): Prisma.RegistrationWhereInput | null {
  const base: Prisma.RegistrationWhereInput = { organizationId: context.organizationId };
  if (!activity || activity === 'registered') return activity ? base : null;
  if (activity === 'entered') return { ...base, roomEnteredAt: { not: null } };
  if (activity === 'question') return { ...base, questions: { some: {} } };
  if (activity === 'cta') return { ...base, partnerApplications: { some: {} } };
  if (activity === 'email') return { ...base, emailOutboxJobs: { some: {} } };
  if (activity === 'telegram') {
    return {
      ...base,
      OR: [
        { telegramClickedAt: { not: null } },
        { telegramReminder24hSentAt: { not: null } },
        { telegramReminder3hSentAt: { not: null } },
        { telegramReminder30mSentAt: { not: null } },
        { telegramLiveSentAt: { not: null } },
        { telegramFollowupSentAt: { not: null } },
      ],
    };
  }
  if (activity === 'viewed') {
    return {
      ...base,
      participantUser: { viewerProgress: { some: { organizationId: context.organizationId } } },
    };
  }
  if (activity === 'note') {
    return {
      ...base,
      participantUser: { viewerNotes: { some: { organizationId: context.organizationId } } },
    };
  }
  return null;
}

function contactProjection(contact: any, masked: boolean) {
  const hotThreshold = contact.scoreRuleSet?.hotThreshold ?? null;
  const automaticHot = hotThreshold !== null && contact.score >= hotThreshold;
  return {
    id: contact.id,
    displayName: masked ? maskName(contact.displayName) : contact.displayName,
    email: masked ? maskEmail(contact.emailNormalized) : contact.emailNormalized,
    phone: masked ? maskPhone(contact.phoneNormalized) : contact.phoneNormalized,
    source: contact.source,
    stage: contact.stage,
    pipeline: contact.pipeline,
    manager: contact.ownerMembership
      ? { type: 'membership', id: contact.ownerMembership.id, name: contact.ownerMembership.user.displayName }
      : contact.legacyAssignedManager
        ? { type: 'legacy_admin', id: contact.legacyAssignedManager.id, name: contact.legacyAssignedManager.name }
        : null,
    nextContactAt: contact.nextContactAt,
    score: {
      value: contact.score || 0,
      ruleSetVersion: contact.scoreRuleSet?.version ?? null,
      hotThreshold,
      automaticHot,
      manualOverride: contact.manualHot === null ? 'AUTOMATIC' : contact.manualHot ? 'HOT' : 'NOT_HOT',
      effectiveHot: contact.manualHot ?? automaticHot,
      manualReason: contact.manualHotReason,
      computedAt: contact.scoreComputedAt,
    },
    tags: (contact.tags || []).map((assignment: any) => ({
      id: assignment.tag.id,
      name: assignment.tag.name,
      colorToken: assignment.tag.colorToken,
      status: assignment.tag.status,
    })),
    updatedAt: contact.updatedAt,
  };
}

function scoreDetailProjection(contact: any) {
  const rules = new Map((contact.scoreRuleSet?.rules || []).map((rule: any) => [rule.code, rule]));
  const groups = new Map<
    string,
    { code: string; label: string; pointsEach: number; count: number; lastOccurredAt: Date }
  >();
  for (const factor of contact.scoreFactors || []) {
    const rule: any = rules.get(factor.signalCode);
    if (!rule) continue;
    const existing = groups.get(factor.signalCode);
    if (existing) {
      existing.count += 1;
      if (factor.occurredAt > existing.lastOccurredAt) existing.lastOccurredAt = factor.occurredAt;
    } else {
      groups.set(factor.signalCode, {
        code: factor.signalCode,
        label: rule.label,
        pointsEach: rule.points,
        count: 1,
        lastOccurredAt: factor.occurredAt,
      });
    }
  }
  return {
    ...contactProjection(contact, false).score,
    factors: CRM_SCORE_SIGNALS.flatMap(signal => {
      const factor = groups.get(signal.code);
      return factor ? [{ ...factor, subtotal: factor.pointsEach * factor.count }] : [];
    }),
  };
}

function taskProjection(task: any, timezone: string, masked: boolean) {
  return {
    id: task.id,
    contactId: task.contactId,
    title: masked ? 'Задача CRM' : task.title,
    description: masked ? null : task.description,
    priority: task.priority,
    status: task.status,
    dueAt: task.dueAt,
    reminderAt: task.reminderAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    timezone,
    assignee: {
      id: task.assigneeMembership.id,
      name: task.assigneeMembership.user.displayName || 'Участник организации',
    },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function findActiveCrmPipeline(db: PrismaClient | CRMTransaction, organizationId: string) {
  const pipeline = await db.cRMPipeline.findFirst({
    where: { organizationId, isDefault: true, status: 'ACTIVE' },
    select: { id: true, timezone: true },
  });
  if (!pipeline) {
    return { id: null, timezone: 'Europe/Moscow' };
  }
  if (!isValidIanaTimezone(pipeline.timezone)) {
    throw new AppError(503, 'CRM timezone is unavailable', undefined, 'crm_timezone_invalid');
  }
  return pipeline;
}

async function requireTaskAssignee(tx: CRMTransaction, organizationId: string, membershipId: string) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      id: membershipId,
      organizationId,
      status: 'ACTIVE',
      role: { in: ['OWNER', 'CRM_MANAGER'] },
    },
    include: { user: { select: { displayName: true } } },
  });
  if (!membership) {
    throw new AppError(404, 'CRM assignee not found', undefined, 'crm_assignee_not_found');
  }
  return membership;
}

export async function getCrmReferenceData(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, CRM_READ_ROLES);
  const [pipelines, memberships, legacyManagers] = await Promise.all([
    db.cRMPipeline.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { stages: { orderBy: { orderIndex: 'asc' } } },
    }),
    db.organizationMembership.findMany({
      where: {
        organizationId: context.organizationId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'CRM_MANAGER'] },
      },
      include: { user: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.adminUser.findMany({
      where: { legacyOwnedCrmContacts: { some: { organizationId: context.organizationId } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return {
    pipelines: pipelines.map(pipeline => ({
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.isDefault,
      version: pipeline.version,
      timezone: pipeline.timezone,
      stages: pipeline.stages.map(stage => ({
        id: stage.id,
        code: stage.code,
        name: stage.name,
        semanticCategory: stage.semanticCategory,
        orderIndex: stage.orderIndex,
        status: stage.status,
        isProtected: stage.isProtected,
      })),
    })),
    managers: [
      ...memberships.map(membership => ({
        id: membership.id,
        type: 'membership' as const,
        name: membership.user.displayName || 'Участник организации',
      })),
      ...legacyManagers.map(manager => ({ id: manager.id, type: 'legacy_admin' as const, name: manager.name })),
    ],
    maskedPersonalData: isMaskedRole(context),
    canEditContacts: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
    canEditTasks: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
    canEditTags: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
    canSendDeliveries: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
    canRunBulkActions: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
    canExport: hasCrmExportPermission(context),
    canManageScoring: context.role === 'OWNER',
    canManageStages: context.role === 'OWNER',
  };
}

async function buildCrmContactSelection(
  db: PrismaClient | CRMTransaction,
  context: TenantContext,
  query: z.infer<typeof listContactsQuerySchema>,
  now: Date,
) {
  if (isMaskedRole(context) && query.search) {
    throw new AppError(403, 'Search by personal data is unavailable for this role', undefined, 'crm_pii_search_denied');
  }
  const registrationFilters: Prisma.RegistrationWhereInput[] = [];
  if (query.webinarId) registrationFilters.push({ webinarId: query.webinarId });
  if (query.sessionId) registrationFilters.push({ webinarSessionId: query.sessionId });
  if (query.hasQuestion) {
    registrationFilters.push({ questions: query.hasQuestion === 'true' ? { some: {} } : { none: {} } });
  }
  if (query.hasCta) {
    registrationFilters.push({ partnerApplications: query.hasCta === 'true' ? { some: {} } : { none: {} } });
  }
  const activityWhere = activityRegistrationWhere(context, query.activity);
  if (activityWhere) registrationFilters.push(activityWhere);

  const pipeline = await findActiveCrmPipeline(db, context.organizationId);
  const bounds = queueBounds(now, pipeline.timezone);
  const queueWhere: Prisma.CRMContactWhereInput =
    query.queue === 'today'
      ? { tasks: { some: { status: 'OPEN', dueAt: { gte: now, lt: bounds.end } } } }
      : query.queue === 'overdue'
        ? { tasks: { some: { status: 'OPEN', dueAt: { lt: now } } } }
        : query.queue === 'without_task'
          ? { stage: { semanticCategory: 'OPEN' }, tasks: { none: { status: 'OPEN' } } }
          : {};

  const where: Prisma.CRMContactWhereInput = {
    organizationId: context.organizationId,
    archivedAt: null,
    ...(query.stageId ? { stageId: query.stageId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.search
      ? {
          OR: [
            { displayName: { contains: query.search, mode: 'insensitive' } },
            { emailNormalized: { contains: query.search.toLowerCase(), mode: 'insensitive' } },
            ...(query.search.replace(/\D/g, '').length >= 3
              ? [{ phoneNormalized: { contains: query.search.replace(/\D/g, '') } }]
              : []),
          ],
        }
      : {}),
    ...(query.managerId
      ? {
          OR: [{ ownerMembershipId: query.managerId }, { legacyAssignedManagerId: query.managerId }],
        }
      : {}),
    ...(registrationFilters.length
      ? { registrations: { some: { organizationId: context.organizationId, AND: registrationFilters } } }
      : {}),
    AND: queueWhere,
  };
  return { where, pipeline, bounds };
}

export async function listCrmContacts(db: PrismaClient, context: TenantContext, queryInput: unknown, now = new Date()) {
  requireTenantRole(context, CRM_READ_ROLES);
  const query = listContactsQuerySchema.parse(queryInput);
  const { where, pipeline, bounds } = await buildCrmContactSelection(db, context, query, now);
  const [total, contacts] = await db.$transaction([
    db.cRMContact.count({ where }),
    db.cRMContact.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        stage: { select: { id: true, code: true, name: true, semanticCategory: true } },
        pipeline: { select: { id: true, name: true } },
        scoreRuleSet: { select: { id: true, version: true, hotThreshold: true } },
        tags: { include: { tag: true }, orderBy: { assignedAt: 'asc' } },
        ownerMembership: { include: { user: { select: { displayName: true } } } },
        legacyAssignedManager: { select: { id: true, name: true } },
      },
    }),
  ]);
  return {
    contacts: contacts.map(contact => contactProjection(contact, isMaskedRole(context))),
    pagination: { page: query.page, pageSize: query.pageSize, total, pages: Math.ceil(total / query.pageSize) },
    filters: query,
    timezone: pipeline.timezone,
    localDate: bounds.localDate,
  };
}

function bulkActionRequestHash(filters: unknown, action: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify({ filters, action })).digest('hex');
}

function crmFilterAuditSummary(filters: Record<string, unknown>) {
  return { filterKeys: Object.keys(filters).sort() };
}

function bulkActionProjection(action: any) {
  return {
    id: action.id,
    actionType: action.actionType,
    expectedCount: action.expectedCount,
    status: action.status,
    expiresAt: action.expiresAt,
    executedAt: action.executedAt,
    results: action.resultsJson,
  };
}

async function validateBulkActionTarget(
  db: PrismaClient | CRMTransaction,
  context: TenantContext,
  action: z.infer<typeof bulkActionSchema>,
) {
  if (action.type === 'ASSIGN_MANAGER' || action.type === 'CREATE_TASK') {
    const membershipId =
      action.type === 'ASSIGN_MANAGER' ? action.assigneeMembershipId : action.task.assigneeMembershipId;
    const membership = await db.organizationMembership.findFirst({
      where: {
        id: membershipId,
        organizationId: context.organizationId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'CRM_MANAGER'] },
      },
      select: { id: true },
    });
    if (!membership) throw new AppError(404, 'CRM bulk target not found', undefined, 'crm_bulk_target_not_found');
  } else if (action.type === 'CHANGE_STAGE') {
    const stage = await db.cRMStage.findFirst({
      where: { id: action.stageId, organizationId: context.organizationId, status: 'ACTIVE' },
      select: { id: true, semanticCategory: true },
    });
    if (!stage) throw new AppError(404, 'CRM bulk target not found', undefined, 'crm_bulk_target_not_found');
    if (stage.semanticCategory === 'LOST' && !action.reason) {
      throw new AppError(400, 'Укажите общую причину потери контактов', undefined, 'crm_lost_reason_required');
    }
  } else {
    const tag = await db.cRMTag.findFirst({
      where: { id: action.tagId, organizationId: context.organizationId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!tag) throw new AppError(404, 'CRM bulk target not found', undefined, 'crm_bulk_target_not_found');
  }
}

export async function previewCrmBulkAction(db: PrismaClient, context: TenantContext, input: unknown, now = new Date()) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const data = bulkPreviewSchema.parse(input);
  const query = listContactsQuerySchema.parse({ ...data.filters, page: 1, pageSize: 1 });
  const { where } = await buildCrmContactSelection(db, context, query, now);
  const requestHash = bulkActionRequestHash(data.filters, data.action);

  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `bulk-preview:${data.idempotencyKey}`);
    const replay = await tx.cRMBulkAction.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: context.organizationId,
          idempotencyKey: data.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (replay.requestHash !== requestHash || replay.requestedByMembershipId !== context.membershipId) {
        throw new AppError(409, 'Bulk idempotency key is already used', undefined, 'crm_bulk_idempotency_conflict');
      }
      return { bulkAction: bulkActionProjection(replay), replayed: true };
    }

    await validateBulkActionTarget(tx, context, data.action);

    const contacts = await tx.cRMContact.findMany({
      where,
      orderBy: { id: 'asc' },
      take: CRM_BULK_MAX_CONTACTS + 1,
      select: { id: true },
    });
    if (contacts.length > CRM_BULK_MAX_CONTACTS) {
      throw new AppError(
        400,
        `Массовое действие ограничено ${CRM_BULK_MAX_CONTACTS} контактами`,
        undefined,
        'crm_bulk_selection_too_large',
      );
    }
    const action = await tx.cRMBulkAction.create({
      data: {
        organizationId: context.organizationId,
        requestedByMembershipId: context.membershipId,
        actionType: data.action.type,
        actionJson: data.action,
        filtersJson: crmFilterAuditSummary(data.filters),
        contactIdsJson: contacts.map(contact => contact.id),
        requestHash,
        expectedCount: contacts.length,
        idempotencyKey: data.idempotencyKey,
        expiresAt: new Date(now.getTime() + CRM_BULK_PREVIEW_TTL_MS),
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.bulk.previewed',
        entityType: 'crm_bulk_action',
        entityId: action.id,
        afterJson: {
          actionType: action.actionType,
          expectedCount: action.expectedCount,
          ...crmFilterAuditSummary(data.filters),
        },
      },
    });
    return { bulkAction: bulkActionProjection(action), replayed: false };
  });
}

async function assignCrmManagerForBulk(
  db: PrismaClient,
  context: TenantContext,
  bulkActionId: string,
  contactId: string,
  assigneeMembershipId: string,
  now: Date,
) {
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}`);
    const [contact, assignee] = await Promise.all([
      tx.cRMContact.findFirst({ where: { id: contactId, organizationId: context.organizationId, archivedAt: null } }),
      requireTaskAssignee(tx, context.organizationId, assigneeMembershipId),
    ]);
    if (!contact) contactUnavailable();
    if (contact.ownerMembershipId === assignee.id) return;
    await tx.cRMContact.update({
      where: { id: contact.id },
      data: { ownerMembershipId: assignee.id, legacyAssignedManagerId: null },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'manager_assigned',
        source: 'tenant_crm_bulk',
        sourceEntityType: 'organization_membership',
        sourceEntityId: assignee.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey: `bulk-manager:${bulkActionId}:${contact.id}`,
        occurredAt: now,
        metadataJson: { assigneeMembershipId: assignee.id },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.contact.manager_assigned',
        entityType: 'crm_contact',
        entityId: contact.id,
        beforeJson: { ownerMembershipId: contact.ownerMembershipId },
        afterJson: { ownerMembershipId: assignee.id, bulkActionId },
      },
    });
  });
}

async function createCrmTaskForBulk(
  db: PrismaClient,
  context: TenantContext,
  bulkActionId: string,
  contactId: string,
  data: z.infer<typeof createTaskSchema>,
  now: Date,
) {
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}`);
    const replay = await tx.cRMTask.findUnique({ where: { bulkActionId_contactId: { bulkActionId, contactId } } });
    if (replay) return;
    const contact = await tx.cRMContact.findFirst({
      where: { id: contactId, organizationId: context.organizationId, archivedAt: null },
      include: { pipeline: { select: { timezone: true } } },
    });
    if (!contact) contactUnavailable();
    const assignee = await requireTaskAssignee(tx, context.organizationId, data.assigneeMembershipId);
    const dueAt = parseTaskLocalDateTime(data.dueLocal, contact.pipeline.timezone);
    const reminderAt = parseTaskLocalDateTime(data.reminderLocal, contact.pipeline.timezone);
    assertReminderOrder(reminderAt, dueAt);
    const task = await tx.cRMTask.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        assigneeMembershipId: assignee.id,
        createdByUserId: context.userId,
        title: data.title,
        description: data.description || null,
        priority: data.priority,
        dueAt,
        reminderAt,
        bulkActionId,
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'task_created',
        source: 'tenant_crm_bulk',
        sourceEntityType: 'crm_task',
        sourceEntityId: task.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey: `bulk-task:${bulkActionId}:${contact.id}`,
        occurredAt: now,
        metadataJson: {
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
          assigneeMembershipId: task.assigneeMembershipId,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.task.created',
        entityType: 'crm_task',
        entityId: task.id,
        afterJson: {
          contactId: task.contactId,
          assigneeMembershipId: task.assigneeMembershipId,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
          bulkActionId,
        },
      },
    });
  });
}

function safeBulkFailureCode(error: unknown) {
  return error instanceof AppError && error.code ? error.code : 'crm_bulk_item_failed';
}

export async function executeCrmBulkAction(db: PrismaClient, context: TenantContext, input: unknown, now = new Date()) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const data = bulkExecuteSchema.parse(input);
  const claim = await db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `bulk-execute:${data.previewId}`);
    const action = await tx.cRMBulkAction.findFirst({
      where: {
        id: data.previewId,
        organizationId: context.organizationId,
        requestedByMembershipId: context.membershipId,
      },
    });
    if (!action) throw new AppError(404, 'CRM bulk preview not found', undefined, 'crm_bulk_preview_not_found');
    if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(action.status)) {
      return { action, replayed: true, expired: false };
    }
    if (action.expiresAt <= now) {
      const expired =
        action.status === 'EXPIRED'
          ? action
          : await tx.cRMBulkAction.update({ where: { id: action.id }, data: { status: 'EXPIRED' } });
      return { action: expired, replayed: false, expired: true };
    }
    if (action.status === 'RUNNING' && action.updatedAt > new Date(now.getTime() - 5 * 60 * 1_000)) {
      throw new AppError(409, 'CRM bulk action is already running', undefined, 'crm_bulk_in_progress');
    }
    const running = await tx.cRMBulkAction.update({ where: { id: action.id }, data: { status: 'RUNNING' } });
    return { action: running, replayed: false, expired: false };
  });
  if (claim.expired) {
    throw new AppError(409, 'CRM bulk preview expired', undefined, 'crm_bulk_preview_expired');
  }
  if (claim.replayed) return { bulkAction: bulkActionProjection(claim.action), replayed: true };

  const action = bulkActionSchema.parse(claim.action.actionJson);
  const contactIds = z.array(idSchema).max(CRM_BULK_MAX_CONTACTS).parse(claim.action.contactIdsJson);
  const successes: Array<{ contactId: string }> = [];
  const failures: Array<{ contactId: string; code: string }> = [];
  for (const contactId of contactIds) {
    try {
      if (action.type === 'ASSIGN_MANAGER') {
        await assignCrmManagerForBulk(db, context, claim.action.id, contactId, action.assigneeMembershipId, now);
      } else if (action.type === 'CREATE_TASK') {
        await createCrmTaskForBulk(db, context, claim.action.id, contactId, action.task, now);
      } else if (action.type === 'CHANGE_STAGE') {
        await transitionCrmContactStage(
          db,
          context,
          contactId,
          { stageId: action.stageId, reason: action.reason },
          now,
        );
      } else {
        await assignCrmContactTag(db, context, contactId, action.tagId, now);
      }
      successes.push({ contactId });
    } catch (error) {
      failures.push({ contactId, code: safeBulkFailureCode(error) });
    }
  }
  const results = { successes, failures };
  const status = failures.length === 0 ? 'COMPLETED' : successes.length === 0 ? 'FAILED' : 'PARTIAL';
  const completed = await db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `bulk-execute:${claim.action.id}`);
    const updated = await tx.cRMBulkAction.update({
      where: { id: claim.action.id },
      data: { status, resultsJson: results, executedAt: now },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.bulk.executed',
        entityType: 'crm_bulk_action',
        entityId: updated.id,
        afterJson: {
          actionType: updated.actionType,
          expectedCount: updated.expectedCount,
          successCount: successes.length,
          failureCount: failures.length,
          failureCodes: [...new Set(failures.map(failure => failure.code))],
          status,
        },
      },
    });
    return updated;
  });
  return { bulkAction: bulkActionProjection(completed), replayed: false };
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportCrmContacts(db: PrismaClient, context: TenantContext, input: unknown, now = new Date()) {
  requireTenantRole(context, CRM_READ_ROLES);
  if (!hasCrmExportPermission(context)) {
    throw new AppError(403, 'CRM export permission is required', undefined, 'crm_export_permission_required');
  }
  const data = exportContactsSchema.parse(input);
  const query = listContactsQuerySchema.parse({ ...data.filters, page: 1, pageSize: 1 });
  const { where } = await buildCrmContactSelection(db, context, query, now);
  const contacts = await db.cRMContact.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: CRM_EXPORT_MAX_CONTACTS + 1,
    include: {
      stage: { select: { code: true, name: true } },
      scoreRuleSet: { select: { hotThreshold: true } },
      tags: { include: { tag: true }, orderBy: { assignedAt: 'asc' } },
      ownerMembership: { include: { user: { select: { displayName: true } } } },
      legacyAssignedManager: { select: { name: true } },
    },
  });
  if (contacts.length > CRM_EXPORT_MAX_CONTACTS) {
    throw new AppError(
      400,
      `Экспорт ограничен ${CRM_EXPORT_MAX_CONTACTS} контактами`,
      undefined,
      'crm_export_too_large',
    );
  }
  const masked = isMaskedRole(context);
  const header = [
    'contact_id',
    'name',
    'email',
    'phone',
    'stage_code',
    'stage',
    'manager',
    'score',
    'hot',
    'tags',
    'next_contact_at',
    'source',
  ];
  const rows = contacts.map(contact => {
    const automaticHot = contact.scoreRuleSet ? contact.score >= contact.scoreRuleSet.hotThreshold : false;
    return [
      contact.id,
      masked ? maskName(contact.displayName) : contact.displayName,
      masked ? maskEmail(contact.emailNormalized) : contact.emailNormalized,
      masked ? maskPhone(contact.phoneNormalized) : contact.phoneNormalized,
      contact.stage.code,
      contact.stage.name,
      contact.ownerMembership?.user.displayName || contact.legacyAssignedManager?.name || '',
      contact.score,
      contact.manualHot ?? automaticHot,
      contact.tags.map(assignment => assignment.tag.name).join('; '),
      contact.nextContactAt?.toISOString() || '',
      contact.source || '',
    ];
  });
  const csv = `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const audit = await db.auditLog.create({
    data: {
      userId: context.userId,
      organizationId: context.organizationId,
      correlationId: context.correlationId,
      action: 'crm.contacts.exported',
      entityType: 'crm_export',
      entityId: crypto.randomUUID(),
      afterJson: {
        ...crmFilterAuditSummary(data.filters),
        rowCount: contacts.length,
        masked,
        format: 'csv',
        delivery: 'single_response',
      },
    },
  });
  return {
    csv,
    rowCount: contacts.length,
    fileName: `crm-contacts-${now.toISOString().slice(0, 10)}.csv`,
    auditId: audit.id,
  };
}

export async function getCrmQueues(db: PrismaClient, context: TenantContext, now = new Date()) {
  requireTenantRole(context, CRM_READ_ROLES);
  const pipeline = await findActiveCrmPipeline(db, context.organizationId);
  const bounds = queueBounds(now, pipeline.timezone);
  const baseTaskWhere: Prisma.CRMTaskWhereInput = {
    organizationId: context.organizationId,
    status: 'OPEN',
    contact: { archivedAt: null },
  };
  const [today, overdue, withoutTask, remindersDue] = await db.$transaction([
    db.cRMTask.count({ where: { ...baseTaskWhere, dueAt: { gte: now, lt: bounds.end } } }),
    db.cRMTask.count({ where: { ...baseTaskWhere, dueAt: { lt: now } } }),
    db.cRMContact.count({
      where: {
        organizationId: context.organizationId,
        archivedAt: null,
        stage: { semanticCategory: 'OPEN' },
        tasks: { none: { status: 'OPEN' } },
      },
    }),
    db.cRMTask.count({ where: { ...baseTaskWhere, reminderAt: { lte: now } } }),
  ]);
  return {
    timezone: pipeline.timezone,
    localDate: bounds.localDate,
    generatedAt: now,
    counts: { today, overdue, withoutTask, remindersDue },
  };
}

type TimelineItem = {
  id: string;
  type: string;
  source: string;
  occurredAt: Date;
  webinarId?: string | null;
  webinarSessionId?: string | null;
  status?: string | null;
  summary: string;
};

function addTimelineItem(items: TimelineItem[], item: TimelineItem) {
  items.push(item);
}

function registrationEventSummary(eventName: string) {
  return (
    {
      participant_login: 'Вход по безопасной ссылке',
      room_entered: 'Вход в вебинарную комнату',
      webinar_progress: 'Прогресс просмотра',
      partner_application: 'CTA-заявка',
    }[eventName] || `Событие: ${eventName}`
  );
}

function crmEventSummary(event: { type: string; metadataJson: unknown }, masked: boolean) {
  const metadata =
    event.metadataJson && typeof event.metadataJson === 'object' && !Array.isArray(event.metadataJson)
      ? (event.metadataJson as Record<string, unknown>)
      : {};
  const title = !masked && typeof metadata.title === 'string' ? `: ${metadata.title}` : '';
  const reason = typeof metadata.reason === 'string' ? ` · Причина: ${metadata.reason}` : '';
  const channel = metadata.channel === 'EMAIL' ? 'Email' : metadata.channel === 'TELEGRAM' ? 'Telegram' : 'Сообщение';
  return (
    {
      task_created: `Задача создана${title}`,
      task_updated: `Задача обновлена${title}`,
      task_completed: `Задача завершена${title}`,
      task_cancelled: `Задача отменена${title}`,
      task_reopened: `Задача возвращена в работу${title}`,
      manual_hot_changed: `Ручной статус hot изменён${reason}`,
      manager_assigned: 'Назначен менеджер',
      tag_assigned: 'Тег добавлен к контакту',
      tag_removed: 'Тег снят с контакта',
      delivery_queued: `${channel} поставлено в очередь`,
      delivery_retry_requested: `${channel}: менеджер запросил повтор`,
      retry_scheduled: `${channel}: назначена повторная попытка`,
      blocked: `${channel}: отправка заблокирована актуальной проверкой`,
      dead_lettered: `${channel}: требуется разбор ошибки доставки`,
      cancelled: `${channel}: отправка отменена безопасно`,
      sent: `${channel}: отправлено`,
    }[event.type] || `Событие CRM: ${event.type}`
  );
}

export async function getCrmContact(db: PrismaClient, context: TenantContext, contactIdInput: unknown) {
  requireTenantRole(context, CRM_READ_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const contact = await db.cRMContact.findFirst({
    where: { id: contactId, organizationId: context.organizationId },
    include: {
      stage: { select: { id: true, code: true, name: true, semanticCategory: true } },
      pipeline: { select: { id: true, name: true, timezone: true } },
      scoreRuleSet: { include: { rules: true } },
      scoreFactors: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] },
      tags: { include: { tag: true }, orderBy: { assignedAt: 'asc' } },
      ownerMembership: { include: { user: { select: { displayName: true } } } },
      legacyAssignedManager: { select: { id: true, name: true } },
      events: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] },
      transitions: {
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        include: {
          fromStage: { select: { id: true, code: true, name: true } },
          toStage: { select: { id: true, code: true, name: true } },
        },
      },
      tasks: {
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
        include: { assigneeMembership: { include: { user: { select: { displayName: true } } } } },
      },
      registrations: {
        where: { organizationId: context.organizationId },
        include: {
          webinar: { select: { id: true, title: true } },
          webinarSession: { select: { id: true, title: true, timezone: true, scheduledAt: true } },
          events: true,
          questions: true,
          partnerApplications: true,
          emailOutboxJobs: true,
        },
      },
    },
  });
  if (!contact) contactUnavailable();

  const userIds = [
    ...new Set(contact.registrations.map(registration => registration.userId).filter(Boolean)),
  ] as string[];
  const [progressRows, noteRows, deliveryOverview] = await Promise.all([
    db.viewerWebinarProgress.findMany({ where: { organizationId: context.organizationId, userId: { in: userIds } } }),
    db.viewerWebinarNote.findMany({ where: { organizationId: context.organizationId, userId: { in: userIds } } }),
    getCrmDeliveryOverview(db, context, contact.id),
  ]);
  const timeline: TimelineItem[] = [];

  for (const event of contact.events) {
    if (event.type === 'registration' || event.type === 'stage_transition') continue;
    const metadata =
      event.metadataJson && typeof event.metadataJson === 'object' && !Array.isArray(event.metadataJson)
        ? (event.metadataJson as Record<string, unknown>)
        : {};
    addTimelineItem(timeline, {
      id: `crm:${event.id}`,
      type: event.type,
      source: event.source,
      occurredAt: event.occurredAt,
      webinarId: event.webinarId,
      webinarSessionId: event.webinarSessionId,
      status: typeof metadata.status === 'string' ? metadata.status : null,
      summary: crmEventSummary(event, isMaskedRole(context)),
    });
  }
  for (const transition of contact.transitions) {
    addTimelineItem(timeline, {
      id: `transition:${transition.id}`,
      type: 'stage_transition',
      source: transition.source,
      occurredAt: transition.occurredAt,
      summary: `${transition.fromStage?.name || 'Без этапа'} → ${transition.toStage.name}${transition.reason ? ` · ${transition.reason}` : ''}`,
    });
  }
  for (const registration of contact.registrations) {
    addTimelineItem(timeline, {
      id: `registration:${registration.id}`,
      type: 'registration',
      source: registration.accessPolicy.toLowerCase(),
      occurredAt: registration.registeredAt,
      webinarId: registration.webinarId,
      webinarSessionId: registration.webinarSessionId,
      status: registration.status,
      summary: `Регистрация · ${registration.webinar?.title || registration.webinarSession.title}`,
    });
    if (registration.roomEnteredAt) {
      addTimelineItem(timeline, {
        id: `room:${registration.id}`,
        type: 'room_entered',
        source: 'webinar_room',
        occurredAt: registration.roomEnteredAt,
        webinarId: registration.webinarId,
        webinarSessionId: registration.webinarSessionId,
        summary: 'Вход в вебинарную комнату',
      });
    }
    for (const event of registration.events) {
      addTimelineItem(timeline, {
        id: `event:${event.id}`,
        type: event.eventName,
        source: event.source || 'event',
        occurredAt: event.createdAt,
        webinarId: registration.webinarId,
        webinarSessionId: event.webinarSessionId,
        summary: registrationEventSummary(event.eventName),
      });
    }
    for (const question of registration.questions) {
      addTimelineItem(timeline, {
        id: `question:${question.id}`,
        type: 'question',
        source: 'webinar_room',
        occurredAt: question.createdAt,
        webinarId: registration.webinarId,
        webinarSessionId: question.webinarSessionId,
        status: question.isAnswered ? 'answered' : 'new',
        summary: isMaskedRole(context) ? 'Вопрос участника' : question.text,
      });
    }
    for (const cta of registration.partnerApplications) {
      addTimelineItem(timeline, {
        id: `cta:${cta.id}`,
        type: 'cta',
        source: 'partner_application',
        occurredAt: cta.createdAt,
        webinarId: registration.webinarId,
        webinarSessionId: cta.webinarSessionId,
        status: cta.status,
        summary: 'Заявка по CTA',
      });
    }
    for (const email of registration.emailOutboxJobs) {
      addTimelineItem(timeline, {
        id: `email:${email.id}`,
        type: 'email_delivery',
        source: 'email_outbox',
        occurredAt: email.sentAt || email.createdAt,
        webinarId: registration.webinarId,
        webinarSessionId: email.webinarSessionId,
        status: email.status,
        summary: 'Email-доставка',
      });
    }
    const telegramDeliveries = [
      ['telegram_reminder_24h', 'Напоминание в Telegram за 24 часа', registration.telegramReminder24hSentAt],
      ['telegram_reminder_3h', 'Напоминание в Telegram за 3 часа', registration.telegramReminder3hSentAt],
      ['telegram_reminder_30m', 'Напоминание в Telegram за 30 минут', registration.telegramReminder30mSentAt],
      ['telegram_live', 'Telegram-уведомление о начале', registration.telegramLiveSentAt],
      ['telegram_followup', 'Telegram-сообщение после вебинара', registration.telegramFollowupSentAt],
    ] as const;
    for (const [deliveryType, summary, sentAt] of telegramDeliveries) {
      if (!sentAt) continue;
      addTimelineItem(timeline, {
        id: `${deliveryType}:${registration.id}`,
        type: 'telegram_delivery',
        source: 'registration_notification',
        occurredAt: sentAt,
        webinarId: registration.webinarId,
        webinarSessionId: registration.webinarSessionId,
        status: 'sent',
        summary,
      });
    }
    if (registration.telegramClickedAt) {
      addTimelineItem(timeline, {
        id: `telegram_clicked:${registration.id}`,
        type: 'telegram_clicked',
        source: 'registration_notification',
        occurredAt: registration.telegramClickedAt,
        webinarId: registration.webinarId,
        webinarSessionId: registration.webinarSessionId,
        summary: 'Переход из Telegram',
      });
    }
  }
  for (const progress of progressRows) {
    const percent = progress.durationMs
      ? Math.min(100, Math.round((progress.positionMs / progress.durationMs) * 100))
      : null;
    addTimelineItem(timeline, {
      id: `progress:${progress.id}`,
      type: 'view_progress',
      source: 'viewer_account',
      occurredAt: progress.lastObservedAt,
      webinarId: progress.webinarId,
      webinarSessionId: progress.webinarSessionId,
      status: progress.completedAt ? 'completed' : 'in_progress',
      summary: percent === null ? 'Прогресс просмотра' : `Просмотрено ${percent}%`,
    });
  }
  for (const note of noteRows) {
    addTimelineItem(timeline, {
      id: `note:${note.id}`,
      type: 'viewer_note_created',
      source: 'viewer_account',
      occurredAt: note.createdAt,
      webinarId: note.webinarId,
      webinarSessionId: note.webinarSessionId,
      summary: 'Участник сохранил личную заметку; содержание скрыто',
    });
  }
  timeline.sort(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id),
  );

  return {
    contact: contactProjection(contact, isMaskedRole(context)),
    scoring: scoreDetailProjection(contact),
    tasks: contact.tasks.map(task => taskProjection(task, contact.pipeline.timezone, isMaskedRole(context))),
    deliveries: deliveryOverview.deliveries,
    canSendDeliveries: deliveryOverview.canSend,
    timeline,
    registrations: contact.registrations.map(registration => ({
      id: registration.id,
      webinarId: registration.webinarId,
      webinarTitle: registration.webinar?.title || registration.webinarSession.title,
      sessionId: registration.webinarSessionId,
      scheduledAt: registration.webinarSession.scheduledAt,
      timezone: registration.webinarSession.timezone,
      deliveryEligibility: deliveryOverview.eligibility.find(item => item.registrationId === registration.id) ?? {
        registrationId: registration.id,
        email: { allowed: false, reasonCode: 'crm_delivery_recipient_unavailable' },
        telegram: { allowed: false, reasonCode: 'crm_delivery_recipient_unavailable' },
      },
    })),
  };
}

export async function createCrmTask(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const data = createTaskSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}`);
    const contact = await tx.cRMContact.findFirst({
      where: { id: contactId, organizationId: context.organizationId, archivedAt: null },
      include: { pipeline: { select: { timezone: true } } },
    });
    if (!contact) contactUnavailable();
    const assignee = await requireTaskAssignee(tx, context.organizationId, data.assigneeMembershipId);
    const dueAt = parseTaskLocalDateTime(data.dueLocal, contact.pipeline.timezone);
    const reminderAt = parseTaskLocalDateTime(data.reminderLocal, contact.pipeline.timezone);
    assertReminderOrder(reminderAt, dueAt);

    const task = await tx.cRMTask.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        assigneeMembershipId: assignee.id,
        createdByUserId: context.userId,
        title: data.title,
        description: data.description || null,
        priority: data.priority,
        dueAt,
        reminderAt,
      },
      include: { assigneeMembership: { include: { user: { select: { displayName: true } } } } },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'task_created',
        source: 'tenant_crm',
        sourceEntityType: 'crm_task',
        sourceEntityId: task.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        occurredAt: now,
        metadataJson: {
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
          assigneeMembershipId: task.assigneeMembershipId,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.task.created',
        entityType: 'crm_task',
        entityId: task.id,
        afterJson: {
          contactId: task.contactId,
          assigneeMembershipId: task.assigneeMembershipId,
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
        },
      },
    });
    return taskProjection(task, contact.pipeline.timezone, false);
  });
}

export async function updateCrmTask(
  db: PrismaClient,
  context: TenantContext,
  taskIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const taskId = idSchema.parse(taskIdInput);
  const data = updateTaskSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `task:${taskId}`);
    const existing = await tx.cRMTask.findFirst({
      where: { id: taskId, organizationId: context.organizationId },
      include: {
        contact: { include: { pipeline: { select: { timezone: true } } } },
        assigneeMembership: { include: { user: { select: { displayName: true } } } },
      },
    });
    if (!existing) taskUnavailable();
    const assigneeId = data.assigneeMembershipId || existing.assigneeMembershipId;
    await requireTaskAssignee(tx, context.organizationId, assigneeId);
    const dueAt = data.dueLocal
      ? parseTaskLocalDateTime(data.dueLocal, existing.contact.pipeline.timezone)
      : existing.dueAt;
    const reminderAt = data.reminderLocal
      ? parseTaskLocalDateTime(data.reminderLocal, existing.contact.pipeline.timezone)
      : existing.reminderAt;
    assertReminderOrder(reminderAt, dueAt);
    const status = data.status || existing.status;
    const completedAt = status === 'COMPLETED' ? existing.completedAt || now : null;
    const cancelledAt = status === 'CANCELLED' ? existing.cancelledAt || now : null;

    const task = await tx.cRMTask.update({
      where: { id: existing.id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description || null } : {}),
        ...(data.assigneeMembershipId !== undefined ? { assigneeMembershipId: data.assigneeMembershipId } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        dueAt,
        reminderAt,
        status,
        completedAt,
        cancelledAt,
      },
      include: { assigneeMembership: { include: { user: { select: { displayName: true } } } } },
    });
    const eventType =
      existing.status !== task.status
        ? task.status === 'COMPLETED'
          ? 'task_completed'
          : task.status === 'CANCELLED'
            ? 'task_cancelled'
            : 'task_reopened'
        : 'task_updated';
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: task.contactId,
        type: eventType,
        source: 'tenant_crm',
        sourceEntityType: 'crm_task',
        sourceEntityId: task.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        occurredAt: now,
        metadataJson: {
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
          assigneeMembershipId: task.assigneeMembershipId,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.task.updated',
        entityType: 'crm_task',
        entityId: task.id,
        beforeJson: {
          assigneeMembershipId: existing.assigneeMembershipId,
          title: existing.title,
          priority: existing.priority,
          status: existing.status,
          dueAt: existing.dueAt.toISOString(),
          reminderAt: existing.reminderAt.toISOString(),
        },
        afterJson: {
          assigneeMembershipId: task.assigneeMembershipId,
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueAt: task.dueAt.toISOString(),
          reminderAt: task.reminderAt.toISOString(),
        },
      },
    });
    return taskProjection(task, existing.contact.pipeline.timezone, false);
  });
}

export async function getCrmScoringConfiguration(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, CRM_READ_ROLES);
  const ruleSets = await db.cRMScoringRuleSet.findMany({
    where: { organizationId: context.organizationId },
    include: { rules: true },
    orderBy: { version: 'desc' },
  });
  return {
    active: ruleSets.find(ruleSet => ruleSet.status === 'ACTIVE')
      ? scoringRuleSetProjection(ruleSets.find(ruleSet => ruleSet.status === 'ACTIVE'))
      : null,
    versions: ruleSets.map(scoringRuleSetProjection),
    canManage: context.role === 'OWNER',
  };
}

export async function activateCrmScoringVersion(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_OWNER_ROLES);
  const data = activateScoringVersionSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, 'scoring-model');
    const replay = await tx.cRMScoringRuleSet.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: context.organizationId,
          idempotencyKey: data.idempotencyKey,
        },
      },
      include: { rules: true },
    });
    if (replay) return { ruleSet: scoringRuleSetProjection(replay), replayed: true };

    const [latest, current] = await Promise.all([
      tx.cRMScoringRuleSet.aggregate({
        where: { organizationId: context.organizationId },
        _max: { version: true },
      }),
      tx.cRMScoringRuleSet.findFirst({
        where: { organizationId: context.organizationId, status: 'ACTIVE' },
        include: { rules: true },
      }),
    ]);
    const draft = await tx.cRMScoringRuleSet.create({
      data: {
        organizationId: context.organizationId,
        version: (latest._max.version || 0) + 1,
        name: data.name,
        hotThreshold: data.hotThreshold,
        idempotencyKey: data.idempotencyKey,
        createdByMembershipId: context.membershipId,
        rules: {
          create: configuredScoreRules(data.points).map(rule => ({ ...rule })),
        },
      },
      include: { rules: true },
    });
    if (current) {
      await tx.cRMScoringRuleSet.update({
        where: { id: current.id },
        data: { status: 'ARCHIVED' },
      });
    }
    const active = await tx.cRMScoringRuleSet.update({
      where: { id: draft.id },
      data: { status: 'ACTIVE', activatedAt: now },
      include: { rules: true },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.scoring.version_activated',
        entityType: 'crm_scoring_rule_set',
        entityId: active.id,
        beforeJson: current ? scoringRuleSetProjection(current) : undefined,
        afterJson: scoringRuleSetProjection(active),
      },
    });
    return { ruleSet: scoringRuleSetProjection(active), replayed: false };
  });
}

async function findCrmContactScoreState(tx: CRMTransaction, organizationId: string, contactId: string) {
  return tx.cRMContact.findFirst({
    where: { id: contactId, organizationId },
    include: {
      scoreRuleSet: { include: { rules: true } },
      scoreFactors: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] },
      tags: { include: { tag: true }, orderBy: { assignedAt: 'asc' } },
    },
  });
}

export async function setCrmContactManualHot(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const data = manualHotSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}`);
    const existing = await findCrmContactScoreState(tx, context.organizationId, contactId);
    if (!existing || existing.archivedAt) contactUnavailable();
    const dedupKey = `manual_hot:${data.idempotencyKey}`;
    const replay = await tx.cRMContactEvent.findUnique({
      where: {
        organizationId_dedupKey: {
          organizationId: context.organizationId,
          dedupKey,
        },
      },
    });
    if (replay) {
      if (replay.contactId !== contactId) {
        throw new AppError(409, 'Idempotency key is already used', undefined, 'crm_idempotency_conflict');
      }
      return { scoring: scoreDetailProjection(existing), replayed: true };
    }

    await ensureDefaultCrmScoringRuleSet(tx, context.organizationId, now);
    const manualHot = data.mode === 'AUTOMATIC' ? null : data.mode === 'HOT';
    await tx.cRMContact.update({
      where: { id: existing.id },
      data: {
        manualHot,
        manualHotReason: manualHot === null ? null : data.reason,
        manualHotByMembershipId: manualHot === null ? null : context.membershipId,
        manualHotAt: manualHot === null ? null : now,
        manualHotSource: manualHot === null ? null : 'tenant_crm',
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: existing.id,
        type: 'manual_hot_changed',
        source: 'tenant_crm',
        sourceEntityType: 'crm_contact',
        sourceEntityId: existing.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey,
        occurredAt: now,
        metadataJson: { mode: data.mode, reason: data.reason },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.contact.manual_hot_changed',
        entityType: 'crm_contact',
        entityId: existing.id,
        beforeJson: {
          manualHot: existing.manualHot,
          manualHotReason: existing.manualHotReason,
        },
        afterJson: { mode: data.mode, reason: data.reason },
      },
    });
    const updated = await findCrmContactScoreState(tx, context.organizationId, contactId);
    if (!updated) contactUnavailable();
    return { scoring: scoreDetailProjection(updated), replayed: false };
  });
}

function tagProjection(tag: any) {
  return {
    id: tag.id,
    name: tag.name,
    colorToken: tag.colorToken,
    status: tag.status,
    contactCount: tag._count?.contacts,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

export async function listCrmTags(db: PrismaClient, context: TenantContext, includeArchivedInput: unknown) {
  requireTenantRole(context, CRM_READ_ROLES);
  const includeArchived = z.enum(['true', 'false']).default('false').parse(includeArchivedInput) === 'true';
  const tags = await db.cRMTag.findMany({
    where: {
      organizationId: context.organizationId,
      ...(includeArchived ? {} : { status: 'ACTIVE' as const }),
    },
    include: { _count: { select: { contacts: true } } },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  });
  return {
    tags: tags.map(tagProjection),
    canEdit: CRM_WRITE_ROLES.includes(context.role as (typeof CRM_WRITE_ROLES)[number]),
  };
}

export async function createCrmTag(db: PrismaClient, context: TenantContext, input: unknown) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const data = createTagSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, 'tags');
    const normalizedName = normalizeTagName(data.name);
    const existing = await tx.cRMTag.findUnique({
      where: {
        organizationId_normalizedName: {
          organizationId: context.organizationId,
          normalizedName,
        },
      },
    });
    if (existing) {
      throw new AppError(409, 'CRM tag name already exists', undefined, 'crm_tag_name_conflict');
    }
    const tag = await tx.cRMTag.create({
      data: {
        organizationId: context.organizationId,
        normalizedName,
        name: data.name.replace(/\s+/g, ' '),
        colorToken: data.colorToken,
        createdByMembershipId: context.membershipId,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.tag.created',
        entityType: 'crm_tag',
        entityId: tag.id,
        afterJson: { name: tag.name, colorToken: tag.colorToken, status: tag.status },
      },
    });
    return tagProjection(tag);
  });
}

export async function updateCrmTag(db: PrismaClient, context: TenantContext, tagIdInput: unknown, input: unknown) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const tagId = idSchema.parse(tagIdInput);
  const data = updateTagSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, 'tags');
    const existing = await tx.cRMTag.findFirst({ where: { id: tagId, organizationId: context.organizationId } });
    if (!existing) tagUnavailable();
    const normalizedName = data.name === undefined ? existing.normalizedName : normalizeTagName(data.name);
    const conflict = await tx.cRMTag.findFirst({
      where: { organizationId: context.organizationId, normalizedName, id: { not: existing.id } },
      select: { id: true },
    });
    if (conflict) throw new AppError(409, 'CRM tag name already exists', undefined, 'crm_tag_name_conflict');
    const tag = await tx.cRMTag.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined ? { name: data.name.replace(/\s+/g, ' '), normalizedName } : {}),
        ...(data.colorToken !== undefined ? { colorToken: data.colorToken } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.tag.updated',
        entityType: 'crm_tag',
        entityId: tag.id,
        beforeJson: { name: existing.name, colorToken: existing.colorToken, status: existing.status },
        afterJson: { name: tag.name, colorToken: tag.colorToken, status: tag.status },
      },
    });
    return tagProjection(tag);
  });
}

export async function assignCrmContactTag(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  tagIdInput: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const tagId = idSchema.parse(tagIdInput);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}:tag:${tagId}`);
    const [contact, tag] = await Promise.all([
      tx.cRMContact.findFirst({ where: { id: contactId, organizationId: context.organizationId, archivedAt: null } }),
      tx.cRMTag.findFirst({ where: { id: tagId, organizationId: context.organizationId, status: 'ACTIVE' } }),
    ]);
    if (!contact) contactUnavailable();
    if (!tag) tagUnavailable();
    const existing = await tx.cRMContactTag.findUnique({
      where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
    });
    if (existing) return { assigned: true, replayed: true };
    await tx.cRMContactTag.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        tagId: tag.id,
        assignedByMembershipId: context.membershipId,
        assignedAt: now,
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'tag_assigned',
        source: 'tenant_crm',
        sourceEntityType: 'crm_tag',
        sourceEntityId: tag.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        occurredAt: now,
        metadataJson: { tagId: tag.id, name: tag.name, colorToken: tag.colorToken },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.contact.tag_assigned',
        entityType: 'crm_contact',
        entityId: contact.id,
        afterJson: { tagId: tag.id, name: tag.name },
      },
    });
    return { assigned: true, replayed: false };
  });
}

export async function removeCrmContactTag(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  tagIdInput: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const tagId = idSchema.parse(tagIdInput);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}:tag:${tagId}`);
    const [contact, tag] = await Promise.all([
      tx.cRMContact.findFirst({ where: { id: contactId, organizationId: context.organizationId } }),
      tx.cRMTag.findFirst({ where: { id: tagId, organizationId: context.organizationId } }),
    ]);
    if (!contact) contactUnavailable();
    if (!tag) tagUnavailable();
    const removed = await tx.cRMContactTag.deleteMany({
      where: { organizationId: context.organizationId, contactId: contact.id, tagId: tag.id },
    });
    if (!removed.count) return { assigned: false, replayed: true };
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'tag_removed',
        source: 'tenant_crm',
        sourceEntityType: 'crm_tag',
        sourceEntityId: tag.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        occurredAt: now,
        metadataJson: { tagId: tag.id, name: tag.name },
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.contact.tag_removed',
        entityType: 'crm_contact',
        entityId: contact.id,
        beforeJson: { tagId: tag.id, name: tag.name },
      },
    });
    return { assigned: false, replayed: false };
  });
}

export async function transitionCrmContactStage(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const data = transitionContactStageSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `contact:${contactId}`);
    await lockCrmScope(tx, context.organizationId, `stage:${data.stageId}`);
    const contact = await tx.cRMContact.findFirst({
      where: { id: contactId, organizationId: context.organizationId, archivedAt: null },
      include: { stage: true },
    });
    const target = await tx.cRMStage.findFirst({
      where: { id: data.stageId, organizationId: context.organizationId, status: 'ACTIVE' },
    });
    if (!contact || !target || target.pipelineId !== contact.pipelineId) contactUnavailable();
    if (target.id === contact.stageId) return { changed: false, contact: { id: contact.id, stage: contact.stage } };
    if (target.semanticCategory === 'LOST' && !data.reason) {
      throw new AppError(400, 'Укажите причину потери контакта', undefined, 'crm_lost_reason_required');
    }

    const updated = await tx.cRMContact.update({
      where: { id: contact.id },
      data: { stageId: target.id },
      include: { stage: { select: { id: true, code: true, name: true, semanticCategory: true } } },
    });
    const transition = await tx.cRMStageTransition.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        pipelineId: contact.pipelineId,
        fromStageId: contact.stageId,
        toStageId: target.id,
        actorUserId: context.userId,
        reason: data.reason,
        source: 'tenant_crm',
        correlationId: context.correlationId,
        occurredAt: now,
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        type: 'stage_transition',
        source: 'tenant_crm',
        sourceEntityType: 'crm_stage_transition',
        sourceEntityId: transition.id,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        occurredAt: now,
        metadataJson: { fromStageId: contact.stageId, toStageId: target.id },
      },
    });
    await tx.registration.updateMany({
      where: { organizationId: context.organizationId, crmContactId: contact.id },
      data: { crmStatus: target.code },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.contact.stage_changed',
        entityType: 'crm_contact',
        entityId: contact.id,
        beforeJson: { stageId: contact.stageId, stageCode: contact.stage.code },
        afterJson: { stageId: target.id, stageCode: target.code, reason: data.reason || null },
      },
    });
    return { changed: true, contact: { id: updated.id, stage: updated.stage }, transitionId: transition.id };
  });
}

export async function createCrmStage(db: PrismaClient, context: TenantContext, input: unknown) {
  requireTenantRole(context, CRM_OWNER_ROLES);
  const data = createStageSchema.parse(input);
  return db.$transaction(async tx => {
    const pipeline = await ensureDefaultPipeline(tx, context.organizationId);
    await lockCrmScope(tx, context.organizationId, `pipeline:${pipeline.id}`);
    const maximum = await tx.cRMStage.aggregate({
      where: { organizationId: context.organizationId, pipelineId: pipeline.id },
      _max: { orderIndex: true },
    });
    const code = `custom_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const stage = await tx.cRMStage.create({
      data: {
        organizationId: context.organizationId,
        pipelineId: pipeline.id,
        code,
        name: data.name,
        semanticCategory: data.semanticCategory,
        orderIndex: (maximum._max.orderIndex ?? 0) + 10,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.stage.created',
        entityType: 'crm_stage',
        entityId: stage.id,
        afterJson: { code: stage.code, name: stage.name, semanticCategory: stage.semanticCategory },
      },
    });
    return stage;
  });
}

export async function updateCrmStage(db: PrismaClient, context: TenantContext, stageIdInput: unknown, input: unknown) {
  requireTenantRole(context, CRM_OWNER_ROLES);
  const stageId = idSchema.parse(stageIdInput);
  const data = updateStageSchema.parse(input);
  return db.$transaction(async tx => {
    await lockCrmScope(tx, context.organizationId, `stage:${stageId}`);
    const stage = await tx.cRMStage.findFirst({ where: { id: stageId, organizationId: context.organizationId } });
    if (!stage) stageUnavailable();
    if (stage.isProtected && data.status === 'ARCHIVED') {
      throw new AppError(409, 'Защищённый этап нельзя архивировать', undefined, 'crm_stage_protected');
    }
    if (data.status === 'ARCHIVED') {
      const currentContacts = await tx.cRMContact.count({
        where: { organizationId: context.organizationId, stageId: stage.id, archivedAt: null },
      });
      if (currentContacts > 0) {
        throw new AppError(409, 'Сначала перенесите контакты на другой этап', undefined, 'crm_stage_in_use');
      }
    }
    if (data.position !== undefined) {
      await lockCrmScope(tx, context.organizationId, `pipeline:${stage.pipelineId}`);
      const stages = await tx.cRMStage.findMany({
        where: { organizationId: context.organizationId, pipelineId: stage.pipelineId },
        orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      });
      const reordered = stages.filter(item => item.id !== stage.id);
      reordered.splice(Math.min(data.position, reordered.length), 0, stage);
      await tx.$executeRaw`
        UPDATE "crm_stages"
        SET "order_index" = "order_index" + 100000
        WHERE "organization_id" = ${context.organizationId}
          AND "pipeline_id" = ${stage.pipelineId}
      `;
      for (const [index, item] of reordered.entries()) {
        await tx.cRMStage.update({ where: { id: item.id }, data: { orderIndex: (index + 1) * 10 } });
      }
    }
    const updated = await tx.cRMStage.update({
      where: { id: stage.id },
      data: { name: data.name, status: data.status },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.stage.updated',
        entityType: 'crm_stage',
        entityId: stage.id,
        beforeJson: { name: stage.name, orderIndex: stage.orderIndex, status: stage.status },
        afterJson: { name: updated.name, orderIndex: updated.orderIndex, status: updated.status },
      },
    });
    return updated;
  });
}
