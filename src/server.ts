import { app } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { startReminderScheduler } from './lib/reminders.js';
import { startParticipantTelegramBot } from './lib/telegramParticipantBot.js';
import { startAdminTelegramBot } from './lib/telegramAdminBot.js';
import { startTelegramNewsScheduler } from './lib/telegramNews.js';

const backgroundHandles: NodeJS.Timeout[] = [];
let shuttingDown = false;

function reportProcessError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }

  return { message: String(error) };
}

function startBackgroundTask(name: string, start: () => NodeJS.Timeout | null) {
  try {
    const handle = start();
    if (handle) {
      backgroundHandles.push(handle);
    }
  } catch (error) {
    logger.error({ err: reportProcessError(error), task: name }, 'Background task failed to start');
  }
}

const server = app.listen(env.PORT, () => {
  logger.info({ url: env.PUBLIC_SITE_URL, port: env.PORT }, 'АСПБ autowebinar backend started');
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

startBackgroundTask('reminder scheduler', startReminderScheduler);
startBackgroundTask('admin telegram bot', startAdminTelegramBot);
startBackgroundTask('participant telegram bot', startParticipantTelegramBot);
startBackgroundTask('telegram news scheduler', startTelegramNewsScheduler);

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

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'Stopping АСПБ autowebinar backend');
  backgroundHandles.forEach(handle => clearInterval(handle));
  server.close(error => {
    if (error) {
      logger.error({ err: reportProcessError(error) }, 'Backend shutdown failed');
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
