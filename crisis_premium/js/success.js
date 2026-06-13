/**
 * success.js — страница успешной регистрации, календарь.
 */

import { state } from './state.js';
import {
  formatMoscowDateTime,
  formatMoscowWebinarDay,
  formatMoscowWebinarTime,
  formatUtcIcsDate,
  getJson,
} from './utils.js?v=ux-fixes-1';
import { getRegistrationState } from './registration.js?v=ux-fixes-1';
import { updateTelegramLinks } from './room.js?v=ux-fixes-1';
import { track } from './analytics.js';

function clearLocalAccessHint() {
  try {
    window.localStorage.removeItem('crisisPremiumRegistered');
  } catch {
    // Server state is authoritative.
  }
}

function revealSuccessContent() {
  document.getElementById('successContent')?.removeAttribute('hidden');
  document.body.classList.add('success-access-ready');
}

function renderSuccessAccessGate() {
  clearLocalAccessHint();
  const gate = document.getElementById('successAccessGate');
  if (!gate) return;

  gate.innerHTML = `
    <div class="success-access-panel">
      <div class="success-access-icon" aria-hidden="true">
        <span class="material-symbols-outlined">lock</span>
      </div>
      <h1>Доступ не найден</h1>
      <p>Кабинет участника показывается после регистрации или входа по одноразовой ссылке. Если вы уже регистрировались, восстановите доступ по email без пароля.</p>
      <div class="success-access-actions">
        <a class="success-access-primary" href="access.html">Войти по email</a>
        <a class="success-access-secondary" href="register.html">Зарегистрироваться</a>
      </div>
    </div>
  `;
}

function capitalizeFirst(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : '';
}

function buildSuccessIntro(data) {
  const scheduledAt = data?.webinar?.scheduledAt;
  if (!scheduledAt) {
    return 'Ваш доступ открыт. Комната вебинара и раздел записей привязаны к этой регистрации; пароль создавать не нужно.';
  }
  const day = formatMoscowWebinarDay(scheduledAt, data.serverTime);
  const time = formatMoscowWebinarTime(scheduledAt);
  // Обе ветки тернарника были идентичны — схлопнуто без изменения вывода.
  const dateLabel = `${capitalizeFirst(day)} в ${time} МСК`;

  return `${dateLabel} покажем готовую цепочку АСПБ: вы видите проблему и передаете клиента, команда ведет процедуру, вы получаете партнерское вознаграждение. Подключите Telegram-напоминания, чтобы получить ссылку на эфир и новости перед стартом.`;
}

