/**
 * room.js — вход в комнату, статус, ожидание, countdown.
 */

import { state } from './state.js';
import {
  getJson,
  pad,
  formatMoscowDateTime,
  formatMoscowWebinarDay,
  formatMoscowWebinarTime,
} from './utils.js?v=site-review-7';
import {
  getRegistrationState,
  participantLoginStatusMessage,
  requestParticipantLogin,
} from './registration.js?v=single-service-20260825-1';

let countdownInterval = null;
let countdownRetries = 0;
const htmlEscapeNode = document.createElement('span');

function escapeHtml(value) {
  htmlEscapeNode.textContent = String(value ?? '');
  return htmlEscapeNode.innerHTML;
}

function resolveUpcomingWebinarAt(scheduledAt) {
  const target = new Date(scheduledAt).getTime();
  if (!Number.isFinite(target)) return null;
  return new Date(target).toISOString();
}

export function startCountdown(scheduledAt, onComplete = null) {
  const resolvedAt = resolveUpcomingWebinarAt(scheduledAt);
  if (!resolvedAt) return;
  const target = new Date(resolvedAt).getTime();

  const nodes = {
    days: document.querySelector('[data-countdown-days]'),
    hours: document.querySelector('[data-countdown-hours]'),
    minutes: document.querySelector('[data-countdown-minutes]'),
    seconds: document.querySelector('[data-countdown-seconds]'),
  };

  if (!nodes.days && !document.getElementById('countdown')) {
    return;
  }

  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  countdownRetries = 0;

  function tick() {
    const diff = Math.max(0, target - (Date.now() + state.serverTimeOffset));
    const total = Math.floor(diff / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (nodes.days) nodes.days.textContent = pad(days);
    if (nodes.hours) nodes.hours.textContent = pad(hours);
    if (nodes.minutes) nodes.minutes.textContent = pad(minutes);
    if (nodes.seconds) nodes.seconds.textContent = pad(seconds);

    const compact = document.getElementById('countdown');
    if (compact) {
      compact.innerHTML = `<span>${pad(hours + days * 24)}</span>:<span>${pad(minutes)}</span>:<span>${pad(seconds)}</span>`;
    }

    if (diff <= 0 && countdownRetries < 1) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      countdownRetries++;
      // At the boundary refresh only the room state. Full-page navigation used
      // to multiply API calls, session refreshes and waiting analytics rows.
      if (typeof onComplete === 'function') {
        window.setTimeout(() => {
          Promise.resolve(onComplete()).catch(() => {
            // hydrateWebinarRoom owns its bounded retry/error UI.
          });
        }, 1000);
      }
    }
  }

  tick();
  // `tick()` completes synchronously for a target that is already in the past.
  // Do not leave an interval behind in that case: it would wake forever even
  // though the single bounded room-state refresh was already scheduled.
  if (target > Date.now() + state.serverTimeOffset && countdownRetries === 0) {
    countdownInterval = setInterval(tick, 1000);
  }
}

function stopCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  countdownRetries = 0;
}

function updatePublicWebinarLabels(scheduledAt, serverTime) {
  const day = formatMoscowWebinarDay(scheduledAt, serverTime);
  const time = formatMoscowWebinarTime(scheduledAt);
  const dayText = day;
  document.querySelectorAll('[data-webinar-relative-label]').forEach(node => {
    const prefix = node.dataset.webinarLabelPrefix || 'Ближайшая премьера записи —';
    node.textContent = `${prefix} ${dayText}`;
  });
  document.querySelectorAll('[data-webinar-target-label], #webinarTargetLabel').forEach(node => {
    node.textContent = `${dayText[0].toUpperCase()}${dayText.slice(1)} в ${time} МСК`;
  });
}

function normalizeTelegramLinks(input) {
  if (!input) return { group: '', bot: '' };
  if (typeof input === 'string') return { group: input, bot: '' };
  return {
    group: input.telegramUrl || input.group || '',
    bot: input.telegramBotUrl || input.bot || '',
  };
}

export function updateTelegramLinks(input) {
  const urls = normalizeTelegramLinks(input);
  document.querySelectorAll('[data-telegram-link], [data-telegram-bot-link="true"], a[href*="t.me"]').forEach(link => {
    const kind = link.dataset.telegramLink || (link.dataset.telegramBotLink === 'true' ? 'bot' : 'group');
    const href = kind === 'bot' ? urls.bot || urls.group : urls.group || urls.bot;
    if (!href) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.classList.add('pointer-events-none', 'opacity-70');
      return;
    }
    link.setAttribute('href', href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
    link.removeAttribute('aria-disabled');
    link.classList.remove('pointer-events-none', 'opacity-70');
  });
}

