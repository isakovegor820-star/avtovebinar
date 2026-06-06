import { expect, test } from '@playwright/test';
import { prisma } from '../../src/lib/prisma.js';
import { createAccessToken, hashToken } from '../../src/lib/tokens.js';

type LiveDvrTestSnapshot = {
  livePosition: number;
  viewerPosition: number;
};

declare global {
  interface Window {
    __ASPB_ENABLE_TEST_HOOKS__?: boolean;
    __ASPB_LIVE_DVR_TEST__?: {
      snapshot: () => LiveDvrTestSnapshot;
      pauseAtCurrentPosition: () => LiveDvrTestSnapshot;
      resumeToLive: () => LiveDvrTestSnapshot;
    };
  }
}

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, telegram_broadcast_jobs, telegram_broadcast_dead_letters, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages CASCADE;',
  );
}

async function createExchangeRegistration(email: string) {
  const scheduledAt = new Date(Date.now() - 5 * 60 * 1000);
  const session = await prisma.webinarSession.create({
    data: {
      title: 'E2E webinar',
      scheduledAt,
      status: 'live',
      videoDurationSeconds: 568,
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

  return { exchangeToken, registration };
}

test.beforeEach(async () => {
  await resetDb();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('registration leads to success and opens webinar room through cookie session', async ({ page }) => {
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

  await prisma.webinarSession.updateMany({
    data: {
      scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
      status: 'live',
    },
  });

  await page.locator('#successRoomLink').click();
  await expect(page).toHaveURL(/webinar\.html$/);
  await expect(page.locator('#webinarStatusText')).toContainText(/Эфир идет|Включайте/);
  await expect(page.locator('#videoPlayerContainer')).toBeVisible();
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
});

test('exchange token is removed from URL and room scenario stays cookie-only', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`exchange-${Date.now()}@aspb.ru`);
  await page.addInitScript(() => {
    window.__ASPB_ENABLE_TEST_HOOKS__ = true;
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  await expect(page.locator('#videoPlayerContainer')).toBeVisible();
  await page.locator('#videoPlayerContainer').hover();
  await page.locator('#videoPlayerContainer').dispatchEvent('mouseenter');
  await page.locator('#videoPlayerContainer').dispatchEvent('mousemove');
  await expect(page.locator('#customPlayerControls')).toHaveClass(/opacity-100/);
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

  await expect
    .poll(async () =>
      page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => Number(node.dataset.livePosition || 0)),
    )
    .toBeGreaterThan(dvrAfterSeek.livePosition);
  const dvrAfterWait = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
    behindLive: node.dataset.behindLive,
  }));
  expect(dvrAfterWait.livePosition - dvrAfterWait.viewerPosition).toBeGreaterThan(10);

  await page.locator('#returnToLiveBtn').click();
  await page.waitForTimeout(800);
  const dvrAfterReturn = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrAfterReturn.livePosition - dvrAfterReturn.viewerPosition).toBeLessThan(4);

  const dvrPaused = await page.evaluate(() => window.__ASPB_LIVE_DVR_TEST__!.pauseAtCurrentPosition());
  await expect
    .poll(async () => page.evaluate(() => window.__ASPB_LIVE_DVR_TEST__!.snapshot().livePosition))
    .toBeGreaterThan(dvrPaused.livePosition + 1);
  const dvrAfterPauseWait = await page.evaluate(() => window.__ASPB_LIVE_DVR_TEST__!.snapshot());
  expect(dvrAfterPauseWait.livePosition).toBeGreaterThan(dvrPaused.livePosition + 1);
  expect(dvrAfterPauseWait.viewerPosition).toBeLessThan(dvrAfterPauseWait.livePosition - 1);

  const dvrAfterPauseResume = await page.evaluate(() => window.__ASPB_LIVE_DVR_TEST__!.resumeToLive());
  expect(dvrAfterPauseResume.livePosition - dvrAfterPauseResume.viewerPosition).toBeLessThan(4);

  await page.mouse.click(seekBarBox!.x + seekBarBox!.width - 2, seekBarBox!.y + seekBarBox!.height / 2);
  await page.waitForTimeout(500);
  const dvrAtLiveEdge = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrAtLiveEdge.viewerPosition).toBeLessThanOrEqual(dvrAtLiveEdge.livePosition + 1);

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

test('chat remains visible and accepts questions after webinar end', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`ended-${Date.now()}@aspb.ru`);
  await prisma.webinarSession.updateMany({
    data: {
      scheduledAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      status: 'finished',
    },
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
  await expect(page.locator('#chatActivity')).toContainText('Вебинар окончен, чат открыт');
  await expect(page.locator('#questionInput')).toHaveAttribute('placeholder', 'Задайте вопрос после эфира...');
  await expect(page.locator('#questionInput')).toBeEnabled();

  await page.locator('#questionInput').fill('Вопрос после завершения вебинара');
  await page.locator('#questionSubmit').click();
  await expect(page.locator('#liveChatMessages')).toContainText('Вопрос после завершения вебинара');
});

test('chat remains active before webinar starts', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`waiting-chat-${Date.now()}@aspb.ru`);
  await prisma.webinarSession.updateMany({
    data: {
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      status: 'scheduled',
    },
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`);
  await expect(page).toHaveURL(/webinar\.html$/);
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
  await expect(page.locator('#chatActivity')).toContainText('Чат открыт');
  await expect(page.locator('#questionInput')).toHaveAttribute('placeholder', 'Задайте вопрос до начала эфира...');
  await expect(page.locator('#questionInput')).toBeEnabled();
  await expect(page.locator('#liveChatMessages')).toContainText('Добрый день всем');

  await page.locator('#questionInput').fill('Вопрос до начала эфира');
  await page.locator('#questionSubmit').click();
  await expect(page.locator('#liveChatMessages')).toContainText('Вопрос до начала эфира');
});
