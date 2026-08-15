import { readFile } from 'node:fs/promises';

const checks = [
  {
    label: 'worker process heartbeat',
    path: '/tmp/aspb-webinar-worker.heartbeat',
    // The process writes every 30s; three missed writes indicate a blocked event loop.
    maxAgeMs: 90_000,
  },
  {
    label: 'reminders progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.reminders',
    // Healthy cycles tick every 60s. 180s is also safely above one bounded SMTP
    // delivery (55s) or Telegram request (20s), but catches a stuck pipeline.
    maxAgeMs: 180_000,
  },
];

if (process.env.TELEGRAM_MANUAL_BROADCAST === 'on' || process.env.TELEGRAM_NEWS_BROADCAST === 'on') {
  checks.push({
    label: 'broadcast progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.broadcast',
    maxAgeMs: 180_000,
  });
}
if (process.env.TELEGRAM_NEWS_BROADCAST === 'on') {
  checks.push({
    label: 'news progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.news',
    maxAgeMs: 180_000,
  });
}
if (process.env.TELEGRAM_ADMIN_BOT_POLLING === 'on') {
  checks.push({
    label: 'admin bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-admin',
    maxAgeMs: 120_000,
  });
}
if (
  process.env.TELEGRAM_PARTICIPANT_BOT_POLLING === 'on' ||
  (!process.env.TELEGRAM_PARTICIPANT_BOT_TOKEN && process.env.TELEGRAM_BOT_POLLING === 'on')
) {
  checks.push({
    label: 'participant bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-participant',
    maxAgeMs: 120_000,
  });
}
if (process.env.TELEGRAM_CONSULTANT_BOT_POLLING === 'on') {
  checks.push({
    label: 'consultant bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-consultant',
    maxAgeMs: 120_000,
  });
}

try {
  const now = Date.now();
  for (const check of checks) {
    const timestamp = Number(await readFile(check.path, 'utf8'));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(`${check.label} is invalid`);
    }
    const ageMs = now - timestamp;
    if (ageMs < 0 || ageMs > check.maxAgeMs) {
      throw new Error(`${check.label} is stale (${ageMs}ms)`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
