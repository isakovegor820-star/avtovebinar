import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeWorkerProgressHeartbeat,
  startWorkerHeartbeat,
  stopWorkerHeartbeat,
  stopWorkerProgressHeartbeat,
  WORKER_PROCESS_HEARTBEAT_MAX_AGE_MS,
  WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS,
  writeWorkerHeartbeat,
  writeWorkerProgressHeartbeat,
} from '../src/lib/workerHeartbeat.js';
import { SMTP_DELIVERY_BUDGET_MS } from '../src/lib/email.js';
import { EMAIL_OUTBOX_STALE_SENDING_MS } from '../src/lib/emailOutbox.js';

const tempDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('webinar worker heartbeat', () => {
  it('writes an initial heartbeat and removes it on shutdown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aspb-worker-heartbeat-'));
    tempDirectories.push(directory);
    const path = join(directory, 'heartbeat');

    startWorkerHeartbeat(path);
    expect(Number(readFileSync(path, 'utf8'))).toBeGreaterThan(0);

    stopWorkerHeartbeat(path);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('keeps the heartbeat fresh while a worker cycle is still running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T10:00:00.000Z'));
    const directory = mkdtempSync(join(tmpdir(), 'aspb-worker-heartbeat-'));
    tempDirectories.push(directory);
    const path = join(directory, 'heartbeat');

    startWorkerHeartbeat(path, 30_000);
    const initialTimestamp = Number(readFileSync(path, 'utf8'));
    vi.advanceTimersByTime(30_000);

    expect(Number(readFileSync(path, 'utf8'))).toBe(initialTimestamp + 30_000);
    stopWorkerHeartbeat(path);
  });

  it('stores the supplied timestamp for deterministic health checks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aspb-worker-heartbeat-'));
    tempDirectories.push(directory);
    const path = join(directory, 'heartbeat');

    writeWorkerHeartbeat(path, 123456789);
    expect(readFileSync(path, 'utf8')).toBe('123456789');
  });

  it('initializes and removes the independent progress heartbeat with the worker lifecycle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aspb-worker-progress-'));
    tempDirectories.push(directory);
    const path = join(directory, 'progress');

    initializeWorkerProgressHeartbeat(path);
    expect(Number(readFileSync(path, 'utf8'))).toBeGreaterThan(0);

    stopWorkerProgressHeartbeat(path);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('does not let the process timer hide a stuck progress pipeline', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-05T10:00:00.000Z').getTime();
    vi.setSystemTime(startedAt);
    const directory = mkdtempSync(join(tmpdir(), 'aspb-worker-heartbeats-'));
    tempDirectories.push(directory);
    const processPath = join(directory, 'process');
    const progressPath = join(directory, 'progress');

    startWorkerHeartbeat(processPath, 30_000);
    writeWorkerProgressHeartbeat(progressPath, startedAt);
    vi.advanceTimersByTime(WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS + 1);

    const now = Date.now();
    const processAge = now - Number(readFileSync(processPath, 'utf8'));
    const progressAge = now - Number(readFileSync(progressPath, 'utf8'));
    expect(processAge).toBeLessThanOrEqual(WORKER_PROCESS_HEARTBEAT_MAX_AGE_MS);
    expect(progressAge).toBeGreaterThan(WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS);
    stopWorkerHeartbeat(processPath);
    stopWorkerProgressHeartbeat(progressPath);
  });

  it('keeps one bounded SMTP delivery below heartbeat and stale-lease thresholds', () => {
    expect(SMTP_DELIVERY_BUDGET_MS).toBeLessThan(WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS);
    expect(WORKER_PROCESS_HEARTBEAT_MAX_AGE_MS).toBeLessThan(WORKER_PROGRESS_HEARTBEAT_MAX_AGE_MS);
    expect(EMAIL_OUTBOX_STALE_SENDING_MS).toBeGreaterThan(SMTP_DELIVERY_BUDGET_MS);
  });

  it('requires both process and progress files in the container healthcheck and watchdog', () => {
    const healthcheck = readFileSync('scripts/worker-healthcheck.mjs', 'utf8');
    const watchdog = readFileSync('scripts/run-worker-with-watchdog.mjs', 'utf8');

    for (const source of [healthcheck, watchdog]) {
      expect(source).toContain('/tmp/aspb-webinar-worker.heartbeat');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.reminders');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.broadcast');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.news');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.bot-admin');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.bot-participant');
      expect(source).toContain('/tmp/aspb-webinar-worker.progress.bot-consultant');
      expect(source).toContain('90_000');
      expect(source).toContain('120_000');
      expect(source).toContain('180_000');
    }
  });

  it('persists cross-container subsystem deadlines in an additive migration', () => {
    const migration = readFileSync('prisma/migrations/20260805140000_worker_subsystem_health/migration.sql', 'utf8');

    expect(migration).toContain('CREATE TABLE "worker_subsystem_health"');
    expect(migration).toContain('"last_progress_at" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain('"deadline_at" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain('PRIMARY KEY ("subsystem")');
  });
});
