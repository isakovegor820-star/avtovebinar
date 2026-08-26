/**
 * registration.js — регистрация, tracking кликов, пути API.
 */

import { clearAccessToken, getUrlToken } from './state.js';
import { post, getJson, utm, withAttribution } from './utils.js?v=prelaunch-20260825-2';
import { track } from './analytics.js?v=prelaunch-20260825-2';

const registrationFieldMessages = {
  name: 'Введите имя минимум из двух букв. Используйте только буквы, пробелы, дефис и апостроф.',
  phone: 'Введите телефон: от 7 до 15 цифр, можно использовать пробелы, +, скобки и дефисы.',
  email: 'Введите email в формате name@example.com.',
  city: 'Сократите название города до 160 символов.',
  professionalStatus: 'Выберите статус или укажите свой вариант.',
  personalDataConsent: 'Подтвердите согласие на обработку персональных данных.',
  termsAccepted: 'Примите пользовательское соглашение отдельным действием.',
};

function scrollRegistrationFieldIntoView(field) {
  field?.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function registrationField(form, name) {
  return form.elements.namedItem(name) || null;
}

function clearRegistrationFieldError(field) {
  if (!(field instanceof HTMLElement)) return;
  field.removeAttribute('aria-invalid');
  const errorId = field.dataset.registrationErrorId;
  if (errorId) document.getElementById(errorId)?.remove();
  const previousDescription = field.dataset.registrationPreviousDescribedby;
  if (previousDescription) field.setAttribute('aria-describedby', previousDescription);
  else field.removeAttribute('aria-describedby');
  delete field.dataset.registrationErrorId;
  delete field.dataset.registrationPreviousDescribedby;
}

function setRegistrationFieldError(field, message) {
  if (!(field instanceof HTMLElement)) return;
  clearRegistrationFieldError(field);
  const fieldId = field.id || `registration-${String(field.getAttribute('name') || 'field')}`;
  const errorId = `${fieldId}-error`;
  const error = document.createElement('p');
  error.id = errorId;
  error.className = 'mt-1.5 text-label-sm text-error';
  error.dataset.registrationFieldError = 'true';
  error.textContent = message;
  const describedBy = field.getAttribute('aria-describedby') || '';
  field.dataset.registrationPreviousDescribedby = describedBy;
  field.dataset.registrationErrorId = errorId;
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', [describedBy, errorId].filter(Boolean).join(' '));
  const label = field.closest('label');
  const anchor = label && ['checkbox', 'radio'].includes(field.getAttribute('type') || '') ? label : field;
  anchor.insertAdjacentElement('afterend', error);
}

function validateRegistrationFields(form) {
  const errors = [];
  const name = registrationField(form, 'name');
  const phone = registrationField(form, 'phone');
  const email = registrationField(form, 'email');
  const city = registrationField(form, 'city');
  const professionalStatus = registrationField(form, 'professionalStatus');
  const professionalStatusOther = form.querySelector('#reg-status-other');
  const personalDataConsent = registrationField(form, 'personalDataConsent');
  const termsAccepted = registrationField(form, 'termsAccepted');
  const nameValue = String(name?.value || '').trim();
  const phoneValue = String(phone?.value || '').trim();
  const emailValue = String(email?.value || '').trim();
  const cityValue = String(city?.value || '').trim();
  const professionalStatusValue = String(professionalStatus?.value || '').trim();
  const professionalStatusOtherValue = String(professionalStatusOther?.value || '').trim();
  if (name && 'value' in name) name.value = nameValue;
  if (phone && 'value' in phone) phone.value = phoneValue;
  if (email && 'value' in email) email.value = emailValue;
  if (city && 'value' in city) city.value = cityValue;

  const normalizedName = nameValue.normalize('NFKC').replace(/\s+/gu, ' ');
  const nameHasAllowedCharacters = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’ʼ-]*$/u.test(normalizedName);
  if ((normalizedName.match(/\p{L}/gu) || []).length < 2 || !nameHasAllowedCharacters) {
    errors.push([name, registrationFieldMessages.name, 'invalid_name']);
  }
  const phoneDigits = phoneValue.replace(/\D/g, '');
  if (!/^[+\d\s().-]+$/.test(phoneValue) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    errors.push([phone, registrationFieldMessages.phone, 'invalid_phone']);
  }
  if (!emailValue || !email?.checkValidity()) {
    errors.push([email, registrationFieldMessages.email, 'invalid_email']);
  }
  if (cityValue.length > 160) errors.push([city, registrationFieldMessages.city, 'invalid_city']);
  if (!professionalStatusValue) {
    errors.push([professionalStatus, registrationFieldMessages.professionalStatus, 'professional_status_required']);
  } else if (professionalStatusValue === 'Другое' && !professionalStatusOtherValue) {
    errors.push([
      professionalStatusOther,
      registrationFieldMessages.professionalStatus,
      'professional_status_required',
    ]);
  }
  if (personalDataConsent && !personalDataConsent.checked) {
    errors.push([personalDataConsent, registrationFieldMessages.personalDataConsent, 'personal_data_consent_required']);
  }
  if (termsAccepted && !termsAccepted.checked) {
    errors.push([termsAccepted, registrationFieldMessages.termsAccepted, 'terms_acceptance_required']);
  }

  for (const field of form.querySelectorAll('[data-registration-error-id]')) clearRegistrationFieldError(field);
  for (const [field, message] of errors) setRegistrationFieldError(field, message);
  return errors;
}

