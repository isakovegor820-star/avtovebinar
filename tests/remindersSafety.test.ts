import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendTelegramMessageToChat: vi.fn(),
  isPermanentTelegramError: vi.fn(() => false),
}));

vi.mock('../src/lib/telegram.js', () => ({
  sendTelegramMessageToChat: mocks.sendTelegramMessageToChat,
  isPermanentTelegramError: mocks.isPermanentTelegramError,
  telegramUrlButton: vi.fn((_label: string, url: string) => ({ inline_keyboard: [[{ url }]] })),
}));

vi.mock('../src/lib/emailOutbox.js', () => ({
  EMAIL_JOB_REMINDER: 'webinar_reminder',
  enqueueReminderEmail: vi.fn(),
  runEmailOutboxJobOnce: vi.fn(),
}));

vi.mock('../src/lib/roomLinks.js', () => ({
  TELEGRAM_BINDING_VERSION: 'v2_20260804',
  buildFrontendUrl: vi.fn((path: string) => `https://example.test${path}`),
  createRoomExchangeUrl: vi.fn(),
  getRoomTokenExpiresAt: vi.fn(),
}));

vi.mock('../src/lib/retention.js', () => ({ runRetentionSweepThrottled: vi.fn() }));
vi.mock('../src/lib/workerHeartbeat.js', () => ({
  initializeWorkerSubsystemProgress: vi.fn(),
  reportWorkerSubsystemProgress: vi.fn(),
  stopWorkerSubsystemProgress: vi.fn(),
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    $executeRaw: vi.fn(),
    registration: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    lead: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    registrationToken: { deleteMany: vi.fn() },
    emailOutboxJob: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  return { prisma };
});

import { prisma } from '../src/lib/prisma.js';
import { runTelegramFollowupJobOnce } from '../src/lib/reminders.js';

const registrationStore = prisma.registration as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const leadStore = prisma.lead as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};

function followupCandidate() {
  return {
    id: 'registration-1',
    leadId: 'lead-1',
    telegramFollowupSentAt: null,
    lead: {
      id: 'lead-1',
      telegramChatId: '12345',
      marketingTelegramConsent: true,
      marketingTelegramRevokedAt: null,
      updatedAt: new Date('2026-08-04T08:30:00.000Z'),
    },
    webinarSession: {
      scheduledAt: new Date('2026-08-04T08:00:00.000Z'),
      durationMinutes: 60,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.isPermanentTelegramError.mockReturnValue(false);
});

describe('Telegram follow-up consent and delivery lease', () => {
  const now = new Date('2026-08-04T09:11:00.000Z');

  it('rechecks consent immediately before send and releases the lease after revocation', async () => {
    registrationStore.findMany.mockResolvedValue([followupCandidate()]);
    registrationStore.updateMany.mockResolvedValue({ count: 1 });
    leadStore.findFirst.mockResolvedValue(null);

    const result = await runTelegramFollowupJobOnce(now);

    expect(mocks.sendTelegramMessageToChat).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0 });
    expect(registrationStore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: expect.objectContaining({
            marketingTelegramConsent: true,
            marketingTelegramRevokedAt: null,
          }),
        }),
      }),
    );
    expect(registrationStore.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { telegramFollowupClaimedUntil: null },
      }),
    );
  });

  it('writes sentAt only after Telegram accepts the message', async () => {
    registrationStore.findMany.mockResolvedValue([followupCandidate()]);
    registrationStore.updateMany.mockResolvedValue({ count: 1 });
    leadStore.findFirst.mockResolvedValue({ telegramChatId: '12345' });
    mocks.sendTelegramMessageToChat.mockResolvedValue({ sent: true, mode: 'send' });

    const result = await runTelegramFollowupJobOnce(now);

    expect(mocks.sendTelegramMessageToChat).toHaveBeenCalledTimes(1);
    expect(mocks.sendTelegramMessageToChat).toHaveBeenCalledWith(
      '12345',
      expect.any(String),
      expect.objectContaining({ attempts: 1 }),
    );
    expect(result).toEqual({ sent: 1 });
    const leaseUntil = registrationStore.updateMany.mock.calls[0][0].data.telegramFollowupClaimedUntil;
    expect(leaseUntil).toBeInstanceOf(Date);
    expect(registrationStore.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ telegramFollowupClaimedUntil: leaseUntil }),
        data: expect.objectContaining({
          telegramFollowupSentAt: expect.any(Date),
          telegramFollowupClaimedUntil: null,
        }),
      }),
    );
  });

  it('keeps sentAt empty and schedules a short retry after a temporary failure', async () => {
    registrationStore.findMany.mockResolvedValue([followupCandidate()]);
    registrationStore.updateMany.mockResolvedValue({ count: 1 });
    leadStore.findFirst.mockResolvedValue({ telegramChatId: '12345' });
    mocks.sendTelegramMessageToChat.mockRejectedValue(new Error('Telegram timeout'));

    const result = await runTelegramFollowupJobOnce(now);

    expect(result).toEqual({ sent: 0 });
    const leaseUntil = registrationStore.updateMany.mock.calls[0][0].data.telegramFollowupClaimedUntil;
    const retryUpdate = registrationStore.updateMany.mock.calls.at(-1)?.[0];
    expect(retryUpdate.data.telegramFollowupSentAt).toBeUndefined();
    expect(retryUpdate.data.telegramFollowupClaimedUntil).toBeInstanceOf(Date);
    expect(retryUpdate.where.telegramFollowupClaimedUntil).toEqual(leaseUntil);
  });

  it('clears a permanently undeliverable chat instead of fabricating a successful send', async () => {
    registrationStore.findMany.mockResolvedValue([followupCandidate()]);
    registrationStore.updateMany.mockResolvedValue({ count: 1 });
    leadStore.findFirst.mockResolvedValue({ telegramChatId: '12345' });
    mocks.sendTelegramMessageToChat.mockRejectedValue(new Error('bot was blocked'));
    mocks.isPermanentTelegramError.mockReturnValue(true);
    leadStore.updateMany.mockResolvedValue({ count: 1 });

    const result = await runTelegramFollowupJobOnce(now);

    expect(result).toEqual({ sent: 0 });
    expect(leadStore.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'lead-1',
        telegramChatId: '12345',
        updatedAt: new Date('2026-08-04T08:30:00.000Z'),
      },
      data: { telegramChatId: null },
    });
    expect(
      registrationStore.updateMany.mock.calls.some(call => call[0].data.telegramFollowupSentAt !== undefined),
    ).toBe(false);
  });

  it('does not clear a valid chat when a stale worker lost its permanent-error lease', async () => {
    registrationStore.findMany.mockResolvedValue([followupCandidate()]);
    registrationStore.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    leadStore.findFirst.mockResolvedValue({ telegramChatId: '12345' });
    mocks.sendTelegramMessageToChat.mockRejectedValue(new Error('bot was blocked'));
    mocks.isPermanentTelegramError.mockReturnValue(true);

    const result = await runTelegramFollowupJobOnce(now);

    expect(result).toEqual({ sent: 0 });
    expect(leadStore.updateMany).not.toHaveBeenCalled();
  });
});
