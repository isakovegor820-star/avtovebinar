process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.TELEGRAM_MANUAL_BROADCAST = 'on';
process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../src/lib/telegram.js', () => ({ sendTelegramMessageToChat: vi.fn() }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    lead: { findMany: vi.fn() },
    telegramBroadcastRecipient: {
      createMany: vi.fn(),
      count: vi.fn(),
    },
    telegramBroadcastJob: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/lib/env.js';
import {
  createTelegramBroadcastJob,
  previewTelegramBroadcastRecipients,
  snapshotTelegramBroadcastRecipients,
  TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE,
} from '../src/lib/telegramBroadcastWorker.js';

type MockFn = ReturnType<typeof vi.fn>;
const findMany = prisma.lead.findMany as unknown as MockFn;
const queryRaw = prisma.$queryRaw as unknown as MockFn;
const recipientStore = prisma.telegramBroadcastRecipient as unknown as {
  createMany: MockFn;
  count: MockFn;
};
const jobStore = prisma.telegramBroadcastJob as unknown as { create: MockFn };

function lead(index: number) {
  return {
    id: `lead-${String(index).padStart(5, '0')}`,
    telegramChatId: `chat-${index}`,
    consentRecords: [
      {
        id: `consent-${index}`,
        occurredAt: new Date('2026-08-05T08:00:00.000Z'),
        documentVersion: '2026-07-30.1',
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.TELEGRAM_MANUAL_BROADCAST = 'on';
});

describe('Telegram durable recipient pagination', () => {
  it('returns an exact 20k total with only a bounded audit sample', async () => {
    queryRaw.mockResolvedValue([{ total: 20_000n }]);
    findMany.mockResolvedValueOnce(Array.from({ length: 500 }, (_, index) => lead(index)));

    const result = await previewTelegramBroadcastRecipients();

    expect(result.total).toBe(20_000);
    expect(result.recipients).toHaveLength(TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE);
    expect(result.recipients.at(-1)?.chatId).toBe('chat-99');
    expect(result.sampleLimit).toBe(TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE);
    expect(result.sampleTruncated).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, orderBy: { id: 'asc' } }));
  });

  it('snapshots 20k recipients with page-sized createMany calls and no giant array', async () => {
    findMany.mockImplementation(async ({ cursor }: { cursor?: { id: string } }) => {
      const start = cursor ? Number(cursor.id.slice('lead-'.length)) + 1 : 0;
      if (start >= 20_000) return [];
      return Array.from({ length: Math.min(500, 20_000 - start) }, (_, offset) => lead(start + offset));
    });
    recipientStore.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({
      count: data.length,
    }));
    recipientStore.count.mockResolvedValue(20_000);

    const total = await snapshotTelegramBroadcastRecipients(prisma as never, 'job-20k');

    expect(total).toBe(20_000);
    expect(recipientStore.createMany).toHaveBeenCalledTimes(40);
    expect(findMany).toHaveBeenCalledTimes(41);
    const batches = recipientStore.createMany.mock.calls.map(call => call[0].data as unknown[]);
    expect(batches.every(batch => batch.length <= 500)).toBe(true);
    expect(batches.reduce((sum, batch) => sum + batch.length, 0)).toBe(20_000);
    expect(recipientStore.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('creates a manual job with empty legacy JSON and a normalized snapshot', async () => {
    findMany.mockResolvedValue([lead(0), lead(1)]);
    recipientStore.createMany.mockResolvedValue({ count: 2 });
    recipientStore.count.mockResolvedValue(2);
    const recipients = [lead(0), lead(1)].map(item => ({
      leadId: item.id,
      chatId: item.telegramChatId,
      consentRecordId: item.consentRecords[0].id,
      consentDocumentVersion: item.consentRecords[0].documentVersion,
      consentAt: item.consentRecords[0].occurredAt,
      inclusionReason: 'current consent',
    }));

    const result = await createTelegramBroadcastJob(
      {
        text: 'Важная новость',
        initiatedById: 'admin-1',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
      },
      {
        preview: {
          enabled: true,
          consentDocumentId: 'aspb-marketing-telegram-consent',
          consentDocumentVersion: '2026-07-30.1',
          total: 2,
          recipients,
          sampleLimit: 100,
          sampleTruncated: false,
        },
        tx: prisma as never,
      },
    );

    expect(result).toMatchObject({ total: 2, queued: true });
    expect(jobStore.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatIds: [],
        recipientSnapshot: Prisma.DbNull,
        total: 2,
      }),
    });
    expect(recipientStore.createMany).toHaveBeenCalledTimes(1);
    expect(recipientStore.createMany.mock.calls[0][0].data).toHaveLength(2);
  });
});
