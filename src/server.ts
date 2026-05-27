import { app } from './app.js';
import { env } from './lib/env.js';
import { startReminderScheduler } from './lib/reminders.js';
import { startParticipantTelegramBot } from './lib/telegramParticipantBot.js';
import { startAdminTelegramBot } from './lib/telegramAdminBot.js';
import { startTelegramNewsScheduler } from './lib/telegramNews.js';

app.listen(env.PORT, () => {
  console.log(`АСПБ autowebinar backend: ${env.PUBLIC_SITE_URL}`);
  console.log(`Admin panel: ${env.PUBLIC_SITE_URL}/admin`);
});

startReminderScheduler();
startAdminTelegramBot();
startParticipantTelegramBot();
startTelegramNewsScheduler();

