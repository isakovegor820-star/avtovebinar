import { app } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { startReminderScheduler, stopReminderScheduler } from './lib/reminders.js';
import { startParticipantTelegramBot, stopParticipantTelegramBot } from './lib/telegramParticipantBot.js';
import { startAdminTelegramBot, stopAdminTelegramBot } from './lib/telegramAdminBot.js';
import { startConsultantTelegramBot, stopConsultantTelegramBot } from './lib/telegramConsultantBot.js';
import { startTelegramNewsScheduler, stopTelegramNewsScheduler } from './lib/telegramNews.js';
import { prisma } from './lib/prisma.js';
import { startTelegramBroadcastWorker, stopTelegramBroadcastWorker } from './lib/telegramBroadcastWorker.js';

type RuntimeHandle = {
  name: string;
  stop: () => void | Promise<void>;
};

const backgroundHandles: RuntimeHandle[] = [];
let shuttingDown = false;
let server: ReturnType<typeof app.listen> | null = null;
const workerRole = env.WORKER_ROLE ?? 'all';

function reportProcessError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }

  return { message: String(error) };
}

function startBackgroundTask(name: string, start: () => unknown, stop: () => void | Promise<void>) {
  try {
    const handle = start();
    if (handle) {
      backgroundHandles.push({ name, stop });
    }
  } catch (error) {
    logger.error({ err: reportProcessError(error), task: name }, 'Background task failed to start');
  }
}

function startApiWorker() {
  server = app.listen(env.PORT, () => {
    logger.info({ url: env.PUBLIC_SITE_URL, port: env.PORT, workerRole }, 'АСПБ autowebinar API started');
  });

  server.on('error', error => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EADDRINUSE') {
      logger.fatal({ port: env.PORT }, 'Backend port is already in use');
    } else {
      logger.fatal({ err: reportProcessError(error) }, 'Backend listen failed');
    }
    process.exit(1);
  });
}

function startWebinarWorker() {
  startBackgroundTask('reminder scheduler', startReminderScheduler, stopReminderScheduler);
  startBackgroundTask('admin telegram bot', startAdminTelegramBot, stopAdminTelegramBot);
  startBackgroundTask('participant telegram bot', startParticipantTelegramBot, stopParticipantTelegramBot);
  startBackgroundTask('consultant telegram bot', startConsultantTelegramBot, stopConsultantTelegramBot);
  startBackgroundTask('telegram news scheduler', startTelegramNewsScheduler, stopTelegramNewsScheduler);
  startBackgroundTask('telegram broadcast worker', startTelegramBroadcastWorker, stopTelegramBroadcastWorker);
  logger.info({ workerRole }, 'АСПБ autowebinar webinar worker started');
}

if (workerRole === 'api' || workerRole === 'all') {
  startApiWorker();
}
if (workerRole === 'webinar' || workerRole === 'all') {
  startWebinarWorker();
}

process.on('unhandledRejection', reason => {
  logger.error({ err: reportProcessError(reason) }, 'Unhandled promise rejection');
  if (env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

process.on('uncaughtException', error => {
  logger.fatal({ err: reportProcessError(error) }, 'Uncaught exception');
  if (env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

async function closeServer() {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      logger.warn('Force closing HTTP connections after graceful timeout');
      server?.closeAllConnections?.();
    }, 10_000);

    server?.close(error => {
      clearTimeout(forceTimer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server?.closeIdleConnections?.();
  });
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal, workerRole }, 'Stopping АСПБ autowebinar runtime');

  try {
    for (const handle of backgroundHandles) {
      logger.debug({ task: handle.name }, 'Stopping background task');
      await handle.stop();
    }
    await closeServer();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    logger.error({ err: reportProcessError(error) }, 'Runtime shutdown failed');
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
