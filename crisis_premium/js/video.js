/**
 * video.js — плеер, контролы, seekbar, timeline events.
 */

import { state } from './state.js';
import { getJson, formatTimelineTime } from './utils.js?v=prelaunch-20260825-2';
import { timelinePath } from './registration.js?v=prelaunch-20260825-2';
import { setChatActivity } from './questions.js?v=prelaunch-20260825-2';
import { track } from './analytics.js?v=prelaunch-20260825-2';

/* --- cleanup tracking: prevents interval/listener leaks on re-init --- */
let _liveControlsInterval = null;
let _visibilityHandler = null;
let _fullscreenHandler = null;
let _hlsInstance = null;
let _hlsScriptPromise = null;
let _mediaAbortController = null;
let _mediaGeneration = 0;
let _endedMediaState = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function playbackStorageScope(webinarConfig) {
  const sessionIdentity = webinarConfig?.id || webinarConfig?.scheduledAt || window.location.pathname;
  return encodeURIComponent(String(sessionIdentity));
}

function playbackEndedStorageKey(webinarConfig) {
  return `aspb-video-ended-v1:${playbackStorageScope(webinarConfig)}`;
}

function readPlaybackEndedState(webinarConfig) {
  try {
    return window.sessionStorage.getItem(playbackEndedStorageKey(webinarConfig)) === 'true';
  } catch {
    return false;
  }
}

function persistPlaybackEndedState(webinarConfig) {
  try {
    window.sessionStorage.setItem(playbackEndedStorageKey(webinarConfig), 'true');
  } catch {
    // The end screen still works when storage is unavailable (private mode/policy).
  }
}

function createPlaybackAnalytics(webinarConfig) {
  const storageKey = `aspb-video-events-v1:${playbackStorageScope(webinarConfig)}`;
  let emitted = new Set();

  try {
    const persisted = JSON.parse(window.sessionStorage.getItem(storageKey) || '[]');
    if (Array.isArray(persisted)) emitted = new Set(persisted.filter(value => typeof value === 'string'));
  } catch {
    emitted = new Set();
  }

  function emitOnce(key, eventName, metadata) {
    if (emitted.has(key)) return;
    emitted.add(key);
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify([...emitted]));
    } catch {
      // In-memory deduplication remains active when sessionStorage is unavailable.
    }
    track(eventName, metadata);
  }

  function recordStart() {
    emitOnce('video_start', 'video_start');
  }

  function recordSound(video) {
    if (!video.paused && !video.muted && video.volume > 0) {
      emitOnce('sound_on', 'sound_on');
    }
  }

  function recordProgress(positionSeconds, durationSeconds) {
    if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    const progress = positionSeconds / durationSeconds;
    if (progress >= 0.25) emitOnce('video_progress_25', 'video_progress_25');
    if (progress >= 0.5) emitOnce('video_progress_50', 'video_progress_50');
    if (progress >= 0.75) emitOnce('video_progress_75', 'video_progress_75');
  }

  function recordFinish() {
    emitOnce('video_finish', 'video_finish');
  }

  function timelineEventKey(event) {
    return `${Number(event?.offsetSeconds) || 0}:${String(event?.ctaUrl || '')}`;
  }

  function recordCtaAppear(event) {
    const key = timelineEventKey(event);
    emitOnce('cta_appear:' + key, 'cta_appear', {
      ctaKey: key,
      positionSeconds: Number(event?.offsetSeconds) || 0,
    });
  }

  function recordCtaClick(event) {
    const key = timelineEventKey(event);
    emitOnce('cta_click:' + key, 'cta_click', {
      ctaKey: key,
      positionSeconds: Number(event?.offsetSeconds) || 0,
    });
  }

  return { recordStart, recordSound, recordProgress, recordFinish, recordCtaAppear, recordCtaClick };
}

function toSafeHref(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function showVideoFallback(fallback, message, mediaGeneration = null) {
  if (
    !fallback ||
    _endedMediaState ||
    (mediaGeneration !== null && mediaGeneration !== _mediaGeneration)
  ) {
    return;
  }
  const text = fallback.querySelector('[data-video-fallback-text]');
  if (text && message) text.textContent = message;
  document.getElementById('videoPlayOverlay')?.classList.add('hidden');
  document.getElementById('videoPauseOverlay')?.classList.add('hidden');
  document.getElementById('customPlayerControls')?.classList.add('hidden');
  document.getElementById('videoProcessing')?.classList.add('hidden');
  document.getElementById('videoProcessing')?.classList.remove('flex');
  setPlayerState('');
  const retry = fallback.querySelector('[data-video-fallback-retry]');
  if (retry) {
    retry.disabled = false;
    retry.textContent = 'Повторить подключение';
  }
  fallback.classList.remove('hidden');
  fallback.classList.add('flex');
}

function setPlayerState(message) {
  const visibleState = document.getElementById('playerStateIndicator');
  const screenReaderState = document.getElementById('webinarPlayerStatus');
  if (screenReaderState) screenReaderState.textContent = message || '';
  if (!visibleState) return;
  visibleState.textContent = message || '';
  visibleState.classList.toggle('hidden', !message);
}

function beginVideoMediaSession() {
  _mediaGeneration += 1;
  _endedMediaState = false;
  _mediaAbortController?.abort();
  _mediaAbortController = new AbortController();
  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }
  return {
    generation: _mediaGeneration,
    signal: _mediaAbortController.signal,
  };
}

function stopVideoMedia(video, { ended = false, clearSource = true } = {}) {
  _mediaGeneration += 1;
  _endedMediaState = ended;
  _mediaAbortController?.abort();
  _mediaAbortController = null;
  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }
  video.pause();
  if (!clearSource) return;
  video.removeAttribute('src');
  video.removeAttribute('poster');
  video.load();
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (_hlsScriptPromise) return _hlsScriptPromise;

  _hlsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.js/hls.min.js';
    script.async = true;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => {
      _hlsScriptPromise = null;
      reject(new Error('hls.js load failed'));
    };
    document.head.appendChild(script);
  });

  return _hlsScriptPromise;
}

