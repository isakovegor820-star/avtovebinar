/**
 * video.js — плеер, контролы, seekbar, timeline events.
 */

import { state } from './state.js';
import { getJson, formatTimelineTime } from './utils.js?v=site-review-7';
import { timelinePath } from './registration.js?v=site-review-7';
import { setChatActivity } from './questions.js?v=site-review-7';

/* --- cleanup tracking: prevents interval/listener leaks on re-init --- */
let _liveControlsInterval = null;
let _keydownHandler = null;
let _visibilityHandler = null;
let _fullscreenHandler = null;
let _hlsInstance = null;
let _hlsScriptPromise = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function showVideoFallback(fallback, message) {
  if (!fallback) return;
  const text = fallback.querySelector('[data-video-fallback-text]');
  if (text && message) text.textContent = message;
  fallback.classList.remove('hidden');
  fallback.classList.add('flex');
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (_hlsScriptPromise) return _hlsScriptPromise;

  _hlsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.js/hls.min.js';
    script.async = true;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error('hls.js load failed'));
    document.head.appendChild(script);
  });

  return _hlsScriptPromise;
}

async function initializeVideoSource(video, videoData, fallback) {
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
  video.addEventListener('contextmenu', e => e.preventDefault());

  if (poster) video.setAttribute('poster', poster);

  if (hlsSrc) {
    video.crossOrigin = 'anonymous';
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsSrc;
      video.load();
      return;
    }

    try {
      const Hls = await loadHlsScript();
      if (!Hls || !Hls.isSupported()) {
        throw new Error('HLS is not supported in this browser');
      }

      const hls = new Hls({
        lowLatencyMode: false,
        enableWorker: true,
      });
      _hlsInstance = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return;
        showVideoFallback(
          fallback,
          'Не удалось загрузить поток вебинара. Обновите страницу или откройте ссылку позже.',
        );
        hls.destroy();
        _hlsInstance = null;
      });
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
      return;
    } catch (error) {
      console.error('HLS initialization failed:', error);
      if (!mp4Allowed) {
        showVideoFallback(
          fallback,
          'Не удалось запустить HLS-поток вебинара. Проверьте соединение или попробуйте открыть комнату позже.',
        );
        return;
      }
    }
  }

  if (mp4Allowed) {
    video.src = mp4Src;
    video.load();
    return;
  }

  showVideoFallback(
    fallback,
    'Видео вебинара пока недоступно. Команда АСПБ уже проверяет поток.',
  );
}

function activateTimelineEvent(seconds, events) {
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
    activeEvent.type !== 'final' &&
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
    const link = document.createElement('a');
    link.className = 'bg-primary text-on-primary rounded-xl px-6 py-3.5 font-label-md hover:bg-opacity-90 transition-all text-center whitespace-nowrap scale-95 hover:scale-100 duration-300';
    link.href = safeCtaUrl;
    link.rel = 'noopener noreferrer';
    link.textContent = activeEvent.ctaLabel;
    panel.appendChild(link);
  }
}

