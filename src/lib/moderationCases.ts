import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env } from './env.js';
import { AppError } from './http.js';
import type { TenantContext } from './tenancy/context.js';

const idSchema = z.string().trim().min(1).max(191);
const reasonSchema = z.string().trim().min(3).max(500);
const descriptionSchema = z.string().trim().min(10).max(2000);
const reportStatusSchema = z.enum(['NEW', 'IN_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'REJECTED']);

export const publicReportSchema = z
  .object({
    targetType: z.enum(['WEBINAR', 'AUTHOR_PROFILE']),
    targetId: idSchema,
    category: z.enum(['CONTENT', 'AUTHOR', 'RIGHTS']),
    description: descriptionSchema,
    reporterContact: z.string().trim().email().max(254).optional(),
  })
  .strict();

const transitionSchema = z
  .object({
    status: reportStatusSchema,
    expectedRevision: z.number().int().min(0),
    reason: reasonSchema,
  })
  .strict();

const correctionRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    reason: reasonSchema,
    visibilityDecision: z.enum(['KEEP_PUBLISHED', 'HIDE_UNTIL_APPROVED']),
    confirmation: z.literal('REQUEST_CORRECTION'),
  })
  .strict();

const contentPayloadSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().min(10).max(4000).nullable().optional(),
    outcomeDescription: z.string().trim().max(2000).nullable().optional(),
    targetAudience: z.string().trim().max(1000).nullable().optional(),
    disclaimer: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const correctionSubmissionSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    baseContentVersion: z.number().int().positive(),
    content: contentPayloadSchema,
  })
  .strict();

const correctionReviewSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    expectedRevision: z.number().int().min(1),
    reason: reasonSchema,
    confirmation: z.literal('REVIEW_CORRECTION'),
  })
  .strict();

const moderationActionSchema = z
  .object({
    action: z.enum(['UNPUBLISH_WEBINAR', 'SUSPEND_AUTHOR', 'RESTORE_WEBINAR', 'RESTORE_AUTHOR']),
    expectedRevision: z.number().int().min(0),
    expectedTargetRevision: z.number().int().min(0),
    reason: reasonSchema,
    confirmation: z.literal('APPLY_MODERATION_ACTION'),
  })
  .strict();

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ['IN_REVIEW', 'REJECTED'],
  IN_REVIEW: ['ACTION_REQUIRED', 'RESOLVED', 'REJECTED'],
  ACTION_REQUIRED: ['IN_REVIEW', 'RESOLVED', 'REJECTED'],
  RESOLVED: ['IN_REVIEW'],
  REJECTED: ['IN_REVIEW'],
};

export function isModerationTransitionAllowed(from: string, to: string) {
  return ALLOWED_TRANSITIONS[from]?.includes(to) === true;
}

function cleanNarrative(value: string) {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reportUnavailable(): never {
  throw new AppError(404, 'Moderation item was not found', undefined, 'moderation_item_not_found');
}

function conflict(code = 'moderation_revision_conflict'): never {
  throw new AppError(409, 'The moderation item changed. Reload and retry.', undefined, code);
}

function reporterHash(value: string) {
  return crypto
    .createHmac('sha256', env.ADMIN_COOKIE_SECRET)
    .update('aspb:public-report:contact:v1\0')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

export async function createPublicContentReport(
  db: PrismaClient,
  raw: unknown,
  correlationId: string,
  reporterUserId?: string | null,
) {
  const data = publicReportSchema.parse(raw);
  const description = cleanNarrative(data.description);
  if (description.length < 10)
    throw new AppError(400, 'Описание слишком короткое', undefined, 'report_description_invalid');

  let organizationId: string;
  let webinarId: string | null = null;
  let authorProfileId: string | null = null;
  if (data.targetType === 'WEBINAR') {
    const webinar = await db.webinar.findFirst({
      where: {
        id: data.targetId,
        contentStatus: 'PUBLISHED',
        archivedAt: null,
        visibility: { in: ['PUBLIC', 'UNLISTED'] },
        organization: { status: 'ACTIVE' },
        authorProfile: { verificationStatus: 'VERIFIED', user: { status: 'ACTIVE' } },
      },
      select: { id: true, organizationId: true },
    });
    if (!webinar) reportUnavailable();
    organizationId = webinar.organizationId;
    webinarId = webinar.id;
  } else {
    const author = await db.authorProfile.findFirst({
      where: {
        id: data.targetId,
        verificationStatus: 'VERIFIED',
        organization: { status: 'ACTIVE' },
        user: { status: 'ACTIVE' },
      },
      select: { id: true, organizationId: true, userId: true },
    });
    if (!author) reportUnavailable();
    const trustedMembership = await db.organizationMembership.findFirst({
      where: {
        organizationId: author.organizationId,
        userId: author.userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'AUTHOR'] },
      },
      select: { id: true },
    });
    if (!trustedMembership) reportUnavailable();
    organizationId = author.organizationId;
    authorProfileId = author.id;
  }

  return db.$transaction(async tx => {
    const report = await tx.contentReport.create({
      data: {
        organizationId,
        targetType: data.targetType,
        webinarId,
        authorProfileId,
        category: data.category,
        description,
        reporterUserId: reporterUserId ?? null,
        reporterContactHash: data.reporterContact ? reporterHash(data.reporterContact) : null,
        correlationId,
      },
      select: { id: true, category: true, status: true, createdAt: true, correlationId: true },
    });
    await tx.contentReportEvent.create({
      data: {
        reportId: report.id,
        organizationId,
        toStatus: 'NEW',
        reason: 'public_report_created',
        correlationId,
        reportRevision: 0,
      },
    });
    return report;
  });
}

