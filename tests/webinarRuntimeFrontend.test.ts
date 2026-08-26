import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const videoSource = readFileSync(
  fileURLToPath(new URL('../crisis_premium/js/video.js', import.meta.url)),
  'utf8',
);
const roomSource = readFileSync(
  fileURLToPath(new URL('../crisis_premium/js/room.js', import.meta.url)),
  'utf8',
);
const chatSource = readFileSync(
  fileURLToPath(new URL('../crisis_premium/live-chat.js', import.meta.url)),
  'utf8',
);

describe('webinar client runtime regressions', () => {
  it('initializes the protected source before applying reduced-motion autoplay policy', () => {
    const reducedMotionBranch = videoSource.indexOf('if (prefersReducedMotion)');
    const sourceInitialization = videoSource.indexOf(
      'await initializeVideoSource(video, data.video || {}, fallback, mediaSession)',
    );

    expect(sourceInitialization).toBeGreaterThan(-1);
    expect(reducedMotionBranch).toBeGreaterThan(sourceInitialization);
    expect(videoSource).toContain('const allowAutoplay = !prefersReducedMotion');
    expect(videoSource).toContain('if (allowAutoplay)');
  });

  it('renders the final CTA and keeps the completed end-state across reload', () => {
    expect(videoSource).not.toContain("activeEvent.type !== 'final'");
    expect(videoSource).toContain("video.addEventListener(\n    'ended'");
    expect(videoSource).toContain('persistPlaybackEndedState');
    expect(videoSource).toContain('readPlaybackEndedState');
    expect(videoSource).toContain('activateTimelineEvent(videoDuration, data.timeline || [], playbackAnalytics)');
    expect(roomSource).toContain('id: data.webinar.id');
  });

  it('does not resume an explicitly paused live video after visibility changes', () => {
    expect(videoSource).toContain('let userPaused = false');
    expect(videoSource).toContain('let wasPlayingBeforeHidden = false');
    expect(videoSource).toContain("if (document.visibilityState === 'hidden')");
    expect(videoSource).toContain('if (userPaused || !wasPlayingBeforeHidden) return');
  });

  it('reconciles scripted chat messages in both directions after a seek', () => {
    expect(chatSource).toContain('function reconcileTimelineMessages(positionSeconds)');
    expect(chatSource).toContain('item.dataset.chatRenderKey = renderKey');
    expect(chatSource).toContain("item.dataset.chatSynthetic = msg.isSynthetic === true ? 'true' : 'false'");
    expect(chatSource).toContain("webinarVideo.addEventListener('seeking'");
    expect(chatSource).toContain("webinarVideo.addEventListener('seeked'");
    expect(chatSource).toContain('renderedMessages.delete(renderKey)');
    expect(chatSource).toContain("if (msg.isSynthetic === true && typeof msg.offsetSeconds === 'number')");
  });

  it('emits the canonical video funnel once per session and timeline CTA', () => {
    expect(videoSource).toContain("import { track } from './analytics.js?v=prelaunch-20260825-2'");
    expect(videoSource).toContain("emitOnce('video_start', 'video_start')");
    expect(videoSource).toContain("emitOnce('sound_on', 'sound_on')");
    expect(videoSource).toContain("emitOnce('video_progress_25', 'video_progress_25')");
    expect(videoSource).toContain("emitOnce('video_progress_50', 'video_progress_50')");
    expect(videoSource).toContain("emitOnce('video_progress_75', 'video_progress_75')");
    expect(videoSource).toContain("emitOnce('video_finish', 'video_finish')");
    expect(videoSource).toContain("emitOnce('cta_appear:' + key, 'cta_appear', {");
    expect(videoSource).toContain("emitOnce('cta_click:' + key, 'cta_click', {");
    expect(videoSource).toContain('ctaKey: key');
    expect(videoSource).toContain('positionSeconds: Number(event?.offsetSeconds) || 0');
    expect(videoSource).toContain('playbackAnalytics.recordProgress(current, videoDuration)');
    expect(videoSource).toContain('window.sessionStorage.setItem(storageKey, JSON.stringify([...emitted]))');
  });

  it('uses a supported decorative glyph for room connection failures', () => {
    expect(roomSource).toContain(
      '<span class="room-access-icon material-symbols-outlined" aria-hidden="true">error</span>',
    );
    expect(roomSource).not.toContain('>wifi_off</span>');
  });
});