export async function hydrateCurrentWebinar() {
  try {
    const data = await getJson('/webinar/current');
    if (!data.ok) return;
    state.serverTimeOffset = (d => (Number.isFinite(d) ? d - Date.now() : 0))(new Date(data.serverTime).getTime());
    const scheduledAt = resolveUpcomingWebinarAt(data.scheduledAt || data.webinar?.scheduledAt);
    if (!scheduledAt) return;
    startCountdown(scheduledAt);
    updatePublicWebinarLabels(scheduledAt, data.serverTime);
    updateTelegramLinks(data);
  } catch {
    // Static preview still works without backend.
  }
}

function setUnderlyingPlayerControlsHidden(hidden) {
  ['webinarVideo', 'videoPlayOverlay', 'videoPauseOverlay', 'customPlayerControls', 'webinarPlayerStatus']
    .map(id => document.getElementById(id))
    .filter(Boolean)
    .forEach(node => {
      if (hidden) {
        if (node.dataset.roomOverlayA11yLocked === 'true') return;
        node.dataset.roomOverlayA11yLocked = 'true';
        node.dataset.roomOverlayHadInert = node.hasAttribute('inert') ? 'true' : 'false';
        node.dataset.roomOverlayPreviousAriaHidden = node.hasAttribute('aria-hidden')
          ? node.getAttribute('aria-hidden')
          : '__absent__';
        node.setAttribute('inert', '');
        node.setAttribute('aria-hidden', 'true');
        return;
      }

      if (node.dataset.roomOverlayA11yLocked !== 'true') return;
      if (node.dataset.roomOverlayHadInert !== 'true') node.removeAttribute('inert');
      const previousAriaHidden = node.dataset.roomOverlayPreviousAriaHidden;
      if (previousAriaHidden === '__absent__') node.removeAttribute('aria-hidden');
      else if (previousAriaHidden != null) node.setAttribute('aria-hidden', previousAriaHidden);
      delete node.dataset.roomOverlayA11yLocked;
      delete node.dataset.roomOverlayHadInert;
      delete node.dataset.roomOverlayPreviousAriaHidden;
    });
}

function closeOverlay() {
  const existing = document.getElementById('aspb-room-overlay');
  if (existing) existing.remove();
  document.getElementById('videoPlayerContainer')?.classList.remove('room-access-gated');
  setUnderlyingPlayerControlsHidden(false);
}

function mountPlayerOverlay(modifier, html) {
  const player = document.getElementById('videoPlayerContainer');
  if (!player) return null;

  closeOverlay();
  player.classList.add('room-access-gated');
  const overlay = document.createElement('div');
  overlay.id = 'aspb-room-overlay';
  overlay.className = `room-access-overlay ${modifier}`;
  overlay.innerHTML = html;
  player.appendChild(overlay);
  setUnderlyingPlayerControlsHidden(true);
  return overlay;
}

function setRoomInteractionLocked(locked) {
  const input = document.getElementById('questionInput');
  const submit = document.getElementById('questionSubmit');
  if (input) {
    input.disabled = locked;
    input.placeholder = locked ? 'Вопросы откроются после входа и начала премьеры' : 'Задайте вопрос команде...';
  }
  if (submit) submit.disabled = locked;
}

function setChatUnavailable(message) {
  if (typeof window.__liveChatSetState === 'function') {
    window.__liveChatSetState('unavailable', message);
  }
}

function setProtectedRoomContentHidden(hidden) {
  document.getElementById('roomLearningContent')?.classList.toggle('hidden', hidden);
  document.getElementById('roomMaterialsPanel')?.classList.toggle('hidden', hidden);
}