export async function listModerationReports(db: PrismaClient, raw: unknown) {
  const query = z
    .object({
      status: reportStatusSchema.optional(),
      organizationId: idSchema.optional(),
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    })
    .strict()
    .parse(raw);
  const where = { status: query.status, organizationId: query.organizationId };
  const [total, items] = await Promise.all([
    db.contentReport.count({ where }),
    db.contentReport.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        organizationId: true,
        targetType: true,
        webinarId: true,
        authorProfileId: true,
        category: true,
        description: true,
        status: true,
        revision: true,
        correlationId: true,
        createdAt: true,
        updatedAt: true,
        webinar: { select: { moderationRevision: true, authorProfile: { select: { moderationRevision: true } } } },
        authorProfile: { select: { moderationRevision: true } },
      },
    }),
  ]);
  return { items, pagination: { page: query.page, pageSize: query.pageSize, total } };
}

export async function transitionModerationReport(
  db: PrismaClient,
  reportId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = transitionSchema.parse(raw);
  return db.$transaction(async tx => {
    const before = await tx.contentReport.findUnique({ where: { id: reportId } });
    if (!before) reportUnavailable();
    if (before.revision !== data.expectedRevision) conflict();
    if (!isModerationTransitionAllowed(before.status, data.status)) {
      throw new AppError(409, 'This moderation transition is not allowed', undefined, 'moderation_transition_invalid');
    }
    const nextRevision = before.revision + 1;
    const updated = await tx.contentReport.updateMany({
      where: { id: reportId, revision: before.revision, status: before.status },
      data: { status: data.status, revision: nextRevision },
    });
    if (updated.count !== 1) conflict();
    await tx.contentReportEvent.create({
      data: {
        reportId,
        organizationId: before.organizationId,
        fromStatus: before.status,
        toStatus: data.status,
        actorAdminUserId: adminUserId,
        reason: cleanNarrative(data.reason),
        correlationId,
        reportRevision: nextRevision,
      },
    });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: before.organizationId,
        correlationId,
        action: 'moderation.report.transitioned',
        entityType: 'ContentReport',
        entityId: reportId,
        beforeJson: { status: before.status, revision: before.revision },
        afterJson: { status: data.status, revision: nextRevision, reason: cleanNarrative(data.reason) },
      },
    });
    return tx.contentReport.findUniqueOrThrow({ where: { id: reportId } });
  });
}

