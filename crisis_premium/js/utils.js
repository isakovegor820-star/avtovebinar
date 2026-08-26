/**
 * utils.js — чистые утилиты без побочных эффектов.
 */

import { API } from './state.js';

let csrfTokenFromApi = '';
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Сервер не ответил вовремя. Проверьте интернет и попробуйте еще раз.');
      timeoutError.status = 0;
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

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

  let response;
  try {
    response = await fetchWithTimeout(`${API}/csrf`, { credentials: 'include' });
  } catch {
    return '';
  }
  if (!response.ok) return '';

  const payload = await response.json().catch(() => ({}));
  csrfTokenFromApi = typeof payload.csrfToken === 'string' ? payload.csrfToken : '';
  return csrfTokenFromApi;
}

export async function csrfHeaders() {
  const token = await getCsrfToken();
  return token ? { 'x-csrf-token': token } : {};
}

export async function post(path, body, headers = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers, ...(await csrfHeaders()) },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  if (response.status === 204) {
    return { ok: true };
  }
  return response.json();
}

export async function postDownload(path, body) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'Не удалось сформировать файл');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([A-Za-z0-9._-]+)"/);
  return {
    blob: await response.blob(),
    fileName: match?.[1] || 'crm-contacts.csv',
    rowCount: Number(response.headers.get('x-crm-export-row-count') || 0),
  };
}

