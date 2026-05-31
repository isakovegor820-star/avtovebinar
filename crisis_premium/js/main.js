/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js';
import { hydrateTimeline } from './video.js';
import { hydrateSuccessPage } from './success.js';
import { bindRegistrationForm, bindRegistrationClicks, bindTelegramTracking } from './registration.js';
import { bindQuestionForm } from './questions.js';
import { bindPartnerApplicationForm } from './partner.js';
import { track } from './analytics.js';

document.addEventListener('DOMContentLoaded', () => {
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
