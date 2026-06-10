/**
 * state.js — общее состояние приложения.
 * Все модули импортируют токен и мутируемый state отсюда.
 */

export const API = window.location.protocol === 'file:'
  ? 'http://127.0.0.1:5174/api' : '/api';

export function getUrlToken() {
  const searchToken = new URLSearchParams(window.location.search).get('token');
  if (searchToken) return searchToken;

  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.includes('token=')) return '';

  return new URLSearchParams(hash).get('token') || '';
}

export function clearAccessToken() {
  try {
    window.localStorage.removeItem('crisisPremiumToken');
  } catch {
    // Storage can be unavailable in static previews.
  }
}

// Мутируемое состояние — экспортируем как объект чтобы изменения были видны во всех модулях
export const state = {
  serverTimeOffset: 0,
  webinarConfig: null,
};

try {
  window.localStorage.removeItem('crisisPremiumToken');
} catch {
  // Storage can be unavailable in static previews.
}
