import crypto from 'node:crypto';
import type {
  OrganizationMembershipRole,
  Prisma,
  PrismaClient,
  WebinarContentStatus,
  WebinarSourceType,
} from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { getSessionLifecycleStatus } from '../sessionScheduling.js';
import { assertAuthorCanPublish } from './authorVerification.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const;
const WEBINAR_SLUG_LOCK_NAMESPACE = 7_106_009_021n;
const WEBINAR_COMMAND_LOCK_NAMESPACE = 7_106_009_022n;
const EDITABLE_CONTENT_STATUSES: WebinarContentStatus[] = ['DRAFT', 'NEEDS_REVIEW'];

const idSchema = z.string().trim().min(1).max(191);
const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must contain lowercase latin letters, digits and hyphens only');
const nullableText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).nullable();
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date')
  .transform(value => new Date(`${value}T00:00:00.000Z`));

const practiceAreaInputSchema = z
  .array(
    z
      .object({
        practiceAreaId: idSchema,
        isPrimary: z.boolean(),
      })
      .strict(),
  )
  .max(20)
  .superRefine((items, context) => {
    if (new Set(items.map(item => item.practiceAreaId)).size !== items.length) {
      context.addIssue({ code: 'custom', message: 'Practice areas must be unique' });
    }
    if (items.length > 0 && items.filter(item => item.isPrimary).length !== 1) {
      context.addIssue({ code: 'custom', message: 'Exactly one primary practice area is required' });
    }
  });

const webinarFieldsSchema = {
  title: z.string().trim().min(3).max(240),
  slug: slugSchema,
  description: nullableText(20, 10_000),
  outcomeDescription: nullableText(10, 2_000),
  jurisdictionId: idSchema.nullable(),
  practiceAreas: practiceAreaInputSchema,
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']),
  freshnessStatus: z.enum(['CURRENT', 'REVIEW_DUE', 'OUTDATED', 'SUPERSEDED', 'UNKNOWN']),
  audienceLevel: z.enum(['INTRODUCTORY', 'PRACTITIONER', 'ADVANCED', 'ALL_LEVELS']).nullable(),
  targetAudience: nullableText(2, 1_000),
  format: z.enum(['RECORDED', 'PREMIERE', 'ON_DEMAND']).nullable(),
  durationMinutes: z.number().int().min(1).max(180).nullable(),
  language: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  currentAsOf: dateOnlySchema.nullable(),
  reviewDueAt: dateOnlySchema.nullable(),
  disclaimer: nullableText(20, 2_000),
  syntheticDisclosure: nullableText(10, 2_000),
  supersededByWebinarId: idSchema.nullable(),
} as const;

export const creatorWebinarCreateSchema = z
  .object({
    title: webinarFieldsSchema.title,
    slug: webinarFieldsSchema.slug,
    description: webinarFieldsSchema.description.optional(),
    outcomeDescription: webinarFieldsSchema.outcomeDescription.optional(),
    jurisdictionId: webinarFieldsSchema.jurisdictionId.optional(),
    practiceAreas: webinarFieldsSchema.practiceAreas.optional(),
    visibility: webinarFieldsSchema.visibility.optional(),
    freshnessStatus: webinarFieldsSchema.freshnessStatus.optional(),
    audienceLevel: webinarFieldsSchema.audienceLevel.optional(),
    targetAudience: webinarFieldsSchema.targetAudience.optional(),
    format: webinarFieldsSchema.format.optional(),
    durationMinutes: webinarFieldsSchema.durationMinutes.optional(),
    language: webinarFieldsSchema.language.optional(),
    currentAsOf: webinarFieldsSchema.currentAsOf.optional(),
    reviewDueAt: webinarFieldsSchema.reviewDueAt.optional(),
    disclaimer: webinarFieldsSchema.disclaimer.optional(),
    syntheticDisclosure: webinarFieldsSchema.syntheticDisclosure.optional(),
    supersededByWebinarId: webinarFieldsSchema.supersededByWebinarId.optional(),
  })
  .strict();

