/**
 * recordings.js — cabinet media library and recording playback.
 */

import { getJson, formatMoscowDateTime, formatTimelineTime } from './utils.js?v=site-review-7';
import { track } from './analytics.js?v=ana-006-1';

let hlsInstance = null;
let hlsScriptPromise = null;
let progressTimer = null;
let currentRecordingId = null;
let fullscreenChangeHandler = null;
let videoSourceAttempt = 0;
const progressMarks = new Set();
const heartbeatMarks = new Set();

let currentPlaylist = [];
let currentServerTime = null;
let searchQuery = '';
let actionsBound = false;

const WATCHED_STORAGE_KEY = 'aspb:watchedRecordings';

function getWatchedIds() {
  try {
    const raw = localStorage.getItem(WATCHED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function markWatched(id) {
  if (!id) return;
  try {
    const watched = getWatchedIds();
    if (watched.has(id)) return;
    watched.add(id);
    localStorage.setItem(WATCHED_STORAGE_KEY, JSON.stringify([...watched]));
  } catch {
    return; // localStorage недоступен (приватный режим) — статус просто не сохранится.
  }
  renderPlaylist(currentRecordingId);
}

function pluralRecordings(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запись';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'записи';
  return 'записей';
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsScriptPromise) return hlsScriptPromise;

  hlsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.js/hls.min.js';
    script.async = true;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => {
      hlsScriptPromise = null;
      reject(new Error('hls.js load failed'));
    };
    document.head.appendChild(script);
  });

  return hlsScriptPromise;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setRecordingPlaybackFailureState(failed) {
  const shell = document.getElementById('recordingPlayerShell');
  const overlay = document.getElementById('recordingOverlayButton');
  const controls = shell?.parentElement?.querySelector('.recording-controls');
  if (shell) shell.dataset.playbackState = failed ? 'failed' : 'ready';

  if (overlay) {
    overlay.disabled = failed;
    overlay.hidden = failed;
    overlay.classList.toggle('hidden', failed);
    if (failed) {
      overlay.setAttribute('inert', '');
      overlay.setAttribute('aria-hidden', 'true');
    } else {
      overlay.removeAttribute('inert');
      overlay.removeAttribute('aria-hidden');
    }
  }

  if (!controls) return;
  controls.hidden = failed;
  if (failed) {
    controls.setAttribute('inert', '');
    controls.setAttribute('aria-hidden', 'true');
  } else {
    controls.removeAttribute('inert');
    controls.removeAttribute('aria-hidden');
  }
  controls.querySelectorAll('button, input').forEach(control => {
    if (failed && !control.disabled) {
      control.disabled = true;
      control.dataset.playbackFailureDisabled = 'true';
    } else if (!failed && control.dataset.playbackFailureDisabled === 'true') {
      control.disabled = false;
      delete control.dataset.playbackFailureDisabled;
    }
  });
}

const htmlEscapeNode = document.createElement('span');

function escapeHtml(value) {
  htmlEscapeNode.textContent = String(value ?? '');
  return htmlEscapeNode.innerHTML;
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
  clearTemporaryError();
  const root = document.getElementById('recordingsApp');
  if (!root) return;
  document.getElementById('recordingsCounter')?.setAttribute('hidden', '');
  root.innerHTML = `
    <section class="recordings-empty">
      <span class="material-symbols-outlined">video_library</span>
      <h1>Записи пока готовятся</h1>
      <p>Как только материал будет опубликован, он появится здесь без повторной регистрации.</p>
      <a href="webinar.html" class="recordings-primary-link">Открыть вебинар</a>
    </section>
  `;
}

function showLocked(payload) {
  clearTemporaryError();
  const root = document.getElementById('recordingsApp');
  if (!root) return;
  document.getElementById('recordingsCounter')?.setAttribute('hidden', '');
  const scheduledAt = payload.webinar?.scheduledAt ? formatMoscowDateTime(payload.webinar.scheduledAt) : '19:30';
  const availableAt = payload.webinar?.recordingAvailableAt ? formatMoscowDateTime(payload.webinar.recordingAvailableAt) : '';
  const isLive = payload.accessStatus === 'live';
  root.innerHTML = `
    <section class="recordings-empty">
      <span class="material-symbols-outlined">${isLive ? 'live_tv' : 'lock_clock'}</span>
      <h1>${isLive ? 'Сейчас идет премьера записи' : 'Запись откроется после премьеры'}</h1>
      <p>${
        isLive
          ? 'Не открываем постоянную запись во время премьеры, чтобы сохранить последовательность программы. Подключайтесь к комнате и смотрите по таймлайну.'
          : `До старта в ${escapeHtml(scheduledAt)} МСК постоянная запись закрыта. После премьеры${availableAt ? `, ориентировочно ${escapeHtml(availableAt)} МСК,` : ''} она появится здесь.`
      }</p>
      <a href="${escapeHtml(payload.roomUrl || 'webinar.html')}" class="recordings-primary-link">${isLive ? 'Подключиться к премьере' : 'Открыть окно ожидания'}</a>
    </section>
  `;
}

function isAccessError(error) {
  return error && [401, 403].includes(Number(error.status));
}

function showAccessGate() {
  clearTemporaryError();
  const root = document.getElementById('recordingsApp');
  if (!root) return;
  root.innerHTML = `
    <section class="recordings-access-gate">
      <div class="recordings-access-panel">
        <div class="recordings-access-visual" aria-hidden="true">
          <span>АСПБ</span>
          <strong>Записи вебинаров открываются через личный доступ участника.</strong>
        </div>
        <div class="recordings-access-copy">
          <p class="recordings-access-kicker">Библиотека участника</p>
          <h1>Войдите в “Мой доступ”, чтобы смотреть записи</h1>
          <p>Записи — часть личной библиотеки участника. Если вы уже регистрировались, не заполняйте форму повторно: войдите по email и откройте материалы без пароля.</p>
          <div class="recordings-access-actions">
            <a href="access.html" class="recordings-primary-link">Я уже зарегистрирован — войти</a>
            <a href="register.html" class="recordings-secondary-link">Зарегистрироваться впервые</a>
          </div>
        </div>
      </div>
    </section>
  `;
}

function temporaryRequestMessage(error) {
  if (navigator.onLine === false) {
    return 'Нет соединения с интернетом. Доступ к библиотеке не удалён; подключитесь к сети и повторите.';
  }
  if (Number(error?.status) >= 500) {
    return 'Сервис записей временно недоступен. Это не означает потерю доступа — повторите запрос через несколько секунд.';
  }
  return error?.message || 'Не удалось связаться с сервером. Доступ и текущий выбор записи сохранены.';
}

function clearTemporaryError() {
  const errorNode = document.getElementById('recordingsRequestError');
  const app = document.getElementById('recordingsApp');
  if (errorNode) errorNode.hidden = true;
  if (app) app.hidden = false;
}

function showTemporaryError(error, retry) {
  const errorNode = document.getElementById('recordingsRequestError');
  const app = document.getElementById('recordingsApp');
  const text = document.getElementById('recordingsRequestErrorText');
  const button = document.getElementById('recordingsRequestRetry');
  if (!errorNode || !app || !button) return;

  if (text) text.textContent = temporaryRequestMessage(error);
  app.hidden = true;
  errorNode.hidden = false;
  button.disabled = false;
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Повторяем...';
    clearTemporaryError();
    try {
      await retry();
    } finally {
      button.disabled = false;
      button.textContent = 'Повторить';
    }
  };
  button.focus({ preventScroll: true });
}

