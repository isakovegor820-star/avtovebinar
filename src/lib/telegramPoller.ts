import { logger } from './logger.js';
import { telegramFetch } from './telegramProxy.js';

/**
 * Единый надёжный long-polling драйвер для всех Telegram-ботов АСПБ.
 *
 * Зачем: раньше три бота дублировали один и тот же poll-цикл с багами, из-за
 * которых боты «молча ломались»:
 *  - не было таймаута на fetch → зависший getUpdates оставлял бота мёртвым до рестарта;
 *  - не обрабатывался 409 Conflict (висящий webhook или второй инстанс на том же токене)
 *    → вечный hot-loop без восстановления;
 *  - не обрабатывался 429 retry_after и не было backoff на сетевых ошибках;
 *  - timeout=0 (short polling) долбил API каждые 3.5с.
 *
 * Этот драйвер: long polling (timeout=25s), AbortController на каждый запрос,
 * deleteWebhook перед стартом, явная обработка 409/429, экспоненциальный backoff
 * с jitter и сброс при успехе. Один self-scheduling цикл — без наложений тиков.
 */

type TelegramUpdateBase = { update_id: number };

type GetUpdatesResponse<TUpdate> = {
  ok: boolean;
  result?: TUpdate[];
  description?: string;
  parameters?: { retry_after?: number };
};

export type TelegramPoller = {
  start: () => void;
  stop: () => void;
};

export type TelegramPollerOptions<TUpdate extends TelegramUpdateBase> = {
  /** Человекочитаемое имя для логов, напр. 'ASPБ participant telegram bot'. */
  name: string;
  /** Бот-специфичный билдер URL, напр. participantTelegramApiUrl. */
  apiUrl: (method: string) => string;
  /** allowed_updates для getUpdates, напр. ['message'] или ['callback_query']. */
  allowedUpdates: string[];
  /** Полная проверка готовности (токен есть, polling включён и т.п.). */
  isEnabled: () => boolean;
  /** Обработчик одного апдейта. Ошибки внутри не останавливают цикл. */
  handleUpdate: (update: TUpdate) => Promise<void>;
};

const LONG_POLL_TIMEOUT_SECONDS = 25;
// Запрос должен иметь возможность блокироваться весь long-poll плюс запас на сеть,
// иначе AbortController оборвёт нормальный long polling.
const REQUEST_TIMEOUT_MS = (LONG_POLL_TIMEOUT_SECONDS + 10) * 1000;
const UPDATE_LIMIT = 20;
// Небольшая пауза между успешными long-poll'ами (getUpdates уже блокируется на сервере).
const IDLE_DELAY_MS = 300;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// 409: другой getUpdates или webhook на том же токене — ждём дольше, чтобы не воевать.
const CONFLICT_BACKOFF_MS = 15_000;

function jitter(ms: number) {
  return ms + Math.floor(Math.random() * 500);
}

export function createTelegramPoller<TUpdate extends TelegramUpdateBase>(
  options: TelegramPollerOptions<TUpdate>,
): TelegramPoller {
  let nextOffset = 0;
  let running = false;
  let stopped = true;
  let webhookCleared = false;
  let backoffMs = MIN_BACKOFF_MS;
  let timer: NodeJS.Timeout | null = null;
  let controller: AbortController | null = null;

  function schedule(delayMs: number) {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  /**
   * Снимает webhook перед поллингом (getUpdates и webhook взаимоисключающи:
   * если на боте остался webhook, getUpdates вечно отдаёт 409).
   * Возвращает true ТОЛЬКО при подтверждённом успехе — иначе вызывающий не
   * латчит флаг и повторит снятие на следующем тике.
   */
  async function clearWebhook(): Promise<boolean> {
    try {
      const response = await telegramFetch(options.apiUrl('deleteWebhook'), { method: 'POST' });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return body?.ok === true;
    } catch (error) {
      logger.warn({ err: error }, `[${options.name}] deleteWebhook failed (повторим на следующем тике)`);
      return false;
    }
  }

  /** Один цикл getUpdates. Возвращает задержку до следующего опроса (мс). */
  async function pollOnce(): Promise<number> {
    const url = new URL(options.apiUrl('getUpdates'));
    if (nextOffset) url.searchParams.set('offset', String(nextOffset));
    url.searchParams.set('limit', String(UPDATE_LIMIT));
    url.searchParams.set('timeout', String(LONG_POLL_TIMEOUT_SECONDS));
    url.searchParams.set('allowed_updates', JSON.stringify(options.allowedUpdates));

    controller = new AbortController();
    const abortTimer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    let payload: GetUpdatesResponse<TUpdate>;
    try {
      const response = await telegramFetch(url, { signal: controller.signal });
      payload = (await response.json()) as GetUpdatesResponse<TUpdate>;
    } finally {
      clearTimeout(abortTimer);
      controller = null;
    }

    if (!payload.ok) {
      const description = payload.description || 'getUpdates failed';
      const retryAfter = payload.parameters?.retry_after;
      if (/conflict/i.test(description)) {
        logger.warn(
          { description },
          `[${options.name}] getUpdates conflict — другой поллер или webhook активен на этом токене; backing off`,
        );
        // 409 может означать недоснятый webhook — повторим deleteWebhook на след. тике.
        webhookCleared = false;
        return jitter(CONFLICT_BACKOFF_MS);
      }
      if (retryAfter && retryAfter > 0) {
        logger.warn({ description, retryAfter }, `[${options.name}] getUpdates rate-limited`);
        return jitter(retryAfter * 1000);
      }
      throw new Error(description);
    }

    // Успех → сбрасываем backoff.
    backoffMs = MIN_BACKOFF_MS;
    for (const update of payload.result || []) {
      try {
        await options.handleUpdate(update);
      } catch (error) {
        logger.error({ err: error, updateId: update.update_id }, `[${options.name}] update handler failed`);
      } finally {
        // Сдвигаем offset даже при ошибке обработчика, чтобы «ядовитый» апдейт
        // не блокировал очередь навсегда.
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      }
    }
    return IDLE_DELAY_MS;
  }

  async function tick() {
    if (stopped || running) return;
    if (!options.isEnabled()) {
      schedule(MAX_BACKOFF_MS);
      return;
    }

    running = true;
    let delay = IDLE_DELAY_MS;
    try {
      if (!webhookCleared) {
        // Латчим только при подтверждённом снятии. Если deleteWebhook упал —
        // флаг остаётся false и следующий тик повторит попытку (иначе бот мог
        // навсегда залипнуть на 409 при недоснятом webhook).
        webhookCleared = await clearWebhook();
      }
      delay = await pollOnce();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Зависший запрос оборван по таймауту — это норма, опрашиваем снова сразу.
        logger.warn(`[${options.name}] getUpdates timed out; retrying`);
        delay = IDLE_DELAY_MS;
      } else {
        delay = jitter(backoffMs);
        logger.error({ err: error }, `[${options.name}] poll cycle failed; backing off ${delay}ms`);
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      }
    } finally {
      running = false;
      schedule(delay);
    }
  }

  return {
    start() {
      if (!stopped) return;
      if (!options.isEnabled()) return;
      stopped = false;
      webhookCleared = false;
      backoffMs = MIN_BACKOFF_MS;
      logger.info(`[${options.name}] polling enabled (long-poll ${LONG_POLL_TIMEOUT_SECONDS}s)`);
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (controller) {
        controller.abort();
        controller = null;
      }
    },
  };
}
