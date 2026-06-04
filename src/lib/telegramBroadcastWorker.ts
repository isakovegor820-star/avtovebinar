import { Prisma } from '@prisma/client';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { createCorrelationId, runWithCorrelation } from './requestContext.js';
import { normalizeError, retryDelayMs } from './resilience.js';
import { sendTelegramMessageToChat } from './telegram.js';

export const TELEGRAM_BROADCAST_MAX_TEXT_LENGTH = 3500;

const TELEGRAM_BROADCAST_DELAY_MS = 40;
const TELEGRAM_BROADCAST_MAX_ATTEMPTS = 6;
const TELEGRAM_BROADCAST_STALE_SENDING_MS = 10 * 60 * 1000;

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createBroadcastJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseBroadcastChatIds(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(item => String(item)).filter(Boolean);
}

function getTelegramRetryAfterMs(error: unknown) {
  if (!(error instanceof Error)) {
    return null;
  }

  const retryAfter = (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds;
  return retryAfter && retryAfter > 0 ? retryAfter * 1000 : null;
}

function nextBroadcastRetryAt(now: Date, attempts: number, error: unknown) {
  return new Date(
    now.getTime() +
      retryDelayMs(attempts, { baseMs: 2000, maxMs: 10 * 60 * 1000, retryAfterMs: getTelegramRetryAfterMs(error) }),
  );
}

async function moveBroadcastJobToDeadLetter(jobId: string, reason: string) {
  const job = await prisma.telegramBroadcastJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }

  await prisma.$transaction(async tx => {
    await tx.telegramBroadcastDeadLetter.upsert({
      where: { jobId: job.id },
      create: {
        jobId: job.id,
        reason,
        payloadJson: {
          textLength: job.text.length,
          total: job.total,
          sent: job.sent,
          failed: job.failed,
          attempts: job.attempts,
          nextIndex: job.nextIndex,
          lastError: job.lastError,
        },
      },
      update: {
        reason,
        payloadJson: {
          textLength: job.text.length,
          total: job.total,
          sent: job.sent,
          failed: job.failed,
          attempts: job.attempts,
          nextIndex: job.nextIndex,
          lastError: job.lastError,
        },
      },
    });

    await tx.telegramBroadcastJob.update({
      where: { id: job.id },
      data: {
        status: 'dead_letter',
        completedAt: new Date(),
        nextAttemptAt: null,
        lastError: reason,
      },
    });
  });
}

async function resetStaleBroadcastJobs(now: Date) {
  await prisma.telegramBroadcastJob.updateMany({
    where: {
      status: 'sending',
      completedAt: null,
      updatedAt: {
        lt: new Date(now.getTime() - TELEGRAM_BROADCAST_STALE_SENDING_MS),
      },
    },
    data: {
      status: 'failed',
      lastError: 'Job was stuck in sending state and was returned to retry queue',
      nextAttemptAt: now,
    },
  });
}

export async function getActiveTelegramBroadcastJob() {
  return prisma.telegramBroadcastJob.findFirst({
    where: {
      status: { in: ['pending', 'sending', 'failed'] },
      completedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createTelegramBroadcastJob(text: string) {
  const leads = await prisma.lead.findMany({
    where: { telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });
  const chatIds = Array.from(new Set(leads.map(lead => lead.telegramChatId).filter(Boolean))) as string[];
  const jobId = createBroadcastJobId();

  await prisma.telegramBroadcastJob.create({
    data: {
      id: jobId,
      status: chatIds.length > 0 ? 'pending' : 'completed',
      text,
      chatIds,
      total: chatIds.length,
      completedAt: chatIds.length > 0 ? null : new Date(),
      nextAttemptAt: chatIds.length > 0 ? new Date() : null,
    },
  });

  return { jobId, total: chatIds.length, queued: chatIds.length > 0, delayMs: TELEGRAM_BROADCAST_DELAY_MS };
}

export async function runTelegramBroadcastJobOnce(now = new Date()) {
  await resetStaleBroadcastJobs(now);

  const job = await prisma.telegramBroadcastJob.findFirst({
    where: {
      status: { in: ['pending', 'failed'] },
      completedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  if (!job) {
    return { checked: 0, sent: 0, failed: 0, deadLettered: 0 };
  }

  if (job.attempts >= TELEGRAM_BROADCAST_MAX_ATTEMPTS) {
    await moveBroadcastJobToDeadLetter(job.id, job.lastError ?? 'Telegram broadcast retry limit reached');
    return { checked: 1, sent: 0, failed: 0, deadLettered: 1 };
  }

  const claimed = await prisma.telegramBroadcastJob.updateMany({
    where: { id: job.id, status: job.status, completedAt: null },
    data: {
      status: 'sending',
      startedAt: job.startedAt ?? now,
      attempts: { increment: 1 },
      nextAttemptAt: null,
    },
  });
  if (claimed.count !== 1) {
    return { checked: 1, sent: 0, failed: 0, deadLettered: 0 };
  }

  const correlationId = createCorrelationId('telegram_broadcast');
  return runWithCorrelation(correlationId, async () => {
    const chatIds = parseBroadcastChatIds(job.chatIds);
    let sent = 0;

    for (let index = job.nextIndex; index < chatIds.length; index += 1) {
      const chatId = chatIds[index];
      try {
        await sendTelegramMessageToChat(chatId, job.text);
        await prisma.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            sent: { increment: 1 },
            nextIndex: index + 1,
            lastError: null,
          },
        });
        sent += 1;
      } catch (error) {
        const retryAt = nextBroadcastRetryAt(new Date(), job.attempts + 1, error);
        const attempts = job.attempts + 1;
        const shouldDeadLetter = attempts >= TELEGRAM_BROADCAST_MAX_ATTEMPTS;

        await prisma.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            status: shouldDeadLetter ? 'dead_letter' : 'failed',
            failed: { increment: 1 },
            lastError: normalizeError(error).slice(0, 2000),
            nextAttemptAt: shouldDeadLetter ? null : retryAt,
            completedAt: shouldDeadLetter ? new Date() : null,
          },
        });
        if (shouldDeadLetter) {
          await moveBroadcastJobToDeadLetter(job.id, normalizeError(error).slice(0, 2000));
        }
        logger.error({ jobId: job.id, chatId, retryAt, err: error }, 'Telegram broadcast recipient failed');
        return { checked: 1, sent, failed: 1, deadLettered: shouldDeadLetter ? 1 : 0 };
      }

      if (index < chatIds.length - 1) {
        await wait(TELEGRAM_BROADCAST_DELAY_MS);
      }
    }

    const completed = await prisma.telegramBroadcastJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        nextAttemptAt: null,
      },
    });

    await prisma.event.create({
      data: {
        eventName: 'telegram_broadcast_completed',
        source: 'worker',
        metadataJson: {
          jobId: job.id,
          total: completed.total,
          sent: completed.sent,
          failed: completed.failed,
          textLength: job.text.length,
        },
      },
    });

    return { checked: 1, sent, failed: 0, deadLettered: 0 };
  });
}

let broadcastInterval: NodeJS.Timeout | null = null;
let broadcastRunning = false;

export function startTelegramBroadcastWorker() {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  const tick = () => {
    if (broadcastRunning) {
      return;
    }
    broadcastRunning = true;
    runTelegramBroadcastJobOnce()
      .catch(error => logger.error({ err: error }, 'Telegram broadcast worker failed'))
      .finally(() => {
        broadcastRunning = false;
      });
  };

  broadcastInterval = setInterval(tick, 5000);
  setTimeout(tick, 1000);
  return broadcastInterval;
}

export function stopTelegramBroadcastWorker() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
}
