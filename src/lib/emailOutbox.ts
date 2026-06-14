import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { sendParticipantLoginEmail, sendRegistrationEmail, sendReminderEmail, type ReminderKind } from './email.js';
import { logger } from './logger.js';

export const EMAIL_JOB_REGISTRATION = 'registration_confirmation';
export const EMAIL_JOB_REMINDER = 'webinar_reminder';
export const EMAIL_JOB_REPLAY = 'webinar_replay';
export const EMAIL_JOB_PARTICIPANT_LOGIN = 'participant_access_login';

const EMAIL_OUTBOX_BATCH_SIZE = 25;
const EMAIL_OUTBOX_MAX_ATTEMPTS = 10;
const EMAIL_OUTBOX_STALE_SENDING_MS = 10 * 60 * 1000;

type EmailOutboxTx = Prisma.TransactionClient;

type EnqueueBase = {
  registrationId: string;
  webinarSessionId: string;
  toEmail: string;
  toName: string;
  scheduledAt: Date;
  webinarUrl: string;
  partnerUrl?: string | null;
};

export type EmailOutboxSenders = {
  sendRegistrationEmail?: typeof sendRegistrationEmail;
  sendReminderEmail?: typeof sendReminderEmail;
  sendParticipantLoginEmail?: typeof sendParticipantLoginEmail;
};

function normalizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function nextRetryAt(now: Date, attempts: number) {
  const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

export async function enqueueRegistrationEmail(tx: EmailOutboxTx, input: EnqueueBase) {
  await tx.emailOutboxJob.deleteMany({
    where: {
      registrationId: input.registrationId,
      type: EMAIL_JOB_REGISTRATION,
      status: { in: ['pending', 'failed'] },
    },
  });

  return tx.emailOutboxJob.create({
    data: {
      type: EMAIL_JOB_REGISTRATION,
      status: 'pending',
      registrationId: input.registrationId,
      webinarSessionId: input.webinarSessionId,
      toEmail: input.toEmail,
      toName: input.toName,
      scheduledAt: input.scheduledAt,
      webinarUrl: input.webinarUrl,
      partnerUrl: input.partnerUrl,
      nextAttemptAt: new Date(),
    },
  });
}

export async function enqueueParticipantLoginEmail(tx: EmailOutboxTx, input: EnqueueBase) {
  await tx.emailOutboxJob.deleteMany({
    where: {
      registrationId: input.registrationId,
      type: EMAIL_JOB_PARTICIPANT_LOGIN,
      status: { in: ['pending', 'failed'] },
    },
  });

  return tx.emailOutboxJob.create({
    data: {
      type: EMAIL_JOB_PARTICIPANT_LOGIN,
      status: 'pending',
      registrationId: input.registrationId,
      webinarSessionId: input.webinarSessionId,
      toEmail: input.toEmail,
      toName: input.toName,
      scheduledAt: input.scheduledAt,
      webinarUrl: input.webinarUrl,
      partnerUrl: input.partnerUrl,
      nextAttemptAt: new Date(),
    },
  });
}

export async function enqueueReminderEmail(tx: EmailOutboxTx, input: EnqueueBase & { kind: ReminderKind }) {
  // Идемпотентно: уникальный индекс (registrationId, type, reminderKind) + skipDuplicates
  // гарантируют ровно одну джобу на вид напоминания, даже при гонке нескольких тиков/реплик.
  // Возвращаем число реально созданных строк (0 — если такое напоминание уже было поставлено).
  const result = await tx.emailOutboxJob.createMany({
    data: [
      {
        type: EMAIL_JOB_REMINDER,
        status: 'pending',
        registrationId: input.registrationId,
        webinarSessionId: input.webinarSessionId,
        toEmail: input.toEmail,
        toName: input.toName,
        scheduledAt: input.scheduledAt,
        webinarUrl: input.webinarUrl,
        partnerUrl: input.partnerUrl,
        reminderKind: input.kind,
        nextAttemptAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return result.count;
}

export async function enqueueReplayEmail(tx: EmailOutboxTx, input: EnqueueBase) {
  await tx.emailOutboxJob.deleteMany({
    where: {
      registrationId: input.registrationId,
      type: EMAIL_JOB_REPLAY,
      sentAt: null,
    },
  });

  return null;
}

async function sendEmailJob(
  job: Awaited<ReturnType<typeof prisma.emailOutboxJob.findMany>>[number],
  senders: EmailOutboxSenders,
) {
  if (job.type === EMAIL_JOB_PARTICIPANT_LOGIN) {
    await (senders.sendParticipantLoginEmail ?? sendParticipantLoginEmail)({
      to: job.toEmail,
      name: job.toName,
      scheduledAt: job.scheduledAt,
      webinarUrl: job.webinarUrl,
      partnerUrl: job.partnerUrl ?? undefined,
    });
    return;
  }

  if (job.type === EMAIL_JOB_REMINDER) {
    if (!job.reminderKind) {
      throw new Error('Reminder email job is missing reminderKind');
    }
    await (senders.sendReminderEmail ?? sendReminderEmail)({
      kind: job.reminderKind as ReminderKind,
      to: job.toEmail,
      name: job.toName,
      scheduledAt: job.scheduledAt,
      webinarUrl: job.webinarUrl,
      partnerUrl: job.partnerUrl ?? undefined,
    });
    return;
  }

  await (senders.sendRegistrationEmail ?? sendRegistrationEmail)({
    to: job.toEmail,
    name: job.toName,
    scheduledAt: job.scheduledAt,
    webinarUrl: job.webinarUrl,
    partnerUrl: job.partnerUrl ?? undefined,
  });
}

async function markEmailJobSent(job: Awaited<ReturnType<typeof prisma.emailOutboxJob.findMany>>[number], now: Date) {
  await prisma.$transaction(async tx => {
    await tx.emailOutboxJob.update({
      where: { id: job.id },
      data: {
        status: 'sent',
        attempts: { increment: 1 },
        sentAt: now,
        lastError: null,
        nextAttemptAt: null,
      },
    });

    if (!job.registrationId) {
      return;
    }

    if (job.type === EMAIL_JOB_REGISTRATION) {
      await tx.registration.update({
        where: { id: job.registrationId },
        data: { emailSentAt: now, confirmationSentAt: now },
      });
      return;
    }

    if (job.type === EMAIL_JOB_REMINDER && job.reminderKind) {
      const field = {
        '24h': 'reminder24hSentAt',
        '3h': 'reminder3hSentAt',
        '30m': 'reminder30mSentAt',
      }[job.reminderKind] as 'reminder24hSentAt' | 'reminder3hSentAt' | 'reminder30mSentAt' | undefined;

      if (field) {
        await tx.registration.update({
          where: { id: job.registrationId },
          data: {
            [field]: now,
            reminderSentAt: now,
          },
        });
      }
    }
  });
}

async function markEmailJobFailed(
  job: Awaited<ReturnType<typeof prisma.emailOutboxJob.findMany>>[number],
  now: Date,
  error: unknown,
) {
  const attempts = job.attempts + 1;
  const canRetry = attempts < EMAIL_OUTBOX_MAX_ATTEMPTS;
  const lastError = normalizeError(error);
  logger.error(
    {
      err: error,
      jobId: job.id,
      type: job.type,
      reminderKind: job.reminderKind,
      attempts,
      willRetry: canRetry,
    },
    '[ASPБ email outbox] send failed',
  );
  await prisma.emailOutboxJob.update({
    where: { id: job.id },
    data: {
      status: 'failed',
      attempts,
      lastError,
      nextAttemptAt: canRetry ? nextRetryAt(now, attempts) : null,
    },
  });
}

async function resetStaleSendingJobs(now: Date) {
  await prisma.emailOutboxJob.updateMany({
    where: {
      status: 'sending',
      sentAt: null,
      updatedAt: {
        lt: new Date(now.getTime() - EMAIL_OUTBOX_STALE_SENDING_MS),
      },
    },
    data: {
      status: 'failed',
      lastError: 'Job was stuck in sending state and was returned to retry queue',
      nextAttemptAt: now,
    },
  });
}

export async function runEmailOutboxJobOnce(now = new Date(), senders: EmailOutboxSenders = {}) {
  await prisma.emailOutboxJob.updateMany({
    where: {
      type: EMAIL_JOB_REPLAY,
      sentAt: null,
      status: { in: ['pending', 'failed', 'sending'] },
    },
    data: {
      status: 'cancelled',
      lastError: 'Replay follow-up emails are disabled; recordings are available in the account library.',
      nextAttemptAt: null,
    },
  });

  await resetStaleSendingJobs(now);

  const jobs = await prisma.emailOutboxJob.findMany({
    where: {
      sentAt: null,
      attempts: { lt: EMAIL_OUTBOX_MAX_ATTEMPTS },
      status: { in: ['pending', 'failed'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: EMAIL_OUTBOX_BATCH_SIZE,
  });

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    const claimed = await prisma.emailOutboxJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        sentAt: null,
      },
      data: {
        status: 'sending',
      },
    });

    if (claimed.count !== 1) {
      continue;
    }

    try {
      await sendEmailJob(job, senders);
      await markEmailJobSent(job, now);
      sent += 1;
    } catch (error) {
      await markEmailJobFailed(job, now, error);
      failed += 1;
    }
  }

  return { checked: jobs.length, sent, failed };
}