function handleRequestError(error, retry) {
  if (isAccessError(error)) {
    showAccessGate();
    return;
  }
  if (Number(error?.status) === 404) {
    showTemporaryError(
      { message: 'Эта запись больше недоступна. Обновите библиотеку, чтобы открыть актуальный материал.' },
      () => hydrateRecordingsPage(),
    );
    return;
  }
  showTemporaryError(error, retry);
}

function recordingMatchesQuery(recording, query) {
  if (!query) return true;
  const haystack = `${recording.title || ''} ${formatAirDate(recording.webinar.scheduledAt)}`.toLowerCase();
  return haystack.includes(query);
}

function renderPlaylist(activeId) {
  const list = document.getElementById('recordingsPlaylist');
  if (!list) return;
  list.replaceChildren();

  const watched = getWatchedIds();
  const query = searchQuery.trim().toLowerCase();
  const visible = currentPlaylist.filter(recording => recordingMatchesQuery(recording, query));

  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'playlist-empty';
    empty.textContent = query ? 'Ничего не найдено по запросу.' : 'Записей пока нет.';
    list.appendChild(empty);
    return;
  }

  visible.forEach(recording => {
    const index = currentPlaylist.indexOf(recording);
    const isActive = recording.id === activeId;
    const isWatched = watched.has(recording.id);

    let statusClass = 'recording-status';
    let statusText = statusLabel(recording, currentServerTime);
    if (isActive) {
      statusClass = 'recording-status recording-status--active';
      statusText = 'Смотрите';
    } else if (isWatched) {
      statusClass = 'recording-status recording-status--watched';
      statusText = 'Просмотрено';
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `recording-item${isActive ? ' recording-item--active' : ''}`;
    item.dataset.recordingId = recording.id;
    if (isActive) item.setAttribute('aria-current', 'true');
    item.innerHTML = `
      <span class="recording-item__thumb">
        <img src="${escapeHtml(recording.posterUrl || 'assets/webinar-poster.jpg')}" alt="" class="recording-item__poster" loading="lazy">
        <span class="recording-item__duration">${formatTimelineTime(recording.durationSeconds || 0)}</span>
        <span class="recording-item__nowplaying"><span class="material-symbols-outlined">graphic_eq</span>Идёт просмотр</span>
      </span>
      <span class="recording-item__body">
        <span class="recording-item__topline"><span>${escapeHtml(formatAirDate(recording.webinar.scheduledAt))}</span></span>
        <span class="recording-item__title">${escapeHtml(recording.title)}</span>
        <span class="recording-item__footer"><span class="${statusClass}">${escapeHtml(statusText)}</span></span>
      </span>
    `;
    item.addEventListener('click', () => {
      track('recording_cta_click', { recordingId: recording.id, index });
      loadRecordingSafely(recording.id);
    });
    list.appendChild(item);
  });
}