export const creatorWebinarUpdateSchema = z
  .object({
    title: webinarFieldsSchema.title.optional(),
    slug: webinarFieldsSchema.slug.optional(),
    description: webinarFieldsSchema.description.optional(),
    outcomeDescription: webinarFieldsSchema.outcomeDescription.optional(),
    jurisdictionId: webinarFieldsSchema.jurisdictionId.optional(),
    practiceAreas: webinarFieldsSchema.practiceAreas.optional(),
    visibility: webinarFieldsSchema.visibility.optional(),
    freshnessStatus: webinarFieldsSchema.freshnessStatus.optional(),
    audienceLevel: webinarFieldsSchema.audienceLevel.optional(),
    targetAudience: webinarFieldsSchema.targetAudience.optional(),
    format: webinarFieldsSchema.format.optional(),
    durationMinutes: webinarFieldsSchema.durationMinutes.optional(),
    language: webinarFieldsSchema.language.optional(),
    currentAsOf: webinarFieldsSchema.currentAsOf.optional(),
    reviewDueAt: webinarFieldsSchema.reviewDueAt.optional(),
    disclaimer: webinarFieldsSchema.disclaimer.optional(),
    syntheticDisclosure: webinarFieldsSchema.syntheticDisclosure.optional(),
    supersededByWebinarId: webinarFieldsSchema.supersededByWebinarId.optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'At least one webinar field is required');

export const creatorWebinarListSchema = z
  .object({
    status: z.enum(['DRAFT', 'NEEDS_REVIEW', 'READY', 'IN_MODERATION', 'PUBLISHED', 'ARCHIVED']).optional(),
    cursor: idSchema.optional(),
  })
  .strict();

export const webinarSourceCreateSchema = z
  .object({
    type: z.enum([
      'REGULATION',
      'STATUTE_PROVISION',
      'COURT_DECISION',
      'OFFICIAL_GUIDANCE',
      'OFFICIAL_SOURCE',
      'TEMPLATE_OR_CHECKLIST',
      'OTHER',
    ]),
    title: z.string().trim().min(2).max(500),
    url: z
      .string()
      .trim()
      .url()
      .max(2_000)
      .refine(value => new URL(value).protocol === 'https:', 'HTTPS is required'),
    accessedAt: dateOnlySchema.nullable().optional(),
    note: nullableText(1, 4_000).optional(),
    orderIndex: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(191)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const webinarIdSchema = idSchema;
export const webinarSourceIdSchema = idSchema;
export const duplicateCreatorWebinarSchema = z
  .object({
    slug: slugSchema.optional(),
    title: z.string().trim().min(3).max(240).optional(),
  })
  .strict();

const webinarInclude = {
  authorProfile: {
    select: { id: true, slug: true, publicName: true, verificationStatus: true, userId: true },
  },
  jurisdiction: { select: { id: true, code: true, name: true, status: true } },
  practiceAreas: {
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
    include: { practiceArea: { select: { id: true, parentId: true, slug: true, name: true, status: true } } },
  },
  sources: { orderBy: [{ orderIndex: 'asc' as const }, { createdAt: 'asc' as const }] },
  currentMediaAsset: {
    select: {
      id: true,
      version: true,
      status: true,
      progressPercent: true,
      originalFileName: true,
      durationSeconds: true,
      failureCode: true,
      readyAt: true,
      updatedAt: true,
    },
  },
  sessions: {
    orderBy: [{ scheduledAt: 'asc' as const }],
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      timezone: true,
      lifecycleStatus: true,
      durationMinutes: true,
      roomOpenBeforeMinutes: true,
      replayAvailableHours: true,
      replayEnabled: true,
    },
  },
} satisfies Prisma.WebinarInclude;

type WebinarWithRelations = Prisma.WebinarGetPayload<{ include: typeof webinarInclude }>;
type CreatorTransaction = Prisma.TransactionClient;

function webinarUnavailable(): never {
  throw new AppError(404, 'Вебинар не найден', undefined, 'webinar_not_found');
}

function sourceUnavailable(): never {
  throw new AppError(404, 'Источник не найден', undefined, 'webinar_source_not_found');
}

function webinarProjection(webinar: WebinarWithRelations) {
  return {
    id: webinar.id,
    slug: webinar.slug,
    title: webinar.title,
    description: webinar.description,
    outcomeDescription: webinar.outcomeDescription,
    contentStatus: webinar.contentStatus,
    visibility: webinar.visibility,
    freshnessStatus: webinar.freshnessStatus,
    audienceLevel: webinar.audienceLevel,
    targetAudience: webinar.targetAudience,
    format: webinar.format,
    durationMinutes: webinar.durationMinutes,
    language: webinar.language,
    currentAsOf: webinar.currentAsOf?.toISOString().slice(0, 10) ?? null,
    reviewDueAt: webinar.reviewDueAt?.toISOString().slice(0, 10) ?? null,
    disclaimer: webinar.disclaimer,
    syntheticDisclosure: webinar.syntheticDisclosure,
    mediaStatus: webinar.mediaStatus,
    currentMediaAsset: webinar.currentMediaAsset,
    transcriptStatus: webinar.transcriptStatus,
    scenarioStatus: webinar.scenarioStatus,
    contentVersion: webinar.contentVersion,
    supersededByWebinarId: webinar.supersededByWebinarId,
    legacyCompatibility: webinar.legacyCompatibility,
    publishedAt: webinar.publishedAt,
    archivedAt: webinar.archivedAt,
    createdAt: webinar.createdAt,
    updatedAt: webinar.updatedAt,
    author: webinar.authorProfile
      ? {
          id: webinar.authorProfile.id,
          slug: webinar.authorProfile.slug,
          publicName: webinar.authorProfile.publicName,
          verificationStatus: webinar.authorProfile.verificationStatus,
        }
      : null,
    jurisdiction: webinar.jurisdiction,
    practiceAreas: webinar.practiceAreas.map(item => ({
      ...item.practiceArea,
      isPrimary: item.isPrimary,
    })),
    sources: webinar.sources.map(source => ({
      id: source.id,
      type: source.type,
      title: source.title,
      url: source.url,
      accessedAt: source.accessedAt?.toISOString().slice(0, 10) ?? null,
      note: source.note,
      orderIndex: source.orderIndex,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    })),
    sessions: webinar.sessions.map(session => ({
      ...session,
      lifecycleStatus: getSessionLifecycleStatus(session),
    })),
  };
}

async function requireCurrentCreatorMembership(
  db: Pick<PrismaClient, 'organizationMembership'>,
  context: TenantContext,
): Promise<OrganizationMembershipRole> {
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

function scopedWebinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId?: string) {
  return {
    ...(webinarId ? { id: webinarId } : {}),
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

async function findScopedWebinar(
  db: Pick<PrismaClient, 'webinar'>,
  context: TenantContext,
  role: OrganizationMembershipRole,
  webinarId: string,
) {
  const webinar = await db.webinar.findFirst({
    where: scopedWebinarWhere(context, role, webinarId),
    include: webinarInclude,
  });
  if (!webinar) webinarUnavailable();
  return webinar;
}

async function lockWebinar(tx: CreatorTransaction, context: TenantContext, webinarId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "webinars"
    WHERE "id" = ${webinarId} AND "organization_id" = ${context.organizationId}
    FOR UPDATE
  `;
  if (locked.length !== 1) webinarUnavailable();
}

async function lockSlugScope(tx: CreatorTransaction, organizationId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, ${WEBINAR_SLUG_LOCK_NAMESPACE}))
  `;
}

async function assertSlugAvailable(
  tx: CreatorTransaction,
  organizationId: string,
  slug: string,
  currentWebinarId?: string,
) {
  const [current, alias] = await Promise.all([
    tx.webinar.findFirst({
      where: { organizationId, slug, ...(currentWebinarId ? { id: { not: currentWebinarId } } : {}) },
      select: { id: true },
    }),
    tx.webinarSlugAlias.findFirst({
      where: { organizationId, slug },
      select: { webinarId: true },
    }),
  ]);
  if (current || (alias && alias.webinarId !== currentWebinarId)) {
    throw new AppError(409, 'Этот slug уже используется', undefined, 'webinar_slug_conflict');
  }
  return alias;
}

async function validateReferences(
  tx: CreatorTransaction,
  context: TenantContext,
  input: {
    jurisdictionId?: string | null;
    practiceAreas?: Array<{ practiceAreaId: string; isPrimary: boolean }>;
    supersededByWebinarId?: string | null;
  },
  currentWebinarId?: string,
) {
  if (input.jurisdictionId) {
    const jurisdiction = await tx.jurisdiction.findFirst({
      where: { id: input.jurisdictionId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!jurisdiction) {
      throw new AppError(400, 'Юрисдикция недоступна', undefined, 'webinar_reference_invalid');
    }
  }

  if (input.practiceAreas) {
    const ids = input.practiceAreas.map(item => item.practiceAreaId);
    const count = await tx.legalPracticeArea.count({ where: { id: { in: ids }, status: 'ACTIVE' } });
    if (count !== ids.length) {
      throw new AppError(400, 'Одна или несколько отраслей недоступны', undefined, 'webinar_reference_invalid');
    }
  }

  if (input.supersededByWebinarId) {
    if (input.supersededByWebinarId === currentWebinarId) {
      throw new AppError(400, 'Вебинар не может заменять сам себя', undefined, 'webinar_reference_invalid');
    }
    const successor = await tx.webinar.findFirst({
      where: {
        id: input.supersededByWebinarId,
        organizationId: context.organizationId,
        contentStatus: 'PUBLISHED',
      },
      select: { id: true },
    });
    if (!successor) {
      throw new AppError(400, 'Актуальная версия вебинара недоступна', undefined, 'webinar_reference_invalid');
    }
  }
}

async function replacePracticeAreas(
  tx: CreatorTransaction,
  organizationId: string,
  webinarId: string,
  areas: Array<{ practiceAreaId: string; isPrimary: boolean }>,
) {
  await tx.webinarPracticeArea.deleteMany({ where: { webinarId, organizationId } });
  if (areas.length > 0) {
    await tx.webinarPracticeArea.createMany({
      data: areas.map(area => ({ webinarId, organizationId, ...area })),
    });
  }
}

function auditSnapshot(webinar: WebinarWithRelations) {
  return {
    slug: webinar.slug,
    contentStatus: webinar.contentStatus,
    visibility: webinar.visibility,
    contentVersion: webinar.contentVersion,
    freshnessStatus: webinar.freshnessStatus,
    currentAsOf: webinar.currentAsOf?.toISOString().slice(0, 10) ?? null,
    reviewDueAt: webinar.reviewDueAt?.toISOString().slice(0, 10) ?? null,
    updatedAt: webinar.updatedAt.toISOString(),
  };
}

function defaultReviewDueAt(currentAsOf: Date) {
  const due = new Date(currentAsOf);
  due.setUTCDate(due.getUTCDate() + 180);
  return due;
}

function assertFreshnessDates(currentAsOf: Date | null | undefined, reviewDueAt: Date | null | undefined) {
  if (reviewDueAt && (!currentAsOf || reviewDueAt <= currentAsOf)) {
    throw new AppError(
      400,
      'Дата повторной проверки должна быть позже даты актуальности',
      undefined,
      'webinar_review_due_invalid',
    );
  }
}

async function createWebinarAudit(
  tx: CreatorTransaction,
  context: TenantContext,
  action: string,
  webinarId: string,
  beforeJson: Prisma.InputJsonValue | undefined,
  afterJson: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: {
      userId: context.userId,
      organizationId: context.organizationId,
      correlationId: context.correlationId,
      action,
      entityType: 'webinar',
      entityId: webinarId,
      beforeJson,
      afterJson,
    },
  });
}

export async function listCreatorWebinars(db: PrismaClient, context: TenantContext, queryInput: unknown) {
  const query = creatorWebinarListSchema.parse(queryInput);
  const role = await requireCurrentCreatorMembership(db, context);
  const rows = await db.webinar.findMany({
    where: { ...scopedWebinarWhere(context, role), ...(query.status ? { contentStatus: query.status } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 51,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: webinarInclude,
  });
  const page = rows.slice(0, 50);
  return {
    items: page.map(webinarProjection),
    nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getCreatorWebinar(db: PrismaClient, context: TenantContext, webinarIdInput: unknown) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const role = await requireCurrentCreatorMembership(db, context);
  return webinarProjection(await findScopedWebinar(db, context, role, webinarId));
}

export async function createCreatorWebinar(db: PrismaClient, context: TenantContext, input: unknown) {
  const data = creatorWebinarCreateSchema.parse(input);
  return db.$transaction(async tx => {
    await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const authorProfile = await tx.authorProfile.findFirst({
      where: { organizationId: context.organizationId, userId: context.userId },
      select: { id: true },
    });
    if (!authorProfile) {
      throw new AppError(409, 'Сначала создайте профиль автора', undefined, 'author_profile_required');
    }
    await lockSlugScope(tx, context.organizationId);
    await assertSlugAvailable(tx, context.organizationId, data.slug);
    await validateReferences(tx, context, data);
    const { practiceAreas = [], ...webinarData } = data;
    const reviewDueAt =
      data.reviewDueAt === undefined && data.currentAsOf ? defaultReviewDueAt(data.currentAsOf) : data.reviewDueAt;
    assertFreshnessDates(data.currentAsOf, reviewDueAt);
    const created = await tx.webinar.create({
      data: {
        organizationId: context.organizationId,
        authorProfileId: authorProfile.id,
        ...webinarData,
        ...(reviewDueAt !== undefined ? { reviewDueAt } : {}),
      },
      include: webinarInclude,
    });
    await replacePracticeAreas(tx, context.organizationId, created.id, practiceAreas);
    const webinar = await tx.webinar.findUniqueOrThrow({ where: { id: created.id }, include: webinarInclude });
    await createWebinarAudit(tx, context, 'webinar.created', webinar.id, undefined, auditSnapshot(webinar));
    return webinarProjection(webinar);
  });
}

function canonicalCommandPayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalCommandPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalCommandPayload(item)]),
    );
  }
  return value;
}

function commandPayloadFingerprint(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalCommandPayload(value)))
    .digest('hex');
}

