process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed } from '../src/lib/telegramNews.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Telegram news RSS boundaries', () => {
  it('aborts a feed that does not answer within the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    const outcome = expect(fetchFeed('https://feed.example.test/private?token=secret')).rejects.toThrow(
      'RSS fetch timed out',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it('rejects an oversized streaming body without logging the configured URL', async () => {
    const oversizedChunk = new Uint8Array(1024 * 1024 + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream({ start: controller => controller.enqueue(oversizedChunk) }), {
            status: 200,
          }),
      ),
    );

    const failure: unknown = await fetchFeed('https://feed.example.test/private?token=secret').catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected the oversized RSS request to fail');
    expect(failure.message).toContain('larger than the configured limit');
    expect(failure.message).not.toContain('secret');
  });
});
