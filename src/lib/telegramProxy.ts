import { ProxyAgent } from 'undici';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Обход блокировки Telegram из РФ-дата-центров.
 *
 * Прямой доступ к api.telegram.org из дата-центра режется DPI (RKN): connect
 * то висит таймаутом, то сбрасывается. Если задан TELEGRAM_HTTPS_PROXY, ВСЕ
 * исходящие запросы к Telegram идут через этот HTTP-прокси (на проде — локальный
 * privoxy → Cloudflare WARP), а всё остальное (сайт, БД, SMTP) — напрямую.
 *
 * Прокси затрагивает ТОЛЬКО Telegram: помощник используется в telegram.ts и
 * telegramPoller.ts, больше нигде.
 */
const proxyUrl = env.TELEGRAM_HTTPS_PROXY?.trim();
const telegramProxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

if (telegramProxyAgent) {
  logger.info({ proxy: proxyUrl }, '[ASPБ telegram] исходящие к Telegram идут через прокси (обход блокировки)');
}

export function telegramFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (!telegramProxyAgent) {
    return fetch(input, init);
  }
  // dispatcher — расширение undici для глобального fetch (в типе RequestInit его нет).
  return fetch(input, { ...init, dispatcher: telegramProxyAgent } as RequestInit);
}