async function initializeVideoSource(video, videoData, fallback, mediaSession) {
  const { generation, signal } = mediaSession;
  const isCurrentSession = () => generation === _mediaGeneration && !signal.aborted && !_endedMediaState;
  if (!isCurrentSession()) return;
  const hlsSrc = videoData && videoData.hlsSrc;
  const mp4Src = videoData && videoData.src;
  const poster = videoData && videoData.poster;
  const localFallbackAllowed = Boolean(videoData && (videoData.localFallbackAllowed ?? videoData.fallbackAllowed));
  const externalMp4Allowed = Boolean(videoData && videoData.externalMp4Allowed);
  const mp4Allowed = Boolean(mp4Src && (externalMp4Allowed || localFallbackAllowed));

  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }

  video.removeAttribute('controls');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.addEventListener('contextmenu', e => e.preventDefault(), { signal });
  fallback?.classList.add('hidden');
  fallback?.classList.remove('flex');

  if (poster) video.setAttribute('poster', poster);

  function loadMp4Fallback() {
    if (!mp4Allowed || !isCurrentSession()) return false;
    fallback?.classList.add('hidden');
    fallback?.classList.remove('flex');
    video.addEventListener(
      'error',
      () => {
        showVideoFallback(
          fallback,
          'Не удалось загрузить резервный формат видео. Проверьте соединение и попробуйте позже.',
          generation,
        );
      },
      { once: true, signal },
    );
    video.src = mp4Src;
    video.load();
    return true;
  }

  if (hlsSrc) {
    video.crossOrigin = 'anonymous';
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener(
        'error',
        () => {
          if (!loadMp4Fallback()) {
            showVideoFallback(
              fallback,
              'Не удалось загрузить HLS-поток вебинара. Проверьте соединение и попробуйте позже.',
              generation,
            );
          }
        },
        { once: true, signal },
      );
      video.src = hlsSrc;
      video.load();
      return;
    }

    try {
      const Hls = await loadHlsScript();
      if (!isCurrentSession()) return;
      if (!Hls || !Hls.isSupported()) {
        throw new Error('HLS is not supported in this browser');
      }

      const hls = new Hls({
        lowLatencyMode: false,
        enableWorker: true,
      });
      _hlsInstance = hls;
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal || !isCurrentSession()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
          networkRecoveries += 1;
          window.setTimeout(() => {
            if (_hlsInstance === hls && isCurrentSession()) hls.startLoad();
          }, networkRecoveries * 500);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
          mediaRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        _hlsInstance = null;
        if (loadMp4Fallback()) return;
        showVideoFallback(
          fallback,
          'Не удалось восстановить поток вебинара. Проверьте соединение и попробуйте позже.',
          generation,
        );
      });
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
      return;
    } catch (error) {
      if (!isCurrentSession()) return;
      console.error('HLS initialization failed:', error);
      if (!mp4Allowed) {
        showVideoFallback(
          fallback,
          'Не удалось запустить HLS-поток вебинара. Проверьте соединение или попробуйте открыть комнату позже.',
          generation,
        );
        return;
      }
    }
  }

  if (loadMp4Fallback()) return;

  showVideoFallback(
    fallback,
    'Видео вебинара пока недоступно. Команда АСПБ уже проверяет поток.',
    generation,
  );
}

function activateTimelineEvent(seconds, events, playbackAnalytics = null) {
  if (window.__ASPB_HIDE_TIMELINE_ACTIONS__) {
    const panel = document.getElementById('timelineActive');
    if (panel) panel.classList.add('hidden');
    return;
  }

  if (!events.length) return;
  const activeEvent = events.reduce((current, event) => {
    return seconds >= event.offsetSeconds ? event : current;
  }, events[0]);
  const panel = document.getElementById('timelineActive');
  if (!panel) return;

  const shouldShow =
    activeEvent &&
    (activeEvent.type === 'cta' || (activeEvent.ctaLabel && activeEvent.ctaUrl));

  if (!shouldShow) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  panel.textContent = '';

  panel.className = "bg-secondary-container border border-secondary rounded-lg p-5 shadow-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 animate-fade-in";

  const contentDiv = document.createElement('div');
  contentDiv.className = "flex-grow";

  const label = document.createElement('p');
  label.className = 'text-label-sm font-label-sm text-on-secondary-fixed-variant uppercase tracking-wider mb-1';
  label.textContent = activeEvent.type === 'final' ? 'Специальное предложение' : 'Интерактивное действие';

  const title = document.createElement('h3');
  title.className = 'text-headline-sm font-headline-sm text-primary font-bold';
  title.textContent = activeEvent.title;

  const text = document.createElement('p');
  text.className = 'text-body-md text-on-surface-variant mt-1 leading-snug';
  text.textContent = activeEvent.text;

  contentDiv.append(label, title, text);
  panel.append(contentDiv);

  const safeCtaUrl = toSafeHref(activeEvent.ctaUrl);
  if (activeEvent.ctaLabel && safeCtaUrl) {
    playbackAnalytics?.recordCtaAppear(activeEvent);
    const link = document.createElement('a');
    link.className = 'bg-primary text-on-primary rounded-xl px-6 py-3.5 font-label-md hover:bg-opacity-90 transition-[background-color,transform] text-center whitespace-nowrap motion-safe:scale-95 motion-safe:hover:scale-100 motion-safe:duration-300';
    link.href = safeCtaUrl;
    link.rel = 'noopener noreferrer';
    link.textContent = activeEvent.ctaLabel;
    link.addEventListener('click', () => playbackAnalytics?.recordCtaClick(activeEvent));
    panel.appendChild(link);
  }
}

