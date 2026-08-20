import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import {
  SMTP_DELIVERY_BUDGET_MS,
  sendParticipantLoginEmail,
  sendRegistrationEmail,
  sendReminderEmail,
  sendSessionChangeEmail,
  type ReminderKind,
} from './email.js';
import { logger } from './logger.js';
import {
  acquireEmailDeliveryLock,
  acquireLeadSecurityLock,
  isLeadIdentityActive,
  isParticipantRegistrationActive,
} from './leadSecurity.js';
import {
  buildTokenizedFrontendUrl,
  getRoomTokenExpiresAt,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
} from './roomLinks.js';
import { createAccessToken, hashToken } from './tokens.js';
import { EMAIL_OUTBOX_STALE_SENDING_MS } from './emailOutboxPolicy.js';

export { EMAIL_OUTBOX_STALE_SENDING_MS } from './emailOutboxPolicy.js';

export const EMAIL_JOB_REGISTRATION = 'registration_confirmation';
export const EMAIL_JOB_REMINDER = 'webinar_reminder';
export const EMAIL_JOB_REPLAY = 'webinar_replay';
export const EMAIL_JOB_PARTICIPANT_LOGIN = 'participant_access_login';
export const EMAIL_JOB_SESSION_RESCHEDULED = 'webinar_session_rescheduled';
export const EMAIL_JOB_SESSION_CANCELLED = 'webinar_session_cancelled';

const EMAIL_OUTBOX_BATCH_SIZE = 25;
const EMAIL_OUTBOX_MAX_ATTEMPTS = 10;
const EMAIL_LINK_MIN_TTL_MS = 20 * 60 * 1000;
const EMAIL_DELIVERY_TRANSACTION_TIMEOUT_MS = SMTP_DELIVERY_BUDGET_MS + 10_000;

// The legacy columns remain for a backwards-compatible migration, but never
// contain a bearer credential. A raw link exists only in worker memory between
// token creation and the SMTP call; the database stores the token hash.
export const EMAIL_OUTBOX_LINK_PENDING = 'generated-at-delivery://email-link';
export const EMAIL_OUTBOX_LINK_REDACTED = 'redacted://email-link';

type EmailOutboxTx = Prisma.TransactionClient;

type EnqueueBase = {
  registrationId: string;
  webinarSessionId: string;
  toEmail: string;
  toName: string;
  scheduledAt: Date;
};

type EmailOutboxJobRow = Awaited<ReturnType<typeof prisma.emailOutboxJob.findMany>>[number];

type PreparedEmailJob = {
  job: EmailOutboxJobRow;
  webinarUrl: string;
  partnerUrl: string | null;
  tokenIds: string[];
  timezone: string;
  webinarTitle: string;
};

export type EmailOutboxSenders = {
  sendRegistrationEmail?: typeof sendRegistrationEmail;
  sendReminderEmail?: typeof sendReminderEmail;
  sendParticipantLoginEmail?: typeof sendParticipantLoginEmail;
  sendSessionChangeEmail?: typeof sendSessionChangeEmail;
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
      webinarUrl: EMAIL_OUTBOX_LINK_PENDING,
      partnerUrl: null,
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
      webinarUrl: EMAIL_OUTBOX_LINK_PENDING,
      partnerUrl: null,
      nextAttemptAt: new Date(),
    },
  });
}

