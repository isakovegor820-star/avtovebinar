/**
 * analytics.js — трекинг событий и данные для инсайтов.
 */

import { API } from './state.js';
import { csrfHeaders, utm } from './utils.js?v=prelaunch-20260825-2';

const ANALYTICS_SCHEMA_VERSION = 1;
const ANALYTICS_QUEUE_KEY = 'aspb_analytics_queue_v1';
const MAX_QUEUE_ITEMS = 100;
const MAX_RETRY_DELAY_MS = 60_000;
let operationSequence = 0;
const pageOperationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pending = new Map();
let flushPromise = null;
let flushTimer = 0;
let exitTracked = false;

function sourceForEvent(eventName, metadata = {}) {
  if (eventName === 'viewer_heartbeat' && metadata.playbackMode === 'replay') return 'replay';
  if (eventName.startsWith('recording') || eventName === 'recordings_open') return 'replay';
  if (
    eventName.startsWith('video_') ||
    eventName.startsWith('cta_') ||
    eventName === 'sound_on' ||
    eventName.startsWith('question_') ||
    eventName.startsWith('partner_') ||
    eventName === 'viewer_heartbeat'
  ) return 'room';
  if (eventName === 'chapter_open' || eventName === 'transcript_search') return 'room';
  if (eventName.startsWith('registration_')) return 'registration';
  return 'web';
}

function attributesForEvent(eventName, metadata = {}) {
  if (eventName === 'question_submit_error' || eventName === 'partner_application_error') {
    return { failureCode: 'client_request_failed' };
  }
  if (eventName === 'recording_cta_click') {
    return {
      ...(typeof metadata.recordingId === 'string' ? { recordingId: metadata.recordingId } : {}),
      ...(Number.isInteger(metadata.index) ? { index: metadata.index } : {}),
      ...(metadata.source === 'success' ? { placement: 'success' } : {}),
      ...(typeof metadata.locked === 'boolean' ? { locked: metadata.locked } : {}),
    };
  }
  if (eventName.startsWith('recording_')) {
    return typeof metadata.recordingId === 'string' ? { recordingId: metadata.recordingId } : {};
  }
  if (eventName === 'question_submit_attempt') {
    return { textLength: Math.max(0, Math.min(4000, Number(metadata.textLength) || 0)) };
  }
  if (eventName === 'viewer_heartbeat') {
    return {
      intervalNumber: Math.max(0, Math.min(100000, Math.trunc(Number(metadata.intervalNumber) || 0))),
      ...(Number.isFinite(metadata.positionSeconds) ? { positionSeconds: Math.max(0, Number(metadata.positionSeconds)) } : {}),
      ...(Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds > 0 ? { durationSeconds: Number(metadata.durationSeconds) } : {}),
      intervalSeconds: Math.max(1, Math.min(30, Number(metadata.intervalSeconds) || 15)),
      playbackState: metadata.playbackState === 'playing' ? 'playing' : metadata.playbackState === 'buffering' ? 'buffering' : 'paused',
      visibilityState: metadata.visibilityState === 'hidden' ? 'hidden' : 'visible',
    };
  }
  if (eventName === 'chapter_open') {
    return typeof metadata.chapterId === 'string' ? { chapterId: metadata.chapterId.slice(0, 191) } : {};
  }
  if (eventName === 'transcript_search') {
    return typeof metadata.query === 'string' ? { query: metadata.query.trim().slice(0, 120) } : {};
  }
  if (eventName === 'partner_application_submitted') {
    return {
      ...(typeof metadata.clientFlow === 'string' ? { clientFlow: metadata.clientFlow.slice(0, 160) } : {}),
      ...(typeof metadata.preferredFormat === 'string' ? { preferredFormat: metadata.preferredFormat.slice(0, 160) } : {}),
    };
  }
  if (eventName === 'registration_form_error') {
    return {
      failureCode:
        typeof metadata.failureCode === 'string'
          ? metadata.failureCode.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80)
          : 'client_validation_failed',
    };
  }
  if (eventName === 'cta_appear' || eventName === 'cta_click') {
    return {
      ...(typeof metadata.ctaKey === 'string'
        ? { ctaKey: metadata.ctaKey.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80) }
        : {}),
      ...(Number.isFinite(metadata.positionSeconds)
        ? { positionSeconds: Math.max(0, Number(metadata.positionSeconds)) }
        : {}),
    };
  }
  return {};
}

function createDedupKey(eventName) {
  operationSequence += 1;
  const logicalOperation = `${pageOperationId}:${operationSequence}`.replace(/[^A-Za-z0-9._:-]/g, '-');
  return `web:${eventName}:${logicalOperation}`.slice(0, 128);
}

function readPersistedQueue() {
  try {
    const rows = JSON.parse(window.sessionStorage.getItem(ANALYTICS_QUEUE_KEY) || '[]');
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(-MAX_QUEUE_ITEMS)) {
      if (row?.payload?.schemaVersion !== ANALYTICS_SCHEMA_VERSION || typeof row.payload.dedupKey !== 'string') continue;
      pending.set(row.payload.dedupKey, {
        payload: row.payload,
        attempts: Math.max(0, Math.min(5, Number(row.attempts) || 0)),
        nextAttemptAt: Math.max(0, Number(row.nextAttemptAt) || 0),
      });
    }
  } catch {
    // Browser storage is optional; the in-memory queue still handles the page.
  }
}