export async function applyModerationAction(
  db: PrismaClient,
  reportId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = moderationActionSchema.parse(raw);
  return db.$transaction(async tx => {
    const report = await tx.contentReport.findUnique({ where: { id: reportId } });
    if (!report) reportUnavailable();
    if (report.revision !== data.expectedRevision) conflict();
    const reason = cleanNarrative(data.reason);

    if (data.action === 'UNPUBLISH_WEBINAR') {
      if (!report.webinarId) reportUnavailable();
      const webinar = await tx.webinar.findFirst({
        where: { id: report.webinarId, organizationId: report.organizationId },
      });
      if (!webinar) reportUnavailable();
      if (webinar.moderationRevision !== data.expectedTargetRevision) conflict('moderation_target_revision_conflict');
      const before = {
        contentStatus: webinar.contentStatus,
        visibility: webinar.visibility,
        archivedAt: webinar.archivedAt?.toISOString() ?? null,
        moderationRevision: webinar.moderationRevision,
      };
      const after = {
        contentStatus: 'ARCHIVED',
        visibility: 'PRIVATE',
        archivedAt: new Date().toISOString(),
        moderationRevision: webinar.moderationRevision + 1,
      };
      const changed = await tx.webinar.updateMany({
        where: {
          id: webinar.id,
          organizationId: report.organizationId,
          moderationRevision: webinar.moderationRevision,
        },
        data: {
          contentStatus: 'ARCHIVED',
          visibility: 'PRIVATE',
          archivedAt: new Date(after.archivedAt),
          moderationRevision: { increment: 1 },
        },
      });
      if (changed.count !== 1) conflict('moderation_target_revision_conflict');
      await tx.moderationPlatformAction.create({
        data: {
          organizationId: report.organizationId,
          targetType: 'WEBINAR',
          webinarId: webinar.id,
          action: 'unpublish_webinar',
          reason,
          beforeJson: before,
          afterJson: after,
          actorAdminUserId: adminUserId,
          correlationId,
        },
      });
    } else if (data.action === 'SUSPEND_AUTHOR') {
      const profileId =
        report.authorProfileId ??
        (report.webinarId
          ? (await tx.webinar.findUnique({ where: { id: report.webinarId }, select: { authorProfileId: true } }))
              ?.authorProfileId
          : null);
      if (!profileId) reportUnavailable();
      const author = await tx.authorProfile.findFirst({
        where: { id: profileId, organizationId: report.organizationId },
      });
      if (!author) reportUnavailable();
      if (author.moderationRevision !== data.expectedTargetRevision) conflict('moderation_target_revision_conflict');
      const before = { verificationStatus: author.verificationStatus, moderationRevision: author.moderationRevision };
      const after = { verificationStatus: 'SUSPENDED', moderationRevision: author.moderationRevision + 1 };
      const changed = await tx.authorProfile.updateMany({
        where: { id: author.id, organizationId: report.organizationId, moderationRevision: author.moderationRevision },
        data: { verificationStatus: 'SUSPENDED', moderationRevision: { increment: 1 } },
      });
      if (changed.count !== 1) conflict('moderation_target_revision_conflict');
      await tx.moderationPlatformAction.create({
        data: {
          organizationId: report.organizationId,
          targetType: 'AUTHOR_PROFILE',
          authorProfileId: author.id,
          action: 'suspend_author',
          reason,
          beforeJson: before,
          afterJson: after,
          actorAdminUserId: adminUserId,
          correlationId,
        },
      });
    } else {
      const targetType = data.action === 'RESTORE_WEBINAR' ? 'WEBINAR' : 'AUTHOR_PROFILE';
      const targetId =
        targetType === 'WEBINAR'
          ? report.webinarId
          : (report.authorProfileId ??
            (report.webinarId
              ? (
                  await tx.webinar.findFirst({
                    where: { id: report.webinarId, organizationId: report.organizationId },
                    select: { authorProfileId: true },
                  })
                )?.authorProfileId
              : null));
      if (!targetId) reportUnavailable();
      const original = await tx.moderationPlatformAction.findFirst({
        where: {
          organizationId: report.organizationId,
          targetType,
          ...(targetType === 'WEBINAR' ? { webinarId: targetId } : { authorProfileId: targetId }),
          action: targetType === 'WEBINAR' ? 'unpublish_webinar' : 'suspend_author',
          reversedBy: { none: {} },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!original)
        throw new AppError(
          409,
          'No reversible moderation action was found',
          undefined,
          'moderation_restore_unavailable',
        );
      const beforeState = original.beforeJson as Record<string, unknown>;
      if (targetType === 'WEBINAR') {
        const webinar = await tx.webinar.findFirst({ where: { id: targetId, organizationId: report.organizationId } });
        if (!webinar || webinar.moderationRevision !== data.expectedTargetRevision)
          conflict('moderation_target_revision_conflict');
        const restored = await tx.webinar.updateMany({
          where: {
            id: webinar.id,
            organizationId: report.organizationId,
            moderationRevision: data.expectedTargetRevision,
          },
          data: {
            contentStatus: beforeState.contentStatus as never,
            visibility: beforeState.visibility as never,
            archivedAt: beforeState.archivedAt ? new Date(String(beforeState.archivedAt)) : null,
            moderationRevision: { increment: 1 },
          },
        });
        if (restored.count !== 1) conflict('moderation_target_revision_conflict');
        await tx.moderationPlatformAction.create({
          data: {
            organizationId: report.organizationId,
            targetType: 'WEBINAR',
            webinarId: targetId,
            action: 'restore_webinar',
            reason,
            beforeJson: original.afterJson as Prisma.InputJsonValue,
            afterJson: { ...beforeState, moderationRevision: webinar.moderationRevision + 1 } as Prisma.InputJsonValue,
            actorAdminUserId: adminUserId,
            correlationId,
            reversesActionId: original.id,
          },
        });
      } else {
        const author = await tx.authorProfile.findFirst({
          where: { id: targetId, organizationId: report.organizationId },
        });
        if (!author || author.moderationRevision !== data.expectedTargetRevision)
          conflict('moderation_target_revision_conflict');
        const restored = await tx.authorProfile.updateMany({
          where: {
            id: author.id,
            organizationId: report.organizationId,
            moderationRevision: data.expectedTargetRevision,
          },
          data: { verificationStatus: beforeState.verificationStatus as never, moderationRevision: { increment: 1 } },
        });
        if (restored.count !== 1) conflict('moderation_target_revision_conflict');
        await tx.moderationPlatformAction.create({
          data: {
            organizationId: report.organizationId,
            targetType: 'AUTHOR_PROFILE',
            authorProfileId: targetId,
            action: 'restore_author',
            reason,
            beforeJson: original.afterJson as Prisma.InputJsonValue,
            afterJson: { ...beforeState, moderationRevision: author.moderationRevision + 1 } as Prisma.InputJsonValue,
            actorAdminUserId: adminUserId,
            correlationId,
            reversesActionId: original.id,
          },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: report.organizationId,
        correlationId,
        action: `moderation.action.${data.action.toLowerCase()}`,
        entityType: 'ContentReport',
        entityId: report.id,
        afterJson: { reason },
      },
    });
    return { action: data.action, reportId: report.id };
  });
}

export async function requestWebinarCorrection(
  db: PrismaClient,
  reportId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = correctionRequestSchema.parse(raw);
  return db.$transaction(async tx => {
    const report = await tx.contentReport.findUnique({ where: { id: reportId } });
    if (!report?.webinarId) reportUnavailable();
    if (report.revision !== data.expectedRevision) conflict();
    const webinar = await tx.webinar.findFirst({
      where: { id: report.webinarId, organizationId: report.organizationId },
    });
    if (!webinar) reportUnavailable();
    if (data.visibilityDecision === 'HIDE_UNTIL_APPROVED') {
      await tx.webinar.update({
        where: { id: webinar.id },
        data: { contentStatus: 'IN_MODERATION', moderationRevision: { increment: 1 } },
      });
    }
    const request = await tx.moderationCorrectionRequest.create({
      data: {
        reportId,
        organizationId: report.organizationId,
        webinarId: webinar.id,
        requestedByAdminUserId: adminUserId,
        reason: cleanNarrative(data.reason),
        visibilityDecision: data.visibilityDecision,
        baselineContentVersion: webinar.contentVersion,
      },
    });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: report.organizationId,
        correlationId,
        action: 'moderation.correction.requested',
        entityType: 'ModerationCorrectionRequest',
        entityId: request.id,
        afterJson: {
          reportId,
          webinarId: webinar.id,
          visibilityDecision: data.visibilityDecision,
          reason: cleanNarrative(data.reason),
        },
      },
    });
    return request;
  });
}

