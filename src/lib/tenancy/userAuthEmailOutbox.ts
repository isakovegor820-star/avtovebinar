import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { sendUserPasswordlessLoginEmail } from '../email.js';
import { prisma } from '../prisma.js';
import { createAccessToken, hashToken } from '../tokens.js';
import { PASSWORDLESS_LOGIN_TOKEN_PURPOSE, PASSWORDLESS_LOGIN_TOKEN_TTL_MS } from './userAuth.js';

export const USER_AUTH_EMAIL_MAX_ATTEMPTS = 10;
export const USER_AUTH_EMAIL_STALE_SENDING_MS = 10 * 60 * 1000;
export const USER_AUTH_EMAIL_DUE_PENDING_SLA_MS = 5 * 60 * 1000;
const USER_AUTH_EMAIL_BATCH_SIZE = 10;

export type UserAuthEmailSenders = {
  sendPasswordlessLoginEmail?: typeof sendUserPasswordlessLoginEmail;
};

function nextRetryAt(now: Date, attempts: number) {
  const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

function safeDeliveryError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/[A-Za-z0-9_-]{43}/g, '[redacted-token]')
    .slice(0, 1000);
}

function buildPasswordlessLoginUrl(token: string) {
  const url = new URL('/crisis_premium/platform-access.html', env.PUBLIC_SITE_URL);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

async function claimNextAuthEmailJob(now: Date) {
  const staleBefore = new Date(now.getTime() - USER_AUTH_EMAIL_STALE_SENDING_MS);
  return prisma.$transaction(async tx => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "user_auth_email_jobs"
      WHERE (
        "status" IN ('pending', 'failed')
        AND "next_attempt_at" <= ${now}
      ) OR (
        "status" = 'sending'
        AND "claimed_at" <= ${staleBefore}
      )
      ORDER BY "next_attempt_at" ASC, "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (candidates.length === 0) return null;

    const claimToken = randomUUID();
    return tx.userAuthEmailJob.update({
      where: { id: candidates[0].id },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        claimedAt: now,
        claimToken,
        lastError: null,
      },
      select: {
        id: true,
        userId: true,
        attempts: true,
        claimToken: true,
      },
    });
  });
}

async function prepareAuthEmailJob(
  job: {
    id: string;
    userId: string;
    attempts: number;
    claimToken: string | null;
  },
  now: Date,
) {
  if (!job.claimToken) return null;
  const claimToken = job.claimToken;
  return prisma.$transaction(async tx => {
    const current = await tx.userAuthEmailJob.findFirst({
      where: {
        id: job.id,
        userId: job.userId,
        status: 'SENDING',
        claimToken,
      },
      include: { user: true },
    });
    if (!current) return null;

    const eligibleMembership = await tx.organizationMembership.findFirst({
      where: {
        userId: current.userId,
        status: 'ACTIVE',
        organization: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (current.user.kind !== 'HUMAN' || !['PENDING', 'ACTIVE'].includes(current.user.status) || !eligibleMembership) {
      await tx.userAuthEmailJob.update({
        where: { id: current.id },
        data: {
          status: 'CANCELLED',
          claimToken: null,
          claimedAt: null,
          lastError: 'account_unavailable',
        },
      });
      return null;
    }

    const rawToken = createAccessToken();
    const expiresAt = new Date(now.getTime() + PASSWORDLESS_LOGIN_TOKEN_TTL_MS);
    const authToken = await tx.userAuthToken.create({
      data: {
        userId: current.userId,
        tokenHash: hashToken(rawToken),
        purpose: PASSWORDLESS_LOGIN_TOKEN_PURPOSE,
        expiresAt,
      },
      select: { id: true },
    });
    return {
      jobId: current.id,
      claimToken,
      attempts: current.attempts,
      authTokenId: authToken.id,
      to: current.user.emailNormalized,
      displayName: current.user.displayName,
      loginUrl: buildPasswordlessLoginUrl(rawToken),
    };
  });
}

async function markAuthEmailSent(jobId: string, claimToken: string, now: Date) {
  const updated = await prisma.userAuthEmailJob.updateMany({
    where: { id: jobId, status: 'SENDING', claimToken },
    data: {
      status: 'SENT',
      sentAt: now,
      claimToken: null,
      claimedAt: null,
      lastError: null,
    },
  });
  if (updated.count !== 1) {
    throw new Error('Passwordless email was delivered but its claim could not be finalized');
  }
}

async function cancelLoggedAuthEmail(jobId: string, claimToken: string, authTokenId: string) {
  await prisma.$transaction(async tx => {
    await tx.userAuthToken.deleteMany({ where: { id: authTokenId, consumedAt: null } });
    await tx.userAuthEmailJob.updateMany({
      where: { id: jobId, status: 'SENDING', claimToken },
      data: {
        status: 'CANCELLED',
        claimToken: null,
        claimedAt: null,
        lastError: 'email_delivery_disabled',
      },
    });
  });
}

async function markAuthEmailFailed(
  job: { id: string; claimToken: string; attempts: number },
  now: Date,
  error: unknown,
) {
  const deadLetter = job.attempts >= USER_AUTH_EMAIL_MAX_ATTEMPTS;
  await prisma.userAuthEmailJob.updateMany({
    where: { id: job.id, status: 'SENDING', claimToken: job.claimToken },
    data: {
      status: deadLetter ? 'DEAD_LETTER' : 'FAILED',
      nextAttemptAt: deadLetter ? now : nextRetryAt(now, job.attempts),
      claimToken: null,
      claimedAt: null,
      lastError: safeDeliveryError(error),
    },
  });
}

export async function runUserAuthEmailOutboxJobOnce(
  now = new Date(),
  senders: UserAuthEmailSenders = {},
  onProgress: () => void = () => {},
) {
  let checked = 0;
  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  for (let index = 0; index < USER_AUTH_EMAIL_BATCH_SIZE; index += 1) {
    onProgress();
    const claimed = await claimNextAuthEmailJob(now);
    if (!claimed) break;
    checked += 1;
    const prepared = await prepareAuthEmailJob(claimed, now);
    if (!prepared) {
      cancelled += 1;
      continue;
    }

    try {
      const result = await (senders.sendPasswordlessLoginEmail ?? sendUserPasswordlessLoginEmail)({
        to: prepared.to,
        displayName: prepared.displayName,
        loginUrl: prepared.loginUrl,
        expiresInMinutes: Math.floor(PASSWORDLESS_LOGIN_TOKEN_TTL_MS / 60_000),
      });
      if (!result.sent) {
        await cancelLoggedAuthEmail(prepared.jobId, prepared.claimToken, prepared.authTokenId);
        cancelled += 1;
        continue;
      }
      await markAuthEmailSent(prepared.jobId, prepared.claimToken, now);
      sent += 1;
    } catch (error) {
      await markAuthEmailFailed(
        {
          id: prepared.jobId,
          claimToken: prepared.claimToken,
          attempts: prepared.attempts,
        },
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

export type UserAuthEmailJobTransaction = Prisma.TransactionClient;