function persistQueue() {
  try {
    window.sessionStorage.setItem(ANALYTICS_QUEUE_KEY, JSON.stringify([...pending.values()].slice(-MAX_QUEUE_ITEMS)));
  } catch {
    // Analytics must not break the user flow when storage is unavailable.
  }
}

function retryDelay(response, attempts) {
  const retryAfter = response?.headers?.get?.('retry-after');
  const retrySeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
  if (retrySeconds > 0) return Math.min(MAX_RETRY_DELAY_MS, retrySeconds * 1000);
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(5, attempts));
}

async function deliver(item, keepalive) {
  let response;
  try {
    response = await fetch(`${API}/events`, {
      method: 'POST',
      credentials: 'include',
      keepalive,
      headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
      body: JSON.stringify(item.payload),
    });
  } catch {
    return { retry: true, delay: retryDelay(null, item.attempts) };
  }
  if (response.ok || response.status === 409) return { delivered: true };
  if (response.status === 429 || response.status >= 500) {
    return { retry: true, delay: retryDelay(response, item.attempts) };
  }
  return { discard: true };
}

function scheduleFlush(delay = 0) {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushAnalytics(), Math.max(0, delay));
}

export function flushAnalytics({ keepalive = false } = {}) {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    let nextDelay = MAX_RETRY_DELAY_MS;
    const now = Date.now();
    for (const [key, item] of pending) {
      if (item.nextAttemptAt > now) {
        nextDelay = Math.min(nextDelay, item.nextAttemptAt - now);
        continue;
      }
      const result = await deliver(item, keepalive);
      if (result.delivered || result.discard) {
        pending.delete(key);
        continue;
      }
      item.attempts = Math.min(5, item.attempts + 1);
      item.nextAttemptAt = Date.now() + result.delay;
      nextDelay = Math.min(nextDelay, result.delay);
    }
    persistQueue();
    if (pending.size && !keepalive) scheduleFlush(nextDelay);
  })().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

export function track(eventName, metadata = {}) {
  const campaign = utm();
  const payload = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    eventName,
    source: sourceForEvent(eventName, metadata),
    dedupKey: createDedupKey(eventName),
    page: window.location.pathname,
    clientOccurredAt: new Date().toISOString(),
    attributes: attributesForEvent(eventName, metadata),
    ...(campaign.utmSource ? { utmSource: campaign.utmSource } : {}),
    ...(campaign.utmMedium ? { utmMedium: campaign.utmMedium } : {}),
    ...(campaign.utmCampaign ? { utmCampaign: campaign.utmCampaign } : {}),
  };
  pending.set(payload.dedupKey, { payload, attempts: 0, nextAttemptAt: 0 });
  while (pending.size > MAX_QUEUE_ITEMS) pending.delete(pending.keys().next().value);
  persistQueue();
  scheduleFlush();
  return payload.dedupKey;
}

readPersistedQueue();
scheduleFlush();
window.addEventListener('online', () => scheduleFlush());
window.addEventListener('pagehide', event => {
  if (event.persisted || exitTracked) return;
  exitTracked = true;
  track('user_exit');
  void flushAnalytics({ keepalive: true });
});

export const WEBINAR_INSIGHTS = [
  {
    time: 8,
    icon: 'flag',
    title: 'Старт премьеры записи',
    text: 'Сразу отметьте: вебинар не про теорию, а про то, как юристу увидеть долговой кейс и не отпустить клиента без маршрута.'
  },
  {
    time: 45,
    icon: 'warning',
    title: 'Первый сигнал клиента',
    text: 'Если клиент говорит про долги, взыскания, блокировки, ФНС или кассовый разрыв — это уже повод предложить диагностику АСПБ.'
  },
  {
    time: 105,
    icon: 'psychology',
    title: 'Не давите словом "банкротство"',
    text: 'Начинайте с безопасной формулировки: "Давайте посмотрим законный маршрут выхода из долговой нагрузки".'
  },
  {
    time: 165,
    icon: 'handshake',
    title: 'Роль партнера',
    text: 'Вы не ведете процедуру сами. Ваша задача — заметить сигнал, передать клиента и сохранить доверие.'
  },
  {
    time: 230,
    icon: 'edit_note',
    title: 'Задайте вопрос',
    text: 'Вспомните одного реального клиента и отправьте вопрос в поле ниже. Такой участник автоматически становится приоритетным для менеджера.'
  },
  {
    time: 315,
    icon: 'route',
    title: 'Что берет АСПБ',
    text: 'Диагностика, документы, суд, кредиторы и сопровождение процедуры остаются на стороне команды АСПБ.'
  },
  {
    time: 430,
    icon: 'description',
    title: 'Условия фиксируются договором',
    text: 'Партнерская модель работает только через прозрачную фиксацию источника клиента и условий в договоре.'
  },
  {
    time: 520,
    icon: 'rocket_launch',
    title: 'Финальный шаг',
    text: 'Если узнали своих клиентов в примерах, оставьте заявку на партнерский договор после премьеры.'
  }
];
