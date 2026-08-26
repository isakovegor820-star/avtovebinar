import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { sendAuthorReviewDueEmail } from '../email.js';
import { logger } from '../logger.js';
import { buildFrontendUrl } from '../roomLinks.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const;
const MAX_NOTIFICATION_ATTEMPTS = 5;
const NOTIFICATION_LEASE_MS = 10 * 60 * 1000;

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export type FreshnessReviewCandidate = {
  contentStatus: string;
  freshnessStatus: string;
  reviewDueAt: Date | null;
  archivedAt: Date | null;
  authorProfileId: string | null;
};

/** Pure boundary predicate used by the worker contract tests (dueAt is inclusive). */
export function isFreshnessReviewDue(candidate: FreshnessReviewCandidate, now: Date) {
  return (
    candidate.contentStatus === 'PUBLISHED' &&
    candidate.freshnessStatus === 'CURRENT' &&
    candidate.archivedAt === null &&
    candidate.authorProfileId !== null &&
    candidate.reviewDueAt !== null &&
    candidate.reviewDueAt.getTime() <= now.getTime()
  );
}

function retryAt(now: Date, attempts: number) {
  const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.name : 'unknown_error';
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) || 'unknown_error';
}

/**
 * Moves due published webinars into REVIEW_DUE and creates exactly one author task/outbox row.
 * The publication itself is deliberately untouched: this job never unpublishes or edits content.
 */
