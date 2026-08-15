import { unlinkSync, writeFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const WORKER_HEARTBEAT_PATH = '/tmp/aspb-webinar-worker.heartbeat';
export const WORKER_PROGRESS_HEARTBEAT_PATH = '/tmp/aspb-webinar-worker.progress.reminders';
export const WORKER_PROCESS_HEARTBEAT_MAX_AGE_MS = 90_000;
export const WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS = 180_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const PROGRESS_DATABASE_WRITE_INTERVAL_MS = 15_000;

export const WORKER_SUBSYSTEMS = {
  reminders: {
    path: WORKER_PROGRESS_HEARTBEAT_PATH,
    maxAgeMs: WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS,
  },
  broadcast: {
    path: '/tmp/aspb-webinar-worker.progress.broadcast',
    maxAgeMs: 180_000,
  },
  news: {
    path: '/tmp/aspb-webinar-worker.progress.news',
    maxAgeMs: 180_000,
  },
  botAdmin: {
    path: '/tmp/aspb-webinar-worker.progress.bot-admin',
    maxAgeMs: 120_000,
  },
  botParticipant: {
    path: '/tmp/aspb-webinar-worker.progress.bot-participant',
    maxAgeMs: 120_000,
  },
  botConsultant: {
    path: '/tmp/aspb-webinar-worker.progress.bot-consultant',
    maxAgeMs: 120_000,
  },
} as const;

export type WorkerSubsystem = keyof typeof WORKER_SUBSYSTEMS;

type ProgressPersistenceState = {
  lastAttemptAt: number;
  inFlight: Promise<void> | null;
};

const progressPersistence = new Map<WorkerSubsystem, ProgressPersistenceState>();

let heartbeatTimer: NodeJS.Timeout | null = null;

export function writeWorkerHeartbeat(path = WORKER_HEARTBEAT_PATH, now = Date.now()) {
  writeFileSync(path, String(now), { encoding: 'utf8', mode: 0o600 });
}

export function writeWorkerProgressHeartbeat(path = WORKER_PROGRESS_HEARTBEAT_PATH, now = Date.now()) {
  writeFileSync(path, String(now), { encoding: 'utf8', mode: 0o600 });
}

export function initializeWorkerProgressHeartbeat(path = WORKER_PROGRESS_HEARTBEAT_PATH) {
  writeWorkerProgressHeartbeat(path);
}

async function persistWorkerSubsystemProgress(subsystem: WorkerSubsystem, now: number) {
  const progressAt = new Date(now);
  const deadlineAt = new Date(now + WORKER_SUBSYSTEMS[subsystem].maxAgeMs);
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "worker_subsystem_health" ("subsystem", "last_progress_at", "deadline_at", "updated_at")
      VALUES (${subsystem}, ${progressAt}, ${deadlineAt}, ${progressAt})
      ON CONFLICT ("subsystem") DO UPDATE SET
        "last_progress_at" = EXCLUDED."last_progress_at",
        "deadline_at" = EXCLUDED."deadline_at",
        "updated_at" = EXCLUDED."updated_at"
    `,
  );
}

export function reportWorkerSubsystemProgress(subsystem: WorkerSubsystem, now = Date.now(), force = false) {
  writeWorkerProgressHeartbeat(WORKER_SUBSYSTEMS[subsystem].path, now);

  const state = progressPersistence.get(subsystem) ?? { lastAttemptAt: 0, inFlight: null };
  progressPersistence.set(subsystem, state);
  if (state.inFlight || (!force && now - state.lastAttemptAt < PROGRESS_DATABASE_WRITE_INTERVAL_MS)) {
    return;
  }

  state.lastAttemptAt = now;
  state.inFlight = persistWorkerSubsystemProgress(subsystem, now)
    .catch(error => {
      logger.error({ err: error, subsystem }, '[ASPБ worker health] failed to persist subsystem progress');
    })
    .finally(() => {
      state.inFlight = null;
    });
}

export function initializeWorkerSubsystemProgress(subsystem: WorkerSubsystem) {
  reportWorkerSubsystemProgress(subsystem, Date.now(), true);
}

export function startWorkerHeartbeat(path = WORKER_HEARTBEAT_PATH, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  writeWorkerHeartbeat(path);
  heartbeatTimer = setInterval(() => writeWorkerHeartbeat(path), intervalMs);
  heartbeatTimer.unref();
}

export function stopWorkerHeartbeat(path = WORKER_HEARTBEAT_PATH) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function stopWorkerProgressHeartbeat(path = WORKER_PROGRESS_HEARTBEAT_PATH) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function stopWorkerSubsystemProgress(subsystem: WorkerSubsystem) {
  progressPersistence.delete(subsystem);
  stopWorkerProgressHeartbeat(WORKER_SUBSYSTEMS[subsystem].path);
}
