import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { sendOrganizationInvitationEmail } from '../email.js';
import { prisma } from '../prisma.js';
import { createAccessToken, hashToken } from '../tokens.js';
import { ORGANIZATION_INVITATION_TTL_MS } from './organizationInvitations.js';

export const ORGANIZATION_INVITATION_EMAIL_MAX_ATTEMPTS = 10;
export const ORGANIZATION_INVITATION_EMAIL_STALE_SENDING_MS = 10 * 60 * 1000;
export const ORGANIZATION_INVITATION_EMAIL_DUE_PENDING_SLA_MS = 5 * 60 * 1000;
const ORGANIZATION_INVITATION_EMAIL_BATCH_SIZE = 10;

const roleLabels = {
  OWNER: 'владелец',
  AUTHOR: 'автор',
  MODERATOR: 'модератор',
  CRM_MANAGER: 'CRM-менеджер',
  ANALYST: 'аналитик',
  AUDITOR: 'аудитор',
} as const;

export type OrganizationInvitationEmailSenders = {
  sendOrganizationInvitationEmail?: typeof sendOrganizationInvitationEmail;
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
  url.hash = new URLSearchParams({ invite: token }).toString();
  return url.toString();
}

async function claimNextInvitationEmail(now: Date) {
  const staleBefore = new Date(now.getTime() - ORGANIZATION_INVITATION_EMAIL_STALE_SENDING_MS);
  return prisma.$transaction(async tx => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "organization_invitation_email_jobs"
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
    return tx.organizationInvitationEmailJob.update({
      where: { id: candidates[0].id },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        claimedAt: now,
        claimToken: randomUUID(),
        lastError: null,
      },
      select: { id: true, invitationId: true, attempts: true, claimToken: true },
    });
  });
}

async function prepareInvitationEmail(
  job: { id: string; invitationId: string; attempts: number; claimToken: string | null },
  now: Date,
) {
  if (!job.claimToken) return null;
  const claimToken = job.claimToken;
  return prisma.$transaction(async tx => {
    const current = await tx.organizationInvitationEmailJob.findFirst({
      where: { id: job.id, invitationId: job.invitationId, status: 'SENDING', claimToken },
      include: { invitation: { include: { organization: true } } },
    });
    if (
      !current ||
      current.invitation.status !== 'PENDING' ||
      current.invitation.expiresAt <= now ||
      current.invitation.organization.status !== 'ACTIVE'
    ) {
      if (current) {
        await tx.organizationInvitationEmailJob.update({
          where: { id: current.id },
          data: {
            status: 'CANCELLED',
            claimedAt: null,
            claimToken: null,
            lastError: 'invitation_unavailable',
          },
        });
      }
      return null;
    }

    const rawToken = createAccessToken();
    const token = await tx.organizationInvitationToken.create({
      data: {
        invitationId: current.invitationId,
        tokenHash: hashToken(rawToken),
        expiresAt: current.invitation.expiresAt,
      },
      select: { id: true },
    });
    return {
      jobId: current.id,
      claimToken,
      attempts: current.attempts,
      invitationTokenId: token.id,
      to: current.invitation.emailNormalized,
      organizationName: current.invitation.organization.name,
      roleLabel: roleLabels[current.invitation.role],
      invitationUrl: invitationUrl(rawToken),
    };
  });
}

async function markSent(jobId: string, claimToken: string, now: Date) {
  const updated = await prisma.organizationInvitationEmailJob.updateMany({
    where: { id: jobId, status: 'SENDING', claimToken },
    data: { status: 'SENT', sentAt: now, claimedAt: null, claimToken: null, lastError: null },
  });
  if (updated.count !== 1) {
    throw new Error('Invitation email was delivered but its claim could not be finalized');
  }
}

async function cancelLogged(jobId: string, claimToken: string, invitationTokenId: string, now: Date) {
  await prisma.$transaction(async tx => {
    await tx.organizationInvitationToken.updateMany({
      where: { id: invitationTokenId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.organizationInvitationEmailJob.updateMany({
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
  const deadLetter = job.attempts >= ORGANIZATION_INVITATION_EMAIL_MAX_ATTEMPTS;
  await prisma.organizationInvitationEmailJob.updateMany({
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

export async function runOrganizationInvitationEmailOutboxJobOnce(
  now = new Date(),
  senders: OrganizationInvitationEmailSenders = {},
  onProgress: () => void = () => {},
) {
  let checked = 0;
  let sent = 0;
  let failed = 0;
  let cancelled = 0;
  for (let index = 0; index < ORGANIZATION_INVITATION_EMAIL_BATCH_SIZE; index += 1) {
    onProgress();
    const claimed = await claimNextInvitationEmail(now);
    if (!claimed) break;
    checked += 1;
    const prepared = await prepareInvitationEmail(claimed, now);
    if (!prepared) {
      cancelled += 1;
      continue;
    }
    try {
      const result = await (senders.sendOrganizationInvitationEmail ?? sendOrganizationInvitationEmail)({
        to: prepared.to,
        organizationName: prepared.organizationName,
        roleLabel: prepared.roleLabel,
        invitationUrl: prepared.invitationUrl,
        expiresInDays: Math.floor(ORGANIZATION_INVITATION_TTL_MS / (24 * 60 * 60 * 1000)),
      });
      if (!result.sent) {
        await cancelLogged(prepared.jobId, prepared.claimToken, prepared.invitationTokenId, now);
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