export async function runFreshnessReviewJobOnce(db: PrismaClient, now = new Date()) {
  const due = await db.webinar.findMany({
    where: {
      contentStatus: 'PUBLISHED',
      freshnessStatus: 'CURRENT',
      archivedAt: null,
      reviewDueAt: { not: null, lte: now },
      authorProfileId: { not: null },
    },
    select: { id: true, organizationId: true, authorProfileId: true, reviewDueAt: true },
    orderBy: [{ reviewDueAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });

  let transitioned = 0;
  let queued = 0;
  for (const candidate of due) {
    if (!candidate.authorProfileId || !candidate.reviewDueAt) continue;
    const authorProfileId = candidate.authorProfileId;
    const reviewDueAt = candidate.reviewDueAt;
    const result = await db.$transaction(async tx => {
      const updated = await tx.webinar.updateMany({
        where: {
          id: candidate.id,
          organizationId: candidate.organizationId,
          contentStatus: 'PUBLISHED',
          freshnessStatus: 'CURRENT',
          archivedAt: null,
          reviewDueAt,
        },
        data: { freshnessStatus: 'REVIEW_DUE', contentVersion: { increment: 1 } },
      });
      if (updated.count !== 1) return { transitioned: false, queued: false };

      const task = await tx.authorReviewTask.upsert({
        where: { webinarId_dueAt: { webinarId: candidate.id, dueAt: reviewDueAt } },
        create: {
          organizationId: candidate.organizationId,
          webinarId: candidate.id,
          authorProfileId,
          dueAt: reviewDueAt,
          dedupKey: `freshness:${candidate.id}:${dateKey(reviewDueAt)}`,
        },
        update: {},
      });
      const profile = await tx.authorProfile.findUnique({
        where: { id: authorProfileId },
        select: { userId: true },
      });
      if (!profile) return { transitioned: true, queued: false };
      const notification = await tx.authorServiceNotification.upsert({
        where: { taskId: task.id },
        create: {
          organizationId: candidate.organizationId,
          webinarId: candidate.id,
          taskId: task.id,
          userId: profile.userId,
          type: 'WEBINAR_REVIEW_DUE',
          dedupKey: `webinar-review-due:${task.id}`,
        },
        update: {},
      });
      await tx.auditLog.create({
        data: {
          organizationId: candidate.organizationId,
          action: 'webinar.freshness_review_due',
          entityType: 'webinar',
          entityId: candidate.id,
          beforeJson: { freshnessStatus: 'CURRENT', reviewDueAt: dateKey(reviewDueAt) },
          afterJson: {
            freshnessStatus: 'REVIEW_DUE',
            reviewDueAt: dateKey(reviewDueAt),
            taskId: task.id,
            notificationId: notification.id,
            automaticPublicationChange: false,
          },
        },
      });
      return { transitioned: true, queued: true };
    });
    if (result.transitioned) transitioned += 1;
    if (result.queued) queued += 1;
  }
  return { checked: due.length, transitioned, queued };
}

export async function runAuthorServiceNotificationJobOnce(db: PrismaClient, now = new Date()) {
  const staleBefore = new Date(now.getTime() - NOTIFICATION_LEASE_MS);
  const candidates = await db.authorServiceNotification.findMany({
    where: {
      attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ status: { in: ['PENDING', 'FAILED'] } }, { status: 'SENDING', claimedAt: { lte: staleBefore } }],
    },
    select: { id: true },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: 25,
  });
  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  for (const candidate of candidates) {
    const claimToken = crypto.randomUUID();
    const claimed = await db.authorServiceNotification.updateMany({
      where: {
        id: candidate.id,
        attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [{ status: { in: ['PENDING', 'FAILED'] } }, { status: 'SENDING', claimedAt: { lte: staleBefore } }],
      },
      data: { status: 'SENDING', claimedAt: now, claimToken, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const job = await db.authorServiceNotification.findUnique({
      where: { id: candidate.id },
      include: {
        user: { select: { emailNormalized: true, displayName: true, status: true } },
        task: { select: { status: true, dueAt: true } },
        webinar: { select: { id: true, title: true, contentStatus: true, freshnessStatus: true } },
      },
    });
    if (
      !job ||
      job.claimToken !== claimToken ||
      job.user.status !== 'ACTIVE' ||
      job.task.status !== 'PENDING' ||
      job.webinar.contentStatus !== 'PUBLISHED' ||
      job.webinar.freshnessStatus !== 'REVIEW_DUE'
    ) {
      await db.authorServiceNotification.updateMany({
        where: { id: candidate.id, claimToken },
        data: { status: 'CANCELLED', claimToken: null, claimedAt: null },
      });
      cancelled += 1;
      continue;
    }

    try {
      const url = new URL('/crisis_premium/creator-webinars.html', buildFrontendUrl('/'));
      url.hash = `webinar=${encodeURIComponent(job.webinar.id)}&step=1`;
      await sendAuthorReviewDueEmail({
        to: job.user.emailNormalized,
        displayName: job.user.displayName,
        webinarTitle: job.webinar.title,
        reviewUrl: url.toString(),
        dueAt: job.task.dueAt,
      });
      const finalized = await db.authorServiceNotification.updateMany({
        where: { id: candidate.id, claimToken, status: 'SENDING' },
        data: { status: 'SENT', sentAt: new Date(), claimToken: null, claimedAt: null, lastErrorCode: null },
      });
      if (finalized.count === 1) sent += 1;
    } catch (error) {
      const attempts = job.attempts;
      const dead = attempts >= MAX_NOTIFICATION_ATTEMPTS;
      await db.authorServiceNotification.updateMany({
        where: { id: candidate.id, claimToken, status: 'SENDING' },
        data: {
          status: dead ? 'DEAD_LETTER' : 'FAILED',
          nextAttemptAt: retryAt(new Date(), attempts),
          claimToken: null,
          claimedAt: null,
          lastErrorCode: safeErrorCode(error),
        },
      });
      logger.error({ err: error, notificationId: candidate.id }, '[ASPБ freshness notification]');
      failed += 1;
    }
  }
  return { checked: candidates.length, sent, failed, cancelled };
}

export async function listCreatorReviewTasks(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, CREATOR_ROLES);
  const tasks = await db.authorReviewTask.findMany({
    where: {
      organizationId: context.organizationId,
      status: 'PENDING',
      authorProfile: context.role === 'AUTHOR' ? { userId: context.userId } : undefined,
    },
    include: { webinar: { select: { id: true, title: true, slug: true, freshnessStatus: true } } },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  return tasks.map(task => ({
    id: task.id,
    dueAt: dateKey(task.dueAt),
    status: task.status,
    webinar: task.webinar,
  }));
}

export type FreshnessReviewTransaction = Prisma.TransactionClient;
