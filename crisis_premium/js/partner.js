/**
 * partner.js — форма партнёрской заявки.
 */

import { post } from './utils.js?v=site-review-7';
import { track } from './analytics.js?v=site-review-7';

export function bindPartnerApplicationForm() {
  const form = document.getElementById('partnerApplicationForm');
  const status = document.getElementById('partnerApplicationStatus');
  if (!form) return;

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

    try {
      await post('/partner-application', {
        sphere: data.get('sphere'),
        city: data.get('city'),
        clientFlow: data.get('clientFlow'),
        experience: data.get('experience'),
        preferredFormat: data.get('preferredFormat'),
        comment: data.get('comment')
      });

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