export async function updateCreatorWebinar(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
  idempotencyKeyInput?: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const data = creatorWebinarUpdateSchema.parse(input);
  const updateIdempotencyKey =
    idempotencyKeyInput === undefined ? undefined : idempotencyKeySchema.parse(idempotencyKeyInput);
  const updateFingerprint = commandPayloadFingerprint(data);
  return db.$transaction(async tx => {
    if (updateIdempotencyKey) {
      await lockCommandScope(tx, context.organizationId, 'metadata_update', updateIdempotencyKey);
      const prior = await tx.creatorMetadataIdempotencyRecord.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: context.organizationId,
            idempotencyKey: updateIdempotencyKey,
          },
        },
        select: { webinarId: true, requestHash: true },
      });
      if (prior) {
        if (prior.webinarId !== webinarId) {
          throw new AppError(409, 'Idempotency key уже использован', undefined, 'idempotency_key_reused');
        }
        if (prior.requestHash !== updateFingerprint) {
          throw new AppError(
            409,
            'Idempotency key использован с другими данными',
            undefined,
            'idempotency_payload_mismatch',
          );
        }
        const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
        const replay = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
        return webinarProjection(replay);
      }
    }
    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const before = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (!EDITABLE_CONTENT_STATUSES.includes(before.contentStatus)) {
      throw new AppError(409, 'Вебинар нельзя редактировать в текущем статусе', undefined, 'webinar_not_editable');
    }
    await validateReferences(tx, context, data, webinarId);
    const effectiveCurrentAsOf = data.currentAsOf === undefined ? before.currentAsOf : data.currentAsOf;
    const effectiveReviewDueAt =
      data.reviewDueAt !== undefined
        ? data.reviewDueAt
        : data.currentAsOf
          ? defaultReviewDueAt(data.currentAsOf)
          : before.reviewDueAt;
    assertFreshnessDates(effectiveCurrentAsOf, effectiveReviewDueAt);
    if (data.slug && data.slug !== before.slug) {
      await lockSlugScope(tx, context.organizationId);
      const existingAlias = await assertSlugAvailable(tx, context.organizationId, data.slug, webinarId);
      if (existingAlias?.webinarId === webinarId) {
        await tx.webinarSlugAlias.delete({
          where: { organizationId_slug: { organizationId: context.organizationId, slug: data.slug } },
        });
      }
      await tx.webinarSlugAlias.create({
        data: { organizationId: context.organizationId, webinarId, slug: before.slug },
      });
    }
    const { practiceAreas, ...webinarData } = data;
    await tx.webinar.update({
      where: { id: webinarId },
      data: {
        ...webinarData,
        ...(data.currentAsOf !== undefined || data.reviewDueAt !== undefined
          ? { reviewDueAt: effectiveReviewDueAt }
          : {}),
        ...(data.supersededByWebinarId ? { freshnessStatus: 'SUPERSEDED' } : {}),
        contentVersion: { increment: 1 },
      },
    });
    if (practiceAreas) {
      await replacePracticeAreas(tx, context.organizationId, webinarId, practiceAreas);
    }
    if (
      (data.freshnessStatus ?? before.freshnessStatus) === 'CURRENT' &&
      effectiveReviewDueAt &&
      effectiveReviewDueAt > new Date()
    ) {
      const completedAt = new Date();
      await tx.authorReviewTask.updateMany({
        where: { webinarId, organizationId: context.organizationId, status: 'PENDING' },
        data: { status: 'COMPLETED', completedAt },
      });
      await tx.authorServiceNotification.updateMany({
        where: { webinarId, organizationId: context.organizationId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED', claimToken: null, claimedAt: null },
      });
    }
    const webinar = await tx.webinar.findUniqueOrThrow({ where: { id: webinarId }, include: webinarInclude });
    if (updateIdempotencyKey) {
      await tx.creatorMetadataIdempotencyRecord.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          webinarId,
          idempotencyKey: updateIdempotencyKey,
          requestHash: updateFingerprint,
          responseJson: { webinarId, contentVersion: webinar.contentVersion },
        },
      });
    }
    await createWebinarAudit(tx, context, 'webinar.updated', webinar.id, auditSnapshot(before), auditSnapshot(webinar));
    return webinarProjection(webinar);
  });
}

