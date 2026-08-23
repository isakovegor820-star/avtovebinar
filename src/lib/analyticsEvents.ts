import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from './http.js';
import { createCorrelationId, getRequestContext } from './requestContext.js';

export const CURRENT_ANALYTICS_SCHEMA_VERSION = 1 as const;
export const LEGACY_ANALYTICS_SCHEMA_VERSION = 0 as const;

export const ANALYTICS_SOURCES = [
  'web',
  'room',
  'replay',
  'registration',
  'crm',
  'email',
  'telegram',
  'worker',
  'system',
  'admin',
] as const;

export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];
type EventScopePolicy = 'platform_or_tenant' | 'tenant' | 'internal';

const idSchema = z.string().trim().min(1).max(191);
const emptyAttributes = z.object({}).strict();
const recordingAttributes = z
  .object({
    recordingId: idSchema.optional(),
    index: z.number().int().min(0).max(10_000).optional(),
    placement: z.enum(['success']).optional(),
    locked: z.boolean().optional(),
  })
  .strict();
const failureAttributes = z.object({ failureCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict();
const registrationAttributes = z.object({ verificationKind: z.enum(['registration', 'login']).optional() }).strict();
const questionAttemptAttributes = z.object({ textLength: z.number().int().min(0).max(4_000) }).strict();
const questionCreatedAttributes = z
  .object({ questionId: idSchema, showToParticipants: z.boolean().optional() })
  .strict();
const partnerClientAttributes = z
  .object({
    clientFlow: z.string().trim().max(160).optional(),
    preferredFormat: z.string().trim().max(160).optional(),
  })
  .strict();
const partnerCreatedAttributes = z.object({ partnerApplicationId: idSchema }).strict();
const heartbeatAttributes = z
  .object({
    intervalNumber: z.number().int().min(0).max(100_000),
    positionSeconds: z.number().min(0).max(86_400).optional(),
    durationSeconds: z.number().positive().max(86_400).optional(),
    intervalSeconds: z.number().positive().max(30).optional(),
    playbackState: z.enum(['playing', 'paused', 'buffering']).optional(),
    visibilityState: z.enum(['visible', 'hidden']).optional(),
  })
  .strict();
const chapterAttributes = z.object({ chapterId: idSchema }).strict();
const transcriptSearchAttributes = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[\p{L}\p{N}\s.,:;!?()«»"'-]+$/u),
  })
  .strict();
const botCommandAttributes = z
  .object({
    command: z
      .string()
      .regex(/^[a-z0-9_:/.-]{1,80}$/)
      .optional(),
    outcome: z
      .string()
      .regex(/^[a-z0-9_:-]{1,80}$/)
      .optional(),
    isRebind: z.boolean().optional(),
    commandEvent: z.boolean().optional(),
  })
  .strict();
const consultantAttributes = z
  .object({
    topic: z.enum(['bankruptcy', 'tax', 'debt', 'partnership', 'webinar_access', 'other']),
    intent: z.enum(['navigation', 'legal_question', 'manager_contact', 'partnership', 'other']),
    urgency: z.enum(['low', 'normal', 'high']),
    handedToHuman: z.boolean(),
    classificationModel: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
    classificationVersion: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  })
  .strict();
const broadcastAttributes = z
  .object({
    jobId: idSchema,
    status: z.enum(['queued', 'completed']).optional(),
    total: z.number().int().min(0).max(1_000_000),
    sent: z.number().int().min(0).max(1_000_000).optional(),
    failed: z.number().int().min(0).max(1_000_000).optional(),
    textLength: z.number().int().min(0).max(10_000).optional(),
    consentDocumentVersion: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,80}$/)
      .optional(),
    initiatedById: idSchema.optional(),
  })
  .strict();

type AnalyticsEventDefinition = {
  scope: EventScopePolicy;
  sources: readonly AnalyticsSource[];
  attributes: z.ZodType<Record<string, unknown>>;
};

const define = (
  scope: EventScopePolicy,
  sources: readonly AnalyticsSource[],
  attributes: z.ZodType<Record<string, unknown>> = emptyAttributes,
): AnalyticsEventDefinition => ({ scope, sources, attributes });