function bindSuccessCalendar(data) {
  const button = document.getElementById('successCalendarButton');
  if (!button || button.dataset.bound === 'true') return;

  button.dataset.bound = 'true';
  button.addEventListener('click', () => {
    const start = new Date(data.webinar.scheduledAt);
    const end = new Date(start.getTime() + Number(data.webinar.durationMinutes || 120) * 60 * 1000);
    const webinarUrl = data.webinarUrl || `${window.location.origin}/crisis_premium/webinar.html`;
    const title = 'Вебинар АСПБ: Экономика кризиса';
    const description = [
      'Автовебинар АСПБ для юристов и партнеров.',
      `Персональная комната: ${webinarUrl}`
    ].join('\n');
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
      `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
      `URL:${webinarUrl}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
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
    if (!data.ok) {
      renderSuccessAccessGate();
      return;
    }
    try {
      window.localStorage.setItem('crisisPremiumRegistered', 'true');
    } catch {
      // Cookie/session access is enough when localStorage is unavailable.
    }
    revealSuccessContent();
    window.dispatchEvent(new CustomEvent('aspb:registration-state', { detail: data }));
    const roomHref = data.webinarUrl || 'webinar.html';
    state.serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
    updateTelegramLinks(data);
    const telegramLink = document.getElementById('successTelegramLink');
    if (telegramLink) {
      const href = data.telegramBotUrl || data.telegramUrl;
      if (href) {
        telegramLink.setAttribute('href', href);
        telegramLink.removeAttribute('aria-disabled');
        telegramLink.classList.remove('pointer-events-none', 'opacity-70');
      }
    }
    const roomLink = document.getElementById('successRoomLink') || document.querySelector('a[href*="webinar.html"]');
    if (roomLink) roomLink.setAttribute('href', roomHref);
    const intro = document.getElementById('successIntroText');
    if (intro) intro.textContent = buildSuccessIntro(data);
    const recordingsLink = document.getElementById('successRecordingsLink');
    if (recordingsLink) {
      recordingsLink.addEventListener('click', () => track('recording_cta_click', {
        source: 'success',
        locked: recordingsLink.dataset.locked === 'true',
      }));
    }
    if (data.testMode || data.webinar?.testMode) {
      if (intro) {
        intro.textContent = 'Демо-доступ включен: вебинарная комната уже открыта. Можно сразу зайти, проверить видео, чат, таймлайн и финальную заявку так, как это увидит участник после регистрации.';
      }
      if (roomLink) {
        roomLink.className = 'flex items-center justify-center gap-2 bg-primary text-on-primary hover:bg-primary/95 py-4 px-6 rounded-xl font-label-md text-label-md transition-all active:scale-95 shadow-md';
        roomLink.innerHTML = '<span class="material-symbols-outlined text-xl">play_circle</span>Открыть вебинар сейчас';
      }
    }
    bindSuccessCalendar(data);
    hydrateRecordingsSummary().catch(() => {});
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
    renderSuccessAccessGate();
  }
}

async function hydrateRecordingsSummary() {
  const summary = document.getElementById('successRecordingsSummary');
  if (!summary) return;

  const payload = await getJson('/recordings');
  summary.classList.remove('hidden');

  const title = document.getElementById('successRecordingsTitle');
  const text = document.getElementById('successRecordingsText');
  const link = document.getElementById('successRecordingsLink');
  if (payload.locked) {
    const availableAt = payload.webinar?.recordingAvailableAt
      ? formatMoscowDateTime(payload.webinar.recordingAvailableAt)
      : '';
    const isLive = payload.accessStatus === 'live';
    if (title) title.textContent = isLive ? 'Сейчас идет эфир' : 'Запись откроется после эфира';
    if (text) {
      text.textContent = isLive
        ? 'Запись не открывается параллельно с трансляцией. Подключайтесь к комнате и смотрите эфир по расписанию.'
        : `До эфира запись закрыта. После завершения${availableAt ? `, ориентировочно ${availableAt} МСК,` : ''} она появится в разделе “Записи”.`;
    }
    if (link) {
      link.setAttribute('href', payload.roomUrl || 'webinar.html');
      link.dataset.locked = 'true';
      link.innerHTML = `<span class="material-symbols-outlined text-xl">${isLive ? 'play_circle' : 'schedule'}</span>${isLive ? 'Подключиться к эфиру' : 'Открыть окно ожидания'}`;
    }
    return;
  }

  if (!payload.recordings?.length) {
    if (title) title.textContent = 'Записи появятся после завершения эфира';
    if (text) text.textContent = 'После окончания вебинара запись автоматически появится в разделе “Записи”.';
    if (link) {
      link.setAttribute('href', payload.roomUrl || 'webinar.html');
      link.dataset.locked = 'true';
      link.innerHTML = '<span class="material-symbols-outlined text-xl">schedule</span>Открыть окно ожидания';
    }
    return;
  }

  const latest = payload.recordings[0];
  if (title) title.textContent = latest.title;
  if (text) text.textContent = 'Последняя запись уже доступна в вашем кабинете без срока истечения.';
  if (link) {
    link.setAttribute('href', `recordings.html?id=${encodeURIComponent(latest.id)}`);
    link.dataset.locked = 'false';
    link.innerHTML = '<span class="material-symbols-outlined text-xl">video_library</span>Смотреть запись';
  }
}
