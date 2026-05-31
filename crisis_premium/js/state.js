/**
 * state.js — общее состояние приложения.
 * Все модули импортируют токен и мутируемый state отсюда.
 */

export const API = window.location.protocol === 'file:'
  ? 'http://127.0.0.1:5174/api' : '/api';

export const allowLocalTokenStorage = window.location.protocol === 'file:'
  || ['localhost', '127.0.0.1', ''].includes(window.location.hostname);

export const storage = {
  get(key) {
    try {
      if (key === 'crisisPremiumToken' && !allowLocalTokenStorage) return '';
      return window.localStorage.getItem(key);
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      if (key === 'crisisPremiumToken' && !allowLocalTokenStorage) return;
      window.localStorage.setItem(key, value);
    } catch {
      // File previews can block storage; registration still works through the API response.
    }
  }
};

export const urlToken = new URLSearchParams(window.location.search).get('token') || '';
export const storedToken = storage.get('crisisPremiumToken') || '';
export const token = urlToken || storedToken;

// Мутируемое состояние — экспортируем как объект чтобы изменения были видны во всех модулях
export const state = {
  serverTimeOffset: 0,
  webinarConfig: null,
};

// Инициализация при загрузке модуля
if (urlToken) {
  storage.set('crisisPremiumToken', urlToken);
}