export async function hydrateTimeline() {
  const container = document.getElementById('videoPlayerContainer');
  const video = document.getElementById('webinarVideo');
  const fallback = document.getElementById('videoFallback');
  const playerStatus = document.getElementById('webinarPlayerStatus');
  const active = document.getElementById('timelineActive');
  const playOverlay = document.getElementById('videoPlayOverlay');
  const standbyBackdrop = document.getElementById('webinarStandbyBackdrop');
  const pauseOverlay = document.getElementById('videoPauseOverlay');
  const processing = document.getElementById('videoProcessing');
  const fallbackRetry = fallback?.querySelector('[data-video-fallback-retry]');

  if (playOverlay) playOverlay.onclick = null;

  const customControls = document.getElementById('customPlayerControls');
  const playPauseBtn = document.getElementById('customPlayPauseBtn');
  const liveIndicator = document.getElementById('customLiveIndicator');
  const viewerCountValue = document.getElementById('viewerCountValue');
  const customTimeDisplay = document.getElementById('customTimeDisplay');
  const currentTimeText = document.getElementById('currentTimeText');
  const durationTimeText = document.getElementById('durationTimeText');
  const muteBtn = document.getElementById('customMuteBtn');
  const volumeSlider = document.getElementById('customVolumeSlider');
  const fullscreenBtn = document.getElementById('customFullscreenBtn');
  const seekContainer = document.getElementById('customSeekBarContainer');
  const seekAvailable = document.getElementById('customSeekBarAvailable');
  const seekProgress = document.getElementById('customSeekBarProgress');
  const seekThumb = document.getElementById('customSeekBarThumb');
  const liveEdgeMarker = document.getElementById('customLiveEdgeMarker');
  let returnToLiveBtn = document.getElementById('returnToLiveBtn');
  if (!returnToLiveBtn && liveIndicator?.parentElement) {
    returnToLiveBtn = document.createElement('button');
    returnToLiveBtn.id = 'returnToLiveBtn';
    returnToLiveBtn.type = 'button';
    returnToLiveBtn.className = 'hidden text-white/90 hover:text-white text-xs bg-white/10 border border-white/20 px-2.5 py-1 rounded-full font-bold uppercase tracking-wider backdrop-blur-sm';
    returnToLiveBtn.textContent = 'К текущему моменту';
    liveIndicator.parentElement.appendChild(returnToLiveBtn);
  }

  if (!active || !video) return;

  // --- cleanup previous intervals and document-level listeners (prevents leaks on re-init) ---
  if (_liveControlsInterval) { clearInterval(_liveControlsInterval); _liveControlsInterval = null; }
  if (_visibilityHandler) { document.removeEventListener('visibilitychange', _visibilityHandler); _visibilityHandler = null; }
  if (_fullscreenHandler) { document.removeEventListener('fullscreenchange', _fullscreenHandler); _fullscreenHandler = null; }
  const mediaSession = beginVideoMediaSession();
  setPlayerState('Загружаем состояние видео…');

  fallbackRetry?.addEventListener(
    'click',
    () => {
      fallbackRetry.disabled = true;
      fallbackRetry.textContent = 'Подключаемся…';
      fallback.classList.add('hidden');
      fallback.classList.remove('flex');
      setPlayerState('Повторно подключаем видео…');
      void hydrateTimeline();
    },
    { signal: mediaSession.signal },
  );

  // Загрузка состояния эфира с ретраями: один сетевой сбой/429/5xx больше не оставляет
  // «пустой» плеер без объяснения — повторяем, а при окончательной неудаче показываем фолбэк.
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await getJson(timelinePath());
      if (data && data.ok) break;
    } catch {
      data = null;
    }
    if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 800 * (attempt + 1)));
  }
  if (!data || !data.ok) {
    showVideoFallback(
      fallback,
      'Не удалось загрузить премьеру записи. Обновите страницу или попробуйте позже.',
      mediaSession.generation,
    );
    return;
  }

  // Waiting payloads intentionally omit video details; their countdown branch
  // below owns the UI. A media state is enforced only after the server returns
  // the protected video projection.
  const mediaState = data.video ? data.video.state || (data.video.expected ? 'ready' : 'unavailable') : 'ready';
  if (mediaState !== 'ready') {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    fallback?.classList.add('hidden');
    fallback?.classList.remove('flex');
    processing?.classList.add('hidden');
    processing?.classList.remove('flex');
    if (mediaState === 'processing') {
      document.getElementById('videoPlayOverlay')?.classList.add('hidden');
      document.getElementById('customPlayerControls')?.classList.add('hidden');
      processing?.classList.remove('hidden');
      processing?.classList.add('flex');
      setPlayerState('Видео обрабатывается');
    } else {
      showVideoFallback(
        fallback,
        mediaState === 'error'
          ? 'Не удалось подготовить запись. Команда АСПБ уже получила информацию и проверяет видео.'
          : 'Запись для этой сессии пока недоступна. Проверьте доступ позже.',
        mediaSession.generation,
      );
    }
    return;
  }

  processing?.classList.add('hidden');
  processing?.classList.remove('flex');
  let stalledFallbackTimer = null;
  const clearStalledFallbackTimer = () => {
    if (stalledFallbackTimer !== null) {
      window.clearTimeout(stalledFallbackTimer);
      stalledFallbackTimer = null;
    }
  };
  const announceLoading = () => setPlayerState('Загружаем видео…');
  const announceBuffering = () => {
    setPlayerState('Видео загружается…');
    if (stalledFallbackTimer !== null) return;
    stalledFallbackTimer = window.setTimeout(() => {
      stalledFallbackTimer = null;
      video.pause();
      showVideoFallback(
        fallback,
        'Видео не отвечает. Проверьте соединение и повторите подключение.',
        mediaSession.generation,
      );
    }, 12_000);
  };
  const announceReady = () => {
    clearStalledFallbackTimer();
    setPlayerState('');
  };
  const announceMediaError = () => {
    clearStalledFallbackTimer();
    showVideoFallback(
      fallback,
      'Не удалось загрузить видео. Проверьте соединение и повторите подключение.',
      mediaSession.generation,
    );
  };
  mediaSession.signal.addEventListener('abort', clearStalledFallbackTimer, { once: true });
  video.addEventListener('loadstart', announceLoading, { signal: mediaSession.signal });
  video.addEventListener('waiting', announceBuffering, { signal: mediaSession.signal });
  video.addEventListener('stalled', announceBuffering, { signal: mediaSession.signal });
  video.addEventListener('canplay', announceReady, { signal: mediaSession.signal });
  video.addEventListener('playing', announceReady, { signal: mediaSession.signal });
  video.addEventListener('error', announceMediaError, { signal: mediaSession.signal });

  const webinarConfig = state.webinarConfig;
  const serverLiveState = data.liveState || webinarConfig?.liveState || null;
  // Всегда конечное положительное число (фолбэк 568). На это опирается скраббер:
  // выражения вида (video.duration || videoDuration) никогда не дают NaN/Infinity,
  // поэтому video.currentTime не получит NaN до загрузки метаданных.
  const videoDuration = data.video && data.video.durationSeconds
    ? Number(data.video.durationSeconds)
    : Number(serverLiveState?.durationSeconds || webinarConfig?.videoDurationSeconds || 568);
  if (webinarConfig && serverLiveState) {
    webinarConfig.liveState = serverLiveState;
    webinarConfig.videoDurationSeconds = serverLiveState.durationSeconds || videoDuration;
    webinarConfig.status = webinarConfig.status || serverLiveState.status;
  }

  const isReplay = webinarConfig && webinarConfig.accessStatus === 'replay';
  const isLive = webinarConfig && webinarConfig.status === 'live' && !isReplay;
  const isTestMode = webinarConfig && webinarConfig.status === 'test';
  const isLiveVisual = isLive || isTestMode;
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const allowAutoplay = !prefersReducedMotion;
  const playbackAnalytics = createPlaybackAnalytics(webinarConfig);
  const nowServerMs = Date.now() + state.serverTimeOffset;
  const scheduledAtMs = Number(webinarConfig?.scheduledAt);
  const endedByClock = Boolean(
    isLive &&
      Number.isFinite(scheduledAtMs) &&
      scheduledAtMs > 0 &&
      nowServerMs >= scheduledAtMs + videoDuration * 1000,
  );
  const isPreLive = webinarConfig && (
    webinarConfig.accessStatus === 'waiting' ||
    webinarConfig.accessStatus === 'pre_live' ||
    webinarConfig.status === 'scheduled' ||
    // Жёсткая страховка «чисто закрытое окно до премьеры»: пока не наступило время старта
    // (19:30 МСК) и НЕ идёт премьера/тест — окно ВСЕГДА закрыто. Без этого до
    // старта мог мелькнуть постер/кадр прошлой трансляции (replay), затем переключиться на
    // отсчёт. Replay прошедших вебинаров не задеваем: у них scheduledAt в прошлом.
    (nowServerMs < webinarConfig.scheduledAt && !isLive && !isTestMode && !isReplay)
  );
  const endedByServerState =
    webinarConfig &&
    !isTestMode &&
    !isReplay &&
    (webinarConfig.status === 'finished' || serverLiveState?.isEnded || endedByClock);
  const hasPersistedPlaybackEnd = readPlaybackEndedState(webinarConfig);
  const isEnded = Boolean(endedByServerState || hasPersistedPlaybackEnd);
  const shouldShowCompletedEndState = isEnded;

  if (isPreLive || isEnded) {
    stopVideoMedia(video, { ended: Boolean(isEnded) });
    if (fallback) {
      fallback.classList.add('hidden');
      fallback.classList.remove('flex');
    }
  } else {
    await initializeVideoSource(video, data.video || {}, fallback, mediaSession);
    if (prefersReducedMotion) {
      video.pause();
      if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
      if (playOverlay) {
        playOverlay.classList.remove('hidden', 'opacity-0', 'webinar-prelive-overlay');
        playOverlay.innerHTML = `
          <span class="w-14 h-14 bg-white/12 backdrop-blur-md rounded-full flex items-center justify-center mb-4 border border-white/25 shadow-lg">
            <span class="material-symbols-outlined text-white text-3xl font-bold">play_arrow</span>
          </span>
          <span class="block text-headline-sm text-white font-bold tracking-wide uppercase">Начать просмотр премьеры</span>
          <span class="block text-body-md text-white/75 mt-1 max-w-md">Автовоспроизведение отключено по настройкам движения устройства</span>
        `;
      }
    }
  }

  if (playOverlay) {
    playOverlay.disabled = Boolean(isPreLive);
    playOverlay.dataset.action = shouldShowCompletedEndState ? 'recordings' : 'play';
    playOverlay.setAttribute(
      'aria-label',
      isPreLive
        ? 'Премьера ещё не началась'
        : shouldShowCompletedEndState
          ? 'Открыть записи вебинаров'
          : 'Начать просмотр видео',
    );
  }

  const liveBadge = document.getElementById('videoLiveBadge');
  if (liveBadge && webinarConfig) {
    if (isTestMode) {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ТЕСТ ПРЕМЬЕРЫ';
    } else if (isLive) {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ПРЕМЬЕРА ЗАПИСИ';
    } else if (isReplay) {
      liveBadge.className = 'absolute top-4 right-4 bg-black/55 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="material-symbols-outlined text-[15px]">play_circle</span>ЗАПИСЬ';
    } else {
      liveBadge.className = 'absolute top-4 right-4 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full text-white text-label-sm z-10';
      liveBadge.textContent = 'ЗАПИСЬ';
    }
  }
  const demoLiveStartedAt = Date.now() + state.serverTimeOffset;
  window.__ASPB_HIDE_TIMELINE_ACTIONS__ = Boolean(isPreLive);
  if (isPreLive && active) active.classList.add('hidden');
  let broadcastStarted = false;
  let manualBehindLive = false;
  let pausedFromLive = false;
  let userPaused = false;
  let wasPlayingBeforeHidden = false;
  let isScrubbing = false;
  let endedScreenVisible = false;
  const liveToleranceSeconds = 2.5;

  if (customControls && !shouldShowCompletedEndState) {
    customControls.removeAttribute('inert');
    customControls.removeAttribute('aria-hidden');
  }

  function getLivePosition() {
    if (!webinarConfig) return 0;
    const nowServer = Date.now() + state.serverTimeOffset;
    if (isTestMode) {
      return clamp((nowServer - demoLiveStartedAt) / 1000, 0, videoDuration);
    }
    if (!isLive) return 0;
    const elapsedSeconds = (nowServer - webinarConfig.scheduledAt) / 1000;
    return clamp(elapsedSeconds, 0, videoDuration);
  }

  video.muted = true;
  if (volumeSlider) volumeSlider.value = 0;
  if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
  if (muteBtn) {
    muteBtn.setAttribute('aria-label', 'Включить звук');
  }

  if (isPreLive) {
    // `room.js` owns the single state refresh at the countdown boundary. The
    // player only renders the local countdown: navigating the whole page here
    // used to duplicate token refreshes, waiting rows and page-view analytics.
    video.pause();
    if (customControls) customControls.classList.add('hidden');
    if (standbyBackdrop) standbyBackdrop.classList.remove('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0', 'bg-black/70', 'hover:bg-black/60', 'bg-black', 'hover:bg-black');
      playOverlay.classList.add('webinar-prelive-overlay');

      const countdownTitle = document.getElementById('broadcastCountdownTitle');
      const countdownNote = document.getElementById('broadcastCountdownNote');
      if (countdownTitle) countdownTitle.textContent = 'Премьера записи начнётся через';
      if (countdownNote) countdownNote.textContent = 'Окно откроется автоматически в момент начала премьеры';

      const countdownHours = document.getElementById('countdownHours');
      const countdownMinutes = document.getElementById('countdownMinutes');
      const countdownSeconds = document.getElementById('countdownSeconds');
      let countdownInterval = null;

      function updateCountdown() {
        const nowServer = Date.now() + state.serverTimeOffset;
        const remaining = Math.max(0, webinarConfig.scheduledAt - nowServer);
        const totalSeconds = Math.floor(remaining / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        if (countdownHours) countdownHours.textContent = String(h).padStart(2, '0');
        if (countdownMinutes) countdownMinutes.textContent = String(m).padStart(2, '0');
        if (countdownSeconds) countdownSeconds.textContent = String(s).padStart(2, '0');
        if (remaining <= 0) {
          if (countdownInterval) clearInterval(countdownInterval);
        }
      }

      updateCountdown();
      countdownInterval = window.setInterval(updateCountdown, 1000);
    }
  } else if (shouldShowCompletedEndState) {
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    showEndedScreen();
  } else if (isReplay) {
    video.pause();
    video.currentTime = 0;
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    if (customControls) customControls.classList.remove('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0');
      playOverlay.classList.remove('webinar-prelive-overlay');
      playOverlay.innerHTML = `
        <span class="w-16 h-16 bg-white/15 backdrop-blur-md rounded-full flex items-center justify-center mb-4 border border-white/25 hover:scale-105 transition-transform shadow-lg">
          <span class="material-symbols-outlined text-white text-4xl">play_arrow</span>
        </span>
        <span class="block text-headline-sm text-white font-bold tracking-wide uppercase">Смотреть запись</span>
        <span class="block text-body-md text-white/75 mt-1 max-w-md">Премьера завершена. Постоянная запись доступна в разделе «Записи».</span>
      `;
    }
  } else if (isTestMode) {
    video.pause();
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    video.currentTime = 0;
  } else {
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    if (playOverlay) playOverlay.classList.add('hidden');
    if (playOverlay) playOverlay.classList.remove('webinar-prelive-overlay');
    if (allowAutoplay) {
      video.play().catch(err => {
        if (_endedMediaState) return;
        console.log('Muted autoplay was prevented by browser, waiting for user click.', err);
        if (playOverlay) {
          playOverlay.classList.remove('hidden', 'opacity-0');
          playOverlay.innerHTML = `
            <span class="w-14 h-14 bg-white/12 backdrop-blur-md rounded-full flex items-center justify-center mb-4 border border-white/25 hover:scale-105 transition-transform shadow-lg">
              <span class="material-symbols-outlined text-white text-3xl font-bold">play_arrow</span>
            </span>
            <span class="block text-headline-sm text-white font-bold tracking-wide uppercase">Начать просмотр премьеры</span>
            <span class="block text-body-md text-white/75 mt-1 max-w-md">Нажмите, чтобы включить запись с текущего момента</span>
          `;
        }
      });
    }
  }

  if (isLiveVisual) {
    if (liveIndicator) liveIndicator.classList.add('hidden');
    if (liveIndicator) liveIndicator.querySelector('span:last-child').textContent = 'Идет премьера';
    if (liveBadge) liveBadge.classList.remove('hidden');
    const viewerBadge = document.getElementById('customViewerCount');
    if (viewerBadge) viewerBadge.classList.add('hidden');
    if (viewerCountValue) viewerCountValue.textContent = 'синхронно';
    if (customTimeDisplay) customTimeDisplay.classList.add('hidden');
    if (playPauseBtn) playPauseBtn.classList.remove('hidden');
    if (seekContainer) seekContainer.classList.remove('hidden');
    if (seekAvailable) seekAvailable.classList.remove('hidden');
    if (liveEdgeMarker) liveEdgeMarker.classList.remove('hidden');
    if (seekThumb) seekThumb.classList.remove('hidden');
    if (seekContainer) {
      seekContainer.setAttribute('aria-label', 'Премьера записи: можно вернуться к уже показанному фрагменту');
      seekContainer.dataset.liveMode = isLive ? 'dvr' : 'test';
      seekContainer.style.background = 'transparent';
      seekContainer.style.boxShadow = 'none';
    }
    // DVR-перемотка доступна и в test/preview, и в реальном live: getLivePosition()
    // в test-режиме тоже прогрессирует от загрузки страницы, поэтому используем тот же
    // интерактивный seekbar, что и в live (раньше тут была статичная полоса без перемотки).
    if (seekContainer) {
      seekContainer.style.cursor = 'pointer';
      seekContainer.style.pointerEvents = 'auto';
    }
    setChatActivity('Подготовленные сообщения синхронизированы с записью; вопросы отправляются команде');
  } else {
    if (liveIndicator) liveIndicator.classList.add('hidden');
    const viewerBadge = document.getElementById('customViewerCount');
    if (viewerBadge) viewerBadge.classList.add('hidden');
    if (customTimeDisplay) customTimeDisplay.classList.remove('hidden');
    if (liveBadge) liveBadge.classList.toggle('hidden', !isReplay);
    if (seekAvailable) seekAvailable.classList.add('hidden');
    if (liveEdgeMarker) liveEdgeMarker.classList.add('hidden');
    if (seekContainer) {
      seekContainer.removeAttribute('aria-label');
      delete seekContainer.dataset.liveMode;
      delete seekContainer.dataset.livePosition;
      delete seekContainer.dataset.viewerPosition;
      delete seekContainer.dataset.behindLive;
      seekContainer.style.background = '';
      seekContainer.style.boxShadow = '';
    }
  }

  const initialPos = getLivePosition();
  if (isLive && !shouldShowCompletedEndState) {
    if (initialPos < videoDuration) {
      video.currentTime = initialPos;
    } else {
      showEndedScreen();
    }
  }

  function showEndedScreen({ userTriggered = false, completedPlayback = false } = {}) {
    const activeElement = document.activeElement;
    const focusNeedsRecovery = Boolean(
      activeElement &&
        ((customControls && customControls.contains(activeElement)) ||
          (pauseOverlay && pauseOverlay.contains(activeElement))),
    );
    const firstTransition = !endedScreenVisible;
    endedScreenVisible = true;
    if (completedPlayback) {
      persistPlaybackEndedState(webinarConfig);
      playbackAnalytics.recordProgress(videoDuration, videoDuration);
      playbackAnalytics.recordFinish();
    }
    if (firstTransition && !_endedMediaState) stopVideoMedia(video, { ended: true });
    else video.pause();
    if (_liveControlsInterval) {
      window.clearInterval(_liveControlsInterval);
      _liveControlsInterval = null;
    }
    if (customControls) {
      customControls.classList.add('hidden');
      customControls.setAttribute('inert', '');
      customControls.setAttribute('aria-hidden', 'true');
    }
    if (returnToLiveBtn) returnToLiveBtn.classList.add('hidden');
    if (pauseOverlay) pauseOverlay.classList.add('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0');
      playOverlay.classList.remove('webinar-prelive-overlay');
      playOverlay.disabled = false;
      playOverlay.dataset.action = 'recordings';
      playOverlay.setAttribute('aria-label', 'Открыть записи вебинаров');
      // Media cleanup aborts the session signal, so the terminal action must
      // remain available independently of the regular player listeners.
      playOverlay.onclick = event => {
        event.stopPropagation();
        window.location.assign('recordings.html');
      };
      if (firstTransition) {
        playOverlay.innerHTML = `
          <span class="w-20 h-20 bg-green-600/90 rounded-full flex items-center justify-center mb-4 border border-white/20">
            <span class="material-symbols-outlined text-white text-4xl">check_circle</span>
          </span>
          <span class="block text-headline-md text-white font-bold tracking-wide uppercase">Премьера завершена</span>
          <span class="block text-body-lg text-white/80 mt-1">Форма вопросов остается открытой. Задайте вопрос или оставьте заявку ниже.</span>
          <span class="mt-5 inline-flex items-center justify-center bg-white text-primary px-5 py-3 rounded-lg font-bold">Открыть записи</span>
        `;
      }
      if ((userTriggered || focusNeedsRecovery) && document.activeElement !== playOverlay) {
        playOverlay.focus({ preventScroll: true });
      }
    }
    if (firstTransition && playerStatus) {
      playerStatus.textContent = 'Премьера завершена. Откройте доступные записи вебинаров.';
    }
    activateTimelineEvent(videoDuration, data.timeline || [], playbackAnalytics);
    const input = document.getElementById('questionInput');
    const submit = document.getElementById('questionSubmit');
    const activity = document.getElementById('chatActivity');
    const onlineLabel = document.getElementById('chatOnlineLabel');
    if (input) {
      input.disabled = false;
      input.placeholder = 'Задайте вопрос после премьеры...';
    }
    if (submit) {
      submit.disabled = false;
      submit.classList.remove('opacity-40', 'pointer-events-none');
    }
    if (activity) activity.textContent = 'Премьера завершена, форма вопросов открыта';
    if (onlineLabel) onlineLabel.textContent = 'вопросы открыты';
  }

  function isNearLive() {
    if (!isLiveVisual) return false;
    return getLivePosition() - video.currentTime <= liveToleranceSeconds;
  }

  function seekToLive({ userTriggered = false } = {}) {
    if (!isLiveVisual) return false;
    const livePosition = getLivePosition();
    if (!isTestMode && livePosition >= videoDuration) {
      showEndedScreen({
        userTriggered,
        completedPlayback: broadcastStarted && !manualBehindLive && !userPaused,
      });
      return false;
    }
    video.currentTime = livePosition;
    manualBehindLive = false;
    pausedFromLive = false;
    updateLiveControls();
    return true;
  }

  function updateLiveControls() {
    if (!isLiveVisual) return;
    const livePosition = getLivePosition();
    if (!isTestMode && livePosition >= videoDuration) {
      showEndedScreen({ completedPlayback: broadcastStarted && !manualBehindLive && !userPaused });
      return;
    }

    if (video.currentTime > livePosition + 0.5) {
      video.currentTime = livePosition;
    }

    const behindLive = livePosition - video.currentTime > liveToleranceSeconds;
    if (!behindLive) {
      manualBehindLive = false;
    }
    if (seekContainer) {
      seekContainer.dataset.livePosition = livePosition.toFixed(2);
      seekContainer.dataset.viewerPosition = video.currentTime.toFixed(2);
      seekContainer.dataset.behindLive = behindLive ? 'true' : 'false';
    }

    if (returnToLiveBtn) {
      returnToLiveBtn.classList.toggle('hidden', !behindLive);
    }
    if (liveIndicator) {
      liveIndicator.classList.toggle('opacity-60', behindLive);
    }
    const liveScaleSeconds = Math.max(1, livePosition);
    const watchPercent = clamp((video.currentTime / liveScaleSeconds) * 100, 0, 100);
    if (seekAvailable) seekAvailable.style.width = '100%';
    if (!isScrubbing) {
      // во время перетаскивания ползунок ведёт сам скраббер — reconciler его не трогает
      if (seekProgress) seekProgress.style.width = watchPercent + '%';
      if (seekThumb) seekThumb.style.left = watchPercent + '%';
      if (seekContainer) {
        seekContainer.setAttribute('aria-valuenow', String(Math.round(watchPercent)));
        seekContainer.setAttribute(
          'aria-valuetext',
          `${formatTimelineTime(video.currentTime)} из доступных ${formatTimelineTime(livePosition)}`,
        );
      }
    }
    if (liveEdgeMarker) {
      liveEdgeMarker.style.left = '100%';
      // у самого live-edge ползунок (thumb) совпадает с точкой прямого эфира →
      // прячем маркер, чтобы не было «двойного кружка»; при отмотке назад (DVR) он снова виден
      liveEdgeMarker.style.visibility = watchPercent >= 98 ? 'hidden' : 'visible';
    }
  }

  video.addEventListener(
    'timeupdate',
    () => {
      const current = video.currentTime;
      window.__aspbVideoPosition = current;
      activateTimelineEvent(current, data.timeline || [], playbackAnalytics);
      playbackAnalytics.recordProgress(current, videoDuration);

      if (isLiveVisual) {
        updateLiveControls();
      } else {
        if (seekProgress && video.duration) {
          seekProgress.style.width = (current / video.duration) * 100 + '%';
        }
        if (seekThumb && video.duration) {
          seekThumb.style.left = (current / video.duration) * 100 + '%';
        }
        if (currentTimeText) currentTimeText.textContent = formatTimelineTime(current);
        if (durationTimeText && video.duration) durationTimeText.textContent = formatTimelineTime(video.duration);
        if (seekContainer && video.duration) {
          seekContainer.setAttribute('aria-valuenow', String(Math.round((current / video.duration) * 100)));
          seekContainer.setAttribute(
            'aria-valuetext',
            `${formatTimelineTime(current)} из ${formatTimelineTime(video.duration)}`,
          );
        }
      }
    },
    { signal: mediaSession.signal },
  );

  activateTimelineEvent(video.currentTime, data.timeline || [], playbackAnalytics);

  video.addEventListener(
    'ended',
    () => showEndedScreen({ completedPlayback: true }),
    { signal: mediaSession.signal },
  );

  document.addEventListener(
    'aspb:room-seek-request',
    event => {
      if (isPreLive || isEnded || _endedMediaState) return;
      const requested = Number(event.detail?.seconds);
      if (!Number.isFinite(requested)) return;
      const ceiling = isLiveVisual ? getLivePosition() : video.duration || videoDuration;
      const target = clamp(requested, 0, Math.max(0, ceiling));
      video.currentTime = target;
      window.__aspbVideoPosition = target;
      if (isLiveVisual) {
        manualBehindLive = getLivePosition() - target > liveToleranceSeconds;
        pausedFromLive = false;
        updateLiveControls();
      }
      if (currentTimeText) currentTimeText.textContent = formatTimelineTime(target);
      if (playerStatus) playerStatus.textContent = `Переход к ${formatTimelineTime(target)}`;
    },
    { signal: mediaSession.signal },
  );
  document.dispatchEvent(new CustomEvent('aspb:video-controls-ready'));

  function startBroadcastFromClick() {
    if (isPreLive || isEnded || _endedMediaState) return;
    userPaused = false;

    if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
      const currentPos = getLivePosition();
      if (!isTestMode && currentPos >= videoDuration) {
        showEndedScreen({ userTriggered: true });
        return;
      }
      video.currentTime = currentPos;
      manualBehindLive = false;
      pausedFromLive = false;
    }

    video.muted = false;
    video.volume = 1;
    if (volumeSlider) volumeSlider.value = 1;
    if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_up';
    updateMuteAccessibility();

    video.play().then(() => {
      if (_endedMediaState) return;
      broadcastStarted = true;
      if (playOverlay) {
        playOverlay.classList.add('opacity-0');
        setTimeout(() => {
          if (playOverlay.dataset.action !== 'recordings') playOverlay.classList.add('hidden');
        }, 300);
      }
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
    }).catch(() => {
      if (_endedMediaState) return;
      video.muted = true;
      updateMuteAccessibility();
      video.play().then(() => {
        if (_endedMediaState) return;
        broadcastStarted = true;
        if (playOverlay) {
          playOverlay.classList.add('opacity-0');
          setTimeout(() => {
            if (playOverlay.dataset.action !== 'recordings') playOverlay.classList.add('hidden');
          }, 300);
        }
        if (pauseOverlay) pauseOverlay.classList.add('hidden');
      }).catch(() => {});
    });
  }

  if (playOverlay) {
    playOverlay.addEventListener('click', event => {
      event.stopPropagation();
      if (playOverlay.dataset.action === 'recordings') {
        window.location.assign('recordings.html');
        return;
      }
      startBroadcastFromClick();
    }, { signal: mediaSession.signal });
  }

  if (pauseOverlay) {
    pauseOverlay.addEventListener('click', event => {
      event.stopPropagation();
      userPaused = false;
      if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
        if (!seekToLive({ userTriggered: true })) return;
      }
      video.play().then(() => { pauseOverlay.classList.add('hidden'); }).catch(() => {});
    }, { signal: mediaSession.signal });
  }

  function toggleMuteState() {
    if (video.muted) {
      video.muted = false;
      video.volume = volumeSlider?.value || 1;
      if (volumeSlider && volumeSlider.value === '0') {
        volumeSlider.value = 1;
        video.volume = 1;
      }
      if (muteBtn) muteBtn.querySelector('span').textContent = video.volume < 0.5 ? 'volume_down' : 'volume_up';
    } else {
      video.muted = true;
      if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
    }
    updateMuteAccessibility();
  }

  function updateMuteAccessibility() {
    if (!muteBtn) return;
    muteBtn.setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук');
  }

  function updatePlayAccessibility() {
    if (!playPauseBtn) return;
    playPauseBtn.querySelector('span').textContent = video.paused ? 'play_arrow' : 'pause';
    playPauseBtn.setAttribute('aria-label', video.paused ? 'Воспроизвести видео' : 'Поставить видео на паузу');
  }

  function togglePlayState() {
    if (video.paused) {
      userPaused = false;
      if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
        if (!seekToLive({ userTriggered: true })) return;
      }
      video.play();
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
      updatePlayAccessibility();
    } else {
      userPaused = true;
      if (isLiveVisual) {
        pausedFromLive = isNearLive() && !manualBehindLive;
      }
      video.pause();
      const p1 = pauseOverlay?.querySelector('[data-pause-title]');
      if (p1) p1.textContent = 'Просмотр приостановлен';
      const p2 = pauseOverlay?.querySelector('[data-pause-note]');
      if (p2) p2.textContent = isLiveVisual && pausedFromLive
        ? 'При продолжении вернемся к текущему моменту премьеры'
        : 'Нажмите в любой точке для продолжения';
      if (pauseOverlay) pauseOverlay.classList.remove('hidden');
      updatePlayAccessibility();
    }
  }

  if (container) {
    container.addEventListener('click', (e) => {
      if (e.target.closest('#customPlayerControls') || e.target.closest('#videoPauseOverlay')) return;
      if (!broadcastStarted || video.paused) {
        startBroadcastFromClick();
      } else {
        // Обе ветки (live/replay) делали одно и то же — схлопнуто без изменения поведения.
        togglePlayState();
      }
    }, { signal: mediaSession.signal });
  }

  _visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      wasPlayingBeforeHidden = !video.paused && !userPaused;
      return;
    }
    if (!isLiveVisual || _endedMediaState) return;
    if (userPaused || !wasPlayingBeforeHidden) return;
    wasPlayingBeforeHidden = false;
    if (!manualBehindLive && !seekToLive()) return;
    video.play().catch(err => console.log('Visibility change auto-play failed:', err));
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  if (isLiveVisual) {
    _liveControlsInterval = window.setInterval(updateLiveControls, 1000);
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => { togglePlayState(); }, { signal: mediaSession.signal });
  }

  if (returnToLiveBtn) {
    returnToLiveBtn.addEventListener('click', () => {
      userPaused = false;
      if (!seekToLive({ userTriggered: true })) return;
      if (video.paused) {
        video.play().catch(err => console.log('Return to live play failed:', err));
      }
    }, { signal: mediaSession.signal });
  }

  video.addEventListener(
    'play',
    () => {
      broadcastStarted = true;
      playbackAnalytics.recordStart();
      playbackAnalytics.recordSound(video);
      updatePlayAccessibility();
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
    },
    { signal: mediaSession.signal },
  );

  video.addEventListener('pause', updatePlayAccessibility, { signal: mediaSession.signal });
  video.addEventListener(
    'volumechange',
    () => playbackAnalytics.recordSound(video),
    { signal: mediaSession.signal },
  );

  video.addEventListener(
    'seeking',
    () => {
      if (isLive) {
        const currentPos = getLivePosition();
        if (video.currentTime > currentPos + 0.5) {
          video.currentTime = currentPos;
        }
        manualBehindLive = currentPos - video.currentTime > liveToleranceSeconds;
        pausedFromLive = false;
        updateLiveControls();
      }
    },
    { signal: mediaSession.signal },
  );

  if (muteBtn) {
    muteBtn.addEventListener('click', () => { toggleMuteState(); }, { signal: mediaSession.signal });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      video.volume = volumeSlider.value;
      video.muted = (video.volume === 0);
      if (video.muted) {
        if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
      } else {
        if (muteBtn) muteBtn.querySelector('span').textContent = video.volume < 0.5 ? 'volume_down' : 'volume_up';
      }
      updateMuteAccessibility();
    }, { signal: mediaSession.signal });
  }

  if (fullscreenBtn && container) {
    fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        if (container.requestFullscreen) {
          container.requestFullscreen().then(() => {
            fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
            fullscreenBtn.setAttribute('aria-label', 'Выйти из полноэкранного режима');
          }).catch(err => { console.error('Fullscreen entering failed:', err); });
        } else if (container.webkitRequestFullscreen) {
          container.webkitRequestFullscreen();
        } else if (video && video.webkitEnterFullscreen) {
          // iOS Safari (iPhone): Fullscreen API для <div> не поддерживается —
          // полноэкранным может стать только сам <video> через нативный метод.
          if (video.readyState >= 1) {
            video.webkitEnterFullscreen();
          } else {
            video.addEventListener(
              'loadedmetadata',
              () => {
                if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
              },
              { once: true, signal: mediaSession.signal },
            );
          }
        }
      } else {
        document.exitFullscreen().then(() => {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen';
          fullscreenBtn.setAttribute('aria-label', 'Открыть видео на весь экран');
        }).catch(err => { console.error('Fullscreen exit failed:', err); });
      }
    }, { signal: mediaSession.signal });

    _fullscreenHandler = () => {
      if (document.fullscreenElement === container) {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
        fullscreenBtn.setAttribute('aria-label', 'Выйти из полноэкранного режима');
        container.classList.add('p-0');
      } else {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen';
        fullscreenBtn.setAttribute('aria-label', 'Открыть видео на весь экран');
        container.classList.remove('p-0');
      }
    };
    document.addEventListener('fullscreenchange', _fullscreenHandler);
  }

  if (seekContainer) {
    // Скраббер: клик в любой точке полосы + плавное перетаскивание.
    // Pointer-события покрывают мышь, тач (телефон) и стилус одним кодом.
    seekContainer.style.touchAction = 'none'; // на телефоне драг по полосе не скроллит страницу
    seekContainer.setAttribute('tabindex', '0');
    seekContainer.setAttribute('role', 'slider');
    seekContainer.setAttribute('aria-label', 'Перемотка премьеры записи');
    seekContainer.setAttribute('aria-valuemin', '0');
    seekContainer.setAttribute('aria-valuemax', '100');
    let scrubResumePlay = false;
    let scrubPointerId = null; // активный указатель — чтобы второй палец не вмешивался
    let scrubMoveRaf = 0; // rAF-коалесинг перемоток во время драга
    let scrubMoveX = 0;

    function seekTargetFromClientX(clientX) {
      const rect = seekContainer.getBoundingClientRect();
      const ratio = rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
      if (isLiveVisual) {
        const livePosition = getLivePosition();
        return Math.min(ratio * Math.max(1, livePosition), livePosition); // не дальше live-edge
      }
      // В replay — единый масштаб с paintScrub (реальная длина видео), а не конфиг-фолбэк.
      return ratio * (video.duration || videoDuration);
    }

    function paintScrub(targetTime) {
      const scale = isLiveVisual ? Math.max(1, getLivePosition()) : video.duration || videoDuration || 1;
      const pct = clamp((targetTime / scale) * 100, 0, 100);
      if (seekProgress) seekProgress.style.width = pct + '%';
      if (seekThumb) seekThumb.style.left = pct + '%';
      seekContainer.setAttribute('aria-valuenow', String(Math.round(pct)));
      seekContainer.setAttribute(
        'aria-valuetext',
        `${formatTimelineTime(targetTime)} из ${formatTimelineTime(scale)}`,
      );
    }

    function applyScrub(clientX, commit) {
      if (!videoDuration) return;
      const targetTime = seekTargetFromClientX(clientX);
      video.currentTime = targetTime;
      paintScrub(targetTime);
      if (commit && isLiveVisual) {
        // Отмотал назад → смотрит позади, премьера идёт дальше; обратно не выкидываем.
        manualBehindLive = getLivePosition() - targetTime > liveToleranceSeconds;
        pausedFromLive = false;
        updateLiveControls();
      }
    }

    // Единая точка сброса состояния скраба (из pointerup/cancel/lostpointercapture).
    function endScrub() {
      if (scrubMoveRaf) {
        cancelAnimationFrame(scrubMoveRaf);
        scrubMoveRaf = 0;
      }
      isScrubbing = false;
      scrubPointerId = null;
    }

    function onScrubStart(e) {
      if (isPreLive || isEnded || !videoDuration) return;
      if (isScrubbing) return; // уже тащим — игнорируем второй палец/повтор
      if (e.button != null && e.button > 0) return; // только основная (левая) кнопка, не правый/средний клик
      e.preventDefault();
      isScrubbing = true;
      scrubPointerId = e.pointerId;
      scrubResumePlay = !video.paused;
      showControlsBriefly();
      try {
        seekContainer.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture не поддержан — драг работает, пока указатель над полосой */
      }
      applyScrub(e.clientX, false);
    }

    function onScrubMove(e) {
      if (!isScrubbing || e.pointerId !== scrubPointerId) return;
      e.preventDefault();
      // rAF-коалесинг: не дёргаем video.currentTime чаще кадра (меньше seek-thrash, особенно на HLS)
      scrubMoveX = e.clientX;
      if (!scrubMoveRaf) {
        scrubMoveRaf = requestAnimationFrame(() => {
          scrubMoveRaf = 0;
          if (isScrubbing) applyScrub(scrubMoveX, false);
        });
      }
    }

    function onScrubEnd(e) {
      if (!isScrubbing || e.pointerId !== scrubPointerId) return;
      const clientX = e.clientX;
      endScrub();
      try {
        seekContainer.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      applyScrub(clientX, true);
      if (scrubResumePlay) video.play().catch(() => {});
    }

    seekContainer.addEventListener('pointerdown', onScrubStart, { signal: mediaSession.signal });
    seekContainer.addEventListener('pointermove', onScrubMove, { signal: mediaSession.signal });
    seekContainer.addEventListener('pointerup', onScrubEnd, { signal: mediaSession.signal });
    seekContainer.addEventListener('pointercancel', onScrubEnd, { signal: mediaSession.signal });
    // Защита от «залипания»: если захват указателя потерян (контекстное меню, системный
    // жест, long-press) и pointerup не пришёл — снимаем флаг, чтобы полоса не застыла.
    seekContainer.addEventListener('lostpointercapture', () => {
      if (isScrubbing) endScrub();
    }, { signal: mediaSession.signal });
    // Двойная страховка от «залипания»: если setPointerCapture не сработал и палец/мышь
    // отпустили мимо полосы, pointerup/cancel прилетят в window, а не в seekContainer —
    // завершаем скраб и тут. onScrubEnd идемпотентен (проверяет isScrubbing + pointerId),
    // поэтому в обычном пути это просто no-op и happy-path не ломается.
    window.addEventListener('pointerup', onScrubEnd, { signal: mediaSession.signal });
    window.addEventListener('pointercancel', onScrubEnd, { signal: mediaSession.signal });

    // Клавиатура (доступность): стрелки мотают на 5 секунд, Home/End — к границам.
    seekContainer.addEventListener('keydown', (e) => {
      if (isPreLive || isEnded || !videoDuration) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const ceiling = isLiveVisual ? getLivePosition() : video.duration || videoDuration;
      const target = e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? ceiling
          : clamp(video.currentTime + (e.key === 'ArrowLeft' ? -5 : 5), 0, ceiling);
      video.currentTime = target;
      if (isLiveVisual) {
        manualBehindLive = getLivePosition() - target > liveToleranceSeconds;
        pausedFromLive = false;
        updateLiveControls();
      } else {
        paintScrub(target);
      }
    }, { signal: mediaSession.signal });
  }

  // FIX 5: touchstart для мобильных
  let controlsTimeout = null;
  const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const hideDelay = isTouchDevice() ? 5000 : 3000;

  function setControlsVisible(visible) {
    if (!customControls) return;
    customControls.classList.toggle('opacity-0', !visible);
    customControls.classList.toggle('pointer-events-none', !visible);
    customControls.classList.toggle('opacity-100', visible);
    customControls.classList.toggle('pointer-events-auto', visible);
  }

  function controlsHaveKeyboardFocus() {
    return Boolean(customControls && customControls.contains(document.activeElement));
  }

  function hideControlsIfAllowed() {
    controlsTimeout = null;
    if (video.paused || isScrubbing || controlsHaveKeyboardFocus()) return;
    setControlsVisible(false);
  }

  function scheduleControlsHide() {
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = null;
    if (!video.paused && !isScrubbing && !controlsHaveKeyboardFocus()) {
      controlsTimeout = setTimeout(hideControlsIfAllowed, hideDelay);
    }
  }

  function showControlsBriefly() {
    setControlsVisible(true);
    scheduleControlsHide();
  }

  container.addEventListener('mousemove', showControlsBriefly, { signal: mediaSession.signal });
  container.addEventListener('mouseenter', showControlsBriefly, { signal: mediaSession.signal });
  container.addEventListener('touchstart', showControlsBriefly, { passive: true, signal: mediaSession.signal });
  container.addEventListener('focusin', () => {
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = null;
    setControlsVisible(true);
  }, { signal: mediaSession.signal });
  container.addEventListener('focusout', event => {
    if (event.relatedTarget && container.contains(event.relatedTarget)) return;
    scheduleControlsHide();
  }, { signal: mediaSession.signal });
  container.addEventListener('mouseleave', () => {
    if (controlsTimeout) clearTimeout(controlsTimeout);
    hideControlsIfAllowed();
  }, { signal: mediaSession.signal });
}