export const ANALYTICS_EVENT_REGISTRY = {
  page_view: define('platform_or_tenant', ['web']),
  registration_click: define('platform_or_tenant', ['web', 'registration']),
  registration_form_open: define('platform_or_tenant', ['web', 'registration']),
  registration_submit: define('platform_or_tenant', ['web', 'registration'], registrationAttributes),
  registration_success: define('tenant', ['registration']),
  telegram_click: define('platform_or_tenant', ['web', 'registration']),
  telegram_subscribe: define('platform_or_tenant', ['web', 'telegram'], botCommandAttributes),
  webinar_room_open: define('tenant', ['room']),
  webinar_room_waiting: define('tenant', ['room']),
  viewer_heartbeat: define('tenant', ['room', 'replay'], heartbeatAttributes),
  video_start: define('tenant', ['room']),
  video_progress_25: define('tenant', ['room']),
  video_progress_50: define('tenant', ['room']),
  video_progress_75: define('tenant', ['room']),
  video_finish: define('tenant', ['room']),
  recordings_open: define('tenant', ['replay']),
  recording_open: define('tenant', ['replay'], recordingAttributes),
  recording_play: define('tenant', ['replay'], recordingAttributes),
  recording_progress_25: define('tenant', ['replay'], recordingAttributes),
  recording_progress_50: define('tenant', ['replay'], recordingAttributes),
  recording_progress_75: define('tenant', ['replay'], recordingAttributes),
  recording_finish: define('tenant', ['replay'], recordingAttributes),
  recording_cta_click: define('tenant', ['replay'], recordingAttributes),
  chapter_open: define('tenant', ['room', 'replay'], chapterAttributes),
  transcript_search: define('tenant', ['room', 'replay'], transcriptSearchAttributes),
  question_submit: define('tenant', ['room'], questionCreatedAttributes),
  question_submit_attempt: define('tenant', ['room'], questionAttemptAttributes),
  question_submitted: define('tenant', ['room']),
  question_submit_error: define('tenant', ['room'], failureAttributes),
  partner_application_submit: define('tenant', ['room'], partnerCreatedAttributes),
  partner_application_submitted: define('tenant', ['room'], partnerClientAttributes),
  partner_application_error: define('tenant', ['room'], failureAttributes),
  partner_form_opened: define('tenant', ['room']),
  partner_request_click: define('tenant', ['room']),
  participant_login_request: define('internal', ['registration']),
  admin_manual_telegram_reminder: define('internal', ['admin']),
  telegram_broadcast: define('internal', ['admin'], broadcastAttributes),
  telegram_news_broadcast: define('internal', ['worker'], broadcastAttributes),
  telegram_broadcast_completed: define('internal', ['worker'], broadcastAttributes),
  telegram_repeat_start: define('internal', ['telegram'], botCommandAttributes),
  telegram_start_without_registration: define('internal', ['telegram'], botCommandAttributes),
  telegram_participant_command: define('internal', ['telegram'], botCommandAttributes),
  telegram_consultant_start: define('internal', ['telegram'], botCommandAttributes),
  telegram_consultant_contact_request: define('internal', ['telegram'], botCommandAttributes),
  telegram_consultant_message: define('internal', ['telegram'], consultantAttributes),
} as const satisfies Record<string, AnalyticsEventDefinition>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENT_REGISTRY;
export type PublicAnalyticsEvent = {
  [Name in AnalyticsEventName]: (typeof ANALYTICS_EVENT_REGISTRY)[Name]['scope'] extends 'internal' ? never : Name;
}[AnalyticsEventName];
export const ANALYTICS_EVENT_NAMES = Object.freeze(Object.keys(ANALYTICS_EVENT_REGISTRY) as AnalyticsEventName[]);

export const PUBLIC_ANALYTICS_EVENTS = Object.freeze(
  ANALYTICS_EVENT_NAMES.filter(
    (name): name is PublicAnalyticsEvent => ANALYTICS_EVENT_REGISTRY[name].scope !== 'internal',
  ),
);

const dedupKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
const pageSchema = z
  .string()
  .trim()
  .max(160)
  .regex(/^\/[^?#]*$/);
const campaignSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[^\r\n]*$/);
const scopeHintSchema = idSchema.optional();

const version1EnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_ANALYTICS_SCHEMA_VERSION),
    eventName: z.string().trim().min(1).max(120),
    source: z.enum(ANALYTICS_SOURCES),
    dedupKey: dedupKeySchema,
    page: pageSchema.optional(),
    clientOccurredAt: z.iso.datetime({ offset: true }).optional(),
    organizationId: scopeHintSchema,
    webinarId: scopeHintSchema,
    webinarSessionId: scopeHintSchema,
    registrationId: scopeHintSchema,
    userId: scopeHintSchema,
    attributes: z.unknown().optional(),
    utmSource: campaignSchema.optional(),
    utmMedium: campaignSchema.optional(),
    utmCampaign: campaignSchema.optional(),
  })
  .strict();

