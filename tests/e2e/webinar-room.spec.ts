import { expect, test, type Page } from '@playwright/test';
import { prisma } from '../../src/lib/prisma.js';
import { createAccessToken, hashToken } from '../../src/lib/tokens.js';

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, telegram_broadcast_jobs, telegram_broadcast_dead_letters, telegram_news_posts, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages CASCADE;',
  );
}

async function createExchangeRegistration(email: string) {
  const scheduledAt = new Date(Date.now() - 5 * 60 * 1000);
  const session = await prisma.webinarSession.create({
    data: {
      title: 'E2E webinar',
      scheduledAt,
      status: 'live',
      videoDurationSeconds: 3860,
    },
  });
  const lead = await prisma.lead.create({
    data: {
      name: 'E2E Участник',
      phone: '+79990000001',
      email,
      city: 'Москва',
      professionalStatus: 'Юрист',
      consent: true,
      marketingConsent: true,
    },
  });
  const registration = await prisma.registration.create({
    data: {
      leadId: lead.id,
      webinarSessionId: session.id,
      accessTokenHash: hashToken(createAccessToken()),
    },
  });
  const exchangeToken = createAccessToken();
  await prisma.registrationToken.create({
    data: {
      registrationId: registration.id,
      tokenHash: hashToken(exchangeToken),
      purpose: 'registration',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return { exchangeToken, registration, session };
}

async function expectDailyRoomState(page: Page) {
  const response = await page.request.get('/api/registration/session/current?view=room');
  expect(response.ok()).toBeTruthy();
  const access = await response.json();

  if (access.accessStatus === 'live' || access.accessStatus === 'replay') {
    await expect(page.locator('#videoPlayerContainer')).toBeVisible();
    await expect(page.locator('#webinarChatPanel')).toBeVisible();
    await expect(page.locator('#customViewerCount')).toBeHidden();
    await expect(page.locator('#viewerCountValue')).not.toHaveText(/^\d+$/);
    return access;
  }

  await expect(page.locator('#aspb-room-overlay')).toHaveCount(0);
  await expect(page.locator('#videoPlayerContainer')).toBeVisible();
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
  await expect(page.locator('#videoPlayOverlay')).toBeVisible();
  await expect(page.locator('#videoPlayOverlay')).toContainText('Трансляция начнётся через');
  await expect(page.locator('#webinarStatusText')).toContainText('Вы зарегистрированы');
  expect(await page.locator('#webinarVideo').getAttribute('src')).toBeNull();
  return access;
}

test.beforeEach(async () => {
  await resetDb();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('registration leads to success and opens protected daily webinar room', async ({ page }) => {
  await page.goto('/crisis_premium/register.html');
  await page.locator('input[name="name"]').fill('Алексей E2E');
  await page.locator('input[name="phone"]').fill('+79998887766');
  await page.locator('input[name="email"]').fill(`e2e-${Date.now()}@aspb.ru`);
  await page.locator('input[name="city"]').fill('Москва');
  await page.locator('input[name="consent"]').check();
  await page.getByRole('button', { name: /Зарегистрироваться/ }).click();

  await expect(page).toHaveURL(/success\.html$/);
  await expect(page.locator('#successRoomLink')).toBeVisible();
  expect(page.url()).not.toContain('token=');

  await page.locator('#successRoomLink').click();
  await expect(page).toHaveURL(/webinar\.html$/);
  const access = await expectDailyRoomState(page);
  expect(['waiting', 'pre_live', 'live', 'replay']).toContain(access.accessStatus);
});

test('exchange token is removed from URL and daily room stays cookie-only', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`exchange-${Date.now()}@aspb.ru`);

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  const access = await expectDailyRoomState(page);
  if (access.accessStatus !== 'live' && access.accessStatus !== 'replay') {
    return;
  }

  await expect(page.locator('#customSeekBarContainer')).toBeVisible();
  await expect(page.locator('#customSeekBarContainer')).toHaveAttribute('data-live-mode', 'dvr');
  await expect(page.locator('#customSeekBarAvailable')).toHaveAttribute('style', /width:\s*100%/);
  await expect(page.locator('#customLiveEdgeMarker')).toBeVisible();

  await page.locator('#videoPlayerContainer').click();
  await page.waitForTimeout(1200);
  const dvrBeforeSeek = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrBeforeSeek.livePosition).toBeGreaterThan(30);

  const seekBarBox = await page.locator('#customSeekBarContainer').boundingBox();
  expect(seekBarBox).not.toBeNull();
  await page.mouse.click(seekBarBox!.x + seekBarBox!.width * 0.25, seekBarBox!.y + seekBarBox!.height / 2);
  await expect(page.locator('#returnToLiveBtn')).toBeVisible();

  const dvrAfterSeek = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
    behindLive: node.dataset.behindLive,
  }));
  expect(dvrAfterSeek.viewerPosition).toBeLessThan(dvrBeforeSeek.livePosition - 20);
  expect(dvrAfterSeek.behindLive).toBe('true');

  await page.waitForTimeout(1800);
  const dvrAfterWait = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
    behindLive: node.dataset.behindLive,
  }));
  expect(dvrAfterWait.livePosition).toBeGreaterThan(dvrAfterSeek.livePosition);
  expect(dvrAfterWait.viewerPosition).toBeGreaterThanOrEqual(dvrAfterSeek.viewerPosition);
  expect(dvrAfterWait.livePosition - dvrAfterWait.viewerPosition).toBeGreaterThan(10);

  await page.locator('#returnToLiveBtn').click();
  await page.waitForTimeout(800);
  const dvrAfterReturn = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrAfterReturn.livePosition - dvrAfterReturn.viewerPosition).toBeLessThan(4);

  await page.mouse.click(seekBarBox!.x + seekBarBox!.width - 2, seekBarBox!.y + seekBarBox!.height / 2);
  await page.waitForTimeout(500);
  const dvrAtLiveEdge = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrAtLiveEdge.viewerPosition).toBeLessThanOrEqual(dvrAtLiveEdge.livePosition + 1);

  const canExercisePlayback = await page.locator('#webinarVideo').evaluate(async (node: HTMLVideoElement) => {
    try {
      if (node.paused) {
        await node.play();
      }
      return !node.paused;
    } catch {
      return false;
    }
  });

  if (canExercisePlayback) {
    await expect
      .poll(async () => page.locator('#webinarVideo').evaluate((node: HTMLVideoElement) => node.paused))
      .toBe(false);

    const videoTimeBeforePause = await page
      .locator('#webinarVideo')
      .evaluate((node: HTMLVideoElement) => node.currentTime);
    await page.locator('#customPlayPauseBtn').click();
    await expect
      .poll(async () => page.locator('#webinarVideo').evaluate((node: HTMLVideoElement) => node.paused))
      .toBe(true);
    await expect(page.locator('#videoPauseOverlay')).toBeVisible();
    await page.waitForTimeout(1800);
    const videoTimeWhilePaused = await page
      .locator('#webinarVideo')
      .evaluate((node: HTMLVideoElement) => node.currentTime);
    expect(videoTimeWhilePaused).toBeGreaterThanOrEqual(videoTimeBeforePause);

    await page.locator('#videoPauseOverlay').click();
    await page.waitForTimeout(1200);
    const videoTimeAfterResume = await page
      .locator('#webinarVideo')
      .evaluate((node: HTMLVideoElement) => node.currentTime);
    expect(videoTimeAfterResume).toBeGreaterThan(videoTimeWhilePaused);
  }

  await page.locator('#questionInput').fill('Как передать клиента с долгами?');
  await page.locator('#questionSubmit').click();
  await expect(page.locator('#liveChatMessages')).toContainText('Как передать клиента с долгами?');

  await page.locator('input[name="sphere"]').fill('Банкротство бизнеса');
  await page.locator('input[name="city"]').fill('Москва');
  await page.locator('select[name="clientFlow"]').selectOption({ index: 1 });
  await page.locator('select[name="preferredFormat"]').selectOption({ index: 1 });
  await page.locator('textarea[name="comment"]').fill('Готов обсудить партнерский договор.');
  await page.locator('#partnerApplicationForm button[type="submit"]').click();
  await expect(page.locator('#partnerApplicationStatus')).toContainText('Заявка отправлена');
});

