/**
 * room.js — вход в комнату, статус, ожидание, countdown.
 */

import { state } from './state.js';
import { getJson, pad, formatMoscowDateTime } from './utils.js';
import { getRegistrationState } from './registration.js';
import { bindQuestionForm } from './questions.js';

let countdownInterval = null;
let countdownRetries = 0;
const ROOM_STATE_DUPLICATE_IDS = [
  'webinarChatPanel',
  'liveChatMessages',
  'chatActivity',
  'chatOnlineLabel',
  'questionInput',
  'questionSubmit',
];

function getServerNowMs() {
  return Date.now() + (state.serverTimeOffset || 0);
}

function getNextMoscowTarget(nowMs = getServerNowMs()) {
  const now = new Date(nowMs);
  const msk = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const m = {};
  msk.forEach(function(p) { if (p.type !== 'literal') m[p.type] = Number(p.value); });
  const todayTarget = Date.UTC(m.year, m.month - 1, m.day, 16, 0, 0);
  if (todayTarget > nowMs) return todayTarget;
  return Date.UTC(m.year, m.month - 1, m.day + 1, 16, 0, 0);
}

export function startCountdown(scheduledAt) {
  let target = new Date(scheduledAt).getTime();
  const now = getServerNowMs();

  if (target <= now) {
    target = getNextMoscowTarget(now);
  }

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
    const diff = Math.max(0, target - getServerNowMs());
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
      target = getNextMoscowTarget();
      countdownInterval = setInterval(tick, 1000);
    }
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

export function updateTelegramLinks(url) {
  if (!url) return;
  document.querySelectorAll('a[href*="t.me"]').forEach(link => {
    if (link.dataset.telegramBotLink === 'true') return;
    link.setAttribute('href', url);
  });
}

export async function hydrateCurrentWebinar() {
  try {
    const data = await getJson('/webinar/current');
    if (!data.ok) return;
    state.serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
    startCountdown(data.scheduledAt);
    updateTelegramLinks(data.telegramUrl);
  } catch {
    // Static preview still works without backend.
  }
}

function getRoomStateOverlay() {
  let overlay = document.getElementById('roomStateOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'roomStateOverlay';
    overlay.className = 'hidden fixed inset-0 z-[1000] bg-background';
    document.body.prepend(overlay);
  }
  return overlay;
}

export function hideRoomStateOverlay() {
  const overlay = getRoomStateOverlay();
  overlay.classList.add('hidden');
  overlay.textContent = '';
  restoreBaseRoomIds();
  window.__ASPB_WAITING_ROOM_CHAT__ = false;
}

function renderRoomStateOverlay(html) {
  const overlay = getRoomStateOverlay();
  suspendBaseRoomIds(overlay);
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
}

function suspendBaseRoomIds(overlay) {
  ROOM_STATE_DUPLICATE_IDS.forEach(id => {
    const node = document.getElementById(id);
    if (!node || overlay.contains(node)) return;
    node.dataset.roomStateOriginalId = id;
    node.removeAttribute('id');
  });
}

function restoreBaseRoomIds() {
  document.querySelectorAll('[data-room-state-original-id]').forEach(node => {
    node.id = node.dataset.roomStateOriginalId;
    delete node.dataset.roomStateOriginalId;
  });
}

export function renderLockedRoom(message) {
  renderRoomStateOverlay(`
    <main style="min-height:100vh;display:grid;place-items:center;background:#f8f9fa;color:#041627;font-family:Manrope,Arial,sans-serif;padding:24px">
      <section style="max-width:560px;background:#fff;border:1px solid #d2e4fb;border-radius:24px;padding:36px;text-align:center;box-shadow:0 24px 70px rgba(4,22,39,.08)">
        <h1 style="font-size:32px;margin:0 0 12px">Вход в комнату по персональной ссылке</h1>
        <p data-locked-room-message style="font-size:18px;color:#44474c;line-height:1.55"></p>
        <a href="register.html" style="display:inline-flex;margin-top:20px;background:#041627;color:#fff;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:700">Зарегистрироваться</a>
      </section>
    </main>`);
  document.querySelector('[data-locked-room-message]').textContent = String(message ?? '');
}

function renderChatPanelHtml() {
  return `
    <section style="width:min(100%,520px);background:#fff;border:1px solid #d2e4fb;border-radius:18px;box-shadow:0 18px 50px rgba(4,22,39,.08);overflow:hidden">
      <div style="padding:16px 18px;border-bottom:1px solid rgba(210,228,251,.55);display:flex;align-items:center;justify-content:space-between;gap:16px">
        <div>
          <h2 style="margin:0;color:#041627;font-size:16px;font-weight:800">Чат эфира</h2>
          <div id="chatActivity" style="font-size:12px;color:#5b6470;margin-top:3px">Чат открыт, можно писать вопрос</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;color:#5b6470;font-size:12px">
          <span style="width:8px;height:8px;border-radius:999px;background:#22c55e;display:inline-block;box-shadow:0 0 0 5px rgba(34,197,94,.12)"></span>
          <span id="chatOnlineLabel">чат открыт</span>
        </div>
      </div>
      <div id="liveChatMessages" style="height:320px;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:10px">
          <div style="width:28px;height:28px;border-radius:50%;background:#1e40af;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:700">М</div>
          <div style="flex:1;min-width:0">
            <span style="font-size:11px;font-weight:700;color:#1e40af">Марина, юрист</span>
            <p style="font-size:13px;color:#44474c;line-height:1.4;margin:2px 0 0;word-wrap:break-word">Добрый день всем. Чат открыт: можно заранее написать вопрос по своему кейсу.</p>
          </div>
        </div>
      </div>
      <div style="padding:12px;background:#f4f8fc;border-top:1px solid rgba(210,228,251,.55)">
        <div style="position:relative">
          <input id="questionInput" type="text" placeholder="Задайте вопрос..." style="width:100%;box-sizing:border-box;border:1px solid rgba(91,100,112,.22);border-radius:14px;padding:12px 46px 12px 14px;font:14px Manrope,Arial,sans-serif;color:#041627;background:#fff;outline:none"/>
          <button id="questionSubmit" type="button" style="position:absolute;right:7px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:0;border-radius:999px;background:#041627;color:#fff;display:grid;place-items:center;cursor:pointer">
            <span class="material-symbols-outlined" style="font-size:19px">send</span>
          </button>
        </div>
      </div>
    </section>`;
}