export const ANALYTICS_VERSION_SCHEMAS = Object.freeze({
  [CURRENT_ANALYTICS_SCHEMA_VERSION]: version1EnvelopeSchema,
});

const FORBIDDEN_KEY_PATTERN =
  /(email|phone|telephone|chatid|bottoken|accesstoken|refreshtoken|authorization|cookie|signedurl|storagekey|providersecret|password|requestbody|ipaddress)/;
const FORBIDDEN_EXACT_KEYS = new Set([
  'token',
  'secret',
  'ip',
  'proto',
  'prototype',
  'constructor',
  'clientsproblem',
  'questiontext',
  'message',
  'text',
]);
const FORBIDDEN_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+/i,
  /x-amz-signature=/i,
  /x-goog-signature=/i,
  /[?&](?:token|signature|key)=/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._/-]+$/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\s)\+?\d[\d\s()-]{8,}\d(?:$|\s)/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];

function analyticsValidationError(message: string, field?: string) {
  return new AppError(
    400,
    message,
    field ? { fieldErrors: { [field]: [message] } } : undefined,
    'analytics_validation_failed',
  );
}

function normalizeMetadataKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function validateSafeValue(value: unknown, path: string, depth = 0): void {
  if (depth > 3) throw analyticsValidationError('Analytics attributes are too deeply nested', path);
  if (typeof value === 'string') {
    if (value.length > 500) throw analyticsValidationError('Analytics attribute string is too long', path);
    if (FORBIDDEN_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
      throw analyticsValidationError('Analytics attributes contain sensitive data', path);
    }
    return;
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > 20) throw analyticsValidationError('Analytics attribute array is too large', path);
    value.forEach((item, index) => validateSafeValue(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (typeof value !== 'object') throw analyticsValidationError('Analytics attribute type is not supported', path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw analyticsValidationError('Analytics attributes must be plain JSON', path);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw analyticsValidationError('Analytics attributes contain too many keys', path);
  for (const [key, child] of entries) {
    const normalized = normalizeMetadataKey(key);
    if (['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase())) {
      throw analyticsValidationError('Unsafe analytics attribute key', `${path}.${key}`);
    }
    if (FORBIDDEN_KEY_PATTERN.test(normalized) || FORBIDDEN_EXACT_KEYS.has(normalized)) {
      throw analyticsValidationError('Analytics attributes contain a forbidden key', `${path}.${key}`);
    }
    validateSafeValue(child, `${path}.${key}`, depth + 1);
  }
}

export function validateAnalyticsAttributes(eventName: AnalyticsEventName, raw: unknown) {
  const attributes = raw ?? {};
  let serialized: string;
  try {
    serialized = JSON.stringify(attributes);
  } catch {
    throw analyticsValidationError('Analytics attributes are not serializable', 'attributes');
  }
  if (Buffer.byteLength(serialized, 'utf8') > 4096) {
    throw analyticsValidationError('Analytics attributes exceed 4096 bytes', 'attributes');
  }
  validateSafeValue(attributes, 'attributes');
  const result = ANALYTICS_EVENT_REGISTRY[eventName].attributes.safeParse(attributes);
  if (!result.success) {
    throw analyticsValidationError('Analytics attributes do not match the event schema', 'attributes');
  }
  return result.data;
}

function requireKnownEventName(value: string): AnalyticsEventName {
  if (!Object.prototype.hasOwnProperty.call(ANALYTICS_EVENT_REGISTRY, value)) {
    throw new AppError(400, 'Unknown analytics event type', undefined, 'analytics_event_type_unknown');
  }
  return value as AnalyticsEventName;
}

function validateCampaignValue(value: string | undefined, field: string) {
  if (!value) return undefined;
  if (FORBIDDEN_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
    throw analyticsValidationError('Analytics campaign value contains sensitive data', field);
  }
  return value;
}

export type AnalyticsV1Request = {
  schemaVersion: 1;
  eventName: AnalyticsEventName;
  source: AnalyticsSource;
  dedupKey: string;
  page?: string;
  clientOccurredAt?: Date;
  organizationId?: string;
  webinarId?: string;
  webinarSessionId?: string;
  registrationId?: string;
  userId?: string;
  attributes: Record<string, unknown>;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
};

export function parseAnalyticsV1Request(raw: unknown, now = new Date()): AnalyticsV1Request {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw analyticsValidationError('Analytics payload must be an object');
  }
  const suppliedVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (suppliedVersion !== CURRENT_ANALYTICS_SCHEMA_VERSION) {
    throw new AppError(
      400,
      'Unsupported analytics schema version',
      { supportedVersions: [CURRENT_ANALYTICS_SCHEMA_VERSION] },
      'analytics_schema_version_unsupported',
    );
  }
  const suppliedEventName = (raw as { eventName?: unknown }).eventName;
  if (typeof suppliedEventName === 'string') requireKnownEventName(suppliedEventName);
  const suppliedSource = (raw as { source?: unknown }).source;
  if (typeof suppliedSource === 'string' && !ANALYTICS_SOURCES.includes(suppliedSource as AnalyticsSource)) {
    throw new AppError(400, 'Unknown analytics source', undefined, 'analytics_source_unknown');
  }
  const parsed = version1EnvelopeSchema.parse(raw);
  const eventName = requireKnownEventName(parsed.eventName);
  if (!PUBLIC_ANALYTICS_EVENTS.includes(eventName)) {
    throw new AppError(400, 'Analytics event type is not public', undefined, 'analytics_event_type_unknown');
  }
  const definition = ANALYTICS_EVENT_REGISTRY[eventName];
  if (!definition.sources.includes(parsed.source)) {
    throw new AppError(400, 'Analytics source is not valid for this event', undefined, 'analytics_source_unknown');
  }
  const clientOccurredAt = parsed.clientOccurredAt ? new Date(parsed.clientOccurredAt) : undefined;
  if (clientOccurredAt && Math.abs(clientOccurredAt.getTime() - now.getTime()) > 24 * 60 * 60 * 1000) {
    throw analyticsValidationError('clientOccurredAt must be within 24 hours of server time', 'clientOccurredAt');
  }
  return {
    ...parsed,
    eventName,
    clientOccurredAt,
    attributes: validateAnalyticsAttributes(eventName, parsed.attributes),
    utmSource: validateCampaignValue(parsed.utmSource, 'utmSource'),
    utmMedium: validateCampaignValue(parsed.utmMedium, 'utmMedium'),
    utmCampaign: validateCampaignValue(parsed.utmCampaign, 'utmCampaign'),
  };
}

export const legacyAnalyticsEventSchema = z
  .object({
    eventName: z.string().trim().min(1).max(120),
    page: z.string().trim().max(160).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    source: z.string().trim().max(120).optional().or(z.literal('')),
    utmSource: z.string().trim().max(120).optional().or(z.literal('')),
    utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
    utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
    utmContent: z.string().trim().max(120).optional().or(z.literal('')),
    utmTerm: z.string().trim().max(120).optional().or(z.literal('')),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (!PUBLIC_ANALYTICS_EVENTS.includes(payload.eventName as AnalyticsEventName)) {
      ctx.addIssue({ code: 'custom', path: ['eventName'], message: 'Unknown legacy analytics event type' });
    }
    if (payload.metadata) {
      try {
        if (Object.keys(payload.metadata).length > 20) throw new Error('keys');
        if (Buffer.byteLength(JSON.stringify(payload.metadata), 'utf8') > 4096) throw new Error('bytes');
        validateSafeValue(payload.metadata, 'metadata');
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['metadata'],
          message:
            error instanceof Error && error.message === 'keys'
              ? 'metadata must contain at most 20 keys'
              : error instanceof Error && error.message === 'bytes'
                ? 'metadata must be at most 4096 bytes'
                : 'metadata contains unsafe or sensitive data',
        });
      }
    }
  });

export function adaptLegacyAnalyticsAttributes(
  eventName: AnalyticsEventName,
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) return {};
  if (eventName === 'question_submit_error' || eventName === 'partner_application_error') {
    return { failureCode: 'legacy_client_error' };
  }
  if (eventName === 'recording_cta_click') {
    return {
      recordingId: typeof metadata.recordingId === 'string' ? metadata.recordingId : undefined,
      index: typeof metadata.index === 'number' ? metadata.index : undefined,
      placement: metadata.source === 'success' ? 'success' : undefined,
      locked: typeof metadata.locked === 'boolean' ? metadata.locked : undefined,
    };
  }
  if (eventName.startsWith('recording_')) {
    return {
      recordingId: typeof metadata.recordingId === 'string' ? metadata.recordingId : undefined,
      index: typeof metadata.index === 'number' ? metadata.index : undefined,
    };
  }
  if (eventName === 'question_submit_attempt') {
    return { textLength: typeof metadata.textLength === 'number' ? metadata.textLength : 0 };
  }
  if (eventName === 'partner_application_submitted') {
    return {
      clientFlow: typeof metadata.clientFlow === 'string' ? metadata.clientFlow : undefined,
      preferredFormat: typeof metadata.preferredFormat === 'string' ? metadata.preferredFormat : undefined,
    };
  }
  return {};
}

