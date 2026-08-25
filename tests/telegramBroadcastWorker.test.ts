process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.TELEGRAM_MANUAL_BROADCAST = 'on';
process.env.TELEGRAM_NEWS_BROADCAST = 'off';
process.env.NODE_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendTelegramMessageToChat } = vi.hoisted(() => ({ sendTelegramMessageToChat: vi.fn() }));

vi.mock('../src/lib/telegram.js', () => ({ sendTelegramMessageToChat }));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    telegramBroadcastJob: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    telegramBroadcastDeadLetter: { upsert: vi.fn() },
    telegramBroadcastRecipient: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    telegramNewsPost: { findMany: vi.fn(), updateMany: vi.fn() },
    event: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: any) => {
    if (typeof callback === 'function') return callback(prisma);
    return Promise.all(callback);
  });
  return { prisma };
});

import {
  runTelegramBroadcastJobOnce,
  TELEGRAM_DELIVERY_TRANSACTION_OPTIONS,
} from '../src/lib/telegramBroadcastWorker.js';
import { MARKETING_TELEGRAM_CONSENT } from '../src/lib/consentDocuments.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { TELEGRAM_BINDING_VERSION } from '../src/lib/roomLinks.js';

type MockFn = ReturnType<typeof vi.fn>;
const jobStore = prisma.telegramBroadcastJob as unknown as {
  findFirst: MockFn;
  updateMany: MockFn;
  findUnique: MockFn;
};
const recipientStore = prisma.telegramBroadcastRecipient as unknown as {
  findFirst: MockFn;
  findUnique: MockFn;
  updateMany: MockFn;
  count: MockFn;
};
const deadLetterStore = prisma.telegramBroadcastDeadLetter as unknown as { upsert: MockFn };
const newsPostStore = prisma.telegramNewsPost as unknown as { findMany: MockFn; updateMany: MockFn };
const eventStore = prisma.event as unknown as { create: MockFn };
const executeRaw = prisma.$executeRaw as unknown as MockFn;
const transaction = prisma.$transaction as unknown as MockFn;

let activeClaimToken: string | null = null;

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    kind: 'marketing_telegram',
    status: 'pending',
    attempts: 0,
    nextIndex: 0,
    chatIds: [],
    text: 'Новость для участников',
    total: 1,
    sent: 0,
    failed: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    claimToken: null,
    ...overrides,
  };
}

function eligibleRecipient(chatId: string, overrides: Record<string, any> = {}) {
  const { lead: leadOverrides = {}, consentRecord: consentOverrides = {}, ...recipientOverrides } = overrides;
  return {
    id: `recipient-${chatId}`,
    jobId: 'job-1',
    leadId: `lead-${chatId}`,
    chatId,
    status: 'pending',
    attempts: 0,
    consentDocumentVersion: MARKETING_TELEGRAM_CONSENT.version,
    ...recipientOverrides,
    lead: {
      email: `${chatId}@example.test`,
      telegramChatId: chatId,
      telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      marketingTelegramConsent: true,
      marketingTelegramConsentAt: new Date('2026-06-01T00:00:00.000Z'),
      marketingTelegramRevokedAt: null,
      personalDataConsentRevokedAt: null,
      ...leadOverrides,
    },
    consentRecord: {
      kind: 'marketing_telegram',
      action: 'grant',
      documentId: MARKETING_TELEGRAM_CONSENT.id,
      documentVersion: MARKETING_TELEGRAM_CONSENT.version,
      ...consentOverrides,
    },
  };
}

function queueDeliveries(...recipients: Array<ReturnType<typeof eligibleRecipient>>) {
  for (const recipient of recipients) {
    recipientStore.findFirst.mockResolvedValueOnce({
      id: recipient.id,
      leadId: recipient.leadId,
      chatId: recipient.chatId,
    });
    recipientStore.findUnique.mockResolvedValueOnce(recipient);
  }
  recipientStore.findFirst.mockResolvedValue(null);
  recipientStore.findUnique.mockResolvedValue(null);
}

beforeEach(() => {
  activeClaimToken = null;
  recipientStore.findFirst.mockResolvedValue(null);
  recipientStore.findUnique.mockResolvedValue(null);
  recipientStore.updateMany.mockResolvedValue({ count: 1 });
  recipientStore.count.mockResolvedValue(1);
  newsPostStore.findMany.mockResolvedValue([]);
  newsPostStore.updateMany.mockResolvedValue({ count: 1 });
  eventStore.create.mockResolvedValue({});
  jobStore.updateMany.mockImplementation(async input => {
    if (input.data?.status === 'sending' && typeof input.data?.claimToken === 'string') {
      activeClaimToken = input.data.claimToken;
    }
    if (input.where?.claimToken && input.where.claimToken !== activeClaimToken) {
      return { count: 0 };
    }
    if (input.data?.claimToken === null && input.where?.claimToken === activeClaimToken) {
      activeClaimToken = null;
    }
    return { count: 1 };
  });
  jobStore.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.claimToken && where.claimToken === activeClaimToken) {
      return { id: 'job-1', status: 'sending', completedAt: null };
    }
    // syncTelegramNewsPost intentionally observes no job in these focused worker tests.
    return null;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  env.TELEGRAM_MANUAL_BROADCAST = 'off';
  env.TELEGRAM_NEWS_BROADCAST = 'off';
});