function renderServerRegistrationErrors(form, details) {
  const fieldErrors = details?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return false;
  let firstField = null;
  for (const name of Object.keys(fieldErrors)) {
    const field = registrationField(form, name);
    if (!(field instanceof HTMLElement)) continue;
    setRegistrationFieldError(field, registrationFieldMessages[name] || 'Проверьте значение этого поля.');
    firstField ||= field;
  }
  firstField?.focus();
  scrollRegistrationFieldIntoView(firstField);
  return Boolean(firstField);
}

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
    scrollRegistrationFieldIntoView(node);
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
    scrollRegistrationFieldIntoView(node);
    node.focus({ preventScroll: true });
  }

  const clientErrors = validateRegistrationFields(form);
  if (clientErrors.length) {
    track('registration_form_error', { failureCode: clientErrors[0][2] });
    clientErrors[0][0]?.focus();
    scrollRegistrationFieldIntoView(clientErrors[0][0]);
    return false;
  }
  const data = new FormData(form);

  // «Другое — напишу сам»: если выбран этот вариант, статус берём из текстового поля.
  let professionalStatus = data.get('professionalStatus');
  if (professionalStatus === 'Другое') {
    professionalStatus = (form.querySelector('#reg-status-other')?.value || '').trim();
  }

  if (button) {
    button.textContent = 'Отправляем...';
    button.disabled = true;
  }

  try {
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
    window.location.href = result.successUrl || 'success.html';
  } catch (error) {
    track('registration_form_error', {
      failureCode: Number(error?.status) > 0 ? `http_${Number(error.status)}` : 'network_error',
    });
    if (!renderServerRegistrationErrors(form, error?.payload?.details)) {
      showFormError(error.message || 'Не удалось отправить регистрацию. Проверьте поля и попробуйте снова.');
    }
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
  form.noValidate = true;
  let formStarted = false;
  const trackFormStart = () => {
    if (formStarted) return;
    formStarted = true;
    track('registration_form_open');
  };
  form.addEventListener('input', trackFormStart, { once: true });
  form.addEventListener('change', trackFormStart, { once: true });
  form.addEventListener('input', event => clearRegistrationFieldError(event.target));
  form.addEventListener('change', event => clearRegistrationFieldError(event.target));
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
    link.setAttribute('href', withAttribution(link.getAttribute('href') || 'register.html'));
    link.addEventListener('click', () => {
      if (link.dataset.participantCta !== 'true') track('registration_click');
    });
  });
}