type AnalyticsDb = Pick<
  PrismaClient,
  '$queryRaw' | 'event' | 'organization' | 'organizationMembership' | 'webinar' | 'webinarSession' | 'registration'
>;

type ScopeHints = Pick<
  AnalyticsV1Request,
  'organizationId' | 'webinarId' | 'webinarSessionId' | 'registrationId' | 'userId'
>;

export type AnalyticsScopeInput =
  | { kind: 'platform' }
  | {
      kind: 'participant';
      trustedRegistrationId: string;
      effectiveWebinarSessionId?: string;
      hints?: ScopeHints;
      identifiable?: boolean;
    }
  | {
      kind: 'trusted';
      organizationId?: string;
      webinarId?: string;
      webinarSessionId?: string;
      registrationId?: string;
      userId?: string;
    };

type ResolvedScope = {
  scopeKind: 'platform' | 'tenant';
  organizationId: string | null;
  webinarId: string | null;
  webinarSessionId: string | null;
  registrationId: string | null;
  leadId: string | null;
  userId: string | null;
};

function scopeNotFound(): never {
  throw new AppError(404, 'Analytics scope not found', undefined, 'analytics_scope_not_found');
}

function assertHintsMatch(hints: ScopeHints | undefined, scope: ResolvedScope) {
  if (!hints) return;
  for (const key of ['organizationId', 'webinarId', 'webinarSessionId', 'registrationId', 'userId'] as const) {
    if (hints[key] !== undefined && hints[key] !== scope[key]) scopeNotFound();
  }
}