function toggleSearchVisibility(total) {
  const wrap = document.getElementById('recordingsSearchWrap');
  if (!wrap) return;
  if (total > 4) wrap.removeAttribute('hidden');
  else wrap.setAttribute('hidden', '');
}

function bindStaticActions() {
  if (actionsBound) return;
  actionsBound = true;

  const search = document.getElementById('recordingsSearch');
  search?.addEventListener('input', () => {
    searchQuery = search.value || '';
    renderPlaylist(currentRecordingId);
  });

  document.getElementById('recordingFullscreenAction')?.addEventListener('click', () => {
    document.getElementById('recordingFullscreenButton')?.click();
  });

  const shareButton = document.getElementById('recordingShareAction');
  const shareLabel = document.getElementById('recordingShareLabel');
  shareButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      if (shareLabel) {
        const original = shareLabel.textContent;
        shareLabel.textContent = 'Ссылка скопирована';
        window.setTimeout(() => {
          shareLabel.textContent = original;
        }, 2000);
      }
    } catch {
      // Clipboard API недоступен (нет https/разрешения) — действие тихо пропускаем.
    }
  });
}

function resetProgressTracking(recordingId) {
  currentRecordingId = recordingId;
  progressMarks.clear();
  heartbeatMarks.clear();
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
  const panel = shell?.closest('.recording-player-panel');

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
    const playbackFailed = shell?.dataset.playbackState === 'failed';
    if (freshPlay) {
      freshPlay.querySelector('.material-symbols-outlined').textContent = icon;
      freshPlay.setAttribute('aria-label', video.paused ? 'Воспроизвести запись' : 'Поставить запись на паузу');
      freshPlay.disabled = playbackFailed;
    }
    if (freshOverlay) {
      freshOverlay.classList.toggle('hidden', playbackFailed || !video.paused);
      freshOverlay.disabled = playbackFailed;
      freshOverlay.setAttribute('aria-label', 'Воспроизвести запись');
    }
  }

  function updateTime() {
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : recording.durationSeconds || 0;
    const percent = total ? (video.currentTime / total) * 100 : 0;
    if (freshSeek) freshSeek.value = String(Math.max(0, Math.min(100, percent)));
    if (freshSeek) freshSeek.setAttribute('aria-valuetext', `${formatTimelineTime(video.currentTime)} из ${formatTimelineTime(total)}`);
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
    freshMute.setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук');
  });
  function updateFullscreenIcon() {
    const icon = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
    freshFullscreen?.querySelector('.material-symbols-outlined')?.replaceChildren(document.createTextNode(icon));
    freshFullscreen?.setAttribute('aria-label', document.fullscreenElement ? 'Выйти из полноэкранного режима' : 'Открыть на весь экран');
  }

  function requestPlayerFullscreen() {
    try {
      const target = panel || shell;
      if (target?.requestFullscreen) {
        target.requestFullscreen().catch(() => {});
      } else if (target?.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      } else if (video?.webkitEnterFullscreen) {
        // iOS Safari (iPhone) не поддерживает Fullscreen API для произвольных
        // элементов — фуллскрин умеет только сам <video> через нативный метод.
        // Для входа нужны метаданные: если ещё не загружены — входим по их готовности.
        if (video.readyState >= 1) {
          video.webkitEnterFullscreen();
        } else {
          // НЕ зовём video.load() — оно ре-инициализирует элемент (currentTime→0, прерывает play).
          // Источник уже задан в openRecording(); ждём метаданные и входим в фуллскрин (как в video.js).
          video.addEventListener('loadedmetadata', () => video.webkitEnterFullscreen?.(), { once: true });
        }
      }
    } catch {
      // Some embedded browsers deny fullscreen synchronously.
    }
  }

  function exitPlayerFullscreen() {
    try {
      if (document.exitFullscreen) {
        document.exitFullscreen()?.catch(() => {});
      } else if (video?.webkitExitFullscreen) {
        // iOS: выход из нативного фуллскрина видео (а также кнопкой «Готово» самого плеера).
        video.webkitExitFullscreen();
      }
    } catch {
      // Ignore browser-level fullscreen permission denials.
    }
  }

  if (fullscreenChangeHandler) {
    document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
    fullscreenChangeHandler = null;
  }

  freshFullscreen?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      requestPlayerFullscreen();
    } else {
      exitPlayerFullscreen();
    }
    window.setTimeout(updateFullscreenIcon, 0);
  });
  fullscreenChangeHandler = updateFullscreenIcon;
  document.addEventListener('fullscreenchange', fullscreenChangeHandler);
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
    markWatched(recording.id);
    updatePlayIcon();
  });
  updateTime();
  updatePlayIcon();
  if (freshMute) {
    freshMute.setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук');
  }
  updateFullscreenIcon();

  progressTimer = window.setInterval(() => {
    if (!currentRecordingId || currentRecordingId !== recording.id || video.paused || document.visibilityState === 'hidden') return;
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : recording.durationSeconds || 0;
    if (!total) return;
    const heartbeatInterval = Math.max(0, Math.floor(video.currentTime / 15));
    if (!heartbeatMarks.has(heartbeatInterval)) {
      heartbeatMarks.add(heartbeatInterval);
      track('viewer_heartbeat', {
        intervalNumber: heartbeatInterval,
        positionSeconds: video.currentTime,
        durationSeconds: total,
        intervalSeconds: 15,
        playbackState: 'playing',
        visibilityState: 'visible',
        playbackMode: 'replay',
      });
    }
    const percent = (video.currentTime / total) * 100;
    [25, 50, 75].forEach(mark => {
      if (percent >= mark && !progressMarks.has(mark)) {
        progressMarks.add(mark);
        track(`recording_progress_${mark}`, { recordingId: recording.id });
      }
    });
    if (percent >= 90) markWatched(recording.id);
  }, 1200);
}

