/**
 * recordings.js — cabinet media library and recording playback.
 */

import { getJson, formatTimelineTime } from './utils.js?v=account-access-4';
import { track } from './analytics.js';

let hlsInstance = null;
let hlsScriptPromise = null;
let progressTimer = null;
let currentRecordingId = null;
const progressMarks = new Set();

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsScriptPromise) return hlsScriptPromise;

  hlsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.js/hls.min.js';
    script.async = true;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error('hls.js load failed'));
    document.head.appendChild(script);
  });

  return hlsScriptPromise;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatAirDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function statusLabel(recording, serverTime) {
  const publishedAt = recording.publishedAt ? new Date(recording.publishedAt).getTime() : 0;
  const now = serverTime ? new Date(serverTime).getTime() : Date.now();
  return publishedAt && now - publishedAt < 7 * 24 * 60 * 60 * 1000 ? 'Новое' : 'Доступно';
}

function showEmpty() {
  const root = document.getElementById('recordingsApp');
  if (!root) return;
  root.innerHTML = `
    <section class="recordings-empty">
      <span class="material-symbols-outlined">video_library</span>
      <h1>Записи пока готовятся</h1>
      <p>Как только материал будет опубликован, он появится здесь без повторной регистрации.</p>
      <a href="webinar.html" class="recordings-primary-link">Открыть вебинар</a>
    </section>
  `;
}

function isAccessError(error) {
  return error && [401, 403, 404].includes(Number(error.status));
}

function showAccessGate() {
  const root = document.getElementById('recordingsApp');
  if (!root) return;
  root.innerHTML = `
    <section class="recordings-access-gate">
      <div class="recordings-access-copy">
        <h1>Записи доступны после регистрации</h1>
        <p>Это раздел кабинета участника. Зарегистрируйтесь один раз или откройте персональную ссылку из письма/Telegram, чтобы восстановить доступ на этом устройстве.</p>
        <div class="recordings-access-actions">
          <a href="register.html" class="recordings-primary-link">Зарегистрироваться</a>
        </div>
      </div>
    </section>
  `;
}

function renderPlaylist(playlist, activeId, serverTime) {
  const list = document.getElementById('recordingsPlaylist');
  if (!list) return;
  list.replaceChildren();

  playlist.forEach((recording, index) => {
    const item = document.createElement('article');
    item.className = `recording-item${recording.id === activeId ? ' recording-item--active' : ''}`;
    item.dataset.recordingId = recording.id;
    item.innerHTML = `
      <img src="${escapeHtml(recording.posterUrl || 'assets/webinar-poster.jpg')}" alt="" class="recording-item__poster" loading="lazy">
      <div class="recording-item__body">
        <div class="recording-item__topline">
          <span>${formatAirDate(recording.webinar.scheduledAt)}</span>
          <span>${formatTimelineTime(recording.durationSeconds || 0)}</span>
        </div>
        <h3>${escapeHtml(recording.title)}</h3>
        <div class="recording-item__footer">
          <span class="recording-status">${statusLabel(recording, serverTime)}</span>
          <button type="button" class="recording-watch-button">Смотреть</button>
        </div>
      </div>
    `;
    item.querySelector('button')?.addEventListener('click', () => {
      track('recording_cta_click', { recordingId: recording.id, index });
      loadRecording(recording.id).catch(() => {});
    });
    item.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      loadRecording(recording.id).catch(() => {});
    });
    list.appendChild(item);
  });
}