export async function patchJson(path, body, headers = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers, ...(await csrfHeaders()) },
    body: JSON.stringify(body)
  });

  const payload = response.status === 204 ? { ok: true } : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function putJson(path, body = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(body),
  });
  const payload = response.status === 204 ? { ok: true } : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function deleteJson(path, body = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(body),
  });
  const payload = response.status === 204 ? { ok: true } : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function postBinary(path, body, headers = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, ...(await csrfHeaders()) },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка запроса');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function getJson(path) {
  const response = await fetchWithTimeout(`${API}${path}`, { credentials: 'include' });
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
  const firstTouchStorageKey = 'aspb_first_touch_attribution_v1';
  const lastTouchStorageKey = 'aspb_last_touch_attribution_v1';
  const params = new URLSearchParams(window.location.search);
  const cleanValue = (value, max = 160) =>
    typeof value === 'string' &&
    !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) &&
    !/[?&](?:token|signature|key)=/i.test(value) &&
    !/\bBearer\s+/i.test(value)
      ? [...value]
          .filter(character => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
          })
          .join('')
          .trim()
          .slice(0, max)
      : '';
  const cleanClickId = value => {
    const cleaned = cleanValue(value, 256);
    return /^[A-Za-z0-9._-]*$/.test(cleaned) ? cleaned : '';
  };
  const cleanLandingUrl = value => {
    try {
      const url = new URL(value || `${window.location.origin}${window.location.pathname}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return `${url.origin}${url.pathname}`.slice(0, 1000);
    } catch {
      return '';
    }
  };
  const externalReferrer = (() => {
    if (!document.referrer) return '';
    try {
      const referrer = new URL(document.referrer);
      return referrer.origin === window.location.origin ? '' : referrer.origin;
    } catch {
      return '';
    }
  })();
  const current = {
    source: cleanValue(params.get('source'), 240) || externalReferrer,
    utmSource: cleanValue(params.get('utm_source')),
    utmMedium: cleanValue(params.get('utm_medium')),
    utmCampaign: cleanValue(params.get('utm_campaign')),
    utmContent: cleanValue(params.get('utm_content')),
    utmTerm: cleanValue(params.get('utm_term')),
    gclid: cleanClickId(params.get('gclid')),
    yclid: cleanClickId(params.get('yclid')),
    landingUrl: cleanLandingUrl(params.get('landing_url')),
  };
  const hasAttributionSignal = Boolean(
    current.source ||
      current.utmSource ||
      current.utmMedium ||
      current.utmCampaign ||
      current.utmContent ||
      current.utmTerm ||
      current.gclid ||
      current.yclid ||
      params.get('landing_url'),
  );
  const cookieConsent = readCookie('aspb_cookie_consent');
  const persistentAttributionAllowed = cookieConsent === 'accepted';
  const sessionStore = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })();
  const persistentStore = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  if (cookieConsent === 'declined') {
    try {
      persistentStore?.removeItem(firstTouchStorageKey);
    } catch {
      // localStorage is optional.
    }
  }
  const readStoredTouch = (storage, key) => {
    if (!storage) return null;
    try {
      const parsed = JSON.parse(storage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };
  const writeStoredTouch = (storage, key, value) => {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // URL decoration below keeps attribution when storage is unavailable.
    }
  };
  const sessionFirstTouch = readStoredTouch(sessionStore, firstTouchStorageKey);
  const persistentFirstTouch = persistentAttributionAllowed
    ? readStoredTouch(persistentStore, firstTouchStorageKey)
    : null;
  const storedFirstTouch = sessionFirstTouch || persistentFirstTouch;
  const storedLastTouch = readStoredTouch(sessionStore, lastTouchStorageKey);
  const normalizedCurrent = {
    source: current.source || 'direct',
    utmSource: current.utmSource,
    utmMedium: current.utmMedium,
    utmCampaign: current.utmCampaign,
    utmContent: current.utmContent,
    utmTerm: current.utmTerm,
    gclid: current.gclid,
    yclid: current.yclid,
    landingUrl: current.landingUrl,
  };

  if (!sessionFirstTouch) {
    writeStoredTouch(sessionStore, firstTouchStorageKey, storedFirstTouch || normalizedCurrent);
  }
  if (persistentAttributionAllowed) {
    writeStoredTouch(persistentStore, firstTouchStorageKey, storedFirstTouch || normalizedCurrent);
  }
  if (hasAttributionSignal || !storedLastTouch) {
    writeStoredTouch(sessionStore, lastTouchStorageKey, normalizedCurrent);
  }

  const firstTouch = storedFirstTouch || normalizedCurrent;
  const lastTouch = hasAttributionSignal ? normalizedCurrent : storedLastTouch || normalizedCurrent;
  return {
    source: cleanValue(lastTouch.source, 120) || 'direct',
    utmSource: cleanValue(lastTouch.utmSource, 120),
    utmMedium: cleanValue(lastTouch.utmMedium, 120),
    utmCampaign: cleanValue(lastTouch.utmCampaign, 120),
    utmContent: cleanValue(lastTouch.utmContent, 120),
    utmTerm: cleanValue(lastTouch.utmTerm, 120),
    gclid: cleanClickId(lastTouch.gclid),
    yclid: cleanClickId(lastTouch.yclid),
    landingUrl: cleanLandingUrl(lastTouch.landingUrl),
    firstSource: cleanValue(firstTouch.source, 120) || 'direct',
    firstUtmSource: cleanValue(firstTouch.utmSource, 120),
    firstUtmMedium: cleanValue(firstTouch.utmMedium, 120),
    firstUtmCampaign: cleanValue(firstTouch.utmCampaign, 120),
    firstUtmContent: cleanValue(firstTouch.utmContent, 120),
    firstUtmTerm: cleanValue(firstTouch.utmTerm, 120),
    firstGclid: cleanClickId(firstTouch.gclid),
    firstYclid: cleanClickId(firstTouch.yclid),
    firstLandingUrl: cleanLandingUrl(firstTouch.landingUrl),
  };
}

export function withAttribution(href) {
  const target = new URL(href, window.location.href);
  const campaign = utm();
  const values = {
    source: campaign.source === 'direct' ? '' : campaign.source,
    utm_source: campaign.utmSource,
    utm_medium: campaign.utmMedium,
    utm_campaign: campaign.utmCampaign,
    utm_content: campaign.utmContent,
    utm_term: campaign.utmTerm,
    gclid: campaign.gclid,
    yclid: campaign.yclid,
    landing_url: campaign.landingUrl,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return target.origin === window.location.origin
    ? `${target.pathname}${target.search}${target.hash}`
    : target.href;
}
