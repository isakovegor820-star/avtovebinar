import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
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

// Жёсткий дедлайн на запрос к Telegram. Без него зависший сокет (особенно через
// прокси/WARP) держал бы await бесконечно и подвешивал весь reminder-цикл/рассылку.
const TELEGRAM_REQUEST_TIMEOUT_MS = 20_000;

export function telegramFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  // Если вызывающий уже задал свой signal (long-poll в поллере имеет собственный таймаут) —
  // уважаем его; иначе добавляем дедлайн, чтобы отправка не могла зависнуть навсегда.
  const withDeadline: RequestInit = init.signal
    ? init
    : { ...init, signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS) };

  if (!telegramProxyAgent) {
    return fetch(input, withDeadline);
  }
  // Через прокси берём fetch ИЗ пакета undici (тот же, что и ProxyAgent): смешивать
  // встроенный в Node undici с ProxyAgent из внешнего пакета нельзя — несовместимый
  // dispatcher (ошибка "invalid onRequestStart method").
  return undiciFetch(input, {
    ...(withDeadline as UndiciRequestInit),
    dispatcher: telegramProxyAgent,
  }) as unknown as Promise<Response>;
}
