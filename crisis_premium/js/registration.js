/**
 * registration.js — регистрация, tracking кликов, пути API.
 */

import { clearAccessToken, urlToken } from './state.js';
import { post, getJson, utm } from './utils.js?v=account-access-4';
import { track } from './analytics.js';

export function registrationStatePath(view) {
  const query = view ? `?view=${encodeURIComponent(view)}` : '';
  return `/registration/session/current${query}`;
}

export function timelinePath() {
  return '/webinar/timeline/session/current';
}

export function chatPath() {
  return '/webinar/chat/session/current';
}

export function getRegistrationState(view) {
  return getJson(registrationStatePath(view));
}

export async function redirectRegisteredUserFromRegisterPage() {
  if (!window.location.pathname.endsWith('register.html')) return false;

  try {
    const data = await getRegistrationState();
    if (!data?.ok) return false;

    try {
      window.localStorage.setItem('crisisPremiumRegistered', 'true');
    } catch {
      // Server session is authoritative.
    }

    window.location.replace(data.successUrl || 'success.html');
    return true;
  } catch {
    try {
      window.localStorage.removeItem('crisisPremiumRegistered');
    } catch {
      // Ignore storage failures.
    }
    return false;
  }
}

export async function exchangeUrlTokenIfPresent() {
  if (!urlToken) return false;

  await post(`/registration/exchange/${encodeURIComponent(urlToken)}`, {});
  clearAccessToken();

  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('token');
  window.history.replaceState({}, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  document.dispatchEvent(new CustomEvent('aspb:room-token-exchanged'));
  return true;
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

  function showFormError(message) {
    form.querySelector('[data-registration-error="true"]')?.remove();
    const node = document.createElement('p');
    node.dataset.registrationError = 'true';
    node.className = 'text-label-sm text-error bg-error-container/40 border border-error/20 rounded-lg px-4 py-3';
    node.textContent = message;
    form.appendChild(node);
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  if (consent && !consent.checked) {
    showFormError('Подтвердите согласие на обработку персональных данных.');
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
      companyWebsite: data.get('companyWebsite') || '',
      city: data.get('city') || '',
      professionalStatus: data.get('professionalStatus'),
      clientsProblem: clients ? clients.value : '',
      consent: consent ? consent.checked : false,
      marketingConsent: marketingConsent ? marketingConsent.checked : false,
      ...utm()
    });

    try {
      window.localStorage.setItem('crisisPremiumRegistered', 'true');
    } catch {
      // Cookie/session access is enough when localStorage is unavailable.
    }
    window.location.href = result.successUrl;
  } catch (error) {
    showFormError(error.message || 'Не удалось отправить регистрацию. Проверьте поля и попробуйте снова.');
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
      post('/telegram-click', { page: window.location.pathname }).catch(() => {});
    });
  });
}

export function bindRegistrationClicks() {
  document.querySelectorAll('a[href*="register.html"]').forEach(link => {
    link.addEventListener('click', () => track('registration_click'));
  });
}
