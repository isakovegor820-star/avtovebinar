import { deleteJson, formatTimelineTime, getJson, post, putJson } from './utils.js?v=viewer-account-1';
import { track } from './analytics.js?v=ana-analytics-1';

const WRITE_INTERVAL_MS = 15_000;
let activeController = null;
let activeSessionId = null;
let progressWriteInFlight = null;
let lastWriteStartedAt = 0;

function node(id) {
  return document.getElementById(id);
}

function setPanelState(state, message) {
  const panel = node('roomNotesPanel');
  if (!panel) return;
  panel.dataset.state = state;
  const status = panel.querySelector('[data-room-block-state]');
  if (status) status.textContent = message;
}

function setHidden(element, hidden) {
  element?.classList.toggle('hidden', hidden);
}

function updateNoteTimestamp() {
  const video = node('webinarVideo');
  const label = node('roomNoteTimestamp');
  if (!video || !label) return;
  label.textContent = `Таймкод ${formatTimelineTime(video.currentTime)}`;
}

function requestSeek(seconds, label) {
  document.dispatchEvent(
    new CustomEvent('aspb:room-seek-request', {
      detail: { seconds: Math.max(0, Number(seconds) || 0), source: 'viewer_account' },
    }),
  );
  const status = node('roomContentActionStatus');
  if (status) status.textContent = `Переходим к ${formatTimelineTime(seconds)}: ${label}`;
}

function renderNotes(notes) {
  const list = node('roomNotesList');
  if (!list) return;
  list.replaceChildren(
    ...notes.map(note => {
      const item = document.createElement('li');
      item.className = 'room-note-item';
      item.dataset.noteId = note.id;
      const seek = document.createElement('button');
      seek.type = 'button';
      seek.className = 'room-time-button';
      seek.textContent = formatTimelineTime(note.timestampSeconds);
      seek.setAttribute('aria-label', `Перейти к заметке на ${formatTimelineTime(note.timestampSeconds)}`);
      seek.addEventListener('click', () => requestSeek(note.timestampSeconds, 'личная заметка'));
      const body = document.createElement('p');
      body.className = 'room-note-body';
      body.textContent = note.body;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'room-note-delete';
      remove.dataset.noteDelete = note.id;
      remove.textContent = 'Удалить';
      remove.setAttribute('aria-label', `Удалить заметку на ${formatTimelineTime(note.timestampSeconds)}`);
      item.append(seek, body, remove);
      return item;
    }),
  );
  setHidden(list, notes.length === 0);
  setHidden(node('roomNoteForm'), false);
  setPanelState(
    notes.length ? 'content' : 'empty',
    notes.length
      ? `Личных заметок: ${notes.length}`
      : 'Заметок пока нет. Они видны только вам.',
  );
}

async function loadNotes(sessionId) {
  const result = await getJson(`/v1/viewer/notes?sessionId=${encodeURIComponent(sessionId)}`);
  renderNotes(result.notes || []);
}

function restoreProgress(progress) {
  if (!progress || progress.completed || progress.positionSeconds <= 0) return;
  const video = node('webinarVideo');
  if (!video) return;
  const restore = () => {
    if (video.currentTime > 2) return;
    const duration = Number(video.duration);
    const target = Number(progress.positionSeconds);
    if (!Number.isFinite(target) || target <= 0) return;
    if (Number.isFinite(duration) && target >= duration - 10) return;
    requestSeek(target, 'сохранённая позиция');
    const status = node('webinarPlayerStatus');
    if (status) status.textContent = `Возвращаемся к ${formatTimelineTime(target)}.`;
  };
  if (video.readyState >= 1) restore();
  else video.addEventListener('loadedmetadata', restore, { once: true, signal: activeController?.signal });
}

