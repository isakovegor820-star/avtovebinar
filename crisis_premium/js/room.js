/**
 * room.js — вход в комнату, статус, ожидание, countdown.
 */

import { state } from './state.js';
import { getJson, pad, formatMoscowDateTime, formatMoscowWebinarDay, formatMoscowWebinarTime } from './utils.js?v=account-access-8';
import { getRegistrationState, requestParticipantLogin } from './registration.js?v=account-access-8';

let countdownInterval = null;
let countdownRetries = 0;
const htmlEscapeNode = document.createElement('span');

function escapeHtml(value) {
  htmlEscapeNode.textContent = String(value ?? '');
  return htmlEscapeNode.innerHTML;
}

function getNextLocalTarget() {
  const now = new Date();
  const msk = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const m = {};
  msk.forEach(function(p) { if (p.type !== 'literal') m[p.type] = Number(p.value); });
  const todayTarget = Date.UTC(m.year, m.month - 1, m.day, 16, 0, 0);
  if (todayTarget > Date.now()) return todayTarget;
  return Date.UTC(m.year, m.month - 1, m.day + 1, 16, 0, 0);
}

function resolveUpcomingWebinarAt(scheduledAt) {
  let target = new Date(scheduledAt).getTime();
  const now = Date.now() + state.serverTimeOffset;

  if (!Number.isFinite(target) || target <= now) {
    target = getNextLocalTarget();
  }

  return new Date(target).toISOString();
}