export async function addCreatorWebinarSource(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const data = webinarSourceCreateSchema.parse(input);
  return db.$transaction(async tx => {
    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const webinar = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (!EDITABLE_CONTENT_STATUSES.includes(webinar.contentStatus)) {
      throw new AppError(409, 'Источники нельзя изменить в текущем статусе', undefined, 'webinar_not_editable');
    }
    const source = await tx.webinarSource.create({
      data: { organizationId: context.organizationId, webinarId, ...data },
    });
    await tx.webinar.update({ where: { id: webinarId }, data: { contentVersion: { increment: 1 } } });
    await createWebinarAudit(tx, context, 'webinar.source_added', webinarId, undefined, {
      sourceId: source.id,
      type: source.type,
    });
    return {
      id: source.id,
      type: source.type,
      title: source.title,
      url: source.url,
      accessedAt: source.accessedAt?.toISOString().slice(0, 10) ?? null,
      note: source.note,
      orderIndex: source.orderIndex,
    };
  });
}

export async function deleteCreatorWebinarSource(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  sourceIdInput: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const sourceId = webinarSourceIdSchema.parse(sourceIdInput);
  return db.$transaction(async tx => {
    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const webinar = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (!EDITABLE_CONTENT_STATUSES.includes(webinar.contentStatus)) {
      throw new AppError(409, 'Источники нельзя изменить в текущем статусе', undefined, 'webinar_not_editable');
    }
    const source = await tx.webinarSource.findFirst({
      where: { id: sourceId, webinarId, organizationId: context.organizationId },
    });
    if (!source) sourceUnavailable();
    await tx.webinarSource.delete({ where: { id: source.id } });
    await tx.webinar.update({ where: { id: webinarId }, data: { contentVersion: { increment: 1 } } });
    await createWebinarAudit(tx, context, 'webinar.source_removed', webinarId, { sourceId }, { removed: true });
    return { id: sourceId, removed: true };
  });
}