test('registered participant does not see registration CTA in landing header', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`landing-nav-${Date.now()}@aspb.ru`);

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);

  await page.goto('/crisis_premium/index.html');
  await expect(page.locator('header a[href*="register.html"]')).toHaveCount(0);
  await expect(page.locator('header a[data-participant-cta="true"]')).toContainText('Открыть комнату');
  await expect(page.locator('header a[data-participant-cta="true"]')).toHaveAttribute('href', /webinar\.html/);
});

test('recordings library follows the daily broadcast gate', async ({ page }) => {
  const { exchangeToken, registration } = await createExchangeRegistration(`ended-${Date.now()}@aspb.ru`);
  await prisma.webinarRecording.create({
    data: {
      webinarSessionId: registration.webinarSessionId,
      title: 'Постоянная запись E2E',
      description: 'Эта запись доступна участнику после регистрации.',
      videoUrl: '/crisis_premium/assets/webinar.mp4',
      posterUrl: '/crisis_premium/assets/webinar-poster.jpg',
      durationSeconds: 3860,
      publishedAt: new Date(Date.now() - 60 * 1000),
      visible: true,
      orderIndex: 1,
    },
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  await page.goto('/crisis_premium/recordings.html');
  const recordingsResponse = await page.request.get('/api/recordings');
  expect(recordingsResponse.ok()).toBeTruthy();
  const recordingsPayload = await recordingsResponse.json();

  if (recordingsPayload.locked) {
    await expect(page.locator('#recordingsApp')).toContainText(/Запись откроется после эфира|Сейчас идет эфир/);
    await expect(page.locator('#recordingsCounter')).toBeHidden();
    await expect(page.locator('#recordingVideo')).toHaveCount(0);
    await expect(page.locator('#recordingsApp')).not.toContainText('Постоянная запись E2E');
    return;
  }

  await expect(page.locator('#recordingsPlaylist')).toContainText('Постоянная запись E2E');
  await expect(page.locator('#recordingsCounter')).toBeVisible();
  await expect(page.locator('#recordingVideo')).toHaveAttribute('src', /webinar\.mp4/);
  await expect(page.locator('#recordingVideoFallback')).toBeHidden();
});