export async function listTenantCorrectionRequests(db: PrismaClient, context: TenantContext) {
  if (!['OWNER', 'AUTHOR'].includes(context.role))
    throw new AppError(403, 'Author permission is required', undefined, 'tenant_author_required');
  return db.moderationCorrectionRequest.findMany({
    where: {
      organizationId: context.organizationId,
      ...(context.role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { contentRevisions: { orderBy: { revision: 'desc' }, take: 1 } },
  });
}

export async function submitWebinarCorrection(
  db: PrismaClient,
  context: TenantContext,
  requestId: string,
  raw: unknown,
) {
  const data = correctionSubmissionSchema.parse(raw);
  if (!['OWNER', 'AUTHOR'].includes(context.role))
    throw new AppError(403, 'Author permission is required', undefined, 'tenant_author_required');
  return db.$transaction(async tx => {
    const request = await tx.moderationCorrectionRequest.findFirst({
      where: {
        id: requestId,
        organizationId: context.organizationId,
        ...(context.role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
      },
    });
    if (!request) reportUnavailable();
    if (
      request.status !== 'OPEN' ||
      request.revision !== data.expectedRevision ||
      request.baselineContentVersion !== data.baseContentVersion
    )
      conflict('moderation_correction_conflict');
    const webinar = await tx.webinar.findUnique({ where: { id: request.webinarId } });
    if (!webinar || webinar.contentVersion !== data.baseContentVersion) conflict('moderation_correction_conflict');
    const revision = await tx.webinarContentRevision.create({
      data: {
        correctionRequestId: request.id,
        organizationId: request.organizationId,
        webinarId: request.webinarId,
        revision: request.revision + 1,
        baseContentVersion: data.baseContentVersion,
        payloadJson: data.content,
        createdByUserId: context.userId,
      },
    });
    const updated = await tx.moderationCorrectionRequest.updateMany({
      where: { id: request.id, status: 'OPEN', revision: request.revision },
      data: { status: 'SUBMITTED', revision: { increment: 1 }, submittedAt: new Date() },
    });
    if (updated.count !== 1) conflict('moderation_correction_conflict');
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'moderation.correction.submitted',
        entityType: 'WebinarContentRevision',
        entityId: revision.id,
        afterJson: {
          correctionRequestId: request.id,
          revision: revision.revision,
          baseContentVersion: revision.baseContentVersion,
        },
      },
    });
    return revision;
  });
}

