/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js?v=account-access-4';
import { hydrateTimeline } from './video.js?v=room-countdown-1';
import { hydrateSuccessPage } from './success.js?v=account-access-5';
import { hydrateRecordingsPage } from './recordings.js?v=account-access-4';
import {
  bindRegistrationForm,
  bindRegistrationClicks,
  bindTelegramTracking,
  exchangeUrlTokenIfPresent,
  redirectRegisteredUserFromRegisterPage
} from './registration.js?v=account-access-4';
import { bindQuestionForm } from './questions.js?v=webinar-chat-2';
import { bindPartnerApplicationForm } from './partner.js';
import { track } from './analytics.js';

document.addEventListener('DOMContentLoaded', async () => {
  const exchangedRoomToken = await exchangeUrlTokenIfPresent().catch(() => false);
  if (exchangedRoomToken) {
    document.dispatchEvent(new CustomEvent('aspb:chat-refresh-request', { detail: { reason: 'token-exchanged' } }));
  }

  // hydrateCurrentWebinar sets serverTimeOffset needed by other modules
  await hydrateCurrentWebinar().catch(() => {});
  const redirectedToAccess = await redirectRegisteredUserFromRegisterPage().catch(() => false);
  if (redirectedToAccess) return;
  hydrateSuccessPage();
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
