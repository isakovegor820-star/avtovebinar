process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.TELEGRAM_NEWS_BROADCAST = 'on';
process.env.NODE_ENV = 'test';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const workerMocks = vi.hoisted(() => ({
  acquireTelegramBroadcastCreationLock: vi.fn(),
  previewTelegramBroadcastRecipientsForSnapshot: vi.fn(),
  runTelegramBroadcastJobOnce: vi.fn(),
  snapshotTelegramBroadcastRecipients: vi.fn(),
}));

vi.mock('../src/lib/telegramBroadcastWorker.js', () => ({
  ...workerMocks,
  TELEGRAM_BROADCAST_KIND_NEWS: 'telegram_news',
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    telegramNewsPost: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    telegramBroadcastJob: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { prisma };
});

import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { runTelegramNewsJobOnce } from '../src/lib/telegramNews.js';

type MockFn = ReturnType<typeof vi.fn>;
const newsPostStore = prisma.telegramNewsPost as unknown as {
  findFirst: MockFn;
  findMany: MockFn;
  create: MockFn;
};
const jobStore = prisma.telegramBroadcastJob as unknown as {
  create: MockFn;
  findUniqueOrThrow: MockFn;
};
afterEach(() => {
  vi.clearAllMocks();
  env.TELEGRAM_NEWS_BROADCAST = 'off';
});

describe('Telegram news durable delivery', () => {
  it('queues the exact durable audience without JSON arrays and lets exactly one concurrent tick send', async () => {
    env.TELEGRAM_NEWS_BROADCAST = 'on';
    env.TELEGRAM_NEWS_TIMES = '09:00';
    env.TELEGRAM_NEWS_RSS_URLS = '';
    newsPostStore.findFirst.mockResolvedValue(null);
    newsPostStore.findMany.mockResolvedValue([]);

    const consentAt = new Date('2026-08-05T08:00:00.000Z');
    const recipients = Array.from({ length: 100 }, (_, index) => ({
      leadId: `lead-${index}`,
      chatId: `chat-${index}`,
      consentRecordId: `consent-${index}`,
      consentDocumentVersion: '2026-07-30.1',
      consentAt,
      inclusionReason: 'current consent',
    }));
    workerMocks.previewTelegramBroadcastRecipientsForSnapshot.mockResolvedValue({
      enabled: false,
      consentDocumentId: 'aspb-marketing-telegram-consent',
      consentDocumentVersion: '2026-07-30.1',
      total: 20_000,
      recipients,
      sampleLimit: 100,
      sampleTruncated: true,
    });
    workerMocks.snapshotTelegramBroadcastRecipients.mockResolvedValue(20_000);
    workerMocks.runTelegramBroadcastJobOnce.mockResolvedValue({
      checked: 1,
      sent: 20_000,
      failed: 0,
      deadLettered: 0,
    });
    jobStore.findUniqueOrThrow.mockResolvedValue({
      status: 'completed',
      sent: 20_000,
      failed: 0,
    });

    const now = new Date('2026-08-05T06:30:00.000Z');
    const results = await Promise.all([runTelegramNewsJobOnce(now), runTelegramNewsJobOnce(now)]);

    expect(results.filter(result => !result.skipped)).toHaveLength(1);
    expect(results.filter(result => result.skipped)).toHaveLength(1);
    expect(workerMocks.acquireTelegramBroadcastCreationLock).toHaveBeenCalledTimes(1);
    expect(workerMocks.previewTelegramBroadcastRecipientsForSnapshot).toHaveBeenCalledWith(prisma, {
      requireActiveRegistration: false,
      onProgress: undefined,
    });
    expect(jobStore.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'telegram_news',
        total: 20_000,
        chatIds: [],
        recipientSnapshot: Prisma.DbNull,
        idempotencyKey: 'telegram-news:2026-08-05:09:00',
      }),
    });
    expect(workerMocks.snapshotTelegramBroadcastRecipients).toHaveBeenCalledWith(prisma, expect.any(String), {
      requireActiveRegistration: false,
      onProgress: undefined,
    });
    expect(workerMocks.runTelegramBroadcastJobOnce).toHaveBeenCalledTimes(1);
    expect(newsPostStore.create).toHaveBeenCalledTimes(1);
  });
});
