process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const telegramMocks = vi.hoisted(() => ({
  sendTelegramMessageToChat: vi.fn(),
}));

vi.mock('../src/lib/telegram.js', () => ({
  buildTelegramStartUrl: vi.fn(),
  formatMoscowDate: vi.fn(),
  hasParticipantTelegramBot: vi.fn(() => false),
  isParticipantBotPollingEnabled: vi.fn(() => false),
  notifyRegistration: vi.fn(),
  notifyTelegramBotStart: vi.fn(),
  notifyTelegramSubscription: vi.fn(),
  participantTelegramApiUrl: vi.fn(),
  sendTelegramMessageToChat: telegramMocks.sendTelegramMessageToChat,
  telegramUrlButton: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    lead: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    registration: { findMany: vi.fn() },
    event: { findFirst: vi.fn() },
    telegramBotEvent: { upsert: vi.fn() },
    telegramBroadcastRecipient: { updateMany: vi.fn() },
    consentRecord: { create: vi.fn() },
    unsubscribeToken: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: ((tx: typeof prisma) => unknown) | Array<Promise<unknown>>) =>
      Array.isArray(callback) ? Promise.all(callback) : callback(prisma),
  );
  return { prisma };
});

import { prisma } from '../src/lib/prisma.js';
import { registrationRouter } from '../src/routes/public/registration.js';
import { TELEGRAM_BINDING_VERSION } from '../src/lib/roomLinks.js';
import {
  handleParticipantTelegramUpdate,
  TELEGRAM_REVOCATION_TRANSACTION_OPTIONS,
} from '../src/lib/telegramParticipantBot.js';
import { buildUnsubscribeToken } from '../src/lib/unsubscribe.js';

type MockFn = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  lead: { findFirst: MockFn; findUnique: MockFn; update: MockFn };
  registration: { findMany: MockFn };
  event: { findFirst: MockFn };
  telegramBotEvent: { upsert: MockFn };
  telegramBroadcastRecipient: { updateMany: MockFn };
  consentRecord: { create: MockFn };
  unsubscribeToken: { create: MockFn; findUnique: MockFn; updateMany: MockFn };
  $executeRaw: MockFn;
  $queryRaw: MockFn;
  $transaction: MockFn;
};

function unsubscribeHandler() {
  const layer = (registrationRouter as any).stack.find(
    (item: any) => item.route?.path === '/unsubscribe' && item.route.methods.post,
  );
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: (error?: unknown) => void) => void;
}

function invokeEmailUnsubscribe(token: string) {
  return new Promise<{ status: number; body?: string; error?: unknown }>(resolve => {
    let status = 200;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      type() {
        return this;
      },
      setHeader() {
        return this;
      },
      send(body: string) {
        resolve({ status, body });
      },
    };
    unsubscribeHandler()(
      {
        body: { token },
        headers: { 'user-agent': 'vitest' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      response,
      error => resolve({ status, error }),
    );
  });
}

function currentLead() {
  return {
    id: 'lead-1',
    email: 'participant@example.test',
    personalDataConsentRevokedAt: null,
    telegramChatId: '111',
    telegramBindingVersion: TELEGRAM_BINDING_VERSION,
    marketingEmailConsent: true,
    marketingEmailConsentAt: null,
    marketingTelegramConsent: true,
    consentRecords: [{ id: 'consent-1' }],
  };
}

let unsubscribeTokenRecord: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  const lead = currentLead();
  prismaMock.lead.findFirst.mockResolvedValue(lead);
  prismaMock.lead.findUnique.mockResolvedValue(lead);
  prismaMock.lead.update.mockResolvedValue(lead);
  prismaMock.registration.findMany.mockResolvedValue([]);
  prismaMock.$queryRaw.mockResolvedValue([
    { occurredAt: new Date(), correlationId: 'participant-analytics-correlation' },
  ]);
  prismaMock.telegramBotEvent.upsert.mockResolvedValue({});
  prismaMock.telegramBroadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.consentRecord.create.mockResolvedValue({});
  prismaMock.unsubscribeToken.create.mockImplementation(async ({ data }: any) => {
    unsubscribeTokenRecord = {
      id: 'unsubscribe-token-1',
      ...data,
      usedAt: null,
      revokedAt: null,
      updatedAt: data.createdAt,
      lead,
    };
    return unsubscribeTokenRecord;
  });
  prismaMock.unsubscribeToken.findUnique.mockImplementation(async () => unsubscribeTokenRecord);
  prismaMock.unsubscribeToken.updateMany.mockImplementation(async ({ data }: any) => {
    if (unsubscribeTokenRecord.usedAt || unsubscribeTokenRecord.revokedAt) return { count: 0 };
    unsubscribeTokenRecord = { ...unsubscribeTokenRecord, ...data };
    return { count: 1 };
  });
  prismaMock.$executeRaw.mockResolvedValue(1);
  prismaMock.$transaction.mockImplementation(
    async (callback: ((tx: typeof prismaMock) => unknown) | Array<Promise<unknown>>) =>
      Array.isArray(callback) ? Promise.all(callback) : callback(prismaMock),
  );
  telegramMocks.sendTelegramMessageToChat.mockResolvedValue({ sent: true, mode: 'send' });
});

describe('unsubscribe transaction lock budget', () => {
  it('gives Telegram unsubscribe enough bounded time to wait for an in-flight provider delivery', async () => {
    await handleParticipantTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: '/unsubscribe',
        chat: { id: '111', type: 'private' },
      },
    });

    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), TELEGRAM_REVOCATION_TRANSACTION_OPTIONS);
    expect(TELEGRAM_REVOCATION_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(20_000);
    const lockSql = prismaMock.$executeRaw.mock.calls.map(call => (call[0] as { strings: string[] }).strings.join(''));
    expect(lockSql).toHaveLength(2);
    expect(lockSql[0]).toContain('48192734');
    expect(lockSql[1]).toContain('48192731');
    expect(prismaMock.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ marketingTelegramConsent: false }) }),
    );
  });

  it('keeps email unsubscribe on the short Lead-only transaction path', async () => {
    const token = await buildUnsubscribeToken('participant@example.test');
    expect(token).toBeTruthy();

    const response = await invokeEmailUnsubscribe(token!);

    expect(response.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    const lockSql = (prismaMock.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('');
    expect(lockSql).toContain('48192731');
    expect(lockSql).not.toContain('48192733');
    expect(lockSql).not.toContain('48192734');
    expect(prismaMock.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ marketingEmailConsent: false }) }),
    );
    expect(prismaMock.unsubscribeToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usedAt: expect.any(Date) } }),
    );
  });

  it('consumes the DB-hashed unsubscribe capability once and rejects replay', async () => {
    const token = await buildUnsubscribeToken('participant@example.test');
    expect(token).toBeTruthy();

    await expect(invokeEmailUnsubscribe(token!)).resolves.toMatchObject({ status: 200 });
    await expect(invokeEmailUnsubscribe(token!)).resolves.toMatchObject({ status: 400 });
    expect(prismaMock.unsubscribeToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.lead.update).toHaveBeenCalledTimes(1);
  });
});