export async function getCreatorWebinarPreview(db: PrismaClient, context: TenantContext, webinarIdInput: unknown) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const role = await requireCurrentCreatorMembership(db, context);
  const webinar = await findScopedWebinar(db, context, role, webinarId);
  return {
    preview: true,
    sideEffectsCreated: false,
    notice: 'Предпросмотр не создаёт регистрацию, CRM-события и сообщения.',
    webinar: webinarProjection(webinar),
  };
}

export async function duplicateCreatorWebinar(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
  idempotencyKeyInput: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const data = duplicateCreatorWebinarSchema.parse(input);
  const idempotencyKey = idempotencyKeySchema.parse(idempotencyKeyInput);
  return db.$transaction(async tx => {
    await lockCommandScope(tx, context.organizationId, 'duplicate', idempotencyKey);
    const prior = await tx.webinarCommand.findUnique({
      where: {
        organizationId_action_idempotencyKey: {
          organizationId: context.organizationId,
          action: 'duplicate',
          idempotencyKey,
        },
      },
    });
    if (prior && prior.webinarId !== webinarId) {
      throw new AppError(409, 'Idempotency key уже использован', undefined, 'idempotency_key_reused');
    }
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    if (prior) {
      const replay = await tx.webinar.findFirst({
        where: { id: prior.resultStatus, organizationId: context.organizationId },
        include: webinarInclude,
      });
      if (!replay) {
        throw new AppError(409, 'Результат прежней команды недоступен', undefined, 'idempotency_result_unavailable');
      }
      return { webinar: webinarProjection(replay), replayed: true };
    }
    await lockWebinar(tx, context, webinarId);
    const source = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    const sourceScenario = await tx.chatScenario.findFirst({
      where: { organizationId: context.organizationId, webinarId, runtimeEnabled: true },
      orderBy: { version: 'desc' },
      include: { messages: { orderBy: { orderIndex: 'asc' } } },
    });
    const authorProfile = await tx.authorProfile.findFirst({
      where: { organizationId: context.organizationId, userId: context.userId },
      select: { id: true },
    });
    if (!authorProfile) {
      throw new AppError(409, 'Сначала создайте профиль автора', undefined, 'author_profile_required');
    }
    const duplicateSlug = data.slug ?? createDuplicateSlug(source.slug);
    const duplicateTitleSuffix = ' — копия';
    const duplicateTitle =
      data.title ?? `${source.title.slice(0, 240 - duplicateTitleSuffix.length)}${duplicateTitleSuffix}`;
    await lockSlugScope(tx, context.organizationId);
    await assertSlugAvailable(tx, context.organizationId, duplicateSlug);
    const created = await tx.webinar.create({
      data: {
        organizationId: context.organizationId,
        authorProfileId: authorProfile.id,
        jurisdictionId: source.jurisdictionId,
        slug: duplicateSlug,
        title: duplicateTitle,
        description: source.description,
        outcomeDescription: source.outcomeDescription,
        contentStatus: 'DRAFT',
        visibility: source.visibility,
        freshnessStatus: source.freshnessStatus,
        audienceLevel: source.audienceLevel,
        targetAudience: source.targetAudience,
        format: source.format,
        durationMinutes: source.durationMinutes,
        language: source.language,
        currentAsOf: source.currentAsOf,
        disclaimer: source.disclaimer,
        syntheticDisclosure: source.syntheticDisclosure,
        mediaStatus: 'NOT_UPLOADED',
        transcriptStatus: 'NOT_AVAILABLE',
        scenarioStatus: sourceScenario ? 'DRAFT' : 'NOT_AVAILABLE',
        contentVersion: 1,
      },
    });
    if (source.practiceAreas.length > 0) {
      await tx.webinarPracticeArea.createMany({
        data: source.practiceAreas.map(item => ({
          organizationId: context.organizationId,
          webinarId: created.id,
          practiceAreaId: item.practiceAreaId,
          isPrimary: item.isPrimary,
        })),
      });
    }
    if (source.sources.length > 0) {
      await tx.webinarSource.createMany({
        data: source.sources.map(item => ({
          organizationId: context.organizationId,
          webinarId: created.id,
          type: item.type,
          title: item.title,
          url: item.url,
          accessedAt: item.accessedAt,
          note: item.note,
          orderIndex: item.orderIndex,
        })),
      });
    }
    if (sourceScenario) {
      const duplicatedScenario = await tx.chatScenario.create({
        data: {
          organizationId: context.organizationId,
          webinarId: created.id,
          version: 1,
          status: 'DRAFT',
          createdById: context.userId,
        },
      });
      if (sourceScenario.messages.length > 0) {
        await tx.chatScenarioMessage.createMany({
          data: sourceScenario.messages.map(message => ({
            organizationId: context.organizationId,
            scenarioId: duplicatedScenario.id,
            orderIndex: message.orderIndex,
            offsetSeconds: message.offsetSeconds,
            kind: message.kind,
            status: 'DRAFT',
            text: message.text,
            authorLabel: message.authorLabel,
            isSynthetic: true,
          })),
        });
      }
    }
    await tx.webinarCommand.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        requestedById: context.userId,
        action: 'duplicate',
        idempotencyKey,
        resultStatus: created.id,
      },
    });
    await createWebinarAudit(tx, context, 'webinar.duplicated', created.id, undefined, {
      sourceWebinarId: webinarId,
      copiedPracticeAreaCount: source.practiceAreas.length,
      copiedSourceCount: source.sources.length,
      copiedScenarioMessageCount: sourceScenario?.messages.length ?? 0,
      copiedSessionCount: 0,
      copiedRegistrationCount: 0,
      copiedAnalyticsCount: 0,
    });
    const duplicate = await tx.webinar.findUniqueOrThrow({ where: { id: created.id }, include: webinarInclude });
    return { webinar: webinarProjection(duplicate), replayed: false };
  });
}