async function resolveParticipantScope(
  db: AnalyticsDb,
  input: Extract<AnalyticsScopeInput, { kind: 'participant' }>,
): Promise<ResolvedScope> {
  const registration = await db.registration.findFirst({
    where: {
      id: input.trustedRegistrationId,
      status: 'registered',
      emailVerifiedAt: { not: null },
    },
    include: { webinarSession: true },
  });
  if (!registration) scopeNotFound();
  const effectiveSessionId = input.effectiveWebinarSessionId ?? registration.webinarSessionId;
  const session =
    effectiveSessionId === registration.webinarSessionId
      ? registration.webinarSession
      : await db.webinarSession.findFirst({
          where: {
            id: effectiveSessionId,
            organizationId: registration.webinarSession.organizationId,
            webinarId: registration.webinarSession.webinarId,
            lifecycleStatus: { not: 'CANCELLED' },
          },
        });
  if (!session) scopeNotFound();
  const exactRegistrationSession = session.id === registration.webinarSessionId;
  const identifiable = input.identifiable !== false;
  const scope: ResolvedScope = {
    scopeKind: 'tenant',
    organizationId: session.organizationId,
    webinarId: session.webinarId,
    webinarSessionId: session.id,
    registrationId: identifiable && exactRegistrationSession ? registration.id : null,
    leadId: identifiable && exactRegistrationSession ? registration.leadId : null,
    userId: identifiable && exactRegistrationSession ? registration.userId : null,
  };
  assertHintsMatch(
    input.hints,
    identifiable
      ? scope
      : {
          ...scope,
          registrationId: exactRegistrationSession ? registration.id : null,
          userId: exactRegistrationSession ? registration.userId : null,
        },
  );
  return scope;
}

