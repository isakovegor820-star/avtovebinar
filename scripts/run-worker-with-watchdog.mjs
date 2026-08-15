#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const heartbeatPath = '/tmp/aspb-webinar-worker.heartbeat';
const heartbeatMaxAgeMs = 90_000;
const startupGraceMs = 120_000;
const checkIntervalMs = 30_000;
const sustainedFailureThreshold = 3;

let consecutiveFailures = 0;
let stopping = false;
let forcedExitTimer;

const healthChecks = [
  { label: 'worker process heartbeat', path: heartbeatPath, maxAgeMs: heartbeatMaxAgeMs },
  {
    label: 'reminders progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.reminders',
    maxAgeMs: 180_000,
  },
];
if (process.env.TELEGRAM_MANUAL_BROADCAST === 'on' || process.env.TELEGRAM_NEWS_BROADCAST === 'on') {
  healthChecks.push({
    label: 'broadcast progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.broadcast',
    maxAgeMs: 180_000,
  });
}
if (process.env.TELEGRAM_NEWS_BROADCAST === 'on') {
  healthChecks.push({
    label: 'news progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.news',
    maxAgeMs: 180_000,
  });
}
if (process.env.TELEGRAM_ADMIN_BOT_POLLING === 'on') {
  healthChecks.push({
    label: 'admin bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-admin',
    maxAgeMs: 120_000,
  });
}
if (
  process.env.TELEGRAM_PARTICIPANT_BOT_POLLING === 'on' ||
  (!process.env.TELEGRAM_PARTICIPANT_BOT_TOKEN && process.env.TELEGRAM_BOT_POLLING === 'on')
) {
  healthChecks.push({
    label: 'participant bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-participant',
    maxAgeMs: 120_000,
  });
}
if (process.env.TELEGRAM_CONSULTANT_BOT_POLLING === 'on') {
  healthChecks.push({
    label: 'consultant bot progress heartbeat',
    path: '/tmp/aspb-webinar-worker.progress.bot-consultant',
    maxAgeMs: 120_000,
  });
}

const worker = spawn(process.execPath, ['dist/src/server.js'], {
  env: process.env,
  stdio: 'inherit',
});

function stopWorker(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  worker.kill(signal);
  forcedExitTimer = setTimeout(() => worker.kill('SIGKILL'), 15_000);
  forcedExitTimer.unref();
}

async function heartbeatIsFresh(path, maxAgeMs) {
  const timestamp = Number(await readFile(path, 'utf8'));
  const ageMs = Date.now() - timestamp;
  return Number.isFinite(timestamp) && timestamp > 0 && ageMs >= 0 && ageMs <= maxAgeMs;
}

const startedAt = Date.now();
const watchdog = setInterval(async () => {
  if (stopping || Date.now() - startedAt < startupGraceMs) return;

  try {
    for (const check of healthChecks) {
      if (!(await heartbeatIsFresh(check.path, check.maxAgeMs))) {
        throw new Error(`${check.label} is stale or invalid`);
      }
    }
    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures += 1;
    console.error(
      `[worker-watchdog] heartbeat check failed (${consecutiveFailures}/${sustainedFailureThreshold}):`,
      error instanceof Error ? error.message : String(error),
    );
    if (consecutiveFailures >= sustainedFailureThreshold) {
      console.error('[worker-watchdog] sustained worker failure detected; exiting for container restart');
      process.exitCode = 1;
      stopWorker('SIGTERM');
    }
  }
}, checkIntervalMs);
watchdog.unref();

worker.on('error', error => {
  console.error('[worker-watchdog] failed to start worker:', error);
  process.exit(1);
});

worker.on('exit', (code, signal) => {
  clearInterval(watchdog);
  if (forcedExitTimer) clearTimeout(forcedExitTimer);
  if (stopping && process.exitCode === 1) {
    process.exit(1);
  }
  if (signal) {
    console.error(`[worker-watchdog] worker exited from signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopWorker(signal));
}