export function transitionWebinarContentStatus(
  current: WebinarContentStatus,
  target: WebinarContentStatus,
  actor: 'AUTHOR' | 'PLATFORM' = 'AUTHOR',
) {
  const authorTransitions: Partial<Record<WebinarContentStatus, readonly WebinarContentStatus[]>> = {
    DRAFT: ['IN_MODERATION'],
    NEEDS_REVIEW: ['IN_MODERATION'],
    READY: ['PUBLISHED'],
    PUBLISHED: ['ARCHIVED'],
  };
  const platformTransitions: Partial<Record<WebinarContentStatus, readonly WebinarContentStatus[]>> = {
    IN_MODERATION: ['NEEDS_REVIEW', 'READY'],
    PUBLISHED: ['ARCHIVED'],
  };
  const allowed = actor === 'AUTHOR' ? authorTransitions[current] : platformTransitions[current];
  if (!allowed?.includes(target)) {
    throw new AppError(409, 'Недопустимый переход статуса вебинара', undefined, 'webinar_transition_invalid');
  }
  return target;
}

function missingPublicationMetadata(webinar: WebinarWithRelations) {
  const missing: string[] = [];
  if (!webinar.authorProfileId) missing.push('author');
  if (!webinar.description) missing.push('description');
  if (!webinar.outcomeDescription) missing.push('outcomeDescription');
  if (!webinar.jurisdictionId) missing.push('jurisdictionId');
  if (!webinar.audienceLevel) missing.push('audienceLevel');
  if (!webinar.targetAudience) missing.push('targetAudience');
  if (!webinar.format) missing.push('format');
  if (!webinar.durationMinutes) missing.push('durationMinutes');
  if (!webinar.currentAsOf) missing.push('currentAsOf');
  if (!webinar.disclaimer) missing.push('disclaimer');
  if (webinar.freshnessStatus !== 'CURRENT') missing.push('freshnessStatus');
  const primary = webinar.practiceAreas.find(item => item.isPrimary && item.practiceArea.parentId === null);
  if (!primary) missing.push('primaryPracticeArea');
  if (!primary || !webinar.practiceAreas.some(item => item.practiceArea.parentId === primary.practiceAreaId)) {
    missing.push('specialization');
  }
  if (webinar.scenarioStatus === 'PUBLISHED' && !webinar.syntheticDisclosure) {
    missing.push('syntheticDisclosure');
  }
  return missing;
}

function assertPublicationMetadata(webinar: WebinarWithRelations) {
  const missing = missingPublicationMetadata(webinar);
  if (missing.length > 0) {
    throw new AppError(
      409,
      'Заполните обязательные юридические метаданные',
      { missingFields: missing },
      'webinar_metadata_incomplete',
    );
  }
}

async function lockCommandScope(tx: CreatorTransaction, organizationId: string, action: string, key: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${organizationId}:${action}:${key}`}, ${WEBINAR_COMMAND_LOCK_NAMESPACE})
    )
  `;
}

