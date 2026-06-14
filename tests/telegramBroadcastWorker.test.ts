process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Мок отправки в Telegram — на уровне границы sendTelegramMessageToChat, чтобы обойти внутренние
// ретраи/circuit-breaker и детерминированно проверять именно логику воркера (skip vs pause).
const { sendTelegramMessageToChat } = vi.hoisted(() => ({ sendTelegramMessageToChat: vi.fn() }));

vi.mock('../src/lib/telegram.js', () => ({ sendTelegramMessageToChat }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    telegramBroadcastJob: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    telegramBroadcastDeadLetter: { upsert: vi.fn() },
    event: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { runTelegramBroadcastJobOnce } from '../src/lib/telegramBroadcastWorker.js';
import { prisma } from '../src/lib/prisma.js';

type MockFn = ReturnType<typeof vi.fn>;
const jobStore = prisma.telegramBroadcastJob as unknown as {
  findFirst: MockFn;
  updateMany: MockFn;
  update: MockFn;
  findUnique: MockFn;
};

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    status: 'pending',
    attempts: 0,
    nextIndex: 0,
    chatIds: ['111', '222', '333'],
    text: 'Новость для участников',
    total: 3,
    sent: 0,
    failed: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runTelegramBroadcastJobOnce — устойчивость к «мёртвым» получателям', () => {
  it('пропускает навсегда недоставляемого получателя и продолжает рассылку остальным', async () => {
    jobStore.findFirst.mockResolvedValue(makeJob());
    jobStore.updateMany.mockResolvedValue({ count: 1 });
    jobStore.update.mockResolvedValue({ sent: 2, failed: 1, total: 3 });

    sendTelegramMessageToChat.mockImplementation(async (chatId: string) => {
      if (chatId === '222') {
        // Типичный ответ Telegram, когда пользователь заблокировал бота.
        throw new Error('Forbidden: bot was blocked by the user');
      }
      return { sent: true, mode: 'send' as const };
    });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    // Все три получателя обработаны — рассылка не «утонула» на заблокированном.
    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ checked: 1, sent: 2, failed: 1, deadLettered: 0 });

    // Заблокированный получатель пропущен: nextIndex сдвинут за него (=2), failed++,
    // и статус НЕ переведён в failed (джоба не встала на паузу).
    const skipUpdate = jobStore.update.mock.calls.find(call => call[0].data?.nextIndex === 2);
    expect(skipUpdate).toBeDefined();
    expect(skipUpdate?.[0].data).toMatchObject({ failed: { increment: 1 }, nextIndex: 2 });
    expect(skipUpdate?.[0].data.status).toBeUndefined();

    // Ни один апдейт не поставил всю джобу на паузу из-за одного мёртвого chatId.
    const pausedUpdate = jobStore.update.mock.calls.find(call => call[0].data?.status === 'failed');
    expect(pausedUpdate).toBeUndefined();

    // Финальный апдейт — completed.
    const completedUpdate = jobStore.update.mock.calls.find(call => call[0].data?.status === 'completed');
    expect(completedUpdate).toBeDefined();
  });

  it('ставит всю рассылку на ретрай при временной ошибке (429), не пропуская получателя', async () => {
    jobStore.findFirst.mockResolvedValue(makeJob({ chatIds: ['111', '222'], total: 2 }));
    jobStore.updateMany.mockResolvedValue({ count: 1 });
    jobStore.update.mockResolvedValue({});

    sendTelegramMessageToChat.mockImplementation(async (chatId: string) => {
      if (chatId === '111') {
        // 429: общий троттлинг, а не «мёртвый» получатель — пропускать его нельзя.
        throw Object.assign(new Error('Too Many Requests: retry after 5'), { retryAfterSeconds: 5 });
      }
      return { sent: true, mode: 'send' as const };
    });

    const result = await runTelegramBroadcastJobOnce(new Date('2026-06-15T10:00:00.000Z'));

    // На 429 рассылка останавливается на текущем получателе: не пропускает его и не идёт дальше.
    expect(sendTelegramMessageToChat).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, deadLettered: 0 });

    // Статус переведён в failed (ретрай по backoff), назначен nextAttemptAt.
    const pausedUpdate = jobStore.update.mock.calls.find(call => call[0].data?.status === 'failed');
    expect(pausedUpdate).toBeDefined();
    expect(pausedUpdate?.[0].data.nextAttemptAt).toBeInstanceOf(Date);
  });
});
