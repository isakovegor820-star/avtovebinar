/**
 * utils.js — чистые утилиты без побочных эффектов.
 */

import { API } from './state.js';

export async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Ошибка запроса');
  }

  return response.json();
}

export async function getJson(path) {
  const response = await fetch(`${API}${path}`, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Ошибка запроса');
  }
  return payload;
}

export function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatTimelineTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatMoscowDateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function formatUtcIcsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function utm() {
  const params = new URLSearchParams(window.location.search);
  return {
    source: params.get('source') || document.referrer || 'direct',
    utmSource: params.get('utm_source') || '',
    utmMedium: params.get('utm_medium') || '',
    utmCampaign: params.get('utm_campaign') || '',
    utmContent: params.get('utm_content') || '',
    utmTerm: params.get('utm_term') || ''
  };
}
