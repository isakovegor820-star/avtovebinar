/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js?v=remediation-20260804-3';
import { hydrateTimeline } from './video.js?v=remediation-20260804-3';
import { hydrateRoomContent } from './room-content.js?v=room-content-20260821-1';
import { hydrateViewerRoom } from './viewer-room.js?v=viewer-account-1';
import { hydrateSuccessPage } from './success.js?v=remediation-20260804-1';
import { hydrateAccessPage } from './access.js?v=remediation-20260804-1';
import { hydrateRecordingsPage } from './recordings.js?v=remediation-20260804-3';
import {
  bindRegistrationForm,
  bindRegistrationClicks,
  bindTelegramTracking,
  exchangeUrlTokenIfPresent,
  hydrateParticipantCtas,
  redirectRegisteredUserFromRegisterPage
} from './registration.js?v=remediation-20260804-1';
import { bindQuestionForm } from './questions.js?v=remediation-20260804-3';
import { bindPartnerApplicationForm } from './partner.js?v=remediation-20260804-1';
import { track } from './analytics.js?v=site-review-7';

async function exchangeCurrentUrlToken() {
  const exchangedRoomToken = await exchangeUrlTokenIfPresent().catch(() => false);
  if (!exchangedRoomToken) return false;

  document.dispatchEvent(new CustomEvent('aspb:chat-refresh-request', { detail: { reason: 'token-exchanged' } }));
  return true;
}

function canLoadProtectedRoomContent(data) {
  return Boolean(
    data?.canEnterRoom &&
      !['waiting', 'pre_live', 'closed'].includes(data.accessStatus),
  );
}

function hydrateRoomFeatures(data) {
  return Promise.all([
    hydrateTimeline(),
    canLoadProtectedRoomContent(data) ? hydrateRoomContent() : Promise.resolve(null),
    hydrateViewerRoom(data).catch(() => null),
  ]);
}

async function refreshAfterTokenExchange() {
  const exchangedRoomToken = await exchangeCurrentUrlToken();
  if (!exchangedRoomToken) return;

  if (window.location.pathname.endsWith('webinar.html')) {
    await hydrateWebinarRoom(hydrateRoomFeatures).catch(() => {});
  } else {
    await Promise.all([
      hydrateParticipantCtas().catch(() => {}),
      hydrateAccessPage().catch(() => {}),
      hydrateRecordingsPage().catch(() => {})
    ]);
  }
}

window.addEventListener('hashchange', () => {
  void refreshAfterTokenExchange();
});

document.addEventListener('DOMContentLoaded', async () => {
  const isWebinarPage = window.location.pathname.endsWith('webinar.html');

  // Form protection must exist before the first network request. Otherwise a
  // slow /csrf or room request leaves a window where the browser can perform
  // the form's native POST without our JSON body and CSRF header.
  bindRegistrationForm();
  bindQuestionForm();
  bindPartnerApplicationForm();
  bindTelegramTracking();
  bindRegistrationClicks();
  track('page_view');

  await exchangeCurrentUrlToken();

  if (isWebinarPage) {
    // The protected room response contains its own server time, Telegram URLs and
    // webinar state. Going straight to it avoids two unrelated requests before
    // the access gate can be rendered on a cold visit.
    await hydrateWebinarRoom(hydrateRoomFeatures).catch(() => {});
  } else {
    await Promise.all([
      hydrateCurrentWebinar().catch(() => {}),
      hydrateParticipantCtas().catch(() => {})
    ]);
  }

  const redirectedToAccess = await redirectRegisteredUserFromRegisterPage().catch(() => false);
  if (redirectedToAccess) return;
  hydrateSuccessPage();
  hydrateAccessPage();
  hydrateRecordingsPage();

});
