/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js?v=site-review-3';
import { hydrateTimeline } from './video.js?v=site-review-3';
import { hydrateSuccessPage } from './success.js?v=site-review-3';
import { hydrateAccessPage } from './access.js?v=site-review-3';
import { hydrateRecordingsPage } from './recordings.js?v=site-review-3';
import {
  bindRegistrationForm,
  bindRegistrationClicks,
  bindTelegramTracking,
  exchangeUrlTokenIfPresent,
  hydrateParticipantCtas,
  redirectRegisteredUserFromRegisterPage
} from './registration.js?v=site-review-3';
import { bindQuestionForm } from './questions.js?v=site-review-3';
import { bindPartnerApplicationForm } from './partner.js?v=site-review-3';
import { track } from './analytics.js?v=site-review-3';

document.addEventListener('DOMContentLoaded', async () => {
  const exchangedRoomToken = await exchangeUrlTokenIfPresent().catch(() => false);
  if (exchangedRoomToken) {
    document.dispatchEvent(new CustomEvent('aspb:chat-refresh-request', { detail: { reason: 'token-exchanged' } }));
  }

  // hydrateCurrentWebinar sets serverTimeOffset needed by other modules
  await hydrateCurrentWebinar().catch(() => {});
  await hydrateParticipantCtas().catch(() => {});
  const redirectedToAccess = await redirectRegisteredUserFromRegisterPage().catch(() => false);
  if (redirectedToAccess) return;
  hydrateSuccessPage();
  hydrateAccessPage();
  hydrateRecordingsPage();

  // hydrateWebinarRoom may render locked/waiting overlay and return early;
  // on success it calls hydrateTimeline which starts the video player
  await hydrateWebinarRoom(() => hydrateTimeline()).catch(() => {});
  document.dispatchEvent(new CustomEvent('aspb:chat-refresh-request', { detail: { reason: 'main-room-hydrated' } }));

  // Bind UI handlers after async state is fully resolved
  bindRegistrationForm();
  bindQuestionForm();
  bindPartnerApplicationForm();
  bindTelegramTracking();
  bindRegistrationClicks();
  track('page_view');
});
