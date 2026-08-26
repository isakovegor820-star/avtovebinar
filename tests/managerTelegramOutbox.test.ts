process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    managerTelegramNotificationJob: prismaMocks,
  },
}));

vi.mock('../src/lib/telegram.js', () => ({
  isPermanentTelegramError: vi.fn(() => false),
  notifyPartnerApplication: vi.fn(),
  notifyQuestion: vi.fn(),
  notifyRegistration: vi.fn(),
}));

import {
  enqueueManagerTelegramNotification,
  runManagerTelegramNotificationJobsOnce,
} from '../src/lib/managerTelegramOutbox.js';

const now = new Date('2026-08-25T12:00:00.000Z');
const candidate = {
  id: 'manager-job-1',
  kind: 'registration',
  registrationId: 'registration-1',
  partnerApplicationId: null,
  questionId: null,
  attempts: 0,
  status: 'pending',
};
const claimedJob = {
  ...candidate,
  claimToken: 'claimed',
  status: 'sending',
  registration: {
    id: 'registration-1',
    status: 'registered',
    emailVerifiedAt: new Date('2026-08-25T11:00:00.000Z'),
    lead: {
      email: 'participant@example.test',
      personalDataConsentRevokedAt: null,
      name: 'Анна',
      phone: '+79995554433',
      city: 'Москва',
      professionalStatus: 'Юрист',
      source: 'campaign',
    },
    webinarSession: { scheduledAt: new Date('2026-08-25T16:30:00.000Z') },
  },
  partnerApplication: null,
  question: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.updateMany.mockResolvedValue({ count: 1 });
});

describe('manager Telegram durable outbox', () => {
  it('enqueues by a stable unique deduplication key inside the caller transaction', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'manager-job-1' });
    await enqueueManagerTelegramNotification(
      { managerTelegramNotificationJob: { upsert } } as never,
      {
        kind: 'registration',
        registrationId: 'registration-1',
        dedupKey: 'manager-telegram:registration:registration-1',
      },
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupKey: 'manager-telegram:registration:registration-1' },
        update: {},
      }),
    );
  });

  it('claims, rehydrates and marks a delivered notification sent', async () => {
    prismaMocks.findFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(claimedJob)
      .mockResolvedValueOnce(null);
    const sender = vi.fn().mockResolvedValue({ sent: true, mode: 'send' });

    await expect(runManagerTelegramNotificationJobsOnce(now, { sender, limit: 2 })).resolves.toEqual({
      checked: 1,
      sent: 1,
      failed: 0,
      cancelled: 0,
      deadLettered: 0,
    });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ registrationId: 'registration-1' }));
    expect(prismaMocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent', sentAt: expect.any(Date) }) }),
    );
  });

  it('honours and bounds Telegram retry_after when a 429 is returned', async () => {
    prismaMocks.findFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(claimedJob)
      .mockResolvedValueOnce(null);
    const throttled = Object.assign(new Error('Too Many Requests'), { retryAfterSeconds: 900 });
    const sender = vi.fn().mockRejectedValue(throttled);

    await expect(runManagerTelegramNotificationJobsOnce(now, { sender, limit: 2 })).resolves.toMatchObject({
      checked: 1,
      failed: 1,
    });
    expect(prismaMocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          nextAttemptAt: new Date(now.getTime() + 10 * 60 * 1000),
        }),
      }),
    );
  });
});
