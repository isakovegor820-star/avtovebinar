import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/email.js', () => ({
  verifyEmailConnectivity: vi.fn().mockRejectedValue(new Error('smtp://user:secret@smtp.internal:587 failed')),
}));

vi.mock('../src/lib/telegram.js', () => ({
  checkTelegramConnectivity: vi.fn().mockResolvedValue({ mode: 'send', username: 'private_bot' }),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [
      {
        subsystem: 'reminders',
        lastProgressAt: new Date(),
        deadlineAt: new Date(Date.now() + 180_000),
      },
    ]),
    emailOutboxJob: {
      count: vi.fn(async ({ where }: { where: { status: string } }) => (where.status === 'dead_letter' ? 2 : 0)),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  checkEmailOutbox,
  checkWorkerSubsystems,
  getDependencySummary,
  getEmailDeliveryReadiness,
} from '../src/lib/health.js';
import { EMAIL_OUTBOX_DUE_PENDING_SLA_MS } from '../src/lib/emailOutboxPolicy.js';

const emailOutboxStore = prisma.emailOutboxJob as unknown as {
  count: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
};
const workerHealthQuery = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

describe('public dependency health hygiene', () => {
  it('exposes only aggregate degradation without component identity, secrets or queue counts', async () => {
    const summary = await getDependencySummary();
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      ok: false,
      status: 'degraded',
    });
    expect(serialized).not.toContain('smtp');
    expect(serialized).not.toContain('telegram');
    expect(serialized).not.toContain('emailOutbox');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('smtp.internal');
    expect(serialized).not.toContain('private_bot');
    expect(serialized).not.toContain('deadLetter');
    expect(serialized).not.toContain('workerSubsystems');
    expect(serialized).not.toContain('lastProgressAt');
    expect(serialized).not.toContain('deadlineAt');

    await expect(getEmailDeliveryReadiness()).resolves.toEqual({
      available: false,
      status: 'degraded',
      retryAfterSeconds: 30,
    });
  });

  it('degrades protected outbox details when the oldest due job breaches the queue SLA', async () => {
    const now = new Date('2026-08-05T10:00:00.000Z');
    const overdueAt = new Date(now.getTime() - EMAIL_OUTBOX_DUE_PENDING_SLA_MS - 1);
    emailOutboxStore.count.mockResolvedValue(0);
    emailOutboxStore.findFirst.mockImplementation(async input =>
      input.where?.nextAttemptAt?.lte ? { nextAttemptAt: overdueAt, createdAt: overdueAt } : null,
    );

    await expect(checkEmailOutbox(now)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        staleSending: 0,
        oldestDuePendingAt: overdueAt,
        oldestDuePendingAgeMs: EMAIL_OUTBOX_DUE_PENDING_SLA_MS + 1,
        duePendingSlaMs: EMAIL_OUTBOX_DUE_PENDING_SLA_MS,
      }),
    );
  });

  it('degrades protected outbox details when a sending lease is stale', async () => {
    const now = new Date('2026-08-05T10:00:00.000Z');
    emailOutboxStore.count.mockImplementation(async input => (input.where?.updatedAt?.lt ? 1 : 0));
    emailOutboxStore.findFirst.mockResolvedValue(null);

    await expect(checkEmailOutbox(now)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        sending: 0,
        staleSending: 1,
        oldestDuePendingAt: null,
        oldestDuePendingAgeMs: null,
      }),
    );
  });

  it('degrades a stale active worker subsystem in protected details', async () => {
    const now = new Date('2026-08-05T10:00:00.000Z');
    workerHealthQuery.mockResolvedValueOnce([
      {
        subsystem: 'reminders',
        lastProgressAt: new Date('2026-08-05T09:55:00.000Z'),
        deadlineAt: new Date('2026-08-05T09:58:00.000Z'),
      },
    ]);

    await expect(checkWorkerSubsystems(now)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        expected: ['reminders'],
        missing: [],
        stale: ['reminders'],
      }),
    );
  });

  it('bounds outbox and worker progress queries when the database never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    emailOutboxStore.count.mockReturnValue(never);
    emailOutboxStore.findFirst.mockReturnValue(never);
    workerHealthQuery.mockReturnValue(never);

    try {
      const outboxResult = checkEmailOutbox();
      const workerResult = checkWorkerSubsystems();
      await vi.advanceTimersByTimeAsync(3500);

      await expect(outboxResult).resolves.toEqual({ ok: false, error: 'email outbox health timed out' });
      await expect(workerResult).resolves.toEqual({
        ok: false,
        error: 'worker subsystem health timed out',
        expected: ['reminders'],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
