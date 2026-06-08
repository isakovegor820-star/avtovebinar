/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js';
import { hydrateTimeline } from './video.js';
import { hydrateSuccessPage } from './success.js';
import { bindRegistrationForm, bindRegistrationClicks, bindTelegramTracking, exchangeUrlTokenIfPresent } from './registration.js';
import { bindQuestionForm } from './questions.js';
import { bindPartnerApplicationForm } from './partner.js';
import { track } from './analytics.js';

document.addEventListener('DOMContentLoaded', async () => {
  await exchangeUrlTokenIfPresent().catch(() => {});

  // hydrateCurrentWebinar sets serverTimeOffset needed by other modules
  await hydrateCurrentWebinar().catch(() => {});
  hydrateSuccessPage();

  // hydrateWebinarRoom may render locked/waiting overlay and return early;
  // on success it calls hydrateTimeline which starts the video player
  await hydrateWebinarRoom(() => hydrateTimeline()).catch(() => {});

  // Bind UI handlers after async state is fully resolved
  bindRegistrationForm();
  bindQuestionForm();
  bindPartnerApplicationForm();
  bindTelegramTracking();
  bindRegistrationClicks();
  track('page_view');
});
