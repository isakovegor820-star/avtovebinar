/**
 * access.js — passwordless “Мой доступ”.
 */

import {
  getParticipantAccess,
  logoutParticipant,
  requestParticipantLogin,
} from './registration.js?v=account-access-8';
import { formatMoscowDateTime } from './utils.js?v=account-access-8';
import { updateTelegramLinks } from './room.js?v=account-access-9';

function statusLabel(data) {
  if (data.accessStatus === 'live') return 'Эфир идет';
  if (data.accessStatus === 'replay') return 'Запись доступна';
  if (data.accessStatus === 'closed') return 'Доступ к эфиру закрыт';
  if (data.accessStatus === 'pre_live') return 'Комната скоро откроется';
  return 'Вы зарегистрированы';
}

function statusText(data) {
  const date = data.webinar?.scheduledAt ? formatMoscowDateTime(data.webinar.scheduledAt) : '';
  if (data.accessStatus === 'live') return 'Можно открыть комнату и подключиться к трансляции.';
  if (data.accessStatus === 'replay') return 'Это запись вебинара. Чат работает как форма вопроса для команды АСПБ.';
  if (data.accessStatus === 'closed') return 'Эфир и replay-окно завершены. Проверьте доступные записи или зарегистрируйтесь на ближайший эфир.';
  if (data.accessStatus === 'pre_live') return `Комната открыта для проверки доступа. Эфир стартует ${date} МСК.`;
  return `Эфир стартует ${date} МСК. До начала подключите Telegram-напоминание.`;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setHref(id, value) {
  const node = document.getElementById(id);
  if (node && value) node.setAttribute('href', value);
}

function showMode(mode) {
  document.body.dataset.accessMode = mode;
}

function tokenErrorMessage() {
  try {
    const value = window.sessionStorage.getItem('aspbAccessTokenError');
    window.sessionStorage.removeItem('aspbAccessTokenError');
    return value ? 'Ссылка уже использована или истекла. Запросите новую ссылку для входа.' : '';
  } catch {
    return '';
  }
}

function bindLoginForm() {
  const form = document.getElementById('accessLoginForm');
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';

  const status = document.getElementById('accessLoginStatus');
  const button = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = String(new FormData(form).get('email') || '').trim();
    if (!email) {
      if (status) status.textContent = 'Введите email, который использовали при регистрации.';
      return;
    }

    const originalText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Отправляем...';
    }

    try {
      await requestParticipantLogin(email);
      if (status) {
        status.textContent = 'Если этот email зарегистрирован, мы отправили одноразовую ссылку для входа.';
      }
    } catch {
      if (status) status.textContent = 'Не удалось отправить ссылку. Попробуйте позже.';
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
}

function bindLogout() {
  const button = document.getElementById('accessLogoutButton');
  if (!button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await logoutParticipant();
      showMode('login');
    } finally {
      button.disabled = false;
    }
  });
}

function renderAccess(data) {
  showMode('ready');
  updateTelegramLinks({
    telegramUrl: data.telegram?.groupUrl,
    telegramBotUrl: data.telegram?.botUrl,
  });

  setText('accessName', data.lead?.name || 'Участник');
  setText('accessEmail', data.lead?.email || '');
  setText('accessStatusLabel', statusLabel(data));
  setText('accessStatusText', statusText(data));
  setText('accessWebinarTitle', data.webinar?.title || 'Вебинар АСПБ');
  setText(
    'accessWebinarDate',
    data.webinar?.scheduledAt ? `${formatMoscowDateTime(data.webinar.scheduledAt)} МСК` : 'Дата уточняется',
  );
  setHref('accessRoomLink', data.roomUrl || data.links?.room || 'webinar.html');
  setHref('accessRecoverLink', data.links?.access || 'access.html');

  const telegramStatus = data.telegram?.subscribed
    ? `Telegram привязан${data.telegram?.username ? `: @${data.telegram.username}` : ''}`
    : 'Telegram-уведомления не подключены';
  setText('accessTelegramStatus', telegramStatus);

  const recordings = document.getElementById('accessRecordings');
  const recordingsText = document.getElementById('accessRecordingsText');
  const recordingsLink = document.getElementById('accessRecordingsLink');
  if (recordings) recordings.classList.toggle('hidden', !data.recordings?.available);
  if (recordingsText && data.recordings?.available) {
    recordingsText.textContent = `Доступно записей: ${data.recordings.count}. Они честно отмечены как записи, не как прямой эфир.`;
  }
  if (recordingsLink && data.recordings?.url) recordingsLink.setAttribute('href', data.recordings.url);

  bindLogout();
}

function renderLogin() {
  showMode('login');
  const status = document.getElementById('accessLoginStatus');
  const tokenError = tokenErrorMessage();
  if (status && tokenError) status.textContent = tokenError;
  bindLoginForm();
}

export async function hydrateAccessPage() {
  if (!window.location.pathname.endsWith('access.html')) return;

  try {
    const data = await getParticipantAccess();
    if (!data?.ok) {
      renderLogin();
      return;
    }
    renderAccess(data);
  } catch {
    renderLogin();
  }
}