export async function hydrateTimeline() {
  const container = document.getElementById('videoPlayerContainer');
  const video = document.getElementById('webinarVideo');
  const fallback = document.getElementById('videoFallback');
  const active = document.getElementById('timelineActive');
  const playOverlay = document.getElementById('videoPlayOverlay');
  const standbyBackdrop = document.getElementById('webinarStandbyBackdrop');
  const pauseOverlay = document.getElementById('videoPauseOverlay');

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
    returnToLiveBtn.textContent = 'К эфиру';
    liveIndicator.parentElement.appendChild(returnToLiveBtn);
  }

  if (!active || !video) return;

  // --- cleanup previous intervals and document-level listeners (prevents leaks on re-init) ---
  if (_liveControlsInterval) { clearInterval(_liveControlsInterval); _liveControlsInterval = null; }
  if (_keydownHandler) { document.removeEventListener('keydown', _keydownHandler); _keydownHandler = null; }
  if (_visibilityHandler) { document.removeEventListener('visibilitychange', _visibilityHandler); _visibilityHandler = null; }
  if (_fullscreenHandler) { document.removeEventListener('fullscreenchange', _fullscreenHandler); _fullscreenHandler = null; }
  if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }

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
    showVideoFallback(fallback, 'Не удалось загрузить эфир. Обновите страницу или попробуйте позже.');
    return;
  }

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
  const nowServerMs = Date.now() + state.serverTimeOffset;
  const isPreLive = webinarConfig && (
    webinarConfig.accessStatus === 'waiting' ||
    webinarConfig.accessStatus === 'pre_live' ||
    webinarConfig.status === 'scheduled' ||
    // Жёсткая страховка «чисто закрытое окно до эфира»: пока не наступило время старта
    // (19:30 МСК) и НЕ идёт реальный прямой эфир/тест — окно ВСЕГДА закрыто. Без этого до
    // старта мог мелькнуть постер/кадр прошлой трансляции (replay), затем переключиться на
    // отсчёт. Replay прошедших вебинаров не задеваем: у них scheduledAt в прошлом.
    (nowServerMs < webinarConfig.scheduledAt && !isLive && !isTestMode && !isReplay)
  );
  const isEnded = webinarConfig && !isTestMode && !isReplay && (webinarConfig.status === 'finished' || serverLiveState?.isEnded);

  if (isPreLive) {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    if (fallback) {
      fallback.classList.add('hidden');
      fallback.classList.remove('flex');
    }
  } else {
    // Слушатель ошибок вешаем ДО назначения src/load(), иначе быстрая ошибка загрузки
    // (битый src, блок CSP) может прилететь раньше подписки и потеряться.
    video.addEventListener('error', () => {
      showVideoFallback(
        fallback,
        'Не удалось загрузить видео вебинара. Обновите страницу или попробуйте позже.',
      );
    });
    await initializeVideoSource(video, data.video || {}, fallback);
  }

  const liveBadge = document.getElementById('videoLiveBadge');
  if (liveBadge && webinarConfig) {
    if (isTestMode) {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ПРЯМОЙ ЭФИР';
    } else if (isLive) {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ПРЯМОЙ ЭФИР';
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
  let isScrubbing = false;
  const liveToleranceSeconds = 2.5;

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

  if (isPreLive) {
    // Защита от тайт-лупа на границе 19:30: первый reload — сразу, повторные не чаще раза в 6с.
    // Страница всё равно перезагрузится и уйдёт в эфир, просто без «шторма» перезагрузок,
    // если серверные часы на доли секунды не дошли до старта.
    const schedulePreliveReload = () => {
      try {
        const KEY = 'aspb:preliveReloadAt';
        const sinceLast = Date.now() - Number(window.sessionStorage.getItem(KEY) || 0);
        if (sinceLast >= 0 && sinceLast < 6000) return;
        window.sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        // sessionStorage недоступен — перезагружаемся без флора
      }
      window.location.reload();
    };
    video.pause();
    if (customControls) customControls.classList.add('hidden');
    if (standbyBackdrop) standbyBackdrop.classList.remove('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0', 'bg-black/70', 'hover:bg-black/60', 'bg-black', 'hover:bg-black');
      playOverlay.classList.add('webinar-prelive-overlay');

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
          schedulePreliveReload();
        }
      }

      updateCountdown();
      countdownInterval = window.setInterval(updateCountdown, 1000);
    }
    // Подстраховка: ОДНА перезагрузка к моменту старта (точный переход делает посекундный
    // отсчёт при достижении 0). Раньше тут стоял Math.min(30000, …) → комната ожидания
    // перезагружалась КАЖДЫЕ 30 секунд за часы до эфира (дёрганье/«лаги»). Теперь — один раз.
    const msUntilStart = webinarConfig.scheduledAt - (Date.now() + state.serverTimeOffset);
    const reloadDelay = Math.max(1000, msUntilStart + 1000);
    window.setTimeout(schedulePreliveReload, reloadDelay);
  } else if (isReplay) {
    video.pause();
    video.currentTime = 0;
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    if (customControls) customControls.classList.remove('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0');
      playOverlay.classList.remove('webinar-prelive-overlay');
      playOverlay.innerHTML = `
        <div class="w-16 h-16 bg-white/15 backdrop-blur-md rounded-full flex items-center justify-center mb-4 border border-white/25 hover:scale-105 transition-transform shadow-lg">
          <span class="material-symbols-outlined text-white text-4xl">play_arrow</span>
        </div>
        <p class="text-headline-sm text-white font-bold tracking-wide uppercase">Смотреть запись</p>
        <p class="text-body-md text-white/75 mt-1 max-w-md">Вебинар уже завершен. Постоянная запись доступна в разделе «Записи».</p>
      `;
    }
  } else if (isEnded) {
    video.pause();
    if (standbyBackdrop) standbyBackdrop.classList.add('hidden');
    if (customControls) customControls.classList.add('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0');
      playOverlay.classList.remove('webinar-prelive-overlay');
      playOverlay.innerHTML = `
        <div class="w-20 h-20 bg-green-600/90 rounded-full flex items-center justify-center mb-4 border border-white/20">
          <span class="material-symbols-outlined text-white text-4xl">check_circle</span>
        </div>
        <p class="text-headline-md text-white font-bold tracking-wide uppercase">Вебинар окончен</p>
        <p class="text-body-lg text-white/80 mt-1 max-w-md">Запись появится в разделе «Записи». Чат остается открытым для вопросов.</p>
        <a href="recordings.html" class="mt-5 inline-flex items-center justify-center bg-white text-primary px-5 py-3 rounded-lg font-bold">Смотреть записи</a>
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
    video.play().catch(err => {
      console.log('Muted autoplay was prevented by browser, waiting for user click.', err);
      if (playOverlay) {
        playOverlay.classList.remove('hidden', 'opacity-0');
        playOverlay.innerHTML = `
          <div class="w-14 h-14 bg-white/12 backdrop-blur-md rounded-full flex items-center justify-center mb-4 border border-white/25 hover:scale-105 transition-transform shadow-lg">
            <span class="material-symbols-outlined text-white text-3xl font-bold">play_arrow</span>
          </div>
          <p class="text-headline-sm text-white font-bold tracking-wide uppercase">Войти в эфир</p>
          <p class="text-body-md text-white/75 mt-1 max-w-md">Нажмите, чтобы подключиться к трансляции</p>
        `;
      }
    });
  }

  if (isLiveVisual) {
    if (liveIndicator) liveIndicator.classList.add('hidden');
    if (liveIndicator) liveIndicator.querySelector('span:last-child').textContent = 'Идет эфир';
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
      seekContainer.setAttribute('aria-label', 'Live DVR: можно отмотать назад в уже прошедший эфир');
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
    setChatActivity('Вопросы и чат синхронизированы с эфиром');
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
  if (isLive) {
    if (initialPos < videoDuration) {
      video.currentTime = initialPos;
    } else {
      showEndedScreen();
    }
  }

  function showEndedScreen() {
    video.pause();
    if (customControls) customControls.classList.add('hidden');
    if (returnToLiveBtn) returnToLiveBtn.classList.add('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0');
      playOverlay.innerHTML = `
        <div class="w-20 h-20 bg-green-600/90 rounded-full flex items-center justify-center mb-4 border border-white/20">
          <span class="material-symbols-outlined text-white text-4xl">check_circle</span>
        </div>
        <p class="text-headline-md text-white font-bold tracking-wide uppercase">Вебинар окончен</p>
        <p class="text-body-lg text-white/80 mt-1">Чат остается открытым. Задайте вопрос или оставьте заявку ниже.</p>
      `;
    }
    const input = document.getElementById('questionInput');
    const submit = document.getElementById('questionSubmit');
    const activity = document.getElementById('chatActivity');
    const onlineLabel = document.getElementById('chatOnlineLabel');
    if (input) {
      input.disabled = false;
      input.placeholder = 'Задайте вопрос после эфира...';
    }
    if (submit) {
      submit.disabled = false;
      submit.classList.remove('opacity-40', 'pointer-events-none');
    }
    if (activity) activity.textContent = 'Вебинар окончен, чат открыт';
    if (onlineLabel) onlineLabel.textContent = 'чат открыт';
  }

  function isNearLive() {
    if (!isLiveVisual) return false;
    return getLivePosition() - video.currentTime <= liveToleranceSeconds;
  }

  function seekToLive() {
    if (!isLiveVisual) return;
    const livePosition = getLivePosition();
    if (!isTestMode && livePosition >= videoDuration) {
      showEndedScreen();
      return;
    }
    video.currentTime = livePosition;
    manualBehindLive = false;
    pausedFromLive = false;
    updateLiveControls();
  }

  function updateLiveControls() {
    if (!isLiveVisual) return;
    const livePosition = getLivePosition();
    if (!isTestMode && livePosition >= videoDuration) {
      showEndedScreen();
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
      if (seekContainer) seekContainer.setAttribute('aria-valuenow', String(Math.round(watchPercent)));
    }
    if (liveEdgeMarker) {
      liveEdgeMarker.style.left = '100%';
      // у самого live-edge ползунок (thumb) совпадает с точкой прямого эфира →
      // прячем маркер, чтобы не было «двойного кружка»; при отмотке назад (DVR) он снова виден
      liveEdgeMarker.style.visibility = watchPercent >= 98 ? 'hidden' : 'visible';
    }
  }

  video.addEventListener('timeupdate', () => {
    const current = video.currentTime;
    window.__aspbVideoPosition = current;
    activateTimelineEvent(current, data.timeline || []);

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
    }
  });

  activateTimelineEvent(video.currentTime, data.timeline || []);

  function startBroadcastFromClick() {
    if (isPreLive || isEnded) return;

    if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
      const currentPos = getLivePosition();
      if (!isTestMode && currentPos >= videoDuration) {
        showEndedScreen();
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

    video.play().then(() => {
      broadcastStarted = true;
      if (playOverlay) {
        playOverlay.classList.add('opacity-0');
        setTimeout(() => playOverlay.classList.add('hidden'), 300);
      }
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
    }).catch(() => {
      video.muted = true;
      video.play().then(() => {
        broadcastStarted = true;
        if (playOverlay) {
          playOverlay.classList.add('opacity-0');
          setTimeout(() => playOverlay.classList.add('hidden'), 300);
        }
        if (pauseOverlay) pauseOverlay.classList.add('hidden');
      }).catch(() => {});
    });
  }

  if (playOverlay) {
    playOverlay.addEventListener('click', event => {
      event.stopPropagation();
      startBroadcastFromClick();
    });
  }

  if (pauseOverlay) {
    pauseOverlay.addEventListener('click', () => {
      if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
        seekToLive();
      }
      video.play().then(() => { pauseOverlay.classList.add('hidden'); }).catch(() => {});
    });
  }

  function toggleMuteState() {
    if (video.muted) {
      video.muted = false;
      video.volume = volumeSlider.value || 1;
      if (volumeSlider && volumeSlider.value === '0') {
        volumeSlider.value = 1;
        video.volume = 1;
      }
      if (muteBtn) muteBtn.querySelector('span').textContent = video.volume < 0.5 ? 'volume_down' : 'volume_up';
    } else {
      video.muted = true;
      if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
    }
  }

  function togglePlayState() {
    if (video.paused) {
      if (isLiveVisual && (!manualBehindLive || pausedFromLive)) {
        seekToLive();
      }
      video.play();
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
    } else {
      if (isLiveVisual) {
        pausedFromLive = isNearLive() && !manualBehindLive;
      }
      video.pause();
      const p1 = pauseOverlay?.querySelector('p');
      if (p1) p1.textContent = 'Просмотр приостановлен';
      const p2 = pauseOverlay?.querySelector('p:last-of-type');
      if (p2) p2.textContent = isLiveVisual && pausedFromLive
        ? 'При продолжении вернемся к актуальному live-таймингу'
        : 'Нажмите в любой точке для продолжения';
      if (pauseOverlay) pauseOverlay.classList.remove('hidden');
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
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
    });
  }

  _keydownHandler = (e) => {
    if (e.code === 'Space') {
      var activeTag = document.activeElement && document.activeElement.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
      e.preventDefault();
      togglePlayState();
    }
  };
  document.addEventListener('keydown', _keydownHandler);

  _visibilityHandler = () => {
    if (document.visibilityState === 'visible' && isLiveVisual) {
      if (!manualBehindLive) {
        seekToLive();
        video.play().catch(err => console.log('Visibility change auto-play failed:', err));
      }
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  if (isLiveVisual) {
    _liveControlsInterval = window.setInterval(updateLiveControls, 1000);
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => { togglePlayState(); });
  }

  if (returnToLiveBtn) {
    returnToLiveBtn.addEventListener('click', () => {
      seekToLive();
      if (video.paused) {
        video.play().catch(err => console.log('Return to live play failed:', err));
      }
    });
  }

  video.addEventListener('play', () => {
    if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
    if (pauseOverlay) pauseOverlay.classList.add('hidden');
  });

  video.addEventListener('pause', () => {
    if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
  });

  video.addEventListener('seeking', () => {
    if (isLive) {
      const currentPos = getLivePosition();
      if (video.currentTime > currentPos + 0.5) {
        video.currentTime = currentPos;
      }
      manualBehindLive = currentPos - video.currentTime > liveToleranceSeconds;
      pausedFromLive = false;
      updateLiveControls();
    }
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => { toggleMuteState(); });
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
    });
  }

  if (fullscreenBtn && container) {
    fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        if (container.requestFullscreen) {
          container.requestFullscreen().then(() => {
            fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
          }).catch(err => { console.error('Fullscreen entering failed:', err); });
        } else if (container.webkitRequestFullscreen) {
          container.webkitRequestFullscreen();
        } else if (video && video.webkitEnterFullscreen) {
          // iOS Safari (iPhone): Fullscreen API для <div> не поддерживается —
          // полноэкранным может стать только сам <video> через нативный метод.
          if (video.readyState >= 1) {
            video.webkitEnterFullscreen();
          } else {
            video.addEventListener('loadedmetadata', () => { if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); }, { once: true });
          }
        }
      } else {
        document.exitFullscreen().then(() => {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen';
        }).catch(err => { console.error('Fullscreen exit failed:', err); });
      }
    });

    _fullscreenHandler = () => {
      if (document.fullscreenElement === container) {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
        container.classList.add('p-0');
      } else {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen';
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
    seekContainer.setAttribute('aria-label', 'Перемотка эфира');
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
    }

    function applyScrub(clientX, commit) {
      if (!videoDuration) return;
      const targetTime = seekTargetFromClientX(clientX);
      video.currentTime = targetTime;
      paintScrub(targetTime);
      if (commit && isLiveVisual) {
        // Отмотал назад → смотрит позади, эфир идёт дальше; обратно не выкидываем.
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

    seekContainer.addEventListener('pointerdown', onScrubStart);
    seekContainer.addEventListener('pointermove', onScrubMove);
    seekContainer.addEventListener('pointerup', onScrubEnd);
    seekContainer.addEventListener('pointercancel', onScrubEnd);
    // Защита от «залипания»: если захват указателя потерян (контекстное меню, системный
    // жест, long-press) и pointerup не пришёл — снимаем флаг, чтобы полоса не застыла.
    seekContainer.addEventListener('lostpointercapture', () => {
      if (isScrubbing) endScrub();
    });
    // Двойная страховка от «залипания»: если setPointerCapture не сработал и палец/мышь
    // отпустили мимо полосы, pointerup/cancel прилетят в window, а не в seekContainer —
    // завершаем скраб и тут. onScrubEnd идемпотентен (проверяет isScrubbing + pointerId),
    // поэтому в обычном пути это просто no-op и happy-path не ломается.
    window.addEventListener('pointerup', onScrubEnd);
    window.addEventListener('pointercancel', onScrubEnd);

    // Клавиатура (доступность): стрелки ←/→ мотают на 5 секунд.
    seekContainer.addEventListener('keydown', (e) => {
      if (isPreLive || isEnded || !videoDuration) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const ceiling = isLiveVisual ? getLivePosition() : video.duration || videoDuration;
      const target = clamp(video.currentTime + (e.key === 'ArrowLeft' ? -5 : 5), 0, ceiling);
      video.currentTime = target;
      if (isLiveVisual) {
        manualBehindLive = getLivePosition() - target > liveToleranceSeconds;
        pausedFromLive = false;
        updateLiveControls();
      } else {
        paintScrub(target);
      }
    });
  }

  // FIX 5: touchstart для мобильных
  let controlsTimeout = null;
  const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const hideDelay = isTouchDevice() ? 5000 : 3000;

  function showControlsBriefly() {
    if (customControls) {
      customControls.classList.remove('opacity-0', 'pointer-events-none');
      customControls.classList.add('opacity-100', 'pointer-events-auto');
    }
    if (controlsTimeout) clearTimeout(controlsTimeout);
    if (!video.paused) {
      controlsTimeout = setTimeout(() => {
        if (customControls) {
          customControls.classList.remove('opacity-100', 'pointer-events-auto');
          customControls.classList.add('opacity-0', 'pointer-events-none');
        }
      }, hideDelay);
    }
  }

  container.addEventListener('mousemove', showControlsBriefly);
  container.addEventListener('mouseenter', showControlsBriefly);
  container.addEventListener('touchstart', showControlsBriefly, { passive: true });
  container.addEventListener('mouseleave', () => {
    if (!video.paused && customControls) {
      if (controlsTimeout) clearTimeout(controlsTimeout);
      customControls.classList.remove('opacity-100', 'pointer-events-auto');
      customControls.classList.add('opacity-0', 'pointer-events-none');
    }
  });
}