export async function enqueueReminderEmail(
  tx: EmailOutboxTx,
  input: EnqueueBase & { kind: ReminderKind; scheduleVersion?: number },
) {
  // Идемпотентно: unique registration/type/kind/scheduleVersion + skipDuplicates
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
        webinarUrl: EMAIL_OUTBOX_LINK_PENDING,
        partnerUrl: null,
        reminderKind: input.kind,
        sessionScheduleVersion: input.scheduleVersion ?? 1,
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

export async function enqueueSessionChangeEmails(
  tx: EmailOutboxTx,
  input: {
    kind: 'rescheduled' | 'cancelled';
    webinarSessionId: string;
    scheduledAt: Date;
    scheduleVersion: number;
    registrations: Array<{ id: string; lead: { email: string; name: string } }>;
  },
) {
  if (input.registrations.length === 0) return 0;
  const type = input.kind === 'rescheduled' ? EMAIL_JOB_SESSION_RESCHEDULED : EMAIL_JOB_SESSION_CANCELLED;
  const result = await tx.emailOutboxJob.createMany({
    data: input.registrations.map(registration => ({
      type,
      status: 'pending',
      registrationId: registration.id,
      webinarSessionId: input.webinarSessionId,
      toEmail: registration.lead.email,
      toName: registration.lead.name,
      scheduledAt: input.scheduledAt,
      webinarUrl: EMAIL_OUTBOX_LINK_PENDING,
      partnerUrl: null,
      reminderKind: 'session-change',
      sessionScheduleVersion: input.scheduleVersion,
      nextAttemptAt: new Date(),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

async function sendEmailJob(prepared: PreparedEmailJob, senders: EmailOutboxSenders) {
  const { job, webinarUrl, partnerUrl, timezone } = prepared;
  if (job.type === EMAIL_JOB_PARTICIPANT_LOGIN) {
    return (senders.sendParticipantLoginEmail ?? sendParticipantLoginEmail)({
      to: job.toEmail,
      name: job.toName,
      scheduledAt: job.scheduledAt,
      webinarUrl,
      partnerUrl: partnerUrl ?? undefined,
      timezone,
    });
  }

  if (job.type === EMAIL_JOB_REMINDER) {
    if (!job.reminderKind) {
      throw new Error('Reminder email job is missing reminderKind');
    }
    return (senders.sendReminderEmail ?? sendReminderEmail)({
      kind: job.reminderKind as ReminderKind,
      to: job.toEmail,
      name: job.toName,
      scheduledAt: job.scheduledAt,
      webinarUrl,
      partnerUrl: partnerUrl ?? undefined,
      timezone,
    });
  }

  if (job.type === EMAIL_JOB_SESSION_RESCHEDULED || job.type === EMAIL_JOB_SESSION_CANCELLED) {
    return (senders.sendSessionChangeEmail ?? sendSessionChangeEmail)({
      kind: job.type === EMAIL_JOB_SESSION_RESCHEDULED ? 'rescheduled' : 'cancelled',
      to: job.toEmail,
      name: job.toName,
      scheduledAt: job.scheduledAt,
      timezone,
      webinarUrl,
      webinarTitle: prepared.webinarTitle,
    });
  }

  return (senders.sendRegistrationEmail ?? sendRegistrationEmail)({
    to: job.toEmail,
    name: job.toName,
    scheduledAt: job.scheduledAt,
    webinarUrl,
    partnerUrl: partnerUrl ?? undefined,
    timezone,
  });
}

async function prepareEmailJob(jobId: string, claimToken: string, now: Date): Promise<PreparedEmailJob | null> {
  const jobRef = await prisma.emailOutboxJob.findUnique({
    where: { id: jobId },
    select: { registrationId: true },
  });
  if (!jobRef?.registrationId) return null;

  return prisma.$transaction(async tx => {
    const registrationRef = await tx.registration.findUnique({
      where: { id: jobRef.registrationId! },
      select: { leadId: true },
    });
    if (!registrationRef) return null;

    await acquireLeadSecurityLock(tx, registrationRef.leadId);
    const currentJob = await tx.emailOutboxJob.findUnique({
      where: { id: jobId },
      include: {
        registration: { include: { lead: true, webinarSession: true } },
        webinarSession: true,
      },
    });
    const pendingConfirmation =
      currentJob?.type === EMAIL_JOB_REGISTRATION &&
      currentJob.registration?.status === 'pending_verification' &&
      !currentJob.registration.emailVerifiedAt &&
      isLeadIdentityActive(currentJob.registration.lead);
    if (
      !currentJob ||
      currentJob.status !== 'sending' ||
      currentJob.sentAt ||
      currentJob.claimToken !== claimToken ||
      !currentJob.registration ||
      currentJob.registration.leadId !== registrationRef.leadId ||
      (currentJob.type !== EMAIL_JOB_SESSION_CANCELLED &&
        currentJob.registration.webinarSession.lifecycleStatus === 'CANCELLED') ||
      (!pendingConfirmation && !isParticipantRegistrationActive(currentJob.registration))
    ) {
      return null;
    }

    const createHashedToken = async (purpose: string, expiresAt: Date) => {
      const token = createAccessToken();
      const created = await tx.registrationToken.create({
        data: {
          registrationId: currentJob.registration!.id,
          tokenHash: hashToken(token),
          purpose,
          expiresAt,
        },
        select: { id: true },
      });
      return { id: created.id, token };
    };

    if (currentJob.type === EMAIL_JOB_PARTICIPANT_LOGIN) {
      const expiresAt = new Date(now.getTime() + EMAIL_LINK_MIN_TTL_MS);
      const createdToken = await createHashedToken(PARTICIPANT_LOGIN_TOKEN_PURPOSE, expiresAt);
      return {
        job: currentJob,
        webinarUrl: buildTokenizedFrontendUrl('/crisis_premium/access.html', createdToken.token),
        partnerUrl: null,
        tokenIds: [createdToken.id],
        timezone: currentJob.webinarSession?.timezone ?? currentJob.registration.webinarSession.timezone,
        webinarTitle: currentJob.webinarSession?.title ?? currentJob.registration.webinarSession.title,
      };
    }

    const webinarSession = currentJob.webinarSession ?? currentJob.registration.webinarSession;
    if (currentJob.type === EMAIL_JOB_SESSION_CANCELLED) {
      return {
        job: currentJob,
        webinarUrl: '',
        partnerUrl: null,
        tokenIds: [],
        timezone: webinarSession.timezone,
        webinarTitle: webinarSession.title,
      };
    }

    const configuredExpiry = getRoomTokenExpiresAt(webinarSession);
    const expiresAt = new Date(Math.max(configuredExpiry.getTime(), now.getTime() + EMAIL_LINK_MIN_TTL_MS));
    const webinarToken = await createHashedToken(ROOM_EXCHANGE_TOKEN_PURPOSE, expiresAt);
    const partnerToken = await createHashedToken(ROOM_EXCHANGE_TOKEN_PURPOSE, expiresAt);
    return {
      job: currentJob,
      webinarUrl: buildTokenizedFrontendUrl('/crisis_premium/webinar.html', webinarToken.token),
      partnerUrl: buildTokenizedFrontendUrl('/crisis_premium/webinar.html', partnerToken.token, 'partnerApplication'),
      tokenIds: [webinarToken.id, partnerToken.id],
      timezone: webinarSession.timezone,
      webinarTitle: webinarSession.title,
    };
  });
}

async function markEmailJobSentInTransaction(tx: EmailOutboxTx, prepared: PreparedEmailJob, now: Date) {
  const { job } = prepared;
  const updated = await tx.emailOutboxJob.updateMany({
    where: { id: job.id, status: 'sending', sentAt: null, claimToken: job.claimToken },
    data: {
      status: 'sent',
      attempts: { increment: 1 },
      sentAt: now,
      lastError: null,
      nextAttemptAt: null,
      claimToken: null,
      webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
      partnerUrl: null,
    },
  });
  if (updated.count !== 1) {
    return false;
  }

  // SMTP can take tens of seconds. Extend only the short-lived tokens created
  // for this exact delivery so the recipient still gets the advertised
  // minimum lifetime from successful delivery, not from an old batch clock.
  if (prepared.tokenIds.length > 0) {
    await tx.registrationToken.updateMany({
      where: {
        id: { in: prepared.tokenIds },
        registrationId: job.registrationId!,
        OR: [{ expiresAt: null }, { expiresAt: { lt: new Date(now.getTime() + EMAIL_LINK_MIN_TTL_MS) } }],
      },
      data: { expiresAt: new Date(now.getTime() + EMAIL_LINK_MIN_TTL_MS) },
    });
  }

  if (!job.registrationId) {
    return true;
  }

  if (job.type === EMAIL_JOB_REGISTRATION) {
    await tx.registration.update({
      where: { id: job.registrationId },
      data: { emailSentAt: now, confirmationSentAt: now },
    });
    return true;
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
  return true;
}

async function deliverPreparedEmailJob(prepared: PreparedEmailJob, senders: EmailOutboxSenders, clock: () => Date) {
  const { job } = prepared;
  if (!job.registrationId || !job.claimToken) {
    return 'cancelled' as const;
  }

  const registrationRef = await prisma.registration.findUnique({
    where: { id: job.registrationId },
    select: { leadId: true },
  });
  if (!registrationRef) {
    return 'cancelled' as const;
  }

  return prisma.$transaction(
    async tx => {
      // Token minting is committed before this transaction so an ambiguous SMTP
      // outcome still leaves the delivered link usable. Hold only the email
      // delivery fence through bounded SMTP: erasure waits for this channel,
      // while ordinary Lead transactions never wait for an external provider.
      await acquireEmailDeliveryLock(tx, registrationRef.leadId);
      const currentJob = await tx.emailOutboxJob.findUnique({
        where: { id: job.id },
        include: {
          registration: { include: { lead: true, webinarSession: true } },
          webinarSession: true,
        },
      });
      const pendingConfirmation =
        currentJob?.type === EMAIL_JOB_REGISTRATION &&
        currentJob.registration?.status === 'pending_verification' &&
        !currentJob.registration.emailVerifiedAt &&
        isLeadIdentityActive(currentJob.registration.lead);
      const stillDeliverable =
        currentJob?.status === 'sending' &&
        !currentJob.sentAt &&
        currentJob.claimToken === job.claimToken &&
        currentJob.registration?.leadId === registrationRef.leadId &&
        currentJob.toEmail.toLowerCase() === currentJob.registration.lead.email.toLowerCase() &&
        (currentJob.type === EMAIL_JOB_SESSION_CANCELLED ||
          currentJob.registration.webinarSession.lifecycleStatus !== 'CANCELLED') &&
        (pendingConfirmation || isParticipantRegistrationActive(currentJob.registration));

      if (!stillDeliverable || !currentJob) {
        await tx.registrationToken.deleteMany({
          where: { id: { in: prepared.tokenIds }, registrationId: job.registrationId! },
        });
        return 'cancelled' as const;
      }

      const currentPrepared: PreparedEmailJob = { ...prepared, job: currentJob };
      const delivery = await sendEmailJob(currentPrepared, senders);
      const finishedAt = clock();
      if (!delivery.sent) {
        const updated = await tx.emailOutboxJob.updateMany({
          where: { id: currentJob.id, status: 'sending', sentAt: null, claimToken: currentJob.claimToken },
          data: {
            status: 'cancelled',
            attempts: { increment: 1 },
            sentAt: null,
            lastError: `Email was not delivered (mode: ${delivery.mode})`,
            nextAttemptAt: null,
            claimToken: null,
            webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
            partnerUrl: null,
          },
        });
        await tx.registrationToken.deleteMany({
          where: { id: { in: prepared.tokenIds }, registrationId: job.registrationId! },
        });
        return updated.count === 1 ? ('cancelled' as const) : ('not_owned' as const);
      }

      return (await markEmailJobSentInTransaction(tx, currentPrepared, finishedAt))
        ? ('sent' as const)
        : ('not_owned' as const);
    },
    { maxWait: 5_000, timeout: EMAIL_DELIVERY_TRANSACTION_TIMEOUT_MS },
  );
}

async function markEmailJobFailed(job: EmailOutboxJobRow, now: Date, error: unknown) {
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
  if (canRetry) {
    const updated = await prisma.emailOutboxJob.updateMany({
      where: { id: job.id, status: 'sending', sentAt: null, claimToken: job.claimToken },
      data: {
        status: 'failed',
        attempts,
        lastError,
        nextAttemptAt: nextRetryAt(now, attempts),
        claimToken: null,
      },
    });
    return updated.count === 1;
  }

  const deadLettered = await prisma.$transaction(async tx => {
    const updated = await tx.emailOutboxJob.updateMany({
      where: { id: job.id, status: 'sending', sentAt: null, claimToken: job.claimToken },
      data: {
        status: 'dead_letter',
        attempts,
        lastError,
        nextAttemptAt: null,
        claimToken: null,
        webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
        partnerUrl: null,
      },
    });
    if (updated.count !== 1) {
      return false;
    }
    await tx.emailOutboxDeadLetter.upsert({
      where: { jobId: job.id },
      create: {
        jobId: job.id,
        reason: lastError,
        payloadJson: {
          type: job.type,
          reminderKind: job.reminderKind,
          registrationId: job.registrationId,
          attempts,
        },
      },
      update: {
        reason: lastError,
        payloadJson: {
          type: job.type,
          reminderKind: job.reminderKind,
          registrationId: job.registrationId,
          attempts,
        },
      },
    });
    return true;
  });
  if (deadLettered) {
    logger.fatal(
      { jobId: job.id, type: job.type, attempts },
      '[ASPБ email outbox] dead letter created; operator alert required',
    );
  }
  return deadLettered;
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
      claimToken: null,
    },
  });
}

export async function runEmailOutboxJobOnce(
  now = new Date(),
  senders: EmailOutboxSenders = {},
  onProgress?: () => void,
  clock: () => Date = () => new Date(),
) {
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
      claimToken: null,
      webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
      partnerUrl: null,
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
  let cancelled = 0;

  for (const job of jobs) {
    onProgress?.();
    const claimToken = randomUUID();
    const claimed = await prisma.emailOutboxJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        sentAt: null,
      },
      data: {
        status: 'sending',
        claimToken,
      },
    });

    if (claimed.count !== 1) {
      continue;
    }

    // Tokenized links are generated only after the claim, under the same Lead
    // lock as erasure. Every retry gets a fresh raw token while previous hashes
    // remain valid for ambiguous SMTP outcomes.
    const claimedJob: EmailOutboxJobRow = { ...job, status: 'sending', claimToken };
    let prepared: PreparedEmailJob | null;
    try {
      prepared = await prepareEmailJob(job.id, claimToken, clock());
    } catch (error) {
      if (await markEmailJobFailed(claimedJob, clock(), error)) {
        failed += 1;
      }
      continue;
    }
    if (!prepared) {
      const cancelledInactive = await prisma.emailOutboxJob.updateMany({
        where: { id: job.id, status: 'sending', sentAt: null, claimToken },
        data: {
          status: 'cancelled',
          nextAttemptAt: null,
          lastError: 'Cancelled because the participant identity is no longer active',
          claimToken: null,
          webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
          partnerUrl: null,
        },
      });
      if (cancelledInactive.count === 1) {
        cancelled += 1;
      }
      continue;
    }
    const currentJob = prepared.job;

    try {
      const outcome = await deliverPreparedEmailJob(prepared, senders, clock);
      if (outcome === 'sent') sent += 1;
      if (outcome === 'cancelled') cancelled += 1;
    } catch (error) {
      if (await markEmailJobFailed(currentJob, clock(), error)) {
        failed += 1;
      }
    } finally {
      onProgress?.();
    }
  }

  return { checked: jobs.length, sent, failed, cancelled };
}
