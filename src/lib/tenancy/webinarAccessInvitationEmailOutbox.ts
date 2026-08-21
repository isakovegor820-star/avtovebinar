import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { sendWebinarAccessInvitationEmail } from '../email.js';
import { prisma } from '../prisma.js';
import { createAccessToken, hashToken } from '../tokens.js';
import { hashWebinarAccessEmail } from './webinarAccess.js';

export const WEBINAR_ACCESS_EMAIL_MAX_ATTEMPTS = 10;
export const WEBINAR_ACCESS_EMAIL_STALE_SENDING_MS = 10 * 60 * 1000;
export const WEBINAR_ACCESS_EMAIL_DUE_PENDING_SLA_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;

export type WebinarAccessInvitationEmailSenders = {
  sendWebinarAccessInvitationEmail?: typeof sendWebinarAccessInvitationEmail;
};

function nextRetryAt(now: Date, attempts: number) {
  return new Date(now.getTime() + Math.min(60, 2 ** Math.max(0, attempts)) * 60 * 1000);
}

function safeDeliveryError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/[A-Za-z0-9_-]{43}/g, '[redacted-token]')
    .slice(0, 1000);
}

function invitationUrl(token: string) {
  const url = new URL('/crisis_premium/platform-access.html', env.PUBLIC_SITE_URL);
  url.hash = new URLSearchParams({ webinarInvite: token }).toString();
  return url.toString();
}

async function claimNext(now: Date) {
  const staleBefore = new Date(now.getTime() - WEBINAR_ACCESS_EMAIL_STALE_SENDING_MS);
  return prisma.$transaction(async tx => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "webinar_access_invitation_email_jobs"
      WHERE (
        "status" IN ('pending', 'failed') AND "next_attempt_at" <= ${now}
      ) OR (
        "status" = 'sending' AND "claimed_at" <= ${staleBefore}
      )
      ORDER BY "next_attempt_at" ASC, "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (candidates.length === 0) return null;
    return tx.webinarAccessInvitationEmailJob.update({
      where: { id: candidates[0].id },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        claimedAt: now,
        claimToken: randomUUID(),
        lastError: null,
      },
      select: { id: true, grantId: true, attempts: true, claimToken: true },
    });
  });
}

async function prepare(job: { id: string; grantId: string; attempts: number; claimToken: string | null }, now: Date) {
  if (!job.claimToken) return null;
  const claimToken = job.claimToken;
  return prisma.$transaction(async tx => {
    const current = await tx.webinarAccessInvitationEmailJob.findFirst({
      where: { id: job.id, grantId: job.grantId, status: 'SENDING', claimToken },
      include: {
        grant: {
          include: {
            webinar: { select: { title: true, visibility: true } },
            organization: { select: { name: true, status: true } },
          },
        },
      },
    });
    if (
      !current ||
      current.grant.revokedAt ||
      current.grant.expiresAt <= now ||
      current.grant.organization.status !== 'ACTIVE' ||
      current.grant.webinar.visibility !== 'PRIVATE' ||
      current.grant.emailHash !== hashWebinarAccessEmail(current.toEmail)
    ) {
      if (current) {
        await tx.webinarAccessInvitationEmailJob.update({
          where: { id: current.id },
          data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'grant_unavailable' },
        });
      }
      return null;
    }
    const rawToken = createAccessToken();
    const token = await tx.webinarAccessGrantToken.create({
      data: { grantId: current.grantId, tokenHash: hashToken(rawToken), expiresAt: current.grant.expiresAt },
      select: { id: true },
    });
    return {
      jobId: current.id,
      claimToken,
      attempts: current.attempts,
      tokenId: token.id,
      grantId: current.grantId,
      to: current.toEmail,
      organizationName: current.grant.organization.name,
      webinarTitle: current.grant.webinar.title,
      invitationUrl: invitationUrl(rawToken),
      expiresAt: current.grant.expiresAt,
    };
  });
}

async function markSent(jobId: string, claimToken: string, now: Date) {
  const updated = await prisma.webinarAccessInvitationEmailJob.updateMany({
    where: { id: jobId, status: 'SENDING', claimToken },
    data: { status: 'SENT', sentAt: now, claimedAt: null, claimToken: null, lastError: null },
  });
  if (updated.count !== 1) throw new Error('Webinar invitation was delivered but its claim could not be finalized');
}

async function cancelLogged(jobId: string, claimToken: string, tokenId: string, now: Date) {
  await prisma.$transaction(async tx => {
    await tx.webinarAccessGrantToken.updateMany({
      where: { id: tokenId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.webinarAccessInvitationEmailJob.updateMany({
      where: { id: jobId, status: 'SENDING', claimToken },
      data: {
        status: 'CANCELLED',
        claimedAt: null,
        claimToken: null,
        lastError: 'email_delivery_disabled',
      },
    });
  });
}

async function markFailed(job: { id: string; claimToken: string; attempts: number }, now: Date, error: unknown) {
  const deadLetter = job.attempts >= WEBINAR_ACCESS_EMAIL_MAX_ATTEMPTS;
  await prisma.webinarAccessInvitationEmailJob.updateMany({
    where: { id: job.id, status: 'SENDING', claimToken: job.claimToken },
    data: {
      status: deadLetter ? 'DEAD_LETTER' : 'FAILED',
      nextAttemptAt: deadLetter ? now : nextRetryAt(now, job.attempts),
      claimedAt: null,
      claimToken: null,
      lastError: safeDeliveryError(error),
    },
  });
}

export async function runWebinarAccessInvitationEmailOutboxJobOnce(
  now = new Date(),
  senders: WebinarAccessInvitationEmailSenders = {},
  onProgress: () => void = () => {},
) {
  let checked = 0;
  let sent = 0;
  let failed = 0;
  let cancelled = 0;
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    onProgress();
    const claimed = await claimNext(now);
    if (!claimed) break;
    checked += 1;
    const prepared = await prepare(claimed, now);
    if (!prepared) {
      cancelled += 1;
      continue;
    }
    try {
      const result = await (senders.sendWebinarAccessInvitationEmail ?? sendWebinarAccessInvitationEmail)({
        to: prepared.to,
        organizationName: prepared.organizationName,
        webinarTitle: prepared.webinarTitle,
        invitationUrl: prepared.invitationUrl,
        expiresAt: prepared.expiresAt,
      });
      if (!result.sent) {
        await cancelLogged(prepared.jobId, prepared.claimToken, prepared.tokenId, now);
        cancelled += 1;
        continue;
      }
      await markSent(prepared.jobId, prepared.claimToken, now);
      sent += 1;
    } catch (error) {
      await markFailed(
        { id: prepared.jobId, claimToken: prepared.claimToken, attempts: prepared.attempts },
        now,
        error,
      );
      failed += 1;
    } finally {
      onProgress();
    }
  }
  return { checked, sent, failed, cancelled };
}