export async function runCreatorWebinarCommand(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  action: 'submit' | 'publish' | 'archive',
  idempotencyKeyInput: unknown,
) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const idempotencyKey = idempotencyKeySchema.parse(idempotencyKeyInput);
  return db.$transaction(async tx => {
    await lockCommandScope(tx, context.organizationId, action, idempotencyKey);
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
    let webinar = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (prior) return { webinar: webinarProjection(webinar), replayed: true };

    let target: WebinarContentStatus;
    if (action === 'submit') {
      await assertAuthorCanPublish(tx as unknown as PrismaClient, context, webinar.authorProfileId);
      assertPublicationMetadata(webinar);
      target = transitionWebinarContentStatus(webinar.contentStatus, 'IN_MODERATION');
    } else if (action === 'publish') {
      // Verification deliberately runs before readiness checks so a direct API call
      // by an unverified/suspended author always receives the AUT-003 403 contract.
      await assertAuthorCanPublish(tx as unknown as PrismaClient, context, webinar.authorProfileId);
      assertPublicationMetadata(webinar);
      target = transitionWebinarContentStatus(webinar.contentStatus, 'PUBLISHED');
      if (
        webinar.mediaStatus !== 'READY' ||
        webinar.transcriptStatus !== 'PUBLISHED' ||
        webinar.scenarioStatus !== 'PUBLISHED'
      ) {
        throw new AppError(
          409,
          'Видео, транскрипт и сценарий должны быть готовы к публикации',
          {
            mediaStatus: webinar.mediaStatus,
            transcriptStatus: webinar.transcriptStatus,
            scenarioStatus: webinar.scenarioStatus,
          },
          'webinar_publication_not_ready',
        );
      }
    } else {
      target = transitionWebinarContentStatus(webinar.contentStatus, 'ARCHIVED');
    }

    const before = auditSnapshot(webinar);
    webinar = await tx.webinar.update({
      where: { id: webinar.id },
      data: {
        contentStatus: target,
        contentVersion: { increment: 1 },
        ...(target === 'PUBLISHED' ? { publishedAt: new Date(), archivedAt: null } : {}),
        ...(target === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
      },
      include: webinarInclude,
    });
    await tx.webinarCommand.create({
      data: {
        organizationId: context.organizationId,
        webinarId: webinar.id,
        requestedById: context.userId,
        action,
        idempotencyKey,
        resultStatus: target,
      },
    });
    await createWebinarAudit(tx, context, `webinar.${action}`, webinar.id, before, auditSnapshot(webinar));
    return { webinar: webinarProjection(webinar), replayed: false };
  });
}

export type CreatorWizardStepStatus = 'not_started' | 'in_progress' | 'complete' | 'blocked';

export function projectCreatorWizardSteps(input: {
  authorEligible: boolean;
  basicMissingCount: number;
  legalMissingCount: number;
  mediaStatus: 'NOT_UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
  transcriptStatus: 'NOT_AVAILABLE' | 'DRAFT' | 'REVIEWED' | 'PUBLISHED';
  scenarioStatus: 'NOT_AVAILABLE' | 'DRAFT' | 'PUBLISHED';
  syntheticDisclosureMissing: boolean;
  sourceAndMaterialCount: number;
  sessionCount: number;
  contentStatus: WebinarContentStatus;
  blockerCount: number;
}) {
  const populatedBasicFieldCount = 6 - input.basicMissingCount;
  const populatedLegalFieldCount = 7 - input.legalMissingCount;
  const transcriptStepStatus: CreatorWizardStepStatus =
    input.mediaStatus !== 'READY'
      ? 'blocked'
      : input.transcriptStatus === 'PUBLISHED'
        ? 'complete'
        : input.transcriptStatus === 'NOT_AVAILABLE'
          ? 'not_started'
          : 'in_progress';
  return [
    {
      number: 1,
      code: 'BASIC_INFORMATION',
      label: 'Основная информация',
      status: !input.authorEligible
        ? 'blocked'
        : input.basicMissingCount === 0
          ? 'complete'
          : populatedBasicFieldCount > 0
            ? 'in_progress'
            : 'not_started',
    },
    {
      number: 2,
      code: 'LEGAL_AND_FRESHNESS',
      label: 'Юридическая классификация и актуальность',
      status: input.legalMissingCount === 0 ? 'complete' : populatedLegalFieldCount > 0 ? 'in_progress' : 'not_started',
    },
    {
      number: 3,
      code: 'VIDEO',
      label: 'Видео',
      status:
        input.mediaStatus === 'READY'
          ? 'complete'
          : input.mediaStatus === 'PROCESSING'
            ? 'in_progress'
            : input.mediaStatus === 'FAILED'
              ? 'blocked'
              : 'not_started',
    },
    {
      number: 4,
      code: 'TRANSCRIPT_AND_CHAPTERS',
      label: 'Транскрипт и главы',
      status: transcriptStepStatus,
    },
    {
      number: 5,
      code: 'SOURCES_AND_MATERIALS',
      label: 'Источники и материалы',
      status: input.sourceAndMaterialCount > 0 ? 'complete' : 'not_started',
    },
    {
      number: 6,
      code: 'PREPARED_CHAT',
      label: 'Подготовленный чат',
      status:
        input.scenarioStatus === 'PUBLISHED' && !input.syntheticDisclosureMissing
          ? 'complete'
          : input.scenarioStatus === 'NOT_AVAILABLE'
            ? 'not_started'
            : 'in_progress',
    },
    {
      number: 7,
      code: 'SCHEDULE_AND_ACCESS',
      label: 'Расписание и доступ',
      status: input.sessionCount > 0 ? 'complete' : 'not_started',
    },
    {
      number: 8,
      code: 'REVIEW_AND_PUBLISH',
      label: 'Проверка и публикация',
      status:
        input.blockerCount === 0 ? 'complete' : input.contentStatus === 'IN_MODERATION' ? 'in_progress' : 'blocked',
    },
  ] satisfies ReadonlyArray<{
    number: number;
    code: string;
    label: string;
    status: CreatorWizardStepStatus;
  }>;
}