describe('runTelegramBroadcastJobOnce — durable per-recipient delivery', () => {
  it('processes a news job while manual broadcasts are disabled', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'off';
    env.TELEGRAM_NEWS_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob({ kind: 'telegram_news' }));
    queueDeliveries(eligibleRecipient('111'));
    sendTelegramMessageToChat.mockResolvedValue({ sent: true, mode: 'send' as const });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(jobStore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: { in: ['telegram_news'] } }) }),
    );
    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageToChat).toHaveBeenCalledWith('111', 'Новость для участников', { attempts: 1 });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), TELEGRAM_DELIVERY_TRANSACTION_OPTIONS);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const deliveryLockSql = (executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('');
    expect(deliveryLockSql).toContain('48192734');
    expect(deliveryLockSql).not.toContain('48192731');
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(sendTelegramMessageToChat.mock.invocationCallOrder[0]);
    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, deadLettered: 0 });
  });

  it('keeps completion durable when analytics and first news sync fail, then reconciles on the next tick', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'off';
    env.TELEGRAM_NEWS_BROADCAST = 'on';
    const completedAt = new Date('2026-06-15T10:00:01.000Z');
    const completedJob = makeJob({
      kind: 'telegram_news',
      status: 'completed',
      sent: 1,
      completedAt,
    });
    jobStore.findFirst.mockResolvedValueOnce(makeJob({ kind: 'telegram_news' })).mockResolvedValueOnce(null);
    jobStore.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.claimToken && where.claimToken === activeClaimToken) {
        return { id: 'job-1', status: 'sending', completedAt: null };
      }
      return where.id === 'job-1' ? completedJob : null;
    });
    recipientStore.count.mockImplementation(async ({ where }: any) => (where.status === 'failed_permanent' ? 0 : 1));
    newsPostStore.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'job-1' }]);
    newsPostStore.updateMany
      .mockRejectedValueOnce(new Error('temporary news status write failure'))
      .mockResolvedValueOnce({ count: 1 });
    eventStore.create.mockRejectedValueOnce(new Error('analytics unavailable'));
    queueDeliveries(eligibleRecipient('111'));
    sendTelegramMessageToChat.mockResolvedValue({ sent: true, mode: 'send' as const });

    const first = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));
    const second = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:05.000Z'));

    expect(first).toEqual({ checked: 1, sent: 1, failed: 0, deadLettered: 0 });
    expect(second).toEqual({ checked: 0, sent: 0, failed: 0, deadLettered: 0 });
    expect(eventStore.create).toHaveBeenCalledTimes(1);
    expect(newsPostStore.updateMany).toHaveBeenCalledTimes(2);
    expect(newsPostStore.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'sent',
        recipientCount: 1,
        failedCount: 0,
        lastError: null,
        completedAt,
      },
    });
  });

  it('skips a permanently undeliverable recipient and continues with the rest', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob({ total: 3 }));
    recipientStore.count.mockResolvedValue(3);
    queueDeliveries(eligibleRecipient('111'), eligibleRecipient('222'), eligibleRecipient('333'));
    sendTelegramMessageToChat.mockImplementation(async (chatId: string) => {
      if (chatId === '222') throw new Error('Forbidden: bot was blocked by the user');
      return { sent: true, mode: 'send' as const };
    });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ checked: 1, sent: 2, failed: 1, deadLettered: 0 });
    expect(jobStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failed: { increment: 1 }, nextIndex: { increment: 1 } }),
      }),
    );
    expect(
      jobStore.updateMany.mock.calls.find(call => call[0].where?.id === 'job-1' && call[0].data?.status === 'failed'),
    ).toBeUndefined();
    expect(jobStore.updateMany.mock.calls.find(call => call[0].data?.status === 'completed')).toBeDefined();
  });

  it('does not dead-letter a fresh recipient when the legacy job attempts counter is already above six', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob({ attempts: 99 }));
    queueDeliveries(eligibleRecipient('111', { attempts: 0 }));
    sendTelegramMessageToChat.mockRejectedValue(
      Object.assign(new Error('Too Many Requests: retry after 5'), { retryAfterSeconds: 5 }),
    );

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, deadLettered: 0 });
    expect(deadLetterStore.upsert).not.toHaveBeenCalled();
    expect(jobStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', nextAttemptAt: expect.any(Date) }),
      }),
    );
    expect(recipientStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attempts: { increment: 1 }, status: 'pending' }) }),
    );
  });

  it('marks only an exhausted recipient terminal and continues with the next recipient', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob({ attempts: 50, total: 2 }));
    recipientStore.count.mockResolvedValue(2);
    queueDeliveries(eligibleRecipient('111', { attempts: 5 }), eligibleRecipient('222'));
    sendTelegramMessageToChat.mockImplementation(async (chatId: string) => {
      if (chatId === '111') throw new Error('temporary upstream reset');
      return { sent: true, mode: 'send' as const };
    });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(result).toEqual({ checked: 1, sent: 1, failed: 1, deadLettered: 0 });
    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(2);
    expect(recipientStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'recipient-111' }),
        data: expect.objectContaining({ status: 'failed_permanent' }),
      }),
    );
    expect(recipientStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'recipient-222' }),
        data: expect.objectContaining({ status: 'sent' }),
      }),
    );
    expect(deadLetterStore.upsert).not.toHaveBeenCalled();
  });

  it('does not exhaust a global budget when transient errors move between recipients after progress', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst
      .mockResolvedValueOnce(makeJob({ status: 'pending', attempts: 20, total: 2 }))
      .mockResolvedValueOnce(makeJob({ status: 'failed', attempts: 21, total: 2 }))
      .mockResolvedValueOnce(makeJob({ status: 'failed', attempts: 22, total: 2, sent: 1 }));
    recipientStore.count.mockResolvedValue(2);
    queueDeliveries(
      eligibleRecipient('111', { attempts: 0 }),
      eligibleRecipient('111', { attempts: 1 }),
      eligibleRecipient('222', { attempts: 0 }),
      eligibleRecipient('222', { attempts: 1 }),
    );
    sendTelegramMessageToChat
      .mockRejectedValueOnce(new Error('temporary reset for 111'))
      .mockResolvedValueOnce({ sent: true, mode: 'send' as const })
      .mockRejectedValueOnce(new Error('temporary reset for 222'))
      .mockResolvedValueOnce({ sent: true, mode: 'send' as const });

    const first = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));
    const second = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:01:00.000Z'));
    const third = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:02:00.000Z'));

    expect(first).toMatchObject({ sent: 0, failed: 1, deadLettered: 0 });
    expect(second).toMatchObject({ sent: 1, failed: 1, deadLettered: 0 });
    expect(third).toMatchObject({ sent: 1, failed: 0, deadLettered: 0 });
    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(4);
    expect(deadLetterStore.upsert).not.toHaveBeenCalled();
    expect(jobStore.updateMany.mock.calls.find(call => call[0].data?.status === 'completed')).toBeDefined();
  });

  it('does not send after Telegram consent was revoked', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob());
    queueDeliveries(
      eligibleRecipient('111', {
        lead: { marketingTelegramConsent: false, marketingTelegramRevokedAt: new Date() },
      }),
    );

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(sendTelegramMessageToChat).not.toHaveBeenCalled();
    expect(recipientStore.updateMany).toHaveBeenCalledWith({
      where: { id: 'recipient-111', status: 'pending', leadId: 'lead-111', chatId: '111' },
      data: expect.objectContaining({ status: 'skipped_revoked' }),
    });
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, deadLettered: 0 });
  });

  it('stops a stale worker after another worker takes the claim', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob());
    queueDeliveries(eligibleRecipient('111'));
    sendTelegramMessageToChat.mockImplementation(async () => {
      activeClaimToken = 'new-worker-claim';
      return { sent: true, mode: 'send' as const };
    });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(1);
    expect(recipientStore.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, deadLettered: 0 });
  });

  it('does not overwrite a recipient redacted after the provider call', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob());
    queueDeliveries(eligibleRecipient('111'));
    recipientStore.updateMany.mockResolvedValue({ count: 0 });
    sendTelegramMessageToChat.mockResolvedValue({ sent: true, mode: 'send' as const });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, deadLettered: 0 });
    expect(recipientStore.updateMany).toHaveBeenCalledWith({
      where: { id: 'recipient-111', status: 'pending', leadId: 'lead-111', chatId: '111' },
      data: expect.objectContaining({ status: 'sent' }),
    });
    const cursorUpdate = jobStore.updateMany.mock.calls.find(call => call[0].data?.nextIndex);
    expect(cursorUpdate?.[0].data.sent).toBeUndefined();
  });

  it('dead-letters a legacy job without a complete durable snapshot instead of reading JSON', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    jobStore.findFirst.mockResolvedValue(makeJob({ chatIds: ['legacy-chat'] }));
    recipientStore.count.mockResolvedValue(0);

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, deadLettered: 1 });
    expect(sendTelegramMessageToChat).not.toHaveBeenCalled();
    expect(deadLetterStore.upsert).toHaveBeenCalledTimes(1);
  });
});
