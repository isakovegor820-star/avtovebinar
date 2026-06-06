/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js';
import { hydrateTimeline } from './video.js?v=active-chat-1';
import { hydrateSuccessPage } from './success.js';
import { bindRegistrationForm, bindRegistrationClicks, bindTelegramTracking, exchangeUrlTokenIfPresent } from './registration.js';
import { bindQuestionForm } from './questions.js';
import { bindPartnerApplicationForm } from './partner.js';
import { track } from './analytics.js';

document.addEventListener('DOMContentLoaded', async () => {
  await exchangeUrlTokenIfPresent().catch(() => {});
  hydrateCurrentWebinar();
  hydrateSuccessPage();
  hydrateWebinarRoom(() => hydrateTimeline());
  bindRegistrationForm();
  bindQuestionForm();
  bindPartnerApplicationForm();
  bindTelegramTracking();
  bindRegistrationClicks();
  track('page_view');
});