async function resolveTrustedScope(
  db: AnalyticsDb,
  input: Extract<AnalyticsScopeInput, { kind: 'trusted' }>,
): Promise<ResolvedScope> {
  if (input.registrationId) {
    const registration = await db.registration.findUnique({
      where: { id: input.registrationId },
      include: { webinarSession: true },
    });
    if (!registration) scopeNotFound();
    if (
      (input.organizationId && input.organizationId !== registration.webinarSession.organizationId) ||
      (input.webinarId && input.webinarId !== registration.webinarSession.webinarId) ||
      (input.webinarSessionId && input.webinarSessionId !== registration.webinarSessionId) ||
      (input.userId && input.userId !== registration.userId)
    ) {
      scopeNotFound();
    }
    return {
      scopeKind: 'tenant',
      organizationId: registration.webinarSession.organizationId,
      webinarId: registration.webinarSession.webinarId,
      webinarSessionId: registration.webinarSessionId,
      registrationId: registration.id,
      leadId: registration.leadId,
      userId: registration.userId,
    };
  }
  if (input.webinarSessionId) {
    const session = await db.webinarSession.findFirst({
      where: {
        id: input.webinarSessionId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.webinarId ? { webinarId: input.webinarId } : {}),
      },
    });
    if (!session) scopeNotFound();
    if (input.userId) await assertTrustedUserTenant(db, input.userId, session.organizationId);
    return {
      scopeKind: 'tenant',
      organizationId: session.organizationId,
      webinarId: session.webinarId,
      webinarSessionId: session.id,
      registrationId: null,
      leadId: null,
      userId: input.userId ?? null,
    };
  }
  if (input.webinarId) {
    if (!input.organizationId) scopeNotFound();
    const webinar = await db.webinar.findFirst({
      where: { id: input.webinarId, organizationId: input.organizationId },
    });
    if (!webinar) scopeNotFound();
    if (input.userId) await assertTrustedUserTenant(db, input.userId, webinar.organizationId);
    return {
      scopeKind: 'tenant',
      organizationId: webinar.organizationId,
      webinarId: webinar.id,
      webinarSessionId: null,
      registrationId: null,
      leadId: null,
      userId: input.userId ?? null,
    };
  }
  if (input.organizationId) {
    const organization = await db.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    });
    if (!organization) scopeNotFound();
    if (input.userId) await assertTrustedUserTenant(db, input.userId, organization.id);
    return {
      scopeKind: 'tenant',
      organizationId: organization.id,
      webinarId: null,
      webinarSessionId: null,
      registrationId: null,
      leadId: null,
      userId: input.userId ?? null,
    };
  }
  return {
    scopeKind: 'platform',
    organizationId: null,
    webinarId: null,
    webinarSessionId: null,
    registrationId: null,
    leadId: null,
    userId: null,
  };
}

