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
  const roomContentJs = readProjectFile('crisis_premium/js/room-content.js');
  const accessJs = readProjectFile('crisis_premium/js/access.js');
  const registrationJs = readProjectFile('crisis_premium/js/registration.js');
  const questionsJs = readProjectFile('crisis_premium/js/questions.js');
  const landingMainJs = readProjectFile('crisis_premium/main.js');
  const webinarHtml = readProjectFile('crisis_premium/webinar.html');
  const recordingsHtml = readProjectFile('crisis_premium/recordings.html');
  const creatorWebinarsJs = readProjectFile('crisis_premium/js/creator-webinars.js');
  const viewerRoomJs = readProjectFile('crisis_premium/js/viewer-room.js');
  const viewerAccountJs = readProjectFile('crisis_premium/js/account.js');
  const viewerAccountHtml = readProjectFile('crisis_premium/account.html');
  const catalogDetailHtml = readProjectFile('crisis_premium/catalog-webinar.html');
  const crmJs = readProjectFile('crisis_premium/js/crm.js');
  const crmHtml = readProjectFile('crisis_premium/crm.html');
  const crmCss = readProjectFile('crisis_premium/crm.css');
  const utilsJs = readProjectFile('crisis_premium/js/utils.js');
  const liveChatJs = readProjectFile('crisis_premium/live-chat.js');
  const moderationJs = readProjectFile('crisis_premium/js/moderation.js');
  const moderationHtml = readProjectFile('crisis_premium/moderation.html');
  const moderationCss = readProjectFile('crisis_premium/moderation.css');
  const analyticsHtml = readProjectFile('crisis_premium/analytics.html');
  const analyticsJs = readProjectFile('crisis_premium/js/analytics-dashboard.js');
  const analyticsCss = readProjectFile('crisis_premium/analytics-dashboard.css');
  const platformModerationHtml = readProjectFile('crisis_premium/platform-moderation.html');
  const platformModerationJs = readProjectFile('crisis_premium/js/platform-moderation.js');
  const platformModerationCss = readProjectFile('crisis_premium/platform-moderation.css');
  const correctionsHtml = readProjectFile('crisis_premium/creator-corrections.html');
  const correctionsJs = readProjectFile('crisis_premium/js/creator-corrections.js');

  it('stops media before rendering an ended webinar and never initializes an ended source', () => {
    const endedBranch = videoJs.indexOf('if (isPreLive || isEnded)');
    const initializeCall = videoJs.indexOf('await initializeVideoSource(', endedBranch);
    const branchSource = videoJs.slice(endedBranch, initializeCall + 160);

    expect(endedBranch).toBeGreaterThan(-1);
    expect(initializeCall).toBeGreaterThan(endedBranch);
    expect(branchSource).toContain('stopVideoMedia(video, { ended: Boolean(isEnded) })');
    expect(branchSource).toMatch(/if \(isPreLive \|\| isEnded\)[\s\S]+?} else \{\s+await initializeVideoSource/);
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

  it('uses action labels for media actions and pressed state only for captions', () => {
    const actionSources = [videoJs, recordingsJs, recordingsHtml].join('\n');
    expect(actionSources).not.toContain('aria-pressed');
    expect(videoJs).toContain("video.paused ? 'Воспроизвести видео' : 'Поставить видео на паузу'");
    expect(recordingsJs).toContain("video.muted ? 'Включить звук' : 'Выключить звук'");
    expect(webinarHtml).toContain('id="customCaptionsBtn"');
    expect(webinarHtml).toContain('aria-pressed="false"');
    expect(roomContentJs).toContain("button.setAttribute('aria-pressed', String(enabled))");
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

  it('keeps self-hosted multipart credentials same-origin and gives bounded recovery feedback', () => {
    expect(creatorWebinarsJs).toContain('const sameOrigin = target.origin === window.location.origin');
    expect(creatorWebinarsJs).toContain('...(sameOrigin ? await csrfHeaders() : {})');
    expect(creatorWebinarsJs).toContain("credentials: sameOrigin ? 'same-origin' : 'omit'");
    expect(creatorWebinarsJs).toContain('for (let attempt = 1; attempt <= 3; attempt += 1)');
    expect(creatorWebinarsJs).toContain('Проверьте соединение и повторите попытку.');
    expect(creatorWebinarsJs).not.toContain('window.localStorage');
  });

  it('keeps viewer progress foreground-only and renders account data without HTML injection', () => {
    expect(viewerRoomJs).toContain("document.visibilityState === 'hidden'");
    expect(viewerRoomJs).toContain('now - lastWriteStartedAt < WRITE_INTERVAL_MS');
    expect(viewerRoomJs).toContain('globalThis.crypto?.randomUUID?.()');
    expect(viewerRoomJs).not.toContain('localStorage');
    expect(viewerRoomJs).not.toContain('sessionStorage');
    expect(viewerRoomJs).not.toContain('innerHTML');
    expect(viewerAccountJs).not.toContain('innerHTML');
    expect(viewerAccountJs).toContain('element.textContent = value');
    expect(viewerAccountHtml).toContain('id="accountSettingsStatus" class="account-live-status" aria-live="polite"');
    expect(catalogDetailHtml).toContain(
      'id="detailRegistrationStatus" class="catalog-registration-status" aria-live="polite"',
    );
    expect(catalogDetailHtml).toContain('name="personalDataConsent" type="checkbox" required');
    expect(catalogDetailHtml).toContain('name="termsAccepted" type="checkbox" required');
  });

  it('keeps the tenant CRM URL-addressable, role-aware and safe to render', () => {
    expect(crmJs).not.toContain('innerHTML');
    expect(crmJs).not.toContain('localStorage');
    expect(crmJs).not.toContain('sessionStorage');
    expect(crmJs).toContain('result.textContent = options.text');
    expect(crmJs).toContain("window.history.pushState({}, '',");
    expect(crmJs).toContain("node('crmStageForm').hidden = !state.reference.canEditContacts");
    expect(crmJs).toContain("node('crmTaskForm').hidden = !state.reference.canEditTasks");
    expect(crmJs).toContain("node('crmManualHotForm').hidden = !state.reference.canEditContacts");
    expect(crmJs).toContain("node('crmTagManagement').hidden = !state.reference.canEditTags");
    expect(crmJs).toContain("node('crmScoringManagement').hidden = !state.reference.canManageScoring");
    expect(crmJs).toContain("node('crmBulkActionSection').hidden = !state.reference.canRunBulkActions");
    expect(crmJs).toContain("node('crmExportSection').hidden = !state.reference.canExport");
    expect(crmJs).toContain('await patchJson(`/v1/crm/tasks/${encodeURIComponent(taskId)}`, { status })');
    expect(crmJs).toContain("pendingIdempotencyKey('pendingManualHotKey', 'crm-hot')");
    expect(crmJs).toContain("pendingIdempotencyKey('pendingScoringVersionKey', 'crm-score-version')");
    expect(crmJs).toContain(
      'await post(`/v1/crm/contacts/${encodeURIComponent(contactId)}/tags/${encodeURIComponent(tagId)}`, {})',
    );
    expect(crmJs).toContain(
      'await deleteJson(`/v1/crm/contacts/${encodeURIComponent(contactId)}/tags/${encodeURIComponent(tagId)}`)',
    );
    expect(crmJs).toContain("field.querySelector('textarea').required = !field.hidden");
    expect(crmJs).toContain("mode: 'PREVIEW'");
    expect(crmJs).toContain("mode: 'EXECUTE', previewId");
    expect(crmJs).toContain("await postDownload('/v1/crm/exports', { filters: currentFilters() })");
    expect(crmJs).toContain('URL.revokeObjectURL(url)');
    expect(utilsJs).toContain("credentials: 'include'");
    expect(utilsJs).toContain("response.headers.get('x-crm-export-row-count')");
    expect(crmHtml).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(crmHtml).toContain('id="crmContactCount" aria-live="polite" aria-atomic="true"');
    expect(crmHtml).toContain('id="crmPagination" class="crm-pagination" aria-label="Страницы контактов"');
    expect(crmHtml).toContain('role="group" aria-label="Фильтр контактов по очереди"');
    expect(crmHtml).toContain('id="crmTaskFormStatus" class="crm-live-status" aria-live="polite"');
    expect(crmHtml).toContain('id="crmScoreValue" class="crm-score-value" aria-live="polite"');
    expect(crmHtml).toContain('id="crmManualHotStatus" class="crm-live-status" aria-live="polite"');
    expect(crmHtml).toContain(
      'id="crmBulkPreviewStatus" class="crm-live-status" aria-live="polite" aria-atomic="true"',
    );
    expect(crmHtml).toContain('id="crmBulkExecuteButton" class="crm-text-button" type="button" disabled');
    expect(crmHtml).toContain('Файл формируется один раз по текущим фильтрам, не сохраняется на платформе');
    expect(crmHtml).toContain('Теги действуют только внутри выбранной организации.');
    expect(crmCss).toContain('@media (max-width: 42rem)');
    expect(crmCss).toContain('.crm-stage-form[hidden]');
    expect(crmCss).toContain('.crm-task-form[hidden]');
    expect(crmCss).toContain('.crm-manual-hot-form[hidden]');
    expect(crmCss).toContain('.crm-scoring-management[hidden]');
    expect(crmCss).toContain('.crm-bulk-tools[hidden]');
  });

  it('labels synthetic chat and keeps tenant moderation reasoned, accessible and injection-safe', () => {
    expect(liveChatJs).toContain("return msg.kind === 'ai_moderator' ? 'AI-модератор' : 'Подготовленный вопрос'");
    expect(liveChatJs).toContain("item.setAttribute('aria-label', disclosure + '. ' + msg.message)");
    expect(liveChatJs).toContain("kind: 'participant'");
    expect(liveChatJs).not.toContain("kind: 'user'");
    expect(moderationJs).not.toContain('innerHTML');
    expect(moderationJs).not.toContain('localStorage');
    expect(moderationJs).not.toContain('sessionStorage');
    expect(moderationJs).toContain('target.textContent = value');
    expect(moderationJs).toContain('reason.length < 3');
    expect(moderationHtml).toContain(
      'id="moderationMessageList" class="mt-6 grid gap-4" aria-live="polite" aria-busy="false"',
    );
    expect(moderationHtml).toContain('id="moderationActionStatus"');
    expect(moderationHtml).toContain('role="status" aria-live="polite"');
    expect(moderationCss).toContain('@media (max-width: 30rem)');
    expect(moderationCss).toContain('.moderation-message-text');
  });

  it('keeps analytics URL-addressable, textual, keyboard-visible and usable at 320px', () => {
    expect(analyticsJs).not.toContain('innerHTML');
    expect(analyticsJs).not.toContain('localStorage');
    expect(analyticsJs).toContain("history.pushState({}, '',");
    expect(analyticsJs).toContain("window.addEventListener('popstate'");
    expect(analyticsHtml).toContain('role="status" aria-live="polite"');
    expect(analyticsHtml).toContain('<table>');
    expect(analyticsHtml).toContain('Как рассчитаны показатели');
    expect(analyticsCss).toContain('@media (max-width: 32rem)');
    expect(analyticsCss).toContain(':focus-visible');
    expect(analyticsCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('requires reason, confirmation and server revisions in accessible moderation interfaces', () => {
    expect(platformModerationJs).not.toContain('innerHTML');
    expect(platformModerationJs).not.toContain('localStorage');
    expect(platformModerationJs).toContain('expectedRevision: report.revision');
    expect(platformModerationJs).toContain("confirmation: 'APPLY_MODERATION_ACTION'");
    expect(platformModerationHtml).toContain('role="status" aria-live="polite"');
    expect(platformModerationHtml).toContain('К очереди модерации');
    expect(platformModerationCss).toContain('@media (max-width: 36rem)');
    expect(platformModerationCss).toContain(':focus-visible');
    expect(correctionsJs).not.toContain('innerHTML');
    expect(correctionsJs).toContain('baseContentVersion: request.baselineContentVersion');
    expect(correctionsHtml).toContain('не попадёт зрителям, пока её не одобрит platform admin');
  });
});
