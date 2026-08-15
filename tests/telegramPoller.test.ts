import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const progressMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  report: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/lib/workerHeartbeat.js', () => ({
  initializeWorkerSubsystemProgress: progressMocks.initialize,
  reportWorkerSubsystemProgress: progressMocks.report,
  stopWorkerSubsystemProgress: progressMocks.stop,
}));

import { createTelegramPoller } from '../src/lib/telegramPoller.js';

type FetchCall = { url: string; method: string };

/**
 * Минимальный мок Telegram API: подменяет глобальный fetch и отдаёт заранее
 * заготовленные ответы getUpdates/deleteWebhook. Возвращает журнал вызовов.
 */
function stubTelegram(getUpdatesResponder: (getUpdatesCallIndex: number) => unknown) {
  const calls: FetchCall[] = [];
  let getUpdatesIndex = 0;
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String((input as URL)?.toString?.() ?? input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('deleteWebhook')) {
      return { json: async () => ({ ok: true, result: true }) };
    }
    if (url.includes('getUpdates')) {
      const payload = getUpdatesResponder(getUpdatesIndex);
      getUpdatesIndex += 1;
      return { json: async () => payload };
    }
    return { json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return {
    calls,
    getUpdatesUrls: () => calls.filter(c => c.url.includes('getUpdates')).map(c => c.url),
    deleteWebhookCount: () => calls.filter(c => c.url.includes('deleteWebhook')).length,
  };
}

function makePoller(handleUpdate: (u: { update_id: number }) => Promise<void>, trackProgress = false) {
  return createTelegramPoller<{ update_id: number }>({
    name: 'test telegram bot',
    apiUrl: method => `https://api.telegram.org/botTEST/${method}`,
    allowedUpdates: ['message'],
    isEnabled: () => true,
    handleUpdate,
    ...(trackProgress ? { progressSubsystem: 'botParticipant' as const } : {}),
  });
}

describe('createTelegramPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('снимает webhook перед поллингом, доставляет апдейты и двигает offset', async () => {
    const handled: number[] = [];
    const tg = stubTelegram(i =>
      i === 0 ? { ok: true, result: [{ update_id: 5, message: { text: 'hi' } }] } : { ok: true, result: [] },
    );
    const poller = makePoller(async u => {
      handled.push(u.update_id);
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // первый тик: deleteWebhook + getUpdates
    await vi.advanceTimersByTimeAsync(350); // следующий long-poll
    poller.stop();

    expect(tg.deleteWebhookCount()).toBe(1); // webhook снят (иначе getUpdates вечно 409)
    expect(handled).toEqual([5]); // апдейт доставлен
    expect(tg.getUpdatesUrls()[1]).toContain('offset=6'); // offset сдвинут на update_id+1
    expect(tg.getUpdatesUrls()[0]).toContain('timeout=25'); // long polling, не short
  });

  it('409 Conflict → backoff без hot-loop, потом восстановление', async () => {
    const tg = stubTelegram(i =>
      i === 0
        ? { ok: false, description: 'Conflict: terminated by other getUpdates request' }
        : { ok: true, result: [] },
    );
    const poller = makePoller(async () => {});

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // тик с конфликтом
    const afterConflict = tg.getUpdatesUrls().length;

    // через 1с НЕ должно быть нового запроса (а старый код долбил бы каждые 3.5с)
    await vi.advanceTimersByTimeAsync(1000);
    expect(tg.getUpdatesUrls().length).toBe(afterConflict);

    // после backoff (~15с) опрос возобновляется
    await vi.advanceTimersByTimeAsync(16_000);
    expect(tg.getUpdatesUrls().length).toBeGreaterThan(afterConflict);
    poller.stop();
  });

  it('ошибка обработчика не роняет цикл и не блокирует очередь (offset двигается)', async () => {
    const tg = stubTelegram(i =>
      i === 0 ? { ok: true, result: [{ update_id: 9, message: { text: 'boom' } }] } : { ok: true, result: [] },
    );
    const poller = makePoller(async () => {
      throw new Error('handler failed');
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(350);
    poller.stop();

    // несмотря на падение обработчика, цикл продолжился и offset ушёл вперёд
    expect(tg.getUpdatesUrls()[1]).toContain('offset=10');
  });

  it('сетевая ошибка → экспоненциальный backoff, цикл не умирает', async () => {
    let failed = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String((input as URL)?.toString?.() ?? input);
      if (url.includes('deleteWebhook')) return { json: async () => ({ ok: true }) };
      // первые два getUpdates падают сетью, третий — успех
      if (failed < 2) {
        failed += 1;
        throw new Error('network down');
      }
      return { json: async () => ({ ok: true, result: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const poller = makePoller(async () => {});
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // 1-й getUpdates падает (backoff ~1с)
    await vi.advanceTimersByTimeAsync(8000); // переживаем 2-е падение и доходим до успеха
    poller.stop();

    const getUpdatesCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('getUpdates')).length;
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(3); // цикл пережил 2 падения и продолжил
  });

  it('повторяет deleteWebhook, если первая попытка не удалась (не латчит флаг при сбое)', async () => {
    let deleteCalls = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String((input as URL)?.toString?.() ?? input);
      if (url.includes('deleteWebhook')) {
        deleteCalls += 1;
        // первая попытка снять webhook — провал (ok:false), последующие — успех
        return { json: async () => ({ ok: deleteCalls > 1 }) };
      }
      return { json: async () => ({ ok: true, result: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const poller = makePoller(async () => {});
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // тик 1: deleteWebhook → ok:false → флаг не латчится
    await vi.advanceTimersByTimeAsync(1000); // тик 2: deleteWebhook повторяется → ok:true → латчится
    poller.stop();

    expect(deleteCalls).toBeGreaterThanOrEqual(2); // снятие webhook повторили после сбоя
  });

  it('tracks each enabled bot in an independent progress subsystem', async () => {
    stubTelegram(() => ({ ok: true, result: [] }));
    const poller = makePoller(async () => {}, true);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    expect(progressMocks.initialize).toHaveBeenCalledWith('botParticipant');
    expect(progressMocks.report).toHaveBeenCalledWith('botParticipant');
    expect(progressMocks.stop).toHaveBeenCalledWith('botParticipant');
  });
});