function ensureRoomAccessStyles() {
  const href = 'webinar.css?v=room-content-20260821-1';
  if (document.querySelector(`link[href="${href}"]`)) {
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

export function renderLockedRoom(message) {
  const safeMessage = escapeHtml(message);
  ensureRoomAccessStyles();
  const overlay = mountPlayerOverlay(
    'room-access-overlay--login',
    `
    <section class="room-access-panel" aria-labelledby="roomAccessTitle">
      <div class="room-access-entry">
        <span class="room-access-icon material-symbols-outlined" aria-hidden="true">lock</span>
        <p class="room-access-eyebrow">Видео доступно участникам</p>
        <h2 id="roomAccessTitle" class="room-access-title">Войдите по email, чтобы открыть премьеру записи</h2>
        <p class="room-access-text">${safeMessage} Если вы уже регистрировались, не заполняйте форму повторно: восстановите доступ по email без пароля.</p>

        <div class="room-access-recovery room-access-recovery--open">
          <form id="participantLoginForm" class="room-access-form">
            <label class="room-access-label">
              Email из регистрации
              <input class="room-access-input" name="email" type="email" autocomplete="email" required placeholder="name@example.com">
            </label>
            <button class="room-access-submit room-access-submit--primary" type="submit">Я уже зарегистрирован — войти по email</button>
            <p id="participantLoginStatus" class="room-access-status" aria-live="polite"></p>
          </form>
          <div class="room-access-actions">
            <a class="room-access-link room-access-secondary" href="register.html">
              <span class="material-symbols-outlined">how_to_reg</span>
              Зарегистрироваться впервые
            </a>
            <a class="room-access-link" href="access.html">Мой доступ</a>
          </div>
        </div>
        <p class="room-access-note">После входа платформа запомнит это устройство. Пароль создавать не нужно.</p>
      </div>
    </section>`,
  );
  if (!overlay) return;

  setRoomInteractionLocked(true);
  setProtectedRoomContentHidden(true);
  setChatUnavailable('Войдите по email, чтобы открыть сообщения и форму вопросов.');
  document.getElementById('timelineActive')?.classList.add('hidden');
  document.getElementById('countdownContainer')?.classList.add('hidden');
  const statusText = document.getElementById('webinarStatusText');
  const chatActivity = document.getElementById('chatActivity');
  const onlineLabel = document.getElementById('chatOnlineLabel');
  if (statusText) statusText.textContent = 'Войдите по email, чтобы открыть премьеру записи.';
  if (chatActivity) chatActivity.textContent = 'Чат подключится после входа в комнату';
  if (onlineLabel) onlineLabel.textContent = 'доступ закрыт';

  const form = overlay.querySelector('#participantLoginForm');
  const status = overlay.querySelector('#participantLoginStatus');
  const button = form?.querySelector('button[type="submit"]');
  form?.addEventListener('submit', async event => {
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
}

function renderRoomUnavailable(message) {
  ensureRoomAccessStyles();
  const safeMessage = escapeHtml(message);
  const overlay = mountPlayerOverlay(
    'room-access-overlay--error',
    `
    <section class="room-access-panel room-access-panel--status" aria-labelledby="roomUnavailableTitle" role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1">
      <span class="room-access-icon material-symbols-outlined" aria-hidden="true">wifi_off</span>
      <p class="room-access-eyebrow">Техническая ошибка</p>
      <h2 id="roomUnavailableTitle" class="room-access-title">Не удалось подключиться к комнате</h2>
      <p class="room-access-text">${safeMessage}</p>
      <div class="room-access-actions room-access-actions--centered">
        <button class="room-access-submit" type="button" data-room-retry>Повторить попытку</button>
        <a class="room-access-link" href="access.html">Открыть “Мой доступ”</a>
      </div>
    </section>`,
  );
  setRoomInteractionLocked(true);
  setProtectedRoomContentHidden(true);
  setChatUnavailable('Комната временно недоступна. Повторите попытку после восстановления соединения.');
  document.getElementById('timelineActive')?.classList.add('hidden');
  const retry = overlay?.querySelector('[data-room-retry]');
  retry?.addEventListener('click', () => window.location.reload());
  retry?.focus({ preventScroll: true });
}

function isAccessError(error) {
  return error && [401, 403, 404].includes(Number(error.status));
}

export function renderWaitingRoom(data) {
  const scheduledAtLabel = data.webinar?.scheduledAt
    ? `${formatMoscowDateTime(data.webinar.scheduledAt)} МСК`
    : '19:30 МСК';
  const title =
    data.accessStatus === 'closed'
      ? 'Доступ к этой сессии завершён'
      : data.accessStatus === 'pre_live'
        ? 'Трансляция скоро начнется'
        : `Трансляция начнется ${scheduledAtLabel}`;
  const text =
    data.accessStatus === 'closed'
      ? 'Срок просмотра этой сессии истёк. Если вам доступна другая запись или новая сессия, она появится в разделе «Мой доступ».'
      : data.accessStatus === 'pre_live'
        ? `Премьера записи стартует ${scheduledAtLabel}. До старта видео и вопросы закрыты, окно ожидания обновится автоматически.`
        : `До премьеры доступ к записи закрыт. Оставайтесь в этом окне: счетчик идет до ${scheduledAtLabel}, затем комната откроется автоматически.`;

  const countdownHtml =
    data.accessStatus === 'waiting' || data.accessStatus === 'pre_live'
      ? `
    <div class="room-schedule-countdown">
      <div><strong data-countdown-days>00</strong><span>дней</span></div>
      <div><strong data-countdown-hours>00</strong><span>часов</span></div>
      <div><strong data-countdown-minutes>00</strong><span>минут</span></div>
      <div><strong data-countdown-seconds>00</strong><span>секунд</span></div>
    </div>
  `
      : '';

  const action =
    data.accessStatus === 'closed'
      ? '<a class="room-schedule-action" href="access.html">Проверить мой доступ</a>'
      : '<a class="room-schedule-action" href="access.html">Открыть “Мой доступ”</a>';

  ensureRoomAccessStyles();
  mountPlayerOverlay(
    'room-access-overlay--schedule',
    `
    <section class="room-schedule-panel" aria-labelledby="roomScheduleTitle">
      <span class="room-access-icon material-symbols-outlined" aria-hidden="true">schedule</span>
      <p class="room-access-eyebrow">АСПБ автовебинар</p>
      <h2 id="roomScheduleTitle" class="room-access-title">${escapeHtml(title)}</h2>
      <p class="room-access-text">${escapeHtml(text)}</p>
      ${countdownHtml}
      ${action}
    </section>`,
  );
  setRoomInteractionLocked(true);
  setProtectedRoomContentHidden(true);
  setChatUnavailable(
    data.accessStatus === 'closed'
      ? 'Срок доступа к сообщениям этой сессии завершён.'
      : 'Сообщения и форма вопросов откроются вместе с премьерой записи.',
  );
  document.getElementById('timelineActive')?.classList.add('hidden');

  const scheduledAtMs = new Date(data.webinar.scheduledAt).getTime();
  const serverNowMs = Date.now() + state.serverTimeOffset;
  if (
    (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') &&
    Number.isFinite(scheduledAtMs) &&
    scheduledAtMs > serverNowMs
  ) {
    startCountdown(data.webinar.scheduledAt);
  } else {
    stopCountdown();
  }
}

export function updateRoomStatus(webinar) {
  const node = document.getElementById('webinarStatusText');
  const countdownContainer = document.getElementById('countdownContainer');
  const chatTitle = document.querySelector('[data-chat-heading]');
  const chatActivity = document.getElementById('chatActivity');
  const onlineLabel = document.getElementById('chatOnlineLabel');
  if (!node || !webinar) return;
  if (webinar.testMode) {
    node.textContent = 'Идет премьера записи. Смотрите материал и отправляйте вопросы команде АСПБ.';
    if (chatTitle) chatTitle.textContent = 'Вопросы к премьере';
    if (chatActivity)
      chatActivity.textContent = 'Подготовленные сообщения синхронизированы с записью; вопросы отправляются команде';
    if (onlineLabel) onlineLabel.textContent = 'синхронно';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'live' || webinar.status === 'live') {
    node.textContent = 'Идет премьера записи. Включайте материал и следите за подсказками АСПБ.';
    if (chatTitle) chatTitle.textContent = 'Вопросы к премьере';
    if (chatActivity)
      chatActivity.textContent = 'Подготовленные сообщения синхронизированы с записью; вопросы отправляются команде';
    if (onlineLabel) onlineLabel.textContent = 'синхронно';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'replay' || webinar.status === 'finished') {
    node.textContent =
      'Запись доступна: можно смотреть вебинар, отправить вопрос команде АСПБ и оставить заявку после просмотра.';
    if (chatTitle) chatTitle.textContent = 'Чат после вебинара';
    if (chatActivity) chatActivity.textContent = 'Запись открыта, чат доступен для вопросов';
    if (onlineLabel) onlineLabel.textContent = 'чат открыт';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else {
    const date = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(webinar.scheduledAt));
    node.textContent = `Вы зарегистрированы. Премьера записи начнется ${date} МСК.`;
    if (chatTitle) chatTitle.textContent = 'Вопросы к премьере';
    if (chatActivity)
      chatActivity.textContent = 'Подготовленное обсуждение и форма вопросов откроются в момент старта премьеры';
    if (onlineLabel) onlineLabel.textContent = 'ожидание';
    if (countdownContainer) countdownContainer.classList.remove('hidden');
  }
}

function applyRoomAccessChrome(data) {
  const accessStatus = data?.accessStatus || data?.webinar?.accessStatus || '';
  const beforeLive = accessStatus === 'waiting' || accessStatus === 'pre_live';
  const isReplay = accessStatus === 'replay';
  const partnerPath = document.getElementById('partnerPath');
  const primaryAction = document.querySelector('[data-room-primary-action]');
  const timelinePanel = document.getElementById('timelineActive');

  document.body.dataset.webinarAccessStatus = accessStatus || 'unknown';

  if (partnerPath) {
    partnerPath.classList.toggle('hidden', beforeLive);
  }

  setProtectedRoomContentHidden(beforeLive);

  if (timelinePanel) {
    timelinePanel.classList.toggle('hidden', beforeLive);
  }

  setRoomInteractionLocked(beforeLive);

  if (primaryAction) {
    if (beforeLive) {
      primaryAction.setAttribute('href', 'access.html');
      primaryAction.textContent = 'Мой доступ';
    } else if (isReplay) {
      primaryAction.setAttribute('href', '#webinarChatPanel');
      primaryAction.textContent = 'Задать вопрос';
    } else {
      primaryAction.setAttribute('href', '#partnerApplication');
      primaryAction.textContent = 'Оставить заявку';
    }
  }
}

// FIX 2: retry-логика при недоступности API
export async function hydrateWebinarRoom(onSuccess) {
  if (!window.location.pathname.endsWith('webinar.html')) return;

  const statusNode = document.getElementById('webinarStatusText');
  if (statusNode) statusNode.textContent = 'Подключаемся к вебинарной комнате...';

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await getRegistrationState('room');
      if (!data.ok || !(data.canViewRoom || data.canEnterRoom)) {
        if (data.accessStatus === 'closed') {
          state.serverTimeOffset = (d => (Number.isFinite(d) ? d - Date.now() : 0))(
            new Date(data.serverTime).getTime(),
          );
          document.body.classList.remove('room-hydrating');
          document.body.removeAttribute('aria-busy');
          renderWaitingRoom(data);
          return;
        }
        document.body.classList.remove('room-hydrating');
        document.body.removeAttribute('aria-busy');
        renderLockedRoom('Доступ к этой комнате закрыт или ссылка недействительна.');
        return;
      }

      // Успех
      const serverTime = new Date(data.serverTime).getTime();
      state.serverTimeOffset = serverTime - Date.now();
      closeOverlay();

      state.webinarConfig = {
        scheduledAt: new Date(data.webinar.scheduledAt).getTime(),
        status: data.roomState || (data.testMode ? 'test' : data.liveState?.status || data.webinar.status),
        accessStatus: data.accessStatus,
        durationMinutes: data.webinar.durationMinutes,
        videoDurationSeconds: data.webinar.videoDurationSeconds,
        liveState: data.liveState,
      };
      document.body.dataset.webinarAccessStatus = data.accessStatus;

      updateTelegramLinks(data);
      const scheduledAtMs = new Date(data.webinar.scheduledAt).getTime();
      const shouldStartCountdown =
        (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') &&
        Number.isFinite(scheduledAtMs) &&
        scheduledAtMs > serverTime;
      if (shouldStartCountdown) {
        startCountdown(data.webinar.scheduledAt, () => hydrateWebinarRoom(onSuccess));
      } else stopCountdown();
      updateRoomStatus({
        ...data.webinar,
        accessStatus: data.accessStatus,
        replayExpiresAt: data.replayExpiresAt,
        testMode: data.testMode,
      });
      applyRoomAccessChrome(data);
      window.__ASPB_ROOM_READY__ = true;
      document.dispatchEvent(
        new CustomEvent('aspb:room-ready', {
          detail: {
            accessStatus: data.accessStatus,
            roomState: data.roomState || state.webinarConfig.status,
            testMode: data.testMode === true,
          },
        }),
      );
      document.body.classList.remove('room-hydrating');
      document.body.removeAttribute('aria-busy');
      await onSuccess(data);
      return;
    } catch (err) {
      if (isAccessError(err)) {
        document.body.classList.remove('room-hydrating');
        document.body.removeAttribute('aria-busy');
        renderLockedRoom(
          'Главная страница сайта открыта без регистрации. Комната вебинара и записи доступны участникам: после регистрации платформа запомнит это устройство и откроет персональную комнату.',
        );
        return;
      }

      if (attempt < MAX_RETRIES) {
        if (statusNode) {
          statusNode.textContent = `Подключаемся... попытка ${attempt} из ${MAX_RETRIES}`;
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        document.body.classList.remove('room-hydrating');
        document.body.removeAttribute('aria-busy');
        renderRoomUnavailable(
          `Не удалось подключиться к комнате после ${MAX_RETRIES} попыток. Проверьте интернет-соединение, обновите страницу или откройте ссылку из письма заново.`,
        );
      }
    }
  }
}
