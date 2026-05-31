/**
 * registration.js — регистрация, tracking кликов, пути API.
 */

import { token, storage } from './state.js';
import { post, getJson, utm } from './utils.js';
import { track } from './analytics.js';

export function registrationStatePath(view) {
  const query = view ? `?view=${encodeURIComponent(view)}` : '';
  if (token) {
    return `/registration/${encodeURIComponent(token)}${query}`;
  }
  return `/registration/session/current${query}`;
}

export function timelinePath() {
  if (token) {
    return `/webinar/timeline/${encodeURIComponent(token)}`;
  }
  return '/webinar/timeline/session/current';
}

export function getRegistrationState(view) {
  return getJson(registrationStatePath(view));
}

export async function handleRegistrationSubmit(event, formOverride) {
  if (event && event.__aspbHandled) return false;
  if (event) {
    event.__aspbHandled = true;
    event.preventDefault();
  }

  const form = formOverride || document.getElementById('registrationForm');
  if (!form) return false;

  const button = form.querySelector('button[type="submit"]');
  const originalText = button ? button.textContent : '';
  const data = new FormData(form);
  const clients = form.querySelector('input[name="clients"]:checked');
  const consent = form.querySelector('input[name="consent"]');
  const marketingConsent = form.querySelector('input[name="marketingConsent"]');

  if (consent && !consent.checked) {
    alert('Пожалуйста, подтвердите согласие на обработку персональных данных.');
    return false;
  }

  if (button) {
    button.textContent = 'Отправляем...';
    button.disabled = true;
  }

  try {
    track('registration_form_open');
    const result = await post('/register', {
      name: data.get('name'),
      phone: data.get('phone'),
      email: data.get('email'),
      city: data.get('city') || '',
      professionalStatus: data.get('professionalStatus'),
      clientsProblem: clients ? clients.value : '',
      consent: consent ? consent.checked : false,
      marketingConsent: marketingConsent ? marketingConsent.checked : false,
      ...utm()
    });

    storage.set('crisisPremiumRegistered', 'true');
    if (result.token) {
      storage.set('crisisPremiumToken', result.token);
    }
    window.location.href = result.successUrl;
  } catch (error) {
    alert(error.message || 'Не удалось отправить регистрацию');
    if (button) {
      button.textContent = originalText;
      button.disabled = false;
    }
  }
  return false;
}

// Глобальный хук для inline-обработчиков в HTML
window.ASPBRegisterSubmit = handleRegistrationSubmit;

export function bindRegistrationForm() {
  const form = document.getElementById('registrationForm');
  if (!form || form.dataset.aspbBound === 'true') return;

  form.dataset.aspbBound = 'true';
  form.addEventListener('submit', event => {
    handleRegistrationSubmit(event, form);
  });
}

export function bindTelegramTracking() {
  document.querySelectorAll('a[href*="t.me"]').forEach(link => {
    link.addEventListener('click', () => {
      post('/telegram-click', { token, page: window.location.pathname }).catch(() => {});
    });
  });
}

export function bindRegistrationClicks() {
  document.querySelectorAll('a[href*="register.html"]').forEach(link => {
    link.addEventListener('click', () => track('registration_click'));
  });
}