async function assertTrustedUserTenant(db: AnalyticsDb, userId: string, organizationId: string) {
  const membership = await db.organizationMembership.findFirst({
    where: {
      organizationId,
      userId,
      status: 'ACTIVE',
      user: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!membership) scopeNotFound();
}

async function resolveAnalyticsScope(db: AnalyticsDb, input: AnalyticsScopeInput): Promise<ResolvedScope> {
  if (input.kind === 'platform') {
    return {
      scopeKind: 'platform',
      organizationId: null,
      webinarId: null,
      webinarSessionId: null,
      registrationId: null,
      leadId: null,
      userId: null,
    };
  }
  return input.kind === 'participant' ? resolveParticipantScope(db, input) : resolveTrustedScope(db, input);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value: unknown) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function safeAnalyticsFailureCode(error: unknown) {
  if (error instanceof AppError && error.code?.startsWith('analytics_')) return error.code;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `analytics_database_${error.code.toLowerCase()}`;
  }
  return 'analytics_write_failed';
}

export type RecordAnalyticsEventInput = {
  eventName: AnalyticsEventName;
  source: AnalyticsSource;
  dedupKey: string;
  correlationId?: string;
  scope: AnalyticsScopeInput;
  attributes?: unknown;
  page?: string | null;
  visitorId?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  clientOccurredAt?: Date | null;
};

export async function recordAnalyticsEvent(db: AnalyticsDb, input: RecordAnalyticsEventInput) {
  const definition = ANALYTICS_EVENT_REGISTRY[input.eventName];
  if (!definition.sources.includes(input.source)) {
    throw new AppError(400, 'Analytics source is not valid for this event', undefined, 'analytics_source_unknown');
  }
  const dedupKey = dedupKeySchema.parse(input.dedupKey);
  const attributes = validateAnalyticsAttributes(input.eventName, input.attributes);
  if (input.page && !pageSchema.safeParse(input.page).success) {
    throw analyticsValidationError('Analytics page is invalid', 'page');
  }
  const utmSource = validateCampaignValue(input.utmSource ?? undefined, 'utmSource') ?? null;
  const utmMedium = validateCampaignValue(input.utmMedium ?? undefined, 'utmMedium') ?? null;
  const utmCampaign = validateCampaignValue(input.utmCampaign ?? undefined, 'utmCampaign') ?? null;
  const scope = await resolveAnalyticsScope(db, input.scope);
  if (definition.scope === 'tenant' && scope.scopeKind !== 'tenant') scopeNotFound();
  const correlationId = input.correlationId ?? getRequestContext()?.correlationId ?? createCorrelationId('analytics');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(correlationId)) {
    throw analyticsValidationError('Correlation ID is invalid', 'correlationId');
  }
  const payloadHash = hashPayload({
    schemaVersion: CURRENT_ANALYTICS_SCHEMA_VERSION,
    eventName: input.eventName,
    source: input.source,
    scope,
    attributes,
    page: input.page ?? null,
    utmSource,
    utmMedium,
    utmCampaign,
    clientOccurredAt: input.clientOccurredAt?.toISOString() ?? null,
  });
  const metadataJson = Object.keys(attributes).length ? JSON.stringify(attributes) : null;
  const clientOccurredAtSql = input.clientOccurredAt
    ? Prisma.sql`${input.clientOccurredAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'`
    : Prisma.sql`NULL`;
  const createdRows = await db.$queryRaw<Array<{ occurredAt: Date; correlationId: string }>>(Prisma.sql`
    INSERT INTO "events" (
      "id", "schema_version", "scope_kind", "event_name", "source",
      "dedup_key", "payload_hash", "correlation_id",
      "organization_id", "webinar_id", "webinar_session_id",
      "registration_id", "lead_id", "user_id", "visitor_id",
      "page", "user_agent", "ip_hash",
      "utm_source", "utm_medium", "utm_campaign", "metadata_json", "client_occurred_at"
    ) VALUES (
      ${`event_${crypto.randomUUID()}`}, ${CURRENT_ANALYTICS_SCHEMA_VERSION}, ${scope.scopeKind}, ${input.eventName}, ${input.source},
      ${dedupKey}, ${payloadHash}, ${correlationId},
      ${scope.organizationId}, ${scope.webinarId}, ${scope.webinarSessionId},
      ${scope.registrationId}, ${scope.leadId}, ${scope.userId}, ${input.visitorId ?? null},
      ${input.page ?? null}, ${input.userAgent ?? null}, ${input.ipHash ?? null},
      ${utmSource}, ${utmMedium}, ${utmCampaign}, ${metadataJson}::jsonb, ${clientOccurredAtSql}
    )
    ON CONFLICT DO NOTHING
    RETURNING "occurred_at" AS "occurredAt", "correlation_id" AS "correlationId"
  `);
  const created = createdRows[0];
  if (created) {
    return { created: true, replayed: false, occurredAt: created.occurredAt, correlationId: created.correlationId! };
  }
  const existing = await db.event.findFirst({
    where: {
      schemaVersion: CURRENT_ANALYTICS_SCHEMA_VERSION,
      scopeKind: scope.scopeKind,
      organizationId: scope.organizationId,
      dedupKey,
    },
    select: { payloadHash: true, occurredAt: true, correlationId: true },
  });
  if (!existing) throw new Error('analytics_conflict_winner_not_visible');
  if (existing.payloadHash !== payloadHash) {
    throw new AppError(
      409,
      'Analytics idempotency key conflicts with another payload',
      undefined,
      'analytics_idempotency_conflict',
    );
  }
  return {
    created: false,
    replayed: true,
    occurredAt: existing.occurredAt,
    correlationId: existing.correlationId ?? correlationId,
  };
}

export function buildServerDedupKey(eventName: AnalyticsEventName, logicalKey: string) {
  const digest = crypto.createHash('sha256').update(`${eventName}\0${logicalKey}`).digest('hex').slice(0, 40);
  return `srv:${eventName}:${digest}`;
}