export async function getCreatorWebinarReadiness(db: PrismaClient, context: TenantContext, webinarIdInput: unknown) {
  const webinarId = webinarIdSchema.parse(webinarIdInput);
  const role = await requireCurrentCreatorMembership(db, context);
  const webinar = await findScopedWebinar(db, context, role, webinarId);
  const [transcript, readyMaterialCount, authorEligible] = await Promise.all([
    db.transcript.findFirst({
      where: { webinarId, organizationId: context.organizationId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, revision: true, status: true, _count: { select: { chapters: true } } },
    }),
    db.webinarMaterial.count({
      where: { webinarId, organizationId: context.organizationId, status: 'READY', deletedAt: null },
    }),
    webinar.authorProfileId
      ? db.authorProfile.findFirst({
          where: {
            id: webinar.authorProfileId,
            organizationId: context.organizationId,
            userId: context.userId,
            verificationStatus: 'VERIFIED',
            organization: { status: 'ACTIVE' },
            user: { kind: 'HUMAN', status: 'ACTIVE' },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const metadataMissing = missingPublicationMetadata(webinar);
  const basicFields = new Set([
    'author',
    'description',
    'outcomeDescription',
    'targetAudience',
    'format',
    'durationMinutes',
  ]);
  const legalFields = new Set([
    'jurisdictionId',
    'audienceLevel',
    'currentAsOf',
    'disclaimer',
    'freshnessStatus',
    'primaryPracticeArea',
    'specialization',
  ]);
  const basicMissing = metadataMissing.filter(field => basicFields.has(field));
  const legalMissing = metadataMissing.filter(field => legalFields.has(field));
  const syntheticDisclosureMissing = metadataMissing.includes('syntheticDisclosure');
  const blockers: Array<{ code: string; step: number; message: string }> = [];
  const metadataLabels: Record<string, string> = {
    author: 'автор',
    description: 'описание',
    outcomeDescription: 'практический результат',
    jurisdictionId: 'юрисдикция',
    audienceLevel: 'уровень аудитории',
    targetAudience: 'целевая аудитория',
    format: 'формат',
    durationMinutes: 'длительность',
    currentAsOf: 'дата актуальности',
    disclaimer: 'правовой дисклеймер',
    freshnessStatus: 'статус актуальности',
    primaryPracticeArea: 'основная отрасль права',
    specialization: 'специализация',
    syntheticDisclosure: 'маркировка подготовленных сообщений',
  };
  for (const field of metadataMissing) {
    blockers.push({
      code: `metadata.${field}`,
      step: field === 'syntheticDisclosure' ? 6 : legalFields.has(field) ? 2 : 1,
      message: `Заполните обязательное поле: ${metadataLabels[field] ?? 'сведения о вебинаре'}.`,
    });
  }
  if (!authorEligible) {
    blockers.push({
      code: 'author.verification_required',
      step: 1,
      message: 'Публикация доступна проверенному активному автору этого вебинара.',
    });
  }
  if (webinar.mediaStatus !== 'READY') {
    blockers.push({ code: 'media.ready_required', step: 3, message: 'Активируйте обработанную версию видео.' });
  }
  if (webinar.transcriptStatus !== 'PUBLISHED') {
    blockers.push({ code: 'transcript.published_required', step: 4, message: 'Проверьте и опубликуйте расшифровку.' });
  }
  if (webinar.scenarioStatus !== 'PUBLISHED') {
    blockers.push({ code: 'scenario.published_required', step: 6, message: 'Проверьте и опубликуйте сценарий чата.' });
  }
  if (!['READY', 'PUBLISHED'].includes(webinar.contentStatus)) {
    blockers.push({
      code: 'moderation.ready_required',
      step: 8,
      message:
        webinar.contentStatus === 'IN_MODERATION'
          ? 'Дождитесь решения модератора.'
          : 'Отправьте заполненный вебинар на модерацию.',
    });
  }

  const steps = projectCreatorWizardSteps({
    authorEligible: Boolean(authorEligible),
    basicMissingCount: basicMissing.length,
    legalMissingCount: legalMissing.length,
    mediaStatus: webinar.mediaStatus,
    transcriptStatus: webinar.transcriptStatus,
    scenarioStatus: webinar.scenarioStatus,
    syntheticDisclosureMissing,
    sourceAndMaterialCount: webinar.sources.length + readyMaterialCount,
    sessionCount: webinar.sessions.length,
    contentStatus: webinar.contentStatus,
    blockerCount: blockers.length,
  });
  return {
    webinarId,
    contentVersion: webinar.contentVersion,
    publicationReady: blockers.length === 0,
    steps,
    blockers,
    counts: {
      sources: webinar.sources.length,
      readyMaterials: readyMaterialCount,
      chapters: transcript?._count.chapters ?? 0,
      sessions: webinar.sessions.length,
    },
    transcript: transcript
      ? { id: transcript.id, version: transcript.version, revision: transcript.revision, status: transcript.status }
      : null,
    generatedAt: new Date(),
  };
}

export async function getCreatorReferenceData(db: PrismaClient, context: TenantContext) {
  await requireCurrentCreatorMembership(db, context);
  const [practiceAreas, jurisdictions] = await Promise.all([
    db.legalPracticeArea.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
      select: { id: true, parentId: true, slug: true, name: true },
    }),
    db.jurisdiction.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, parentId: true, code: true, name: true },
    }),
  ]);
  return { practiceAreas, jurisdictions };
}

export function createDuplicateSlug(slug: string) {
  const suffix = crypto.randomBytes(5).toString('hex');
  return `${slug.slice(0, Math.max(3, 109 - suffix.length))}-copy-${suffix}`;
}

export type CreatorWebinarSourceInput = {
  type: WebinarSourceType;
  title: string;
  url: string;
  accessedAt?: Date | null;
  note?: string | null;
  orderIndex?: number;
};
