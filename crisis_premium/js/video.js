/**
 * video.js — плеер, контролы, seekbar, timeline events.
 */

import { state } from './state.js';
import { getJson, formatTimelineTime } from './utils.js';
import { timelinePath } from './registration.js';
import { updateWebinarInsights, setChatActivity } from './questions.js';

function activateTimelineEvent(seconds, events) {
  if (!events.length) return;
  const activeEvent = events.reduce((current, event) => {
    return seconds >= event.offsetSeconds ? event : current;
  }, events[0]);
  const panel = document.getElementById('timelineActive');
  if (!panel) return;

  const shouldShow = activeEvent && (activeEvent.type === 'cta' || activeEvent.type === 'final' || (activeEvent.ctaLabel && activeEvent.ctaUrl));

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

  if (activeEvent.ctaLabel && activeEvent.ctaUrl) {
    const link = document.createElement('a');
    link.className = 'bg-primary text-on-primary rounded-xl px-6 py-3.5 font-label-md hover:bg-opacity-90 transition-all text-center whitespace-nowrap scale-95 hover:scale-100 duration-300';
    link.href = activeEvent.ctaUrl;
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
  const seekProgress = document.getElementById('customSeekBarProgress');

  if (!active || !video) return;

  const data = await getJson(timelinePath());
  if (!data.ok) return;

  const webinarConfig = state.webinarConfig;
  const videoDuration = data.video && data.video.durationSeconds ? Number(data.video.durationSeconds) : 568;

  if (data.video && data.video.src) {
    const source = video.querySelector('source');
    if (source) source.setAttribute('src', data.video.src);
    if (data.video.poster) video.setAttribute('poster', data.video.poster);
    video.load();
    video.addEventListener('error', () => {
      if (fallback) fallback.classList.remove('hidden');
    });
    video.addEventListener('contextmenu', e => e.preventDefault());
  }

  const liveBadge = document.getElementById('videoLiveBadge');
  if (liveBadge && webinarConfig) {
    if (webinarConfig.status === 'test') {
      liveBadge.className = 'absolute top-4 right-4 bg-primary/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.textContent = 'ТЕСТОВАЯ ТРАНСЛЯЦИЯ';
    } else if (webinarConfig.status === 'live') {
      liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
      liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-ping"></span>🔴 ПРЯМОЙ ЭФИР';
    } else {
      liveBadge.className = 'absolute top-4 right-4 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full text-white text-label-sm z-10';
      liveBadge.textContent = '🔴 ЗАПИСЬ ТРАНСЛЯЦИИ';
    }
  }

  function getLivePosition() {
    if (!webinarConfig || webinarConfig.status !== 'live') return 0;
    const nowServer = Date.now() + state.serverTimeOffset;
    const elapsedSeconds = (nowServer - webinarConfig.scheduledAt) / 1000;
    return elapsedSeconds;
  }

  const isLive = webinarConfig && webinarConfig.status === 'live';
  const isTestMode = webinarConfig && webinarConfig.status === 'test';
  let broadcastStarted = false;

  video.muted = true;
  if (volumeSlider) volumeSlider.value = 0;
  if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';

  if (isTestMode) {
    video.pause();
    video.currentTime = 0;
  } else {
    video.play().catch(err => {
      console.log('Muted autoplay was prevented by browser, waiting for user click.', err);
    });
  }

  if (isLive) {
    if (liveIndicator) liveIndicator.classList.remove('hidden');
    if (liveIndicator) liveIndicator.querySelector('span:last-child').textContent = 'Идет эфир';
    if (customTimeDisplay) customTimeDisplay.classList.add('hidden');
    if (playPauseBtn) playPauseBtn.classList.add('hidden');
    if (seekContainer) seekContainer.classList.add('hidden');

    let viewers = Math.floor(Math.random() * (165 - 145) + 145);
    if (viewerCountValue) viewerCountValue.textContent = String(viewers);
    setChatActivity('Подсказки будут появляться по мере просмотра');

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
  }

  const initialPos = getLivePosition();
  if (isLive) {
    if (initialPos < videoDuration) {
      video.currentTime = initialPos;
    } else {
      if (playOverlay) {
        playOverlay.innerHTML = `
          <div class="w-20 h-20 bg-green-600/90 rounded-full flex items-center justify-center mb-4 border border-white/20">
            <span class="material-symbols-outlined text-white text-4xl">check_circle</span>
          </div>
          <p class="text-headline-md text-white font-bold tracking-wide uppercase">🏁 Трансляция завершена</p>
          <p class="text-body-lg text-white/80 mt-1">Основная часть эфира завершена. Оставьте вопрос или заявку ниже.</p>
        `;
      }
    }
  }

  video.addEventListener('timeupdate', () => {
    const current = video.currentTime;
    activateTimelineEvent(current, data.timeline || []);
    updateWebinarInsights(current);

    if (!isLive) {
      if (seekProgress && video.duration) {
        seekProgress.style.width = (current / video.duration) * 100 + '%';
      }
      if (currentTimeText) currentTimeText.textContent = formatTimelineTime(current);
      if (durationTimeText && video.duration) durationTimeText.textContent = formatTimelineTime(video.duration);
    }
  });

  activateTimelineEvent(video.currentTime, data.timeline || []);
  updateWebinarInsights(video.currentTime, true);

  function startBroadcastFromClick() {
    if (isLive) {
      const currentPos = getLivePosition();
      if (currentPos >= videoDuration) return;
      video.currentTime = currentPos;
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
    }).catch(err => {
      console.error('Play unmuted failed:', err);
      video.muted = true;
      video.play().then(() => {
        broadcastStarted = true;
        if (playOverlay) {
          const title = playOverlay.querySelector('p');
          if (title) title.textContent = '🔊 Включить звук трансляции';
          const desc = playOverlay.querySelector('p:last-of-type');
          if (desc) desc.textContent = 'Трансляция идет без звука. Нажмите еще раз для включения.';
        }
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
      if (isLive) {
        const currentPos = getLivePosition();
        if (currentPos < videoDuration) {
          video.currentTime = currentPos;
          video.play().then(() => { pauseOverlay.classList.add('hidden'); });
        }
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
      video.play();
      pauseOverlay.classList.add('hidden');
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
    } else {
      video.pause();
      const p1 = pauseOverlay.querySelector('p');
      if (p1) p1.textContent = 'Просмотр приостановлен';
      const p2 = pauseOverlay.querySelector('p:last-of-type');
      if (p2) p2.textContent = 'Нажмите в любой точке для продолжения';
      pauseOverlay.classList.remove('hidden');
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
    }
  }

  if (container) {
    container.addEventListener('click', (e) => {
      if (e.target.closest('#customPlayerControls') || e.target.closest('#videoPauseOverlay')) return;
      if (!broadcastStarted || video.paused) {
        startBroadcastFromClick();
      } else if (isLive) {
        toggleMuteState();
      } else {
        togglePlayState();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (isLive) { toggleMuteState(); } else { togglePlayState(); }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isLive) {
      const currentPos = getLivePosition();
      if (currentPos < videoDuration) {
        video.currentTime = currentPos;
        video.play().catch(err => console.log('Visibility change auto-play failed:', err));
      }
    }
  });

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => { togglePlayState(); });
  }

  video.addEventListener('play', () => {
    if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
    pauseOverlay.classList.add('hidden');
  });

  video.addEventListener('pause', () => {
    if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
  });

  video.addEventListener('seeking', () => {
    if (isLive) {
      const currentPos = getLivePosition();
      if (Math.abs(video.currentTime - currentPos) > 2) {
        video.currentTime = currentPos;
      }
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

  if (seekContainer && !isLive) {
    seekContainer.addEventListener('click', (e) => {
      const rect = seekContainer.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      if (videoDuration) {
        video.currentTime = pos * videoDuration;
        if (seekProgress) seekProgress.style.width = (pos * 100) + '%';
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