function allowedMp4Source(recording) {
  const localFallbackAllowed = Boolean(recording.video.localFallbackAllowed ?? recording.video.fallbackAllowed);
  const externalMp4Allowed = Boolean(recording.video.externalMp4Allowed);
  return recording.video.src && (externalMp4Allowed || localFallbackAllowed) ? recording.video.src : '';
}

function showRecordingVideoFailure(video, recording, message) {
  const fallback = document.getElementById('recordingVideoFallback');
  const text = document.getElementById('recordingVideoFallbackText');
  const retry = document.getElementById('recordingVideoRetry');
  const activeElement = document.activeElement;
  const controls = document.querySelector('.recording-controls');
  const overlay = document.getElementById('recordingOverlayButton');
  const focusNeedsRecovery = Boolean(
    activeElement &&
      ((controls && controls.contains(activeElement)) ||
        (overlay && (activeElement === overlay || overlay.contains(activeElement)))),
  );
  video.pause();
  setRecordingPlaybackFailureState(true);
  if (text) text.textContent = message;
  fallback?.classList.remove('hidden');
  if (retry) {
    retry.disabled = false;
    retry.onclick = async () => {
      retry.disabled = true;
      retry.textContent = 'Загружаем...';
      try {
        await setVideoSource(video, recording);
      } finally {
        retry.disabled = false;
        retry.textContent = 'Повторить загрузку видео';
      }
    };
    if (focusNeedsRecovery) retry.focus({ preventScroll: true });
  }
}

function loadMp4(video, recording, source, attempt) {
  video.addEventListener('error', () => {
    if (attempt !== videoSourceAttempt) return;
    showRecordingVideoFailure(
      video,
      recording,
      'Не удалось загрузить резервный формат записи. Проверьте соединение и повторите попытку.',
    );
  }, { once: true });
  video.src = source;
  video.load();
}