export function startCountdown(scheduledAt) {
  let target = new Date(resolveUpcomingWebinarAt(scheduledAt)).getTime();

  const nodes = {
    days: document.querySelector('[data-countdown-days]'),
    hours: document.querySelector('[data-countdown-hours]'),
    minutes: document.querySelector('[data-countdown-minutes]'),
    seconds: document.querySelector('[data-countdown-seconds]')
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
      target = getNextLocalTarget();
      updatePublicWebinarLabels(new Date(target).toISOString(), new Date(Date.now() + state.serverTimeOffset).toISOString());
      countdownInterval = setInterval(tick, 1000);
    }
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function updatePublicWebinarLabels(scheduledAt, serverTime) {
  const day = formatMoscowWebinarDay(scheduledAt, serverTime);
  const time = formatMoscowWebinarTime(scheduledAt);
  const dayText = day === 'сегодня' || day === 'завтра' ? day : day;
  document.querySelectorAll('[data-webinar-relative-label]').forEach(node => {
    const prefix = node.dataset.webinarLabelPrefix || 'Ближайший эфир —';
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
    bot: input.telegramBotUrl || input.bot || ''
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
    state.serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
    const scheduledAt = resolveUpcomingWebinarAt(data.scheduledAt || data.webinar?.scheduledAt);
    startCountdown(scheduledAt);
    updatePublicWebinarLabels(scheduledAt, data.serverTime);
    updateTelegramLinks(data);
  } catch {
    // Static preview still works without backend.
  }
}

function closeOverlay() {
  const existing = document.getElementById('aspb-room-overlay');
  if (existing) existing.remove();
}

function ensureRoomAccessStyles() {
  const href = 'webinar.css?v=account-access-1';
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
  closeOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'aspb-room-overlay';
  overlay.className = 'room-access-overlay';
  overlay.innerHTML = `
    <section class="room-access-panel">
      <p class="room-access-eyebrow">Мой доступ</p>
      <h1 class="room-access-title">Войдите по email, чтобы открыть комнату</h1>
      <p class="room-access-text">${safeMessage}</p>
      <form id="participantLoginForm" class="room-access-form" novalidate>
        <label class="room-access-label">
          Email, указанный при регистрации
          <input class="room-access-input" name="email" type="email" autocomplete="email" required placeholder="name@example.com">
        </label>
        <button class="room-access-submit" type="submit">Получить ссылку для входа</button>
        <p id="participantLoginStatus" class="room-access-status" aria-live="polite"></p>
      </form>
      <div class="room-access-actions">
        <a class="room-access-secondary" href="register.html">Зарегистрироваться</a>
        <a class="room-access-link" href="access.html">Открыть “Мой доступ”</a>
      </div>
    </section>`;
  document.body.appendChild(overlay);

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
      await requestParticipantLogin(email);
      if (status) {
        status.textContent = 'Если этот email зарегистрирован, мы отправили одноразовую ссылку для входа.';
      }
    } catch {
      if (status) status.textContent = 'Не удалось отправить ссылку. Проверьте email и попробуйте позже.';
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
}

function isAccessError(error) {
  return error && [401, 403, 404].includes(Number(error.status));
}

export function renderWaitingRoom(data) {
  const title = data.accessStatus === 'closed'
    ? 'Вебинар завершен'
    : data.accessStatus === 'pre_live'
      ? 'Комната скоро откроется'
      : 'Эфир еще не начался';
  const text =
    data.accessStatus === 'closed'
      ? 'Постоянная запись доступна зарегистрированным участникам в разделе “Записи”.'
      : data.accessStatus === 'pre_live'
        ? `Эфир стартует ${formatMoscowDateTime(data.webinar.scheduledAt)} МСК. Страница обновится автоматически.`
      : `Комната откроется к началу эфира: ${formatMoscowDateTime(data.webinar.scheduledAt)} МСК.`;

  const countdownHtml = (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') ? `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:32px;max-width:420px;margin-left:auto;margin-right:auto">
      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(210,228,251,0.2);border-radius:16px;padding:20px 10px;text-align:center">
        <strong data-countdown-days style="font-size:36px;font-weight:800;background:linear-gradient(135deg,#b7d4f7,#7ec8f0);-webkit-background-clip:text;-webkit-text-fill-color:transparent">00</strong>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px;text-transform:uppercase;letter-spacing:0.05em">дней</div>
      </div>
      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(210,228,251,0.2);border-radius:16px;padding:20px 10px;text-align:center">
        <strong data-countdown-hours style="font-size:36px;font-weight:800;background:linear-gradient(135deg,#b7d4f7,#7ec8f0);-webkit-background-clip:text;-webkit-text-fill-color:transparent">00</strong>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px;text-transform:uppercase;letter-spacing:0.05em">часов</div>
      </div>
      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(210,228,251,0.2);border-radius:16px;padding:20px 10px;text-align:center">
        <strong data-countdown-minutes style="font-size:36px;font-weight:800;background:linear-gradient(135deg,#b7d4f7,#7ec8f0);-webkit-background-clip:text;-webkit-text-fill-color:transparent">00</strong>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px;text-transform:uppercase;letter-spacing:0.05em">минут</div>
      </div>
      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(210,228,251,0.2);border-radius:16px;padding:20px 10px;text-align:center">
        <strong data-countdown-seconds style="font-size:36px;font-weight:800;background:linear-gradient(135deg,#b7d4f7,#7ec8f0);-webkit-background-clip:text;-webkit-text-fill-color:transparent">00</strong>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px;text-transform:uppercase;letter-spacing:0.05em">секунд</div>
      </div>
    </div>
  ` : '';

  const action =
    data.accessStatus === 'closed'
      ? '<a href="recordings.html" style="display:inline-flex;margin-top:28px;background:#fff;color:#041627;text-decoration:none;padding:16px 28px;border-radius:14px;font-weight:700;font-size:15px;box-shadow:0 4px 16px rgba(0,0,0,0.1)">Смотреть записи</a>'
      : '<a href="success.html" style="display:inline-flex;margin-top:28px;background:rgba(255,255,255,0.1);border:1px solid rgba(210,228,251,0.3);color:#d2e4fb;text-decoration:none;padding:14px 24px;border-radius:14px;font-weight:600;font-size:14px;backdrop-filter:blur(8px)">Проверить регистрацию</a>';

  closeOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'aspb-room-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#041627;color:#fff;font-family:Manrope,Arial,sans-serif;padding:24px;overflow:hidden';
  overlay.innerHTML = `
    <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(56,78,183,0.15),transparent 60%),radial-gradient(ellipse at 80% 70%,rgba(108,52,163,0.1),transparent 50%);pointer-events:none"></div>
    <section style="max-width:560px;text-align:center;position:relative;z-index:1">
      <div style="width:56px;height:56px;margin:0 auto 20px;border-radius:50%;background:rgba(210,228,251,0.1);border:1px solid rgba(210,228,251,0.2);display:flex;align-items:center;justify-content:center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b7d4f7" stroke-width="2" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <p style="margin:0 0 8px;color:rgba(210,228,251,0.6);font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:11px">АСПБ автовебинар</p>
      <h1 style="font-size:32px;font-weight:800;margin:0 0 12px;line-height:1.2">${escapeHtml(title)}</h1>
      <p style="font-size:16px;color:rgba(255,255,255,0.6);line-height:1.6;margin:0">${escapeHtml(text)}</p>
      ${countdownHtml}
      ${action}
    </section>`;
  document.body.appendChild(overlay);

  if (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') {
    startCountdown(data.webinar.scheduledAt);
    window.setTimeout(() => window.location.reload(), 30 * 1000);
  }
}

export function updateRoomStatus(webinar) {
  const node = document.getElementById('webinarStatusText');
  const countdownContainer = document.getElementById('countdownContainer');
  const chatTitle = document.querySelector('#webinarChatPanel h3');
  const chatActivity = document.getElementById('chatActivity');
  const onlineLabel = document.getElementById('chatOnlineLabel');
  if (!node || !webinar) return;
  if (webinar.testMode) {
    node.textContent = 'Эфир идет. Включайте трансляцию и задавайте вопросы в чате.';
    if (chatTitle) chatTitle.textContent = 'Чат эфира';
    if (chatActivity) chatActivity.textContent = 'Вопросы и чат синхронизированы с эфиром';
    if (onlineLabel) onlineLabel.textContent = 'синхронно';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'live' || webinar.status === 'live') {
    node.textContent = 'Эфир идет. Включайте трансляцию и следите за подсказками АСПБ.';
    if (chatTitle) chatTitle.textContent = 'Чат эфира';
    if (chatActivity) chatActivity.textContent = 'Вопросы и чат синхронизированы с эфиром';
    if (onlineLabel) onlineLabel.textContent = 'синхронно';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'replay' || webinar.status === 'finished') {
    node.textContent = 'Запись доступна. Это не прямой эфир: можно смотреть вебинар, задать вопрос в форме справа и оставить заявку после просмотра.';
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
      minute: '2-digit'
    }).format(new Date(webinar.scheduledAt));
    node.textContent = `Вы зарегистрированы. Эфир начнется ${date} МСК.`;
    if (chatTitle) chatTitle.textContent = 'Чат эфира';
    if (chatActivity) chatActivity.textContent = 'Чат откроется в момент старта эфира';
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

  if (timelinePanel && beforeLive) {
    timelinePanel.classList.add('hidden');
  }

  if (primaryAction) {
    if (beforeLive) {
      primaryAction.setAttribute('href', 'access.html');
      primaryAction.textContent = 'Мой доступ';
    } else if (isReplay) {
      primaryAction.setAttribute('href', '#partnerApplication');
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
        if (data.accessStatus === 'waiting' || data.accessStatus === 'closed') {
          state.serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
          renderWaitingRoom(data);
          return;
        }
        renderLockedRoom('Доступ к этой комнате закрыт или ссылка недействительна.');
        return;
      }

      // Успех
      const serverTime = new Date(data.serverTime).getTime();
      state.serverTimeOffset = serverTime - Date.now();

      state.webinarConfig = {
        scheduledAt: new Date(data.webinar.scheduledAt).getTime(),
        status: data.roomState || (data.testMode ? 'test' : data.liveState?.status || data.webinar.status),
        accessStatus: data.accessStatus,
        durationMinutes: data.webinar.durationMinutes,
        videoDurationSeconds: data.webinar.videoDurationSeconds,
        liveState: data.liveState
      };
      document.body.dataset.webinarAccessStatus = data.accessStatus;

      updateTelegramLinks(data);
      startCountdown(data.webinar.scheduledAt);
      updateRoomStatus({ ...data.webinar, accessStatus: data.accessStatus, replayExpiresAt: data.replayExpiresAt, testMode: data.testMode });
      applyRoomAccessChrome(data);
      window.__ASPB_ROOM_READY__ = true;
      document.dispatchEvent(new CustomEvent('aspb:room-ready', {
        detail: {
          accessStatus: data.accessStatus,
          roomState: data.roomState || state.webinarConfig.status,
          testMode: data.testMode === true
        }
      }));
      await onSuccess();
      return;

    } catch (err) {
      if (isAccessError(err)) {
        renderLockedRoom(
          'Комната открывается для зарегистрированных участников. Если вы уже регистрировались, введите email — мы отправим одноразовую ссылку для входа без пароля.',
        );
        return;
      }

      if (attempt < MAX_RETRIES) {
        if (statusNode) {
          statusNode.textContent = `Подключаемся... попытка ${attempt} из ${MAX_RETRIES}`;
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        renderLockedRoom(
          `Не удалось подключиться к комнате после ${MAX_RETRIES} попыток. Проверьте интернет-соединение, обновите страницу или откройте ссылку из письма заново.`,
        );
      }
    }
  }
}
