/**
 * success.js — страница успешной регистрации, календарь.
 */

import { token, state } from './state.js';
import { formatUtcIcsDate } from './utils.js';
import { getRegistrationState } from './registration.js';
import { updateTelegramLinks } from './room.js';

function bindSuccessCalendar(data) {
  const button = document.getElementById('successCalendarButton');
  if (!button || button.dataset.bound === 'true') return;

  button.dataset.bound = 'true';
  button.addEventListener('click', () => {
    const start = new Date(data.webinar.scheduledAt);
    const end = new Date(start.getTime() + Number(data.webinar.durationMinutes || 120) * 60 * 1000);
    const webinarUrl = data.webinarUrl || (token ? `${window.location.origin}/crisis_premium/webinar.html?token=${encodeURIComponent(token)}` : `${window.location.origin}/crisis_premium/webinar.html`);
    const title = 'Вебинар АСПБ: Экономика кризиса';
    const description = [
      'Автовебинар АСПБ для юристов и партнеров.',
      `Персональная комната: ${webinarUrl}`
    ].join('\\n');
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ASPB//Autowebinar//RU',
      'BEGIN:VEVENT',
      `UID:${data.registration.id || Date.now()}@aspb-autowebinar`,
      `DTSTAMP:${formatUtcIcsDate(new Date())}`,
      `DTSTART:${formatUtcIcsDate(start)}`,
      `DTEND:${formatUtcIcsDate(end)}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${description.replace(/\n/g, '\\\\n')}`,
      `URL:${webinarUrl}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\\r\\n');
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'aspb-webinar.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    button.innerHTML = '<span class="material-symbols-outlined text-xl">event_available</span>Добавлено в календарь';
  });
}

export async function hydrateSuccessPage() {
  if (!window.location.pathname.endsWith('success.html')) return;

  try {
    const data = await getRegistrationState('success');
    if (!data.ok) return;
    state.serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
    updateTelegramLinks(data.telegramUrl);
    const telegramLink = document.getElementById('successTelegramLink');
    if (telegramLink) {
      telegramLink.setAttribute('href', data.telegramBotUrl || data.telegramUrl);
    }
    const roomLink = document.getElementById('successRoomLink') || document.querySelector('a[href*="webinar.html"]');
    if (roomLink) roomLink.setAttribute('href', token ? `webinar.html?token=${encodeURIComponent(token)}` : 'webinar.html');
    bindSuccessCalendar(data);
    const dateNode = document.getElementById('successWebinarDate');
    if (dateNode) {
      dateNode.textContent = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(data.webinar.scheduledAt));
    }

    const supportBtn = document.getElementById('successSupportBtn');
    if (supportBtn) {
      supportBtn.addEventListener('click', () => {
        window.open(data.telegramBotUrl || data.telegramUrl || 'mailto:partners@aspb.ru', '_blank');
      });
    }

    const copyBtn = document.getElementById('successCopyLinkBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          const shareUrl = window.location.origin + '/crisis_premium/index.html';
          await navigator.clipboard.writeText(shareUrl);
          const originalHTML = copyBtn.innerHTML;
          copyBtn.innerHTML = 'Ссылка скопирована! <span class="material-symbols-outlined" style="margin-left:4px">done</span>';
          copyBtn.style.color = '#4caf50';
          setTimeout(() => {
            copyBtn.innerHTML = originalHTML;
            copyBtn.style.color = '';
          }, 2000);
        } catch (err) {
          console.error('Failed to copy text: ', err);
        }
      });
    }
  } catch {
    // Keep static success page readable.
  }
}