function resetProgressTracking(recordingId) {
  currentRecordingId = recordingId;
  progressMarks.clear();
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function bindControls(video, recording) {
  const playButton = document.getElementById('recordingPlayButton');
  const overlayButton = document.getElementById('recordingOverlayButton');
  const muteButton = document.getElementById('recordingMuteButton');
  const fullscreenButton = document.getElementById('recordingFullscreenButton');
  const seek = document.getElementById('recordingSeek');
  const shell = document.getElementById('recordingPlayerShell');

  playButton?.replaceWith(playButton.cloneNode(true));
  overlayButton?.replaceWith(overlayButton.cloneNode(true));
  muteButton?.replaceWith(muteButton.cloneNode(true));
  fullscreenButton?.replaceWith(fullscreenButton.cloneNode(true));
  seek?.replaceWith(seek.cloneNode(true));

  const freshPlay = document.getElementById('recordingPlayButton');
  const freshOverlay = document.getElementById('recordingOverlayButton');
  const freshMute = document.getElementById('recordingMuteButton');
  const freshFullscreen = document.getElementById('recordingFullscreenButton');
  const freshSeek = document.getElementById('recordingSeek');
  const current = document.getElementById('recordingCurrentTime');
  const duration = document.getElementById('recordingDuration');
  if (freshMute) freshMute.querySelector('.material-symbols-outlined').textContent = video.muted ? 'volume_off' : 'volume_up';

  function updatePlayIcon() {
    const icon = video.paused ? 'play_arrow' : 'pause';
    if (freshPlay) freshPlay.querySelector('.material-symbols-outlined').textContent = icon;
    if (freshOverlay) freshOverlay.classList.toggle('hidden', !video.paused);
  }

  function updateTime() {
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : recording.durationSeconds || 0;
    const percent = total ? (video.currentTime / total) * 100 : 0;
    if (freshSeek) freshSeek.value = String(Math.max(0, Math.min(100, percent)));
    if (current) current.textContent = formatTimelineTime(video.currentTime);
    if (duration) duration.textContent = formatTimelineTime(total);
  }

  async function togglePlay() {
    if (video.paused) {
      await video.play();
      track('recording_play', { recordingId: recording.id });
    } else {
      video.pause();
    }
    updatePlayIcon();
  }

  freshPlay?.addEventListener('click', () => togglePlay().catch(() => {}));
  freshOverlay?.addEventListener('click', () => togglePlay().catch(() => {}));
  freshMute?.addEventListener('click', () => {
    video.muted = !video.muted;
    freshMute.querySelector('.material-symbols-outlined').textContent = video.muted ? 'volume_off' : 'volume_up';
  });
  freshFullscreen?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      shell?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  });
  freshSeek?.addEventListener('input', () => {
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : recording.durationSeconds || 0;
    if (total) video.currentTime = (Number(freshSeek.value) / 100) * total;
  });

  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('loadedmetadata', updateTime);
  video.addEventListener('ended', () => {
    track('recording_finish', { recordingId: recording.id });
    updatePlayIcon();
  });
  updateTime();
  updatePlayIcon();

  progressTimer = window.setInterval(() => {
    if (!currentRecordingId || currentRecordingId !== recording.id || video.paused) return;
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : recording.durationSeconds || 0;
    if (!total) return;
    const percent = (video.currentTime / total) * 100;
    [25, 50, 75].forEach(mark => {
      if (percent >= mark && !progressMarks.has(mark)) {
        progressMarks.add(mark);
        track(`recording_progress_${mark}`, { recordingId: recording.id });
      }
    });
  }, 1200);
}

async function setVideoSource(video, recording) {
  const fallback = document.getElementById('recordingVideoFallback');
  fallback?.classList.add('hidden');

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  video.pause();
  video.removeAttribute('controls');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.currentTime = 0;
  video.src = '';
  if (recording.video.poster) video.setAttribute('poster', recording.video.poster);

  if (recording.video.hlsSrc) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = recording.video.hlsSrc;
      video.load();
      return;
    }

    const Hls = await loadHlsScript();
    if (Hls?.isSupported()) {
      hlsInstance = new Hls({ lowLatencyMode: false, enableWorker: true });
      hlsInstance.loadSource(recording.video.hlsSrc);
      hlsInstance.attachMedia(video);
      return;
    }
  }

  if (recording.video.src && recording.video.fallbackAllowed) {
    video.src = recording.video.src;
    video.load();
    return;
  }

  fallback?.classList.remove('hidden');
}

function applyRecording(recording, playlist, currentIndex, serverTime) {
  const previousVideo = document.getElementById('recordingVideo');
  if (!previousVideo) return;
  const video = previousVideo.cloneNode(true);
  previousVideo.replaceWith(video);

  document.getElementById('recordingsCounter')?.removeAttribute('hidden');
  resetProgressTracking(recording.id);
  setText('recordingEyebrow', 'Запись');
  setText('recordingTitle', recording.title);
  setText('recordingDescription', recording.description || 'Запись вебинара доступна в вашем кабинете.');
  setText('recordingMeta', `${formatAirDate(recording.webinar.scheduledAt)} · ${formatTimelineTime(recording.durationSeconds || 0)}`);
  setText('recordingsCount', `${playlist.length} ${playlist.length === 1 ? 'запись' : 'записей'}`);
  setText('recordingPosition', `${currentIndex + 1} из ${playlist.length}`);
  renderPlaylist(playlist, recording.id, serverTime);
  setVideoSource(video, recording).catch(() => {
    document.getElementById('recordingVideoFallback')?.classList.remove('hidden');
  });
  bindControls(video, recording);
}

async function loadRecording(id) {
  const payload = await getJson(`/recordings/${encodeURIComponent(id)}`);
  if (!payload.ok) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('token');
  url.searchParams.set('id', payload.recording.id);
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  applyRecording(payload.recording, payload.playlist, payload.currentIndex, payload.serverTime);
}

export async function hydrateRecordingsPage() {
  if (!window.location.pathname.endsWith('recordings.html')) return;

  try {
    const payload = await getJson('/recordings');
    if (!payload.ok) return;

    if (!payload.recordings.length) {
      showEmpty();
      return;
    }

    const requestedId = new URLSearchParams(window.location.search).get('id');
    const initial = payload.recordings.find(recording => recording.id === requestedId) || payload.recordings[0];
    await loadRecording(initial.id);
  } catch (error) {
    if (isAccessError(error)) {
      showAccessGate();
      return;
    }
    showEmpty();
  }
}
