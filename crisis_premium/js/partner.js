/**
 * partner.js — форма партнёрской заявки.
 */

import { post } from './utils.js';
import { track } from './analytics.js';

export function bindPartnerApplicationForm() {
  const form = document.getElementById('partnerApplicationForm');
  const status = document.getElementById('partnerApplicationStatus');
  if (!form) return;
  form.noValidate = true;

  // FIX 6a: трекаем открытие формы при первом фокусе (один раз)
  form.addEventListener('focusin', () => {
    track('partner_form_opened');
  }, { once: true });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const originalText = button ? button.textContent : '';
    const data = new FormData(form);
    const fields = ['sphere', 'city', 'clientFlow', 'experience', 'preferredFormat', 'comment'];
    const values = Object.fromEntries(fields.map(field => [field, String(data.get(field) || '').trim()]));
    const hasAnyValue = Object.values(values).some(Boolean);

    form.querySelectorAll('[name="sphere"], [name="clientFlow"]').forEach(field => {
      field.classList.remove('border-red-300', 'ring-2', 'ring-red-300');
    });

    if (!hasAnyValue) {
      if (status) {
        status.className = 'text-label-sm text-red-300';
        status.textContent = 'Заполните хотя бы одно поле.';
      }
      return;
    }

    if (!values.sphere || !values.clientFlow) {
      form.querySelectorAll('[name="sphere"], [name="clientFlow"]').forEach(field => {
        if (!String(field.value || '').trim()) field.classList.add('border-red-300', 'ring-2', 'ring-red-300');
      });
      if (status) {
        status.className = 'text-label-sm text-red-300';
        status.textContent = 'Укажите сферу и поток проблемных клиентов.';
      }
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Отправляем...';
    }

    try {
      await post('/partner-application', {
        sphere: values.sphere,
        city: values.city,
        clientFlow: values.clientFlow,
        experience: values.experience,
        preferredFormat: values.preferredFormat,
        comment: values.comment
      });

      // FIX 6a: трекаем успешную отправку заявки
      track('partner_application_submitted', {
        clientFlow: values.clientFlow,
        preferredFormat: values.preferredFormat
      });

      if (status) {
        status.className = 'text-label-sm text-green-300 font-semibold';
        status.textContent = '✓ Заявка отправлена. Менеджер АСПБ увидит её в CRM и свяжется с вами.';
      }
      form.reset();
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
}
