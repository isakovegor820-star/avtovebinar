/**
 * utils.js — чистые утилиты без побочных эффектов.
 */

import { API } from './state.js';

let csrfTokenFromApi = '';

function readCookie(name) {
  const prefix = `${name}=`;
  const item = document.cookie
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

async function getCsrfToken() {
  const cookieToken = readCookie('aspb_csrf_token');
  if (cookieToken) return cookieToken;
  if (csrfTokenFromApi) return csrfTokenFromApi;

  const response = await fetch(`${API}/csrf`, { credentials: 'include' });
  if (!response.ok) return '';

  const payload = await response.json().catch(() => ({}));
  csrfTokenFromApi = typeof payload.csrfToken === 'string' ? payload.csrfToken : '';
  return csrfTokenFromApi;
}

export async function csrfHeaders() {
  const token = await getCsrfToken();
  return token ? { 'x-csrf-token': token } : {};
}

export async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
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
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
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

function moscowDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return moscowDateKey(date);
}

export function formatMoscowWebinarDay(scheduledAt, serverTime) {
  const scheduleKey = moscowDateKey(scheduledAt);
  const todayKey = moscowDateKey(serverTime || new Date());
  if (scheduleKey === todayKey) return 'сегодня';
  if (scheduleKey === addDaysKey(todayKey, 1)) return 'завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'long'
  }).format(new Date(scheduledAt));
}

export function formatMoscowWebinarTime(scheduledAt) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(scheduledAt));
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
