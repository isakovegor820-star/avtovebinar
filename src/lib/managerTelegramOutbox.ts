import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { retryDelayMs } from './resilience.js';
import { isParticipantRegistrationActive } from './leadSecurity.js';
import {
  isPermanentTelegramError,
  notifyPartnerApplication,
  notifyQuestion,
  notifyRegistration,
} from './telegram.js';
import { buildFrontendUrl } from './roomLinks.js';
import { logger } from './logger.js';

export const MANAGER_TELEGRAM_NOTIFICATION_MAX_ATTEMPTS = 6;
export const MANAGER_TELEGRAM_NOTIFICATION_STALE_MS = 10 * 60 * 1000;
export const MANAGER_TELEGRAM_NOTIFICATION_DUE_SLA_MS = 5 * 60 * 1000;

export type ManagerTelegramNotificationKind = 'registration' | 'partner_application' | 'question';

type EnqueueInput = {
  kind: ManagerTelegramNotificationKind;
  registrationId: string;
  dedupKey: string;
  partnerApplicationId?: string;
  questionId?: string;
};

type OutboxTx = Pick<Prisma.TransactionClient, 'managerTelegramNotificationJob'>;

export async function enqueueManagerTelegramNotification(tx: OutboxTx, input: EnqueueInput) {
  return tx.managerTelegramNotificationJob.upsert({
    where: { dedupKey: input.dedupKey },
    create: {
      kind: input.kind,
      dedupKey: input.dedupKey,
      registrationId: input.registrationId,
      partnerApplicationId: input.partnerApplicationId,
      questionId: input.questionId,
      status: 'pending',
      nextAttemptAt: new Date(),
    },
    update: {},
  });
}

export type ManagerTelegramNotificationSender = (input: {
  id: string;
  kind: ManagerTelegramNotificationKind;
  registrationId: string;
  partnerApplicationId: string | null;
  questionId: string | null;
}) => Promise<{ sent: boolean; mode: string; reason?: string }>;

function normalizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function deliverJob(
  job: Awaited<ReturnType<typeof findClaimedJob>>,
  sender?: ManagerTelegramNotificationSender,
) {
  if (!job) return { kind: 'cancelled' as const, reason: 'manager_notification_job_missing' };
  if (!isParticipantRegistrationActive(job.registration)) {
    return { kind: 'cancelled' as const, reason: 'manager_notification_registration_inactive' };
  }
  if (job.kind === 'partner_application' && !job.partnerApplication) {
    return { kind: 'cancelled' as const, reason: 'manager_notification_partner_application_missing' };
  }
  if (job.kind === 'question' && !job.question) {
    return { kind: 'cancelled' as const, reason: 'manager_notification_question_missing' };
  }

  const delivery = sender
    ? await sender({
        id: job.id,
        kind: job.kind as ManagerTelegramNotificationKind,
        registrationId: job.registrationId,
        partnerApplicationId: job.partnerApplicationId,
        questionId: job.questionId,
      })
    : job.kind === 'registration'
      ? await notifyRegistration({
          name: job.registration.lead.name,
          phone: job.registration.lead.phone,
          email: job.registration.lead.email,
          city: job.registration.lead.city,
          professionalStatus: job.registration.lead.professionalStatus,
          scheduledAt: job.registration.webinarSession.scheduledAt,
          source: job.registration.lead.source,
          adminUrl: buildFrontendUrl('/admin'),
        })
      : job.kind === 'partner_application'
        ? await notifyPartnerApplication({
            name: job.registration.lead.name,
            phone: job.registration.lead.phone,
            email: job.registration.lead.email,
            sphere: job.partnerApplication!.sphere,
            city: job.partnerApplication!.city,
            clientFlow: job.partnerApplication!.clientFlow,
            preferredFormat: job.partnerApplication!.preferredFormat,
            comment: job.partnerApplication!.comment,
            adminUrl: buildFrontendUrl('/admin'),
          })
        : await notifyQuestion({
            name: job.registration.lead.name,
            phone: job.registration.lead.phone,
            email: job.registration.lead.email,
            text: job.question!.text,
            adminUrl: buildFrontendUrl('/admin'),
          });

  if (!delivery.sent) {
    throw new Error(`Manager Telegram delivery unavailable (${delivery.mode}${delivery.reason ? `:${delivery.reason}` : ''})`);
  }
  return { kind: 'sent' as const };
}

