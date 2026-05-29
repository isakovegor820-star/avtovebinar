import { app } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { startReminderScheduler } from './lib/reminders.js';
import { startParticipantTelegramBot } from './lib/telegramParticipantBot.js';
import { startAdminTelegramBot } from './lib/telegramAdminBot.js';
import { startTelegramNewsScheduler } from './lib/telegramNews.js';

app.listen(env.PORT, () => {
  logger.info({ url: env.PUBLIC_SITE_URL, port: env.PORT }, 'АСПБ autowebinar backend started');
});

startReminderScheduler();
startAdminTelegramBot();
startParticipantTelegramBot();
startTelegramNewsScheduler();
