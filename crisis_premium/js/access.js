/**
 * access.js — passwordless “Мой доступ”.
 */

import {
  getParticipantAccess,
  logoutParticipant,
  participantLoginStatusMessage,
  requestParticipantLogin,
} from './registration.js?v=single-service-20260825-1';
import { formatMoscowDateTime } from './utils.js?v=site-review-7';
import { updateTelegramLinks } from './room.js?v=site-review-7';

function statusLabel(data) {
  if (data.accessStatus === 'live') return 'Идет премьера записи';
  if (data.accessStatus === 'replay') return 'Запись доступна';
  if (data.accessStatus === 'closed') return 'Доступ к премьере закрыт';
  if (data.accessStatus === 'pre_live') return 'Ожидание премьеры записи';
  return 'Премьера записи по расписанию';
}

function statusText(data) {
  const date = data.webinar?.scheduledAt ? formatMoscowDateTime(data.webinar.scheduledAt) : '';
  if (data.accessStatus === 'live') return 'Можно открыть комнату и подключиться к премьере записи.';
  if (data.accessStatus === 'replay') return 'Это запись вебинара. Чат работает как форма вопроса для команды АСПБ.';
  if (data.accessStatus === 'closed') return 'Вебинарная комната закрыта. Опубликованные записи остаются в библиотеке участника без повторной регистрации.';
  if (data.accessStatus === 'pre_live') return `До старта осталось меньше 15 минут. Откройте окно ожидания: премьера начнется ${date} МСК.`;
  return `Вы зарегистрированы. До ${date} МСК доступ к видео закрыт: сейчас главное — напоминание и окно ожидания.`;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setHref(id, value) {
  const node = document.getElementById(id);
  if (node && value) node.setAttribute('href', value);
}

function setLinkContent(id, icon, label) {
  const node = document.getElementById(id);
  if (!node) return;
  node.innerHTML = `<span class="material-symbols-outlined text-[18px]">${icon}</span>${label}`;
}

function showMode(mode) {
  document.body.dataset.accessMode = mode;
}

function isAccessError(error) {
  return error && [401, 403, 404].includes(Number(error.status));
}

function temporaryErrorMessage(error) {
  if (Number(error?.status) >= 500) {
    return 'Сервис временно недоступен. Ваш доступ не удалён — повторите проверку через несколько секунд.';
  }
  if (navigator.onLine === false) {
    return 'Нет соединения с интернетом. Ваш доступ сохранён; подключитесь к сети и повторите проверку.';
  }
  return error?.message || 'Не удалось связаться с сервером. Ваш доступ не удалён — повторите проверку.';
}

function renderTemporaryError(error) {
  showMode('error');
  setText('accessErrorText', temporaryErrorMessage(error));
  const retry = document.getElementById('accessRetryButton');
  if (!retry || retry.dataset.bound === 'true') return;
  retry.dataset.bound = 'true';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    showMode('loading');
    try {
      await hydrateAccessPage();
    } finally {
      retry.disabled = false;
    }
  });
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
  const button = form.querySelector('[data-enable-submit]');

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
      const result = await requestParticipantLogin(email);
      if (status) {
        status.textContent = participantLoginStatusMessage(result);
      }
    } catch {
      if (status) status.textContent = 'Не удалось запросить ссылку. Проверьте соединение и повторите попытку.';
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
  if (button) button.type = 'submit';
  form.removeAttribute('inert');
  form.removeAttribute('aria-busy');
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
  if (data.accessStatus === 'live') {
    setLinkContent('accessRoomLink', 'play_circle', 'Подключиться к премьере');
  } else if (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') {
    setLinkContent('accessRoomLink', 'schedule', 'Открыть окно ожидания');
  } else {
    setLinkContent('accessRoomLink', 'meeting_room', 'Открыть комнату');
  }

  const telegramStatus = data.telegram?.subscribed
    ? `Telegram привязан${data.telegram?.username ? `: @${data.telegram.username}` : ''}`
    : 'Telegram-уведомления не подключены';
  setText('accessTelegramStatus', telegramStatus);

  const recordings = document.getElementById('accessRecordings');
  const recordingsText = document.getElementById('accessRecordingsText');
  const recordingsLink = document.getElementById('accessRecordingsLink');
  const recordingsLocked = Boolean(data.recordings?.locked);
  if (recordings) recordings.classList.toggle('hidden', !(data.recordings?.available || recordingsLocked));
  if (recordingsText && recordingsLocked) {
    const availableAt = data.recordings?.recordingAvailableAt
      ? formatMoscowDateTime(data.recordings.recordingAvailableAt)
      : '';
    recordingsText.textContent = `Постоянная запись откроется после премьеры${availableAt ? ` — ориентировочно ${availableAt} МСК` : ''}. До этого видео доступно только в комнате по расписанию.`;
  } else if (recordingsText && data.recordings?.available) {
    recordingsText.textContent = `Доступно записей: ${data.recordings.count}. Это защищённая библиотека материалов.`;
  }
  if (recordingsLink && recordingsLocked) {
    recordingsLink.setAttribute('href', data.roomUrl || data.links?.room || 'webinar.html');
    setLinkContent('accessRecordingsLink', 'schedule', 'Открыть окно ожидания');
  } else if (recordingsLink && data.recordings?.url) {
    recordingsLink.setAttribute('href', data.recordings.url);
    setLinkContent('accessRecordingsLink', 'video_library', 'Открыть записи');
  }

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
    if (new URLSearchParams(window.location.search).get('next') === 'account') {
      window.location.replace(data.accountUrl || data.links?.account || 'account.html');
      return;
    }
    renderAccess(data);
  } catch (error) {
    if (isAccessError(error)) {
      renderLogin();
      return;
    }
    renderTemporaryError(error);
  }
}
