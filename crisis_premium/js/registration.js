/**
 * registration.js — регистрация, tracking кликов, пути API.
 */

import { clearAccessToken, getUrlToken } from './state.js';
import { post, getJson, utm } from './utils.js?v=account-access-14';
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

function setParticipantCtaLabel(link, label) {
  if (link.classList.contains('hero-register-btn')) {
    link.innerHTML = `
      <span class="leading-none whitespace-nowrap">${label}</span>
      <span class="hero-register-icon inline-flex items-center justify-center">
        <span class="material-symbols-outlined text-[19px]">arrow_forward</span>
      </span>
    `;
    return;
  }

  const icon = link.querySelector('.material-symbols-outlined');
  if (icon) {
    const iconName = label === 'Открыть комнату' ? 'meeting_room' : 'person';
    link.innerHTML = `<span class="material-symbols-outlined text-[18px]">${iconName}</span>${label}`;
    return;
  }

  link.textContent = label;
}

function rewriteRegisterLinksForParticipant(data) {
  const roomUrl = data?.webinarUrl || 'webinar.html';
  const accessUrl = data?.accessUrl || 'access.html';

  document.querySelectorAll('a[href*="register.html"]:not([data-keep-register])').forEach(link => {
    const inAccessRecovery = Boolean(link.closest('#accessLogin, .room-access-recovery, .recordings-access-actions'));
    const targetUrl = inAccessRecovery ? accessUrl : roomUrl;
    const label = inAccessRecovery ? 'Мой доступ' : 'Открыть комнату';

    link.setAttribute('href', targetUrl);
    link.dataset.participantCta = 'true';
    link.setAttribute('aria-label', label);
    setParticipantCtaLabel(link, label);
  });
}

export async function hydrateParticipantCtas() {
  if (window.location.pathname.endsWith('register.html')) return;

  try {
    const data = await getRegistrationState();
    if (!data?.ok) return;
    rewriteRegisterLinksForParticipant(data);
  } catch {
    // Anonymous visitors should keep registration CTAs.
  }
}

export function getParticipantAccess() {
  return getJson('/participant/access/current');
}

export function requestParticipantLogin(email) {
  return post('/participant/login/request', { email });
}

export function consumeParticipantLoginToken(token) {
  return post('/participant/login/consume', { token });
}

export function logoutParticipant() {
  return post('/participant/logout', {});
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

    window.location.replace(data.accessUrl || 'access.html');
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
  const urlToken = getUrlToken();
  if (!urlToken) return false;

  try {
    await post('/registration/exchange', { token: urlToken });
  } catch (error) {
    if (Number(error?.status) !== 404) {
      throw error;
    }
    try {
      await consumeParticipantLoginToken(urlToken);
    } catch (participantError) {
      try {
        window.sessionStorage.setItem('aspbAccessTokenError', participantError.message || 'token_failed');
      } catch {
        // Session storage is optional.
      }
      clearAccessToken();
      removeTokenFromUrl();
      return false;
    }
  }

  clearAccessToken();
  removeTokenFromUrl();
  document.dispatchEvent(new CustomEvent('aspb:room-token-exchanged'));
  return true;
}

function removeTokenFromUrl() {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('token');
  const hash = cleanUrl.hash.replace(/^#/, '');
  let nextHash = hash && !hash.includes('token=') ? hash : '';
  if (hash.includes('token=')) {
    const hashParams = new URLSearchParams(hash);
    nextHash = hashParams.get('anchor') || '';
  }
  window.history.replaceState(
    {},
    document.title,
    `${cleanUrl.pathname}${cleanUrl.search}${nextHash ? `#${nextHash}` : ''}`,
  );
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
