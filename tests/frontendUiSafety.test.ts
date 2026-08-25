import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function readProjectFile(path: string) {
  return readFileSync(join(projectRoot, path), 'utf8');
}

describe('frontend player safety regressions', () => {
  const videoJs = readProjectFile('crisis_premium/js/video.js');
  const recordingsJs = readProjectFile('crisis_premium/js/recordings.js');
  const roomJs = readProjectFile('crisis_premium/js/room.js');
  const accessJs = readProjectFile('crisis_premium/js/access.js');
  const registrationJs = readProjectFile('crisis_premium/js/registration.js');
  const questionsJs = readProjectFile('crisis_premium/js/questions.js');
  const landingMainJs = readProjectFile('crisis_premium/main.js');
  const webinarHtml = readProjectFile('crisis_premium/webinar.html');
  const recordingsHtml = readProjectFile('crisis_premium/recordings.html');

  it('stops media before rendering an ended webinar and never initializes an ended source', () => {
    const endedBranch = videoJs.indexOf('if (isPreLive || isEnded)');
    const initializeCall = videoJs.indexOf('await initializeVideoSource(', endedBranch);
    const branchSource = videoJs.slice(endedBranch, initializeCall + 160);

    expect(endedBranch).toBeGreaterThan(-1);
    expect(initializeCall).toBeGreaterThan(endedBranch);
    expect(branchSource).toContain('stopVideoMedia(video, { ended: Boolean(isEnded) })');
    expect(branchSource).toMatch(/if \(isPreLive \|\| isEnded\)[\s\S]+?} else \{[\s\S]+?await initializeVideoSource/);
    expect(videoJs).toContain('serverLiveState?.isEnded || endedByClock');
    expect(videoJs).toContain('const mediaSession = beginVideoMediaSession()');
    expect(videoJs).toContain('mediaGeneration !== _mediaGeneration');
    expect(videoJs).toContain("playOverlay.dataset.action !== 'recordings'");
    expect(videoJs).toContain('{ signal: mediaSession.signal }');
  });

  it('makes failed recording controls unreachable until retry restores them', () => {
    expect(recordingsJs).toContain('function setRecordingPlaybackFailureState(failed)');
    expect(recordingsJs).toContain('overlay.disabled = failed');
    expect(recordingsJs).toContain('overlay.hidden = failed');
    expect(recordingsJs).toContain('controls.hidden = failed');
    expect(recordingsJs).toContain("controls.setAttribute('inert', '')");
    expect(recordingsJs).toContain('setRecordingPlaybackFailureState(true)');
    expect(recordingsJs).toContain('setRecordingPlaybackFailureState(false)');
  });

  it('gives an unavailable webinar video an accessible bounded retry path', () => {
    expect(webinarHtml).toContain('data-video-fallback-retry');
    expect(webinarHtml).toContain('Повторить подключение');
    expect(videoJs).toContain("fallback.querySelector('[data-video-fallback-retry]')");
    expect(videoJs).toContain("video.addEventListener('error', announceMediaError");
    expect(videoJs).toContain("video.addEventListener('stalled', announceBuffering");
    expect(videoJs).toContain('}, 12_000);');
    expect(videoJs).toContain('void hydrateTimeline()');
  });

  it('uses action labels without contradictory aria-pressed toggle state', () => {
    const toggleSources = [videoJs, recordingsJs, webinarHtml, recordingsHtml].join('\n');
    expect(toggleSources).not.toContain('aria-pressed');
    expect(videoJs).toContain("video.paused ? 'Воспроизвести видео' : 'Поставить видео на паузу'");
    expect(recordingsJs).toContain("video.muted ? 'Включить звук' : 'Выключить звук'");
  });

  it('announces automatic completion and only recovers focus when appropriate', () => {
    expect(webinarHtml).toContain(
      'id="webinarPlayerStatus" class="sr-only" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(videoJs).toContain('function showEndedScreen({ userTriggered = false } = {})');
    expect(videoJs).toContain('const focusNeedsRecovery = Boolean(');
    expect(videoJs).toContain('if ((userTriggered || focusNeedsRecovery)');
    expect(videoJs).toContain("playerStatus.textContent = 'Премьера завершена. Откройте доступные записи вебинаров.'");
  });

  it('only starts the room countdown for a future waiting state', () => {
    expect(roomJs).toContain("data.accessStatus === 'waiting' || data.accessStatus === 'pre_live'");
    expect(roomJs).toContain('scheduledAtMs > serverTime');
    expect(roomJs).toContain('if (shouldStartCountdown) {');
    expect(roomJs).toContain('else stopCountdown()');
    expect(roomJs).not.toContain('window.setTimeout(() => window.location.reload(), 30 * 1000)');
    expect(videoJs).not.toContain('window.location.reload()');
    expect(videoJs).not.toContain('schedulePreliveReload');
    expect(roomJs).toContain('startCountdown(data.webinar.scheduledAt, () => hydrateWebinarRoom(onSuccess))');
    expect(roomJs).toContain('if (target > Date.now() + state.serverTimeOffset && countdownRetries === 0)');
    expect(roomJs).not.toContain('sessionStorage.setItem(KEY');
  });

  it('routes the replay question action to the chat instead of the partner form', () => {
    const replayBranch = roomJs.slice(
      roomJs.indexOf('} else if (isReplay)'),
      roomJs.indexOf('} else {', roomJs.indexOf('} else if (isReplay)')),
    );
    expect(replayBranch).toContain("primaryAction.setAttribute('href', '#webinarChatPanel')");
    expect(replayBranch).toContain("primaryAction.textContent = 'Задать вопрос'");
    expect(replayBranch).not.toContain('#partnerApplication');
  });

  it('removes covered player controls from keyboard and accessibility navigation', () => {
    expect(roomJs).toContain('function setUnderlyingPlayerControlsHidden(hidden)');
    expect(roomJs).toContain("node.setAttribute('inert', '')");
    expect(roomJs).toContain("node.setAttribute('aria-hidden', 'true')");
    expect(roomJs).toContain("node.removeAttribute('inert')");
    expect(roomJs).toContain('setUnderlyingPlayerControlsHidden(false)');
  });

  it('keeps question errors in a stable assertive live region', () => {
    expect(questionsJs).toContain("status.setAttribute('role', error ? 'alert' : 'status')");
    expect(questionsJs).toContain("status.setAttribute('aria-live', error ? 'assertive' : 'polite')");
    expect(questionsJs).not.toMatch(/setTimeout\([\s\S]{0,240}questionSubmitStatus/);
  });

  it('announces the asynchronous room failure and moves focus to recovery', () => {
    expect(roomJs).toContain('role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1"');
    expect(roomJs).toContain("overlay?.querySelector('[data-room-retry]')");
    expect(roomJs).toContain('retry?.focus({ preventScroll: true })');
  });

  it('does not claim that a recovery email was sent while delivery is degraded', () => {
    expect(registrationJs).toContain("result?.deliveryStatus === 'retrying'");
    expect(registrationJs).toContain('Сейчас не удаётся отправить письмо.');
    expect(roomJs).toContain('participantLoginStatusMessage(result)');
    expect(accessJs).toContain('participantLoginStatusMessage(result)');
    expect(roomJs).not.toContain('мы отправили одноразовую ссылку');
  });

  it('makes flip cards keyboard-operable disclosures without automatic state changes', () => {
    expect(landingMainJs).toContain("card.setAttribute('role', 'button')");
    expect(landingMainJs).toContain("card.setAttribute('tabindex', '0')");
    expect(landingMainJs).toContain("event.key !== 'Enter' && event.key !== ' '");
    expect(landingMainJs).toContain("card.setAttribute('aria-expanded', expanded ? 'true' : 'false')");
    expect(landingMainJs).not.toContain('Auto-flip first card');
  });
});
