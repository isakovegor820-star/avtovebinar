import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

export const RETENTION_PLAN_POLICY_VERSION = 'UNAPPROVED-2026-08-24.1';
export const RETENTION_PLAN_CATEGORIES = [
  'AUTHOR_PROFILE_EVIDENCE',
  'WEBINAR_ACCESS_GRANTS',
  'VIEWER_ACCOUNT_DATA',
  'TENANT_CRM_DATA',
  'MODERATION_CHAT_QUESTION_HISTORY',
  'TENANT_TELEGRAM_DATA',
] as const;
type RetentionPlanCategory = (typeof RETENTION_PLAN_CATEGORIES)[number];
type RetentionInventoryCounts = Record<RetentionPlanCategory, number>;

function digestPlan(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function inventoryCounts(db: PrismaClient, organizationId: string) {
  const [authorProfiles, authorEvidence, accessGrants, favorites, progress, notes, preferences] = await Promise.all([
    db.authorProfile.count({ where: { organizationId } }),
    db.authorVerificationEvidence.count({ where: { organizationId } }),
    db.webinarAccessGrant.count({ where: { organizationId } }),
    db.viewerWebinarFavorite.count({ where: { organizationId } }),
    db.viewerWebinarProgress.count({ where: { organizationId } }),
    db.viewerWebinarNote.count({ where: { organizationId } }),
    db.viewerNotificationPreference.count({ where: { organizationId } }),
  ]);
  const [contacts, tasks, scoringRuleSets, scoringRules, scoreFactors, tags, contactTags, bulkActions, deliveries] =
    await Promise.all([
      db.cRMContact.count({ where: { organizationId } }),
      db.cRMTask.count({ where: { organizationId } }),
      db.cRMScoringRuleSet.count({ where: { organizationId } }),
      db.cRMScoringRule.count({ where: { organizationId } }),
      db.cRMScoreFactor.count({ where: { organizationId } }),
      db.cRMTag.count({ where: { organizationId } }),
      db.cRMContactTag.count({ where: { organizationId } }),
      db.cRMBulkAction.count({ where: { organizationId } }),
      db.cRMDelivery.count({ where: { organizationId } }),
    ]);
  const [
    reports,
    reportEvents,
    corrections,
    revisions,
    moderationActions,
    scenarios,
    scenarioMessages,
    chatMessages,
    questions,
    questionEvents,
  ] = await Promise.all([
    db.contentReport.count({ where: { organizationId } }),
    db.contentReportEvent.count({ where: { organizationId } }),
    db.moderationCorrectionRequest.count({ where: { organizationId } }),
    db.webinarContentRevision.count({ where: { organizationId } }),
    db.moderationPlatformAction.count({ where: { organizationId } }),
    db.chatScenario.count({ where: { organizationId } }),
    db.chatScenarioMessage.count({ where: { organizationId } }),
    db.webinarChatMessage.count({ where: { organizationId } }),
    db.question.count({ where: { organizationId } }),
    db.questionModerationEvent.count({ where: { organizationId } }),
  ]);
  const [bindings, callbacks, events, consultantMessages, templates, previews, jobs, recipients] = await Promise.all([
    db.telegramManagerChatBinding.count({ where: { organizationId } }),
    db.telegramManagerCallback.count({ where: { organizationId } }),
    db.telegramBotEvent.count({ where: { organizationId } }),
    db.telegramConsultantMessage.count({ where: { organizationId } }),
    db.telegramBroadcastTemplate.count({ where: { organizationId } }),
    db.telegramBroadcastPreview.count({ where: { organizationId } }),
    db.telegramBroadcastJob.count({ where: { organizationId } }),
    db.telegramBroadcastRecipient.count({ where: { organizationId } }),
  ]);
  return {
    AUTHOR_PROFILE_EVIDENCE: authorProfiles + authorEvidence,
    WEBINAR_ACCESS_GRANTS: accessGrants,
    VIEWER_ACCOUNT_DATA: favorites + progress + notes + preferences,
    TENANT_CRM_DATA:
      contacts + tasks + scoringRuleSets + scoringRules + scoreFactors + tags + contactTags + bulkActions + deliveries,
    MODERATION_CHAT_QUESTION_HISTORY:
      reports +
      reportEvents +
      corrections +
      revisions +
      moderationActions +
      scenarios +
      scenarioMessages +
      chatMessages +
      questions +
      questionEvents,
    TENANT_TELEGRAM_DATA: bindings + callbacks + events + consultantMessages + templates + previews + jobs + recipients,
  } satisfies Record<RetentionPlanCategory, number>;
}

export function buildRetentionPlanProjection(
  organizationId: string,
  counts: RetentionInventoryCounts,
  holds: Array<{ categories: string[] }>,
) {
  const categories = RETENTION_PLAN_CATEGORIES.map(category => {
    const blocked = holds.some(hold => hold.categories.includes('*') || hold.categories.includes(category));
    return {
      category,
      entityCount: counts[category],
      cutoff: null,
      eligibleCount: 0,
      blockedByLegalHoldCount: blocked ? counts[category] : 0,
      reasonCode: blocked ? 'LEGAL_HOLD_ACTIVE' : 'POLICY_TERM_UNAPPROVED',
    };
  });
  const digestInput = {
    scopeKind: 'ORGANIZATION',
    organizationId,
    policyVersion: RETENTION_PLAN_POLICY_VERSION,
    categories,
  };
  return {
    mode: 'DRY_RUN' as const,
    scope: { kind: 'ORGANIZATION' as const },
    policyVersion: RETENTION_PLAN_POLICY_VERSION,
    policyReady: false,
    destructiveApplyAllowed: false,
    categories,
    digest: digestPlan(digestInput),
  };
}

export async function buildTenantRetentionPlan(db: PrismaClient, context: TenantContext, now = new Date()) {
  requireTenantRole(context, ['OWNER', 'AUDITOR']);
  const [counts, holds] = await Promise.all([
    inventoryCounts(db, context.organizationId),
    db.legalHold.findMany({
      where: {
        organizationId: context.organizationId,
        status: 'ACTIVE',
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { categories: true },
    }),
  ]);
  return buildRetentionPlanProjection(context.organizationId, counts, holds);
}

export function rejectRetentionApply(_input: unknown): never {
  throw new AppError(
    409,
    'Удаление заблокировано до утверждения политики хранения',
    undefined,
    'retention_apply_blocked',
  );
}

const createLegalHoldSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(191),
    categories: z
      .array(z.union([z.literal('*'), z.enum(RETENTION_PLAN_CATEGORIES)]))
      .min(1)
      .max(20),
    reason: z.string().trim().min(20).max(2_000),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().optional(),
    confirm: z.literal(true),
  })
  .strict()
  .refine(value => !value.endsAt || value.endsAt > value.startsAt, {
    path: ['endsAt'],
    message: 'Invalid hold window',
  });
const releaseLegalHoldSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(20).max(2_000),
    confirm: z.literal(true),
  })
  .strict();

export async function createLegalHold(db: PrismaClient, raw: unknown, adminUserId: string, correlationId: string) {
  const data = createLegalHoldSchema.parse(raw);
  return db.$transaction(async tx => {
    const organization = await tx.organization.findFirst({
      where: { id: data.organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { id: true },
    });
    if (!organization) throw new AppError(404, 'Объект недоступен', undefined, 'legal_hold_target_unavailable');
    const hold = await tx.legalHold.create({
      data: {
        organizationId: data.organizationId,
        categories: [...new Set(data.categories)].sort(),
        reason: data.reason,
        startsAt: data.startsAt,
        endsAt: data.endsAt ?? null,
        createdByAdminUserId: adminUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: data.organizationId,
        correlationId,
        action: 'legal_hold.created',
        entityType: 'legal_hold',
        entityId: hold.id,
        afterJson: {
          categories: hold.categories,
          startsAt: hold.startsAt.toISOString(),
          endsAt: hold.endsAt?.toISOString() ?? null,
          revision: hold.revision,
          reason: data.reason,
        },
      },
    });
    return { id: hold.id, categories: hold.categories, status: hold.status, revision: hold.revision };
  });
}

export async function releaseLegalHold(
  db: PrismaClient,
  holdIdInput: unknown,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const holdId = z.string().trim().min(1).max(191).parse(holdIdInput);
  const data = releaseLegalHoldSchema.parse(raw);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "legal_holds" WHERE "id" = ${holdId} FOR UPDATE`;
    const current = await tx.legalHold.findUnique({ where: { id: holdId } });
    if (!current) throw new AppError(404, 'Объект недоступен', undefined, 'legal_hold_unavailable');
    if (current.status !== 'ACTIVE' || current.revision !== data.expectedRevision) {
      throw new AppError(409, 'Legal hold уже изменён', undefined, 'legal_hold_revision_conflict');
    }
    const releasedAt = new Date();
    const hold = await tx.legalHold.update({
      where: { id: holdId },
      data: {
        status: 'RELEASED',
        revision: { increment: 1 },
        releasedByAdminUserId: adminUserId,
        releasedAt,
        releaseReason: data.reason,
      },
    });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: hold.organizationId,
        correlationId,
        action: 'legal_hold.released',
        entityType: 'legal_hold',
        entityId: hold.id,
        beforeJson: { status: current.status, revision: current.revision },
        afterJson: {
          status: hold.status,
          revision: hold.revision,
          releasedAt: releasedAt.toISOString(),
          reason: data.reason,
        },
      },
    });
    return { id: hold.id, status: hold.status, revision: hold.revision };
  });
}