async function writeProgress(options = {}) {
  const video = node('webinarVideo');
  if (!video || !activeSessionId || document.visibilityState === 'hidden') return null;
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime)) return null;
  const now = Date.now();
  if (!options.force && now - lastWriteStartedAt < WRITE_INTERVAL_MS) return null;
  if (progressWriteInFlight) return progressWriteInFlight;
  lastWriteStartedAt = now;
  const eventId = globalThis.crypto?.randomUUID?.() || `progress-${now}-${Math.random().toString(36).slice(2)}`;
  progressWriteInFlight = putJson(`/v1/viewer/progress/${encodeURIComponent(activeSessionId)}`, {
    positionSeconds: Math.max(0, video.currentTime),
    durationSeconds: video.duration,
    eventId,
  })
    .then(result => {
      if (result.writeAccepted) {
        track('viewer_heartbeat', {
          intervalNumber: Math.floor(now / WRITE_INTERVAL_MS),
          positionSeconds: Math.max(0, video.currentTime),
          durationSeconds: video.duration,
          intervalSeconds: WRITE_INTERVAL_MS / 1000,
          playbackState: video.paused ? 'paused' : 'playing',
          visibilityState: document.visibilityState,
          playbackMode: 'live',
        });
      }
      if (!result.writeAccepted && result.retryAfterMs) {
        lastWriteStartedAt = Date.now() - WRITE_INTERVAL_MS + Number(result.retryAfterMs);
      }
      return result;
    })
    .catch(() => null)
    .finally(() => {
      progressWriteInFlight = null;
    });
  return progressWriteInFlight;
}

function bindRoomEvents(sessionId) {
  activeController?.abort();
  activeController = new AbortController();
  activeSessionId = sessionId;
  progressWriteInFlight = null;
  lastWriteStartedAt = 0;
  const { signal } = activeController;
  const video = node('webinarVideo');
  if (!video) return;
  video.addEventListener(
    'timeupdate',
    () => {
      updateNoteTimestamp();
      if (!video.paused) void writeProgress();
    },
    { signal },
  );
  video.addEventListener('pause', () => void writeProgress({ force: true }), { signal });
  video.addEventListener('ended', () => void writeProgress({ force: true }), { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible' && !video.paused) void writeProgress({ force: true });
    },
    { signal },
  );
  node('roomNoteForm')?.addEventListener(
    'submit',
    async event => {
      event.preventDefault();
      const textarea = node('roomNoteBody');
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const body = String(textarea?.value || '').trim();
      if (!body) {
        textarea?.focus();
        return;
      }
      button.disabled = true;
      try {
        await post('/v1/viewer/notes', {
          sessionId: activeSessionId,
          timestampSeconds: Math.max(0, Number(video.currentTime) || 0),
          body,
        });
        textarea.value = '';
        await loadNotes(activeSessionId);
      } catch {
        setPanelState('error', 'Не удалось сохранить заметку. Проверьте доступ и повторите.');
      } finally {
        button.disabled = false;
      }
    },
    { signal },
  );
  node('roomNotesList')?.addEventListener(
    'click',
    async event => {
      const button = event.target.closest('[data-note-delete]');
      if (!button) return;
      button.disabled = true;
      try {
        await deleteJson(`/v1/viewer/notes/${encodeURIComponent(button.dataset.noteDelete)}`);
        await loadNotes(activeSessionId);
      } catch {
        button.disabled = false;
        setPanelState('error', 'Не удалось удалить заметку. Обновите список и повторите.');
      }
    },
    { signal },
  );
  updateNoteTimestamp();
}

export async function hydrateViewerRoom(data) {
  const sessionId = data?.webinar?.id;
  if (!data?.canEnterRoom || !sessionId) {
    activeController?.abort();
    activeSessionId = null;
    setHidden(node('roomNoteForm'), true);
    setHidden(node('roomNotesList'), true);
    setPanelState('unavailable', 'Личные заметки доступны после входа в открытую сессию.');
    return null;
  }
  bindRoomEvents(sessionId);
  setPanelState('loading', 'Загружаем личные заметки…');
  const [progressResult] = await Promise.all([
    getJson(`/v1/viewer/progress/${encodeURIComponent(sessionId)}`),
    loadNotes(sessionId),
  ]);
  restoreProgress(progressResult.progress);
  return progressResult;
}
