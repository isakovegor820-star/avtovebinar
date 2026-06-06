/**
 * video.js — плеер, контролы, seekbar, timeline events.
 */

import { state } from './state.js';
import { getJson, formatTimelineTime } from './utils.js';
import { timelinePath } from './registration.js';
import { updateWebinarInsights, setChatActivity } from './questions.js';

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

function getServerNowMs() {
  return Date.now() + (state.serverTimeOffset || 0);
}

function getNextMoscowWebinarMs(nowMs = getServerNowMs()) {
  const now = new Date(nowMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  });

  const todayTarget = Date.UTC(values.year, values.month - 1, values.day, 16, 0, 0);
  if (todayTarget > nowMs) return todayTarget;
  return Date.UTC(values.year, values.month - 1, values.day + 1, 16, 0, 0);
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

  const data = await getJson(timelinePath());
  if (!data.ok) return;

  const webinarConfig = state.webinarConfig;
  const videoDuration = data.video && data.video.durationSeconds ? Number(data.video.durationSeconds) : 3300;
  const serverLiveState = data.liveState || webinarConfig?.liveState || null;
  if (webinarConfig && serverLiveState) {
    webinarConfig.liveState = serverLiveState;
    webinarConfig.videoDurationSeconds = serverLiveState.durationSeconds || videoDuration;
    webinarConfig.status = webinarConfig.status || serverLiveState.status;
  }

  if (data.video && data.video.src) {
    const source = video.querySelector('source');
    if (source) source.setAttribute('src', data.video.src);
    if (data.video.poster) video.setAttribute('poster', data.video.poster);
    video.load();
    video.addEventListener('error', () => {
      if (fallback) {
        fallback.classList.remove('hidden');
        fallback.classList.add('flex');
      }
    });
    video.addEventListener('contextmenu', e => e.preventDefault());
  }

  const liveBadge = document.getElementById('videoLiveBadge');
  if (liveBadge && webinarConfig) {
    if (webinarConfig.status === 'test') {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ПРЯМОЙ ЭФИР';
    } else if (webinarConfig.status === 'live') {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>ПРЯМОЙ ЭФИР';
    } else {
      liveBadge.className = 'absolute top-4 right-4 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full text-white text-label-sm z-10';
      liveBadge.textContent = '🔴 ЗАПИСЬ ТРАНСЛЯЦИИ';
    }
  }

  const isLive = webinarConfig && webinarConfig.status === 'live';
  const isTestMode = webinarConfig && webinarConfig.status === 'test';
  const isLiveVisual = isLive || isTestMode;
  const isPreLive = webinarConfig && (webinarConfig.accessStatus === 'pre_live' || webinarConfig.status === 'scheduled');
  const isEnded = webinarConfig && !isTestMode && (webinarConfig.status === 'finished' || webinarConfig.accessStatus === 'replay' || serverLiveState?.isEnded);
  const demoLiveStartedAt = Date.now() + state.serverTimeOffset;
  window.__ASPB_HIDE_TIMELINE_ACTIONS__ = Boolean(isLiveVisual);
  if (isLiveVisual && active) active.classList.add('hidden');
  let broadcastStarted = false;
  let manualBehindLive = false;
  let pausedFromLive = false;
  let nextWebinarCountdownInterval = null;
  const liveToleranceSeconds = 2.5;

  function startNextWebinarCountdown() {
    if (nextWebinarCountdownInterval) {
      clearInterval(nextWebinarCountdownInterval);
      nextWebinarCountdownInterval = null;
    }

    function tick() {
      const target = getNextMoscowWebinarMs();
      const remaining = Math.max(0, target - getServerNowMs());
      const totalSeconds = Math.floor(remaining / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const hoursNode = document.getElementById('nextWebinarHours');
      const minutesNode = document.getElementById('nextWebinarMinutes');
      const secondsNode = document.getElementById('nextWebinarSeconds');

      if (hoursNode) hoursNode.textContent = String(hours).padStart(2, '0');
      if (minutesNode) minutesNode.textContent = String(minutes).padStart(2, '0');
      if (secondsNode) secondsNode.textContent = String(seconds).padStart(2, '0');

      if (remaining <= 0) {
        window.location.reload();
      }
    }

    tick();
    nextWebinarCountdownInterval = window.setInterval(tick, 1000);
  }

  function renderEndedOverlay() {
    video.pause();
    if (standbyBackdrop) standbyBackdrop.classList.remove('hidden');
    if (customControls) customControls.classList.add('hidden');
    if (returnToLiveBtn) returnToLiveBtn.classList.add('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0', 'bg-black/70', 'hover:bg-black/60', 'bg-black', 'hover:bg-black');
      playOverlay.classList.remove('webinar-prelive-overlay');
      playOverlay.classList.add('webinar-ended-overlay');
      playOverlay.innerHTML = `
        <div class="w-16 h-16 bg-primary/90 rounded-full flex items-center justify-center mb-4 border border-white/20 shadow-lg">
          <span class="material-symbols-outlined text-white text-4xl">event_available</span>
        </div>
        <p class="text-label-sm text-white/60 font-bold tracking-[0.18em] uppercase mb-2">Эфир завершен</p>
        <p class="text-headline-sm md:text-headline-md text-white font-bold tracking-wide uppercase mb-3">До следующего вебинара</p>
        <div class="flex gap-3 mb-4">
          <div class="bg-white/10 backdrop-blur-md rounded-xl px-4 py-3 min-w-[72px] border border-white/15">
            <span id="nextWebinarHours" class="text-3xl font-bold text-white tabular-nums">00</span>
            <p class="text-[10px] text-white/50 uppercase tracking-wider mt-1">часов</p>
          </div>
          <div class="text-3xl font-bold text-white/40 self-start mt-3">:</div>
          <div class="bg-white/10 backdrop-blur-md rounded-xl px-4 py-3 min-w-[72px] border border-white/15">
            <span id="nextWebinarMinutes" class="text-3xl font-bold text-white tabular-nums">00</span>
            <p class="text-[10px] text-white/50 uppercase tracking-wider mt-1">минут</p>
          </div>
          <div class="text-3xl font-bold text-white/40 self-start mt-3">:</div>
          <div class="bg-white/10 backdrop-blur-md rounded-xl px-4 py-3 min-w-[72px] border border-white/15">
            <span id="nextWebinarSeconds" class="text-3xl font-bold text-white tabular-nums">00</span>
            <p class="text-[10px] text-white/50 uppercase tracking-wider mt-1">секунд</p>
          </div>
        </div>
        <p class="text-body-md text-white/70 max-w-lg">Следующий эфир начнется в 19:00 МСК. Чат остается открытым: можно задать вопрос или оставить заявку ниже.</p>
      `;
    }
    startNextWebinarCountdown();

    const input = document.getElementById('questionInput');
    const submit = document.getElementById('questionSubmit');
    const activity = document.getElementById('chatActivity');
    const onlineLabel = document.getElementById('chatOnlineLabel');
    if (input) {
      input.disabled = false;
      input.placeholder = 'Задайте вопрос...';
    }
    if (submit) {
      submit.disabled = false;
      submit.classList.remove('opacity-40', 'pointer-events-none');
    }
    if (activity) activity.textContent = 'Вебинар окончен, чат открыт';
    if (onlineLabel) onlineLabel.textContent = 'чат открыт';
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

  if (isPreLive) {
    video.pause();
    if (customControls) customControls.classList.add('hidden');
    if (standbyBackdrop) standbyBackdrop.classList.remove('hidden');
    if (playOverlay) {
      playOverlay.classList.remove('hidden', 'opacity-0', 'bg-black/70', 'hover:bg-black/60', 'bg-black', 'hover:bg-black');
      playOverlay.classList.add('webinar-prelive-overlay');

      const countdownHours = document.getElementById('countdownHours');
      const countdownMinutes = document.getElementById('countdownMinutes');
      const countdownSeconds = document.getElementById('countdownSeconds');

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
          clearInterval(countdownInterval);
          window.location.reload();
        }
      }

      updateCountdown();
      const countdownInterval = window.setInterval(updateCountdown, 1000);
    }
    // Fallback: force reload if countdown somehow misses the transition
    const reloadDelay = Math.max(1000, Math.min(30000, (webinarConfig.scheduledAt - (Date.now() + state.serverTimeOffset)) + 1000));
    window.setTimeout(() => window.location.reload(), reloadDelay);
	  } else if (isEnded) {
	    renderEndedOverlay();
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
    if (customTimeDisplay) customTimeDisplay.classList.add('hidden');
    if (playPauseBtn) playPauseBtn.classList.remove('hidden');
    if (seekContainer) seekContainer.classList.remove('hidden');
    if (seekAvailable) seekAvailable.classList.remove('hidden');
    if (liveEdgeMarker) liveEdgeMarker.classList.remove('hidden');
    if (seekThumb) seekThumb.classList.remove('hidden');
    if (seekContainer) {
      seekContainer.setAttribute('aria-label', 'Live DVR: можно отмотать назад в уже прошедший эфир');
      seekContainer.dataset.liveMode = isLive ? 'dvr' : 'test';
      seekContainer.style.background = 'rgba(239, 68, 68, 0.32)';
      seekContainer.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.16), 0 0 22px rgba(239,68,68,0.24)';
    }
    if (isTestMode && seekContainer) {
      seekContainer.classList.remove('hidden');
      seekContainer.style.cursor = 'default';
      seekContainer.style.pointerEvents = 'none';
      seekContainer.style.background = 'rgba(239, 68, 68, 0.92)';
      seekContainer.style.boxShadow = '0 0 22px rgba(239,68,68,0.45), inset 0 0 0 1px rgba(255,255,255,0.2)';
      if (seekAvailable) seekAvailable.classList.add('hidden');
      if (seekProgress) {
        seekProgress.classList.remove('hidden');
        seekProgress.style.width = '100%';
        seekProgress.style.background = 'linear-gradient(90deg, #dc2626 0%, #ef4444 52%, #fb7185 100%)';
      }
      if (seekThumb) seekThumb.classList.add('hidden');
      if (liveEdgeMarker) liveEdgeMarker.classList.add('hidden');
    }

    let viewers = Math.floor(Math.random() * (165 - 145) + 145);
    if (viewerCountValue) viewerCountValue.textContent = String(viewers);
    setChatActivity('Чат идет в live-режиме');

    setInterval(() => {
      const change = Math.floor(Math.random() * 7) - 3;
      viewers = Math.max(130, Math.min(190, viewers + change));
      if (viewerCountValue) viewerCountValue.textContent = String(viewers);
    }, 8000);
  } else {
    if (liveIndicator) liveIndicator.classList.add('hidden');
    const viewerBadge = document.getElementById('customViewerCount');
    if (viewerBadge) viewerBadge.classList.add('hidden');
    if (customTimeDisplay) customTimeDisplay.classList.remove('hidden');
    if (liveBadge && webinarConfig?.status !== 'test') liveBadge.classList.add('hidden');
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
    renderEndedOverlay();
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
    if (isTestMode) {
      if (seekAvailable) seekAvailable.classList.add('hidden');
      if (seekProgress) seekProgress.style.width = '100%';
      if (seekThumb) seekThumb.classList.add('hidden');
      if (liveEdgeMarker) liveEdgeMarker.classList.add('hidden');
      return;
    }
    if (seekAvailable) seekAvailable.style.width = '100%';
    if (seekProgress) seekProgress.style.width = watchPercent + '%';
    if (seekThumb) seekThumb.style.left = watchPercent + '%';
    if (liveEdgeMarker) liveEdgeMarker.style.left = '100%';
  }

  let testPausedViewerPosition = null;
  if (window.__ASPB_ENABLE_TEST_HOOKS__) {
    window.__ASPB_LIVE_DVR_TEST__ = {
      snapshot() {
        updateLiveControls();
        const livePosition = getLivePosition();
        const viewerPosition = testPausedViewerPosition ?? video.currentTime;
        return {
          livePosition,
          viewerPosition,
          behindLive: livePosition - viewerPosition > liveToleranceSeconds,
          paused: testPausedViewerPosition !== null || video.paused
        };
      },
      pauseAtCurrentPosition() {
        testPausedViewerPosition = video.currentTime;
        pausedFromLive = isNearLive() && !manualBehindLive;
        video.pause();
        updateLiveControls();
        return this.snapshot();
      },
      resumeToLive() {
        testPausedViewerPosition = null;
        seekToLive();
        return this.snapshot();
      }
    };
  }

  video.addEventListener('timeupdate', () => {
    const current = video.currentTime;
    activateTimelineEvent(current, data.timeline || []);
    updateWebinarInsights(current);

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
  updateWebinarInsights(video.currentTime, true);

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
      });
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
      if (isLiveVisual) {
        if (!manualBehindLive || pausedFromLive) {
          seekToLive();
        }
        video.play().then(() => { pauseOverlay.classList.add('hidden'); });
      } else {
        video.play().then(() => { pauseOverlay.classList.add('hidden'); });
      }
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
      } else if (isLiveVisual) {
        togglePlayState();
      } else {
        togglePlayState();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      e.preventDefault();
      togglePlayState();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isLiveVisual) {
      if (!manualBehindLive) {
        seekToLive();
        video.play().catch(err => console.log('Visibility change auto-play failed:', err));
      }
    }
  });

  if (isLiveVisual) {
    window.setInterval(updateLiveControls, 1000);
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
        container.requestFullscreen().then(() => {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
        }).catch(err => { console.error('Fullscreen entering failed:', err); });
      } else {
        document.exitFullscreen().then(() => {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen';
        });
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === container) {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
        container.classList.add('p-0');
      } else {
        fullscreenBtn.querySelector('span').textContent = 'fullscreen';
        container.classList.remove('p-0');
      }
    });
  }

  if (seekContainer) {
    seekContainer.addEventListener('click', (e) => {
      if (isTestMode) return;
      const rect = seekContainer.getBoundingClientRect();
      const pos = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      if (videoDuration) {
        const livePosition = getLivePosition();
        const requestedTime = isLive ? pos * Math.max(1, livePosition) : pos * videoDuration;
        const targetTime = isLive ? Math.min(requestedTime, livePosition) : requestedTime;
        video.currentTime = targetTime;
        if (isLive) {
          manualBehindLive = getLivePosition() - targetTime > liveToleranceSeconds;
          pausedFromLive = false;
          updateLiveControls();
        } else {
          if (seekProgress) seekProgress.style.width = (targetTime / videoDuration * 100) + '%';
          if (seekThumb) seekThumb.style.left = (targetTime / videoDuration * 100) + '%';
        }
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