export async function reviewWebinarCorrection(
  db: PrismaClient,
  requestId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = correctionReviewSchema.parse(raw);
  return db.$transaction(async tx => {
    const request = await tx.moderationCorrectionRequest.findUnique({
      where: { id: requestId },
      include: { contentRevisions: { where: { status: 'SUBMITTED' }, orderBy: { revision: 'desc' }, take: 1 } },
    });
    if (!request) reportUnavailable();
    if (request.status !== 'SUBMITTED' || request.revision !== data.expectedRevision)
      conflict('moderation_correction_conflict');
    const revision = request.contentRevisions[0];
    if (!revision) conflict('moderation_correction_conflict');
    const webinar = await tx.webinar.findUnique({ where: { id: request.webinarId } });
    if (!webinar || webinar.contentVersion !== revision.baseContentVersion) conflict('moderation_correction_conflict');
    const approved = data.decision === 'APPROVE';
    const reason = cleanNarrative(data.reason);
    const claimed = await tx.moderationCorrectionRequest.updateMany({
      where: { id: request.id, status: 'SUBMITTED', revision: data.expectedRevision },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        reviewedByAdminUserId: adminUserId,
        reviewReason: reason,
        reviewedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    if (claimed.count !== 1) conflict('moderation_correction_conflict');
    await tx.webinarContentRevision.update({
      where: { id: revision.id },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        reviewedByAdminUserId: adminUserId,
        reviewReason: reason,
        reviewedAt: new Date(),
      },
    });
    if (approved) {
      const content = contentPayloadSchema.parse(revision.payloadJson);
      await tx.webinar.update({
        where: { id: webinar.id },
        data: {
          ...content,
          contentVersion: { increment: 1 },
          ...(request.visibilityDecision === 'HIDE_UNTIL_APPROVED' ? { contentStatus: 'PUBLISHED' as const } : {}),
          moderationRevision: { increment: 1 },
        },
      });
    }
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: request.organizationId,
        correlationId,
        action: approved ? 'moderation.correction.approved' : 'moderation.correction.rejected',
        entityType: 'WebinarContentRevision',
        entityId: revision.id,
        afterJson: { requestId, decision: data.decision, reason },
      },
    });
    return { requestId, revisionId: revision.id, decision: data.decision };
  });
}