async function setVideoSource(video, recording) {
  const attempt = ++videoSourceAttempt;
  const fallback = document.getElementById('recordingVideoFallback');
  fallback?.classList.add('hidden');
  setRecordingPlaybackFailureState(false);

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  video.pause();
  video.removeAttribute('controls');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.removeAttribute('src');
  video.load();
  if (recording.video.poster) video.setAttribute('poster', recording.video.poster);
  const mp4Source = allowedMp4Source(recording);

  if (recording.video.hlsSrc) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener('error', () => {
        if (attempt !== videoSourceAttempt) return;
        if (mp4Source) {
          loadMp4(video, recording, mp4Source, attempt);
          return;
        }
        showRecordingVideoFailure(video, recording, 'HLS-поток временно недоступен. Проверьте соединение и повторите попытку.');
      }, { once: true });
      video.src = recording.video.hlsSrc;
      video.load();
      return;
    }

    try {
      const Hls = await loadHlsScript();
      if (attempt !== videoSourceAttempt) return;
      if (Hls?.isSupported()) {
        const hls = new Hls({ lowLatencyMode: false, enableWorker: true });
        hlsInstance = hls;
        let networkRecoveries = 0;
        let mediaRecoveries = 0;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal || attempt !== videoSourceAttempt) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
            networkRecoveries += 1;
            window.setTimeout(() => {
              if (attempt === videoSourceAttempt) hls.startLoad();
            }, networkRecoveries * 500);
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          if (hlsInstance === hls) hlsInstance = null;
          if (mp4Source) {
            loadMp4(video, recording, mp4Source, attempt);
            return;
          }
          showRecordingVideoFailure(video, recording, 'Не удалось восстановить HLS-поток. Повторите загрузку записи.');
        });
        hls.loadSource(recording.video.hlsSrc);
        hls.attachMedia(video);
        return;
      }
    } catch {
      // Continue to the explicitly permitted MP4 fallback below.
    }
  }

  if (mp4Source) {
    loadMp4(video, recording, mp4Source, attempt);
    return;
  }

  showRecordingVideoFailure(video, recording, 'Для этой записи нет поддерживаемого источника видео. Попробуйте позже.');
}

function applyRecording(recording, playlist, serverTime) {
  const previousVideo = document.getElementById('recordingVideo');
  if (!previousVideo) return;
  const video = previousVideo.cloneNode(true);
  previousVideo.replaceWith(video);

  currentPlaylist = playlist;
  currentServerTime = serverTime;
  resetProgressTracking(recording.id);
  bindStaticActions();
  setText('recordingEyebrow', 'Запись');
  setText('recordingTitle', recording.title);
  setText('recordingDescription', recording.description || 'Запись вебинара доступна в вашем кабинете.');
  setText('recordingMeta', `${formatAirDate(recording.webinar.scheduledAt)} · ${formatTimelineTime(recording.durationSeconds || 0)}`);
  setText('recordingsCount', `${playlist.length} ${pluralRecordings(playlist.length)}`);
  toggleSearchVisibility(playlist.length);
  renderPlaylist(recording.id);
  setVideoSource(video, recording).catch(() => {
    showRecordingVideoFailure(
      video,
      recording,
      'Не удалось подготовить запись. Проверьте соединение и повторите загрузку.',
    );
  });
  bindControls(video, recording);
}

async function loadRecording(id) {
  clearTemporaryError();
  const payload = await getJson(`/recordings/${encodeURIComponent(id)}`);
  if (!payload.ok) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('token');
  url.searchParams.set('id', payload.recording.id);
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  applyRecording(payload.recording, payload.playlist, payload.serverTime);
}

async function loadRecordingSafely(id) {
  try {
    await loadRecording(id);
  } catch (error) {
    handleRequestError(error, () => loadRecordingSafely(id));
  }
}

export async function hydrateRecordingsPage() {
  if (!window.location.pathname.endsWith('recordings.html')) return;

  clearTemporaryError();
  try {
    const payload = await getJson('/recordings');
    if (!payload.ok) return;

    if (payload.locked) {
      showLocked(payload);
      return;
    }

    if (!payload.recordings?.length) {
      showEmpty();
      return;
    }

    const requestedId = new URLSearchParams(window.location.search).get('id');
    const initial = payload.recordings.find(recording => recording.id === requestedId) || payload.recordings[0];
    await loadRecording(initial.id);
  } catch (error) {
    handleRequestError(error, () => hydrateRecordingsPage());
  }
}
