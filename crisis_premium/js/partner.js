/**
 * partner.js — форма партнёрской заявки.
 */

import { post } from './utils.js?v=prelaunch-20260825-2';
import { track } from './analytics.js?v=prelaunch-20260825-2';

export function bindPartnerApplicationForm() {
  const form = document.getElementById('partnerApplicationForm');
  const status = document.getElementById('partnerApplicationStatus');
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';
  let pendingIdempotencyKey = '';
  let pendingPayloadFingerprint = '';

  function setAvailable(available, unavailableMessage) {
    form.toggleAttribute('inert', !available);
    form.setAttribute('aria-busy', 'false');
    for (const control of form.elements) control.disabled = !available;
    if (!available && status) {
      status.className = 'text-label-sm text-primary-fixed-dim';
      status.textContent =
        unavailableMessage ||
        'Войдите по email участника, чтобы отправить заявку. Контакты будут добавлены из регистрации.';
    }
  }

  setAvailable(false);
  document.addEventListener('aspb:room-ready', event => {
    const accessStatus = event.detail?.accessStatus;
    const available = event.detail?.testMode === true || accessStatus === 'live' || accessStatus === 'replay';
    setAvailable(
      available,
      accessStatus === 'waiting' || accessStatus === 'pre_live'
        ? 'Форма заявки станет доступна после начала вебинара.'
        : undefined,
    );
  });

  // FIX 6a: трекаем открытие формы при первом фокусе (один раз)
  form.addEventListener('focusin', () => {
    track('partner_form_opened');
  }, { once: true });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const originalText = button ? button.textContent : '';
    const data = new FormData(form);
    if (button) {
      button.disabled = true;
      button.textContent = 'Отправляем...';
    }

    const payload = {
        sphere: data.get('sphere'),
        city: data.get('city'),
        clientFlow: data.get('clientFlow'),
        experience: data.get('experience'),
        preferredFormat: data.get('preferredFormat'),
        comment: data.get('comment')
    };
    const payloadFingerprint = JSON.stringify(payload);
    if (!pendingIdempotencyKey || pendingPayloadFingerprint !== payloadFingerprint) {
      pendingIdempotencyKey = `partner-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      pendingPayloadFingerprint = payloadFingerprint;
    }

    try {
      await post('/partner-application', payload, { 'Idempotency-Key': pendingIdempotencyKey });

      // FIX 6a: трекаем успешную отправку заявки
      track('partner_application_submitted', {
        clientFlow: data.get('clientFlow'),
        preferredFormat: data.get('preferredFormat')
      });

      if (status) {
        status.className = 'text-label-sm text-green-300 font-semibold';
        status.textContent = '✓ Заявка отправлена. Менеджер АСПБ увидит её в CRM и свяжется с вами.';
      }
      form.reset();
      pendingIdempotencyKey = '';
      pendingPayloadFingerprint = '';
    } catch (error) {
      // FIX 6b: понятное сообщение об ошибке вместо технического текста
      track('partner_application_error', { error: error.message });
      if (status) {
        status.className = 'text-label-sm text-red-300';
        status.textContent = 'Не удалось отправить заявку — проверьте соединение и попробуйте снова. Или напишите нам напрямую: partners@aspb.ru';
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
  const submitButton = form.querySelector('[data-enable-submit]');
  if (submitButton) submitButton.type = 'submit';
}
