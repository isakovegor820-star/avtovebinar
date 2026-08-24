/**
 * analytics.js — трекинг событий и данные для инсайтов.
 */

import { post, utm } from './utils.js?v=site-review-7';

const ANALYTICS_SCHEMA_VERSION = 1;
let operationSequence = 0;
const pageOperationId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function sourceForEvent(eventName, metadata = {}) {
  if (eventName === 'viewer_heartbeat' && metadata.playbackMode === 'replay') return 'replay';
  if (eventName.startsWith('recording') || eventName === 'recordings_open') return 'replay';
  if (
    eventName.startsWith('video_') ||
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
  return {};
}

function createDedupKey(eventName) {
  operationSequence += 1;
  const logicalOperation = `${pageOperationId}:${operationSequence}`.replace(/[^A-Za-z0-9._:-]/g, '-');
  return `web:${eventName}:${logicalOperation}`.slice(0, 128);
}

export function track(eventName, metadata) {
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
  // One retry represents the same logical delivery and deliberately reuses the
  // same dedup key. Nothing is persisted in browser storage.
  post('/events', payload).catch(error => {
    if (!error?.status) return post('/events', payload).catch(() => {});
    return undefined;
  });
}

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
