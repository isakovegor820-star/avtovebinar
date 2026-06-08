/**
 * main.js — точка входа. Только инициализация.
 */

import { hydrateCurrentWebinar, hydrateWebinarRoom } from './room.js';
import { hydrateTimeline } from './video.js?v=simple-chat-1';
import { hydrateSuccessPage } from './success.js';
import { bindRegistrationForm, bindRegistrationClicks, bindTelegramTracking, exchangeUrlTokenIfPresent } from './registration.js';
import { bindQuestionForm } from './questions.js';
import { bindPartnerApplicationForm } from './partner.js';
import { track } from './analytics.js';

async function init() {
  await exchangeUrlTokenIfPresent().catch(() => {});

  const isWebinarRoom = window.location.pathname.endsWith('webinar.html');
  if (!isWebinarRoom) {
    await hydrateCurrentWebinar();
  }

  hydrateSuccessPage();
  await hydrateWebinarRoom(() => hydrateTimeline());

  bindRegistrationForm();
  bindQuestionForm();
  bindPartnerApplicationForm();
  bindTelegramTracking();
  bindRegistrationClicks();
  track('page_view');
}

document.addEventListener('DOMContentLoaded', () => {
  init();
});
