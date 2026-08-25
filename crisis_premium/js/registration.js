/**
 * registration.js — регистрация, tracking кликов, пути API.
 */

import { clearAccessToken, getUrlToken } from './state.js';
import { post, getJson, utm } from './utils.js?v=site-review-7';
import { track } from './analytics.js?v=ana-006-1';

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
  const accountUrl = data?.accountUrl || 'account.html';
  const accessUrl = data?.accessUrl || 'access.html';

  document.querySelectorAll('a[href*="register.html"]:not([data-keep-register])').forEach(link => {
    const inAccessRecovery = Boolean(link.closest('#accessLogin, .room-access-recovery, .recordings-access-actions'));
    const targetUrl = inAccessRecovery ? accessUrl : accountUrl;
    const label = inAccessRecovery ? 'Войти в кабинет' : 'Мои вебинары';

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

export function participantLoginStatusMessage(result) {
  if (result?.deliveryStatus === 'retrying' || result?.emailDeliveryAvailable === false) {
    const retryAfter = Number(result?.retryAfterSeconds);
    const retryText = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` через ${Math.ceil(retryAfter)} с`
      : ' позже';
    return `Сейчас не удаётся отправить письмо. Повторите запрос${retryText}.`;
  }
  return 'Если адрес зарегистрирован, ссылка для входа будет отправлена на него.';
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

    window.location.replace(data.accountUrl || 'account.html');
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
  const personalDataConsent = form.querySelector('input[name="personalDataConsent"]');
  const termsAccepted = form.querySelector('input[name="termsAccepted"]');
  const marketingEmailConsent = form.querySelector('input[name="marketingEmailConsent"]');
  const marketingTelegramConsent = form.querySelector('input[name="marketingTelegramConsent"]');

  function showFormError(message) {
    form.querySelector('[data-registration-error="true"]')?.remove();
    const node = document.createElement('p');
    node.dataset.registrationError = 'true';
    node.className = 'text-label-sm text-error bg-error-container/40 border border-error/20 rounded-lg px-4 py-3';
    node.setAttribute('role', 'alert');
    node.setAttribute('aria-live', 'assertive');
    node.setAttribute('tabindex', '-1');
    node.textContent = message;
    // Ошибку показываем НАД кнопкой отправки (а не в конце формы) и центрируем — иначе на
    // мобильном она появлялась под кнопкой, ниже видимой области, и причина отказа не видна.
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.parentNode) {
      submitBtn.parentNode.insertBefore(node, submitBtn);
    } else {
      form.appendChild(node);
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.focus({ preventScroll: true });
  }

  function showVerificationRequired(result) {
    form.querySelector('[data-registration-error="true"]')?.remove();
    form.querySelector('[data-registration-verification="true"]')?.remove();

    const node = document.createElement('section');
    node.dataset.registrationVerification = 'true';
    node.className = 'registration-verification-state';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('tabindex', '-1');

    const title = document.createElement('strong');
    const deliveryAvailable = result.emailDeliveryAvailable !== false;
    title.textContent = deliveryAvailable ? 'Проверьте почту' : 'Нужно подтвердить email';
    const text = document.createElement('p');
    text.textContent = deliveryAvailable
      ? result.message ||
        'Если этот email уже зарегистрирован, на него отправлена одноразовая ссылка для безопасного входа.'
      : 'Данные существующего участника не изменены. Почтовая доставка сейчас отключена, поэтому ссылка не отправлена; повторите запрос на странице «Мой доступ» позже.';
    const link = document.createElement('a');
    link.href = result.accessUrl || 'access.html';
    link.textContent = 'Запросить новую ссылку или открыть «Мой доступ»';
    node.append(title, text, link);

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton?.parentNode) submitButton.parentNode.insertBefore(node, submitButton);
    else form.appendChild(node);
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.focus({ preventScroll: true });
  }

  if (personalDataConsent && !personalDataConsent.checked) {
    showFormError('Подтвердите согласие на обработку персональных данных.');
    return false;
  }
  if (termsAccepted && !termsAccepted.checked) {
    showFormError('Подтвердите принятие пользовательского соглашения отдельным действием.');
    return false;
  }

  // «Другое — напишу сам»: если выбран этот вариант, статус берём из текстового поля.
  let professionalStatus = data.get('professionalStatus');
  if (professionalStatus === 'Другое') {
    professionalStatus = (form.querySelector('#reg-status-other')?.value || '').trim();
    if (!professionalStatus) {
      showFormError('Укажите ваш статус или выберите вариант из списка.');
      return false;
    }
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
      professionalStatus,
      clientsProblem: clients ? clients.value : '',
      personalDataConsent: personalDataConsent ? personalDataConsent.checked : false,
      termsAccepted: termsAccepted ? termsAccepted.checked : false,
      marketingEmailConsent: marketingEmailConsent ? marketingEmailConsent.checked : false,
      marketingTelegramConsent: marketingTelegramConsent ? marketingTelegramConsent.checked : false,
      ...utm()
    });

    if (result.verificationRequired) {
      try {
        // A stale client hint must never make an unverified duplicate email
        // look authenticated. The server session remains authoritative.
        window.localStorage.removeItem('crisisPremiumRegistered');
      } catch {
        // localStorage is optional.
      }
      showVerificationRequired(result);
      if (button) {
        button.textContent =
          result.emailDeliveryAvailable === false ? 'Подтверждение email недоступно' : 'Ссылка для входа запрошена';
        button.disabled = true;
      }
      return false;
    }

    try {
      window.localStorage.setItem('crisisPremiumRegistered', 'true');
    } catch {
      // Cookie/session access is enough when localStorage is unavailable.
    }
    window.location.replace(result.accountUrl || 'account.html');
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

  // «Другое — напишу сам»: поле своего статуса показываем только при выборе этого варианта.
  const statusSelect = form.querySelector('#reg-status');
  const statusOther = form.querySelector('#reg-status-other');
  if (statusSelect && statusOther) {
    statusSelect.addEventListener('change', () => {
      const isOther = statusSelect.value === 'Другое';
      statusOther.classList.toggle('hidden', !isOther);
      if (isOther) statusOther.focus();
      else statusOther.value = '';
    });
  }

  const submitButton = form.querySelector('[data-enable-submit]');
  if (submitButton) submitButton.type = 'submit';
  form.removeAttribute('inert');
  form.removeAttribute('aria-busy');
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