export function renderWaitingRoom(data) {
  const title = data.accessStatus === 'closed'
    ? 'Доступ к записи завершен'
    : data.accessStatus === 'pre_live'
      ? 'Комната скоро откроется'
      : 'Эфир еще не начался';
  const text =
    data.accessStatus === 'closed'
      ? 'Срок доступа к записи по этой персональной ссылке истек.'
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
      ? '<a href="register.html" style="display:inline-flex;margin-top:28px;background:#fff;color:#041627;text-decoration:none;padding:16px 28px;border-radius:14px;font-weight:700;font-size:15px;box-shadow:0 4px 16px rgba(0,0,0,0.1)">Зарегистрироваться заново</a>'
      : '<a href="success.html" style="display:inline-flex;margin-top:28px;background:rgba(255,255,255,0.1);border:1px solid rgba(210,228,251,0.3);color:#d2e4fb;text-decoration:none;padding:14px 24px;border-radius:14px;font-weight:600;font-size:14px;backdrop-filter:blur(8px)">Проверить регистрацию</a>';

  renderRoomStateOverlay(`
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#041627;color:#fff;font-family:Manrope,Arial,sans-serif;padding:24px;position:relative;overflow:hidden">
      <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(56,78,183,0.15),transparent 60%),radial-gradient(ellipse at 80% 70%,rgba(108,52,163,0.1),transparent 50%);pointer-events:none"></div>
      <div style="width:min(100%,1120px);display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px;align-items:center;position:relative;z-index:1">
        <section style="max-width:560px;text-align:center;margin:0 auto">
          <div style="width:56px;height:56px;margin:0 auto 20px;border-radius:50%;background:rgba(210,228,251,0.1);border:1px solid rgba(210,228,251,0.2);display:flex;align-items:center;justify-content:center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#b7d4f7" stroke-width="2" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
          <p style="margin:0 0 8px;color:rgba(210,228,251,0.6);font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:11px">АСПБ автовебинар</p>
          <h1 data-waiting-room-title style="font-size:32px;font-weight:800;margin:0 0 12px;line-height:1.2"></h1>
          <p data-waiting-room-text style="font-size:16px;color:rgba(255,255,255,0.6);line-height:1.6;margin:0"></p>
          ${countdownHtml}
          ${action}
        </section>
        <div id="webinarChatPanel" style="display:flex;justify-content:center">${renderChatPanelHtml()}</div>
      </div>
    </main>`);
  window.__ASPB_WAITING_ROOM_CHAT__ = data.accessStatus === 'waiting' || data.accessStatus === 'pre_live';
  document.querySelector('[data-waiting-room-title]').textContent = title;
  document.querySelector('[data-waiting-room-text]').textContent = text;
  bindQuestionForm();

  if (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') {
    startCountdown(data.webinar.scheduledAt);
    if (window.__liveChatRefresh) {
      window.__liveChatRefresh();
    }
    window.setTimeout(() => window.location.reload(), 30 * 1000);
  }
}

export function updateRoomStatus(webinar) {
  const node = document.getElementById('webinarStatusText');
  const countdownContainer = document.getElementById('countdownContainer');
  if (!node || !webinar) return;
  if (webinar.testMode) {
    node.textContent = 'Эфир идет. Включайте трансляцию и задавайте вопросы в чате.';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'live' || webinar.status === 'live') {
    node.textContent = 'Эфир идет. Включайте запись и следите за подсказками АСПБ.';
    if (countdownContainer) countdownContainer.classList.add('hidden');
  } else if (webinar.accessStatus === 'replay' || webinar.status === 'finished') {
    const expires = webinar.replayExpiresAt ? ` Доступ к записи открыт до ${formatMoscowDateTime(webinar.replayExpiresAt)} МСК.` : '';
    node.textContent = `Вебинар окончен, но запись доступна по вашей персональной ссылке.${expires} Чат остается открытым для вопросов, а заявку можно оставить ниже.`;
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
    if (countdownContainer) countdownContainer.classList.remove('hidden');
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
      hideRoomStateOverlay();
      const serverTime = new Date(data.serverTime).getTime();
      state.serverTimeOffset = serverTime - Date.now();

      state.webinarConfig = {
        scheduledAt: new Date(data.webinar.scheduledAt).getTime(),
        status: data.testMode ? 'test' : data.liveState?.status || data.webinar.status,
        accessStatus: data.accessStatus,
        durationMinutes: data.webinar.durationMinutes,
        videoDurationSeconds: data.webinar.videoDurationSeconds,
        liveState: data.liveState
      };

      updateTelegramLinks(data.telegramUrl);
      startCountdown(data.webinar.scheduledAt);
      updateRoomStatus({ ...data.webinar, accessStatus: data.accessStatus, replayExpiresAt: data.replayExpiresAt, testMode: data.testMode });
      await onSuccess();
      return;

    } catch (err) {
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