async function findClaimedJob(id: string, claimToken: string) {
  return prisma.managerTelegramNotificationJob.findFirst({
    where: { id, status: 'sending', claimToken },
    include: {
      registration: { include: { lead: true, webinarSession: true } },
      partnerApplication: true,
      question: true,
    },
  });
}

async function runOneManagerTelegramNotification(
  now: Date,
  sender?: ManagerTelegramNotificationSender,
) {
  const candidate = await prisma.managerTelegramNotificationJob.findFirst({
    where: {
      status: { in: ['pending', 'failed'] },
      sentAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!candidate) return { checked: 0, sent: 0, failed: 0, cancelled: 0, deadLettered: 0 };

  const claimToken = randomUUID();
  const claimed = await prisma.managerTelegramNotificationJob.updateMany({
    where: { id: candidate.id, status: candidate.status, claimToken: null, sentAt: null },
    data: { status: 'sending', claimToken, attempts: { increment: 1 }, nextAttemptAt: null },
  });
  if (claimed.count !== 1) return { checked: 1, sent: 0, failed: 0, cancelled: 0, deadLettered: 0 };

  const attempt = candidate.attempts + 1;
  try {
    const job = await findClaimedJob(candidate.id, claimToken);
    const outcome = await deliverJob(job, sender);
    const finishedAt = new Date();
    if (outcome.kind === 'cancelled') {
      await prisma.managerTelegramNotificationJob.updateMany({
        where: { id: candidate.id, status: 'sending', claimToken, sentAt: null },
        data: {
          status: 'cancelled',
          claimToken: null,
          nextAttemptAt: null,
          lastError: outcome.reason,
        },
      });
      return { checked: 1, sent: 0, failed: 0, cancelled: 1, deadLettered: 0 };
    }

    const updated = await prisma.managerTelegramNotificationJob.updateMany({
      where: { id: candidate.id, status: 'sending', claimToken, sentAt: null },
      data: {
        status: 'sent',
        claimToken: null,
        nextAttemptAt: null,
        lastError: null,
        sentAt: finishedAt,
      },
    });
    return { checked: 1, sent: updated.count, failed: 0, cancelled: 0, deadLettered: 0 };
  } catch (error) {
    const deadLetter = attempt >= MANAGER_TELEGRAM_NOTIFICATION_MAX_ATTEMPTS || isPermanentTelegramError(error);
    const lastError = normalizeError(error);
    const retryAfterSeconds = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
    const retryAfterMs =
      typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(10 * 60 * 1000, Math.max(1_000, Math.ceil(retryAfterSeconds * 1000)))
        : null;
    const updated = await prisma.managerTelegramNotificationJob.updateMany({
      where: { id: candidate.id, status: 'sending', claimToken, sentAt: null },
      data: deadLetter
        ? {
            status: 'dead_letter',
            claimToken: null,
            nextAttemptAt: null,
            lastError,
            deadLetteredAt: new Date(),
          }
        : {
            status: 'failed',
            claimToken: null,
            nextAttemptAt: new Date(
              now.getTime() + retryDelayMs(attempt, { baseMs: 2_000, maxMs: 10 * 60 * 1000, retryAfterMs }),
            ),
            lastError,
          },
    });
    logger.error(
      { jobId: candidate.id, kind: candidate.kind, attempt, deadLetter },
      'Manager Telegram notification delivery failed',
    );
    return {
      checked: 1,
      sent: 0,
      failed: updated.count && !deadLetter ? 1 : 0,
      cancelled: 0,
      deadLettered: updated.count && deadLetter ? 1 : 0,
    };
  }
}

export async function runManagerTelegramNotificationJobsOnce(
  now = new Date(),
  options: { sender?: ManagerTelegramNotificationSender; limit?: number; onProgress?: () => void } = {},
) {
  await prisma.managerTelegramNotificationJob.updateMany({
    where: {
      status: 'sending',
      sentAt: null,
      updatedAt: { lt: new Date(now.getTime() - MANAGER_TELEGRAM_NOTIFICATION_STALE_MS) },
    },
    data: {
      status: 'failed',
      claimToken: null,
      nextAttemptAt: now,
      lastError: 'Recovered stale manager Telegram notification claim',
    },
  });

  const total = { checked: 0, sent: 0, failed: 0, cancelled: 0, deadLettered: 0 };
  for (let index = 0; index < Math.max(1, Math.min(options.limit ?? 20, 100)); index += 1) {
    options.onProgress?.();
    const result = await runOneManagerTelegramNotification(now, options.sender);
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
    if (result.checked === 0) break;
  }
  return total;
}
