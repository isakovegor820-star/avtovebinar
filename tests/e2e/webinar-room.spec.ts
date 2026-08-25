import { expect, test, type Page } from '@playwright/test';
import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../../src/lib/tokens.js';
import { generateTotp } from '../../src/lib/mfa.js';
import { buildUnsubscribeToken } from '../../src/lib/unsubscribe.js';
import { TELEGRAM_BINDING_VERSION } from '../../src/lib/roomLinks.js';
import { runEmailOutboxJobOnce } from '../../src/lib/emailOutbox.js';

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, email_outbox_dead_letters, telegram_broadcast_jobs, telegram_broadcast_recipients, telegram_broadcast_dead_letters, telegram_news_posts, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages, consent_records, legal_acceptances, retention_runs CASCADE;',
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
      emailVerifiedAt: new Date(),
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

async function deliverNextEmailToken() {
  let deliveredUrl = '';
  const captureDelivery = async (input: { webinarUrl: string }) => {
    deliveredUrl = input.webinarUrl;
    return { sent: true, mode: 'send' as const };
  };
  const result = await runEmailOutboxJobOnce(new Date(), {
    sendRegistrationEmail: captureDelivery,
    sendParticipantLoginEmail: captureDelivery,
  });
  expect(result.sent).toBe(1);
  const token = deliveredUrl ? new URLSearchParams(new URL(deliveredUrl).hash.slice(1)).get('token') : null;
  expect(token).toBeTruthy();
  return token!;
}

async function installDeterministicMediaClock(page: Page) {
  await page.addInitScript(() => {
    type MediaClock = { position: number; paused: boolean; startedAt: number };
    const clocks = new WeakMap<HTMLMediaElement, MediaClock>();
    const stateFor = (media: HTMLMediaElement) => {
      let state = clocks.get(media);
      if (!state) {
        state = { position: 0, paused: true, startedAt: performance.now() };
        clocks.set(media, state);
      }
      return state;
    };
    const positionFor = (media: HTMLMediaElement) => {
      const state = stateFor(media);
      const elapsed = state.paused ? 0 : (performance.now() - state.startedAt) / 1000;
      return Math.min(3860, state.position + elapsed);
    };

    Object.defineProperties(HTMLMediaElement.prototype, {
      paused: {
        configurable: true,
        get() {
          return stateFor(this as HTMLMediaElement).paused;
        },
      },
      currentTime: {
        configurable: true,
        get() {
          return positionFor(this as HTMLMediaElement);
        },
        set(value: number) {
          const media = this as HTMLMediaElement;
          const state = stateFor(media);
          state.position = Math.max(0, Math.min(3860, Number(value) || 0));
          state.startedAt = performance.now();
          media.dispatchEvent(new Event('seeking'));
          media.dispatchEvent(new Event('timeupdate'));
        },
      },
      duration: { configurable: true, get: () => 3860 },
      readyState: { configurable: true, get: () => 4 },
    });

    HTMLMediaElement.prototype.play = function play() {
      const state = stateFor(this);
      if (state.paused) {
        state.paused = false;
        state.startedAt = performance.now();
        this.dispatchEvent(new Event('play'));
      }
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      const state = stateFor(this);
      if (!state.paused) {
        state.position = positionFor(this);
        state.paused = true;
        this.dispatchEvent(new Event('pause'));
      }
    };
    HTMLMediaElement.prototype.load = function load() {};
  });
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
  await expect(page.locator('#videoPlayOverlay')).toContainText('Премьера записи начнётся через');
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

test('anonymous visitor sees the access gate only inside the video window', async ({ page }) => {
  await page.goto('/crisis_premium/webinar.html', { waitUntil: 'domcontentloaded' });

  const gate = page.locator('#aspb-room-overlay');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Войдите по email, чтобы открыть премьеру записи');
  await expect(gate.locator('input[name="email"]')).toBeVisible();
  await expect(gate.getByRole('link', { name: /Зарегистрироваться впервые/ })).toBeVisible();

  await expect(page.locator('#videoPlayerContainer > #aspb-room-overlay')).toHaveCount(1);
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
  await expect(page.locator('#questionInput')).toBeDisabled();
  await expect(page.locator('#timelineActive')).toBeHidden();
  await expect(page.locator('#webinarStatusText')).toContainText('Войдите по email');
  await expect(page.locator('header')).toBeVisible();
});

test('registered waiting state keeps the room visible and the video closed', async ({ page }) => {
  const now = new Date();
  const scheduledAt = new Date(now.getTime() + 45 * 60 * 1000);
  const webinar = {
    id: 'waiting-e2e',
    title: 'Ежедневный вебинар АСПБ',
    scheduledAt: scheduledAt.toISOString(),
    status: 'scheduled',
    durationMinutes: 65,
    videoDurationSeconds: 3860,
  };

  await page.route('**/api/registration/session/current?view=room', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        serverTime: now.toISOString(),
        canViewRoom: true,
        canEnterRoom: true,
        accessStatus: 'waiting',
        roomState: 'waiting',
        testMode: false,
        webinar,
      }),
    }),
  );
  await page.route('**/api/webinar/timeline/session/current', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accessStatus: 'waiting',
        liveState: { status: 'scheduled', durationSeconds: 3860 },
        video: null,
        timeline: [],
      }),
    }),
  );

  await page.goto('/crisis_premium/webinar.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#aspb-room-overlay')).toHaveCount(0);
  await expect(page.locator('#videoPlayOverlay')).toBeVisible();
  await expect(page.locator('#videoPlayOverlay')).toContainText('Премьера записи начнётся через');
  await expect(page.locator('#webinarStatusText')).toContainText('Вы зарегистрированы');
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
  await expect(page.locator('#questionInput')).toBeDisabled();
  expect(await page.locator('#webinarVideo').getAttribute('src')).toBeNull();
});

test('anonymous access gate has no horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/crisis_premium/webinar.html', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#videoPlayerContainer > #aspb-room-overlay')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator('#questionInput')).toBeDisabled();
  await expect(page.locator('#webinarChatPanel')).toBeVisible();
});

test('declining optional cookies leaves no persistent visitor identifier', async ({ page }) => {
  await page.goto('/crisis_premium/register.html', { waitUntil: 'domcontentloaded' });

  expect((await page.context().cookies()).find(cookie => cookie.name === 'aspb_visitor_id')).toBeUndefined();
  const banner = page.getByRole('dialog', { name: 'Уведомление об использовании cookie' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Отклонить' }).click();
  await expect(banner).toHaveCount(0);

  await expect
    .poll(async () => (await page.context().cookies()).find(cookie => cookie.name === 'aspb_cookie_consent')?.value)
    .toBe('declined');
  expect((await page.context().cookies()).find(cookie => cookie.name === 'aspb_visitor_id')).toBeUndefined();
});

test('magic link opened in the same access tab creates the participant session', async ({ page }) => {
  const email = `restore-browser-${Date.now()}@aspb.ru`;
  await createExchangeRegistration(email);

  await page.goto('/crisis_premium/access.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-access-mode', 'login');
  await page.locator('#accessLoginForm input[name="email"]').fill(email);
  await page.locator('#accessLoginForm button[type="submit"]').click();
  await expect(page.locator('#accessLoginStatus')).toContainText('Сейчас не удаётся отправить письмо');

  const loginJob = await prisma.emailOutboxJob.findFirstOrThrow({
    where: { type: 'participant_access_login', toEmail: email },
    orderBy: { createdAt: 'desc' },
  });
  expect(loginJob.webinarUrl).toBe('generated-at-delivery://email-link');
  const token = await deliverNextEmailToken();

  await page.goto(`/crisis_premium/access.html#token=${token}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/access\.html$/);
  await expect(page.locator('body')).toHaveAttribute('data-access-mode', 'ready');
  await expect(page.locator('#accessEmail')).toHaveText(email);
  await expect(page.locator('#accessRoomLink')).toBeVisible();

  const accessResponse = await page.request.get('/api/participant/access/current');
  expect(accessResponse.ok()).toBeTruthy();
  expect((await accessResponse.json()).lead.email).toBe(email);
});

test('registered participant restores access in a clean browser context', async ({ page, browser }) => {
  const email = `restore-clean-${Date.now()}@aspb.ru`;
  await createExchangeRegistration(email);

  await page.goto('/crisis_premium/access.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#accessLoginForm input[name="email"]').fill(email);
  await page.locator('#accessLoginForm button[type="submit"]').click();
  await expect(page.locator('#accessLoginStatus')).toContainText('Сейчас не удаётся отправить письмо');

  const loginJob = await prisma.emailOutboxJob.findFirstOrThrow({
    where: { type: 'participant_access_login', toEmail: email },
    orderBy: { createdAt: 'desc' },
  });
  expect(loginJob.webinarUrl).toBe('generated-at-delivery://email-link');
  const token = await deliverNextEmailToken();

  const cleanContext = await browser.newContext();
  try {
    const restoredPage = await cleanContext.newPage();
    const origin = new URL(page.url()).origin;
    await restoredPage.goto(`${origin}/crisis_premium/access.html#token=${token}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(restoredPage).toHaveURL(/access\.html$/);
    await expect(restoredPage.locator('body')).toHaveAttribute('data-access-mode', 'ready');
    await expect(restoredPage.locator('#accessEmail')).toHaveText(email);
    const accessResponse = await restoredPage.request.get('/api/participant/access/current');
    expect(accessResponse.ok()).toBeTruthy();
  } finally {
    await cleanContext.close();
  }
});

test('admin frontend logs in without relying on implicit DOM globals', async ({ page }) => {
  const email = 'admin-e2e@aspb.ru';
  const password = 'StrongAdminE2E123';
  await prisma.adminUser.create({
    data: {
      name: 'E2E Администратор',
      email,
      passwordHash: await hashPassword(password),
      role: 'owner',
      isActive: true,
    },
  });

  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/crisis_premium/admin.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#login').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#loginBtn').click();
  await expect(page.locator('#otp')).toBeVisible();
  await expect(page.locator('#mfaSetup')).toContainText('Добавьте в приложение-аутентификатор ключ:');
  const setupText = await page.locator('#mfaSetup').innerText();
  const mfaSecret = setupText.match(/ключ:\s*([A-Z2-7]+)/)?.[1];
  expect(mfaSecret).toBeTruthy();
  await page.locator('#otp').fill(generateTotp(mfaSecret!));
  await page.locator('#loginBtn').click();

  await expect(page.locator('#appPanel')).toBeVisible();
  await expect(page.locator('#logoutBtn')).toBeVisible();
  await expect(page.locator('#metrics')).toContainText('Регистрации');
  expect(pageErrors).toEqual([]);
});

test('registration without optional marketing consent activates after email verification', async ({ page }) => {
  await page.goto('/crisis_premium/register.html', { waitUntil: 'domcontentloaded' });
  const email = `e2e-no-marketing-${Date.now()}@aspb.ru`;
  const emailMarketing = page.getByRole('checkbox', {
    name: /согласен на рекламу, новости и предложения АСПБ по email/i,
  });
  const telegramMarketing = page.getByRole('checkbox', {
    name: /согласен на рекламу, новости и предложения АСПБ в Telegram/i,
  });
  await expect(emailMarketing).not.toBeChecked();
  await expect(telegramMarketing).not.toBeChecked();
  await page.locator('input[name="name"]').fill('Алексей E2E');
  await page.locator('input[name="phone"]').fill('+79998887766');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="city"]').fill('Москва');
  await page.locator('input[name="personalDataConsent"]').check();
  await page.locator('input[name="termsAccepted"]').check();
  await page.getByRole('button', { name: /Зарегистрироваться/ }).click();

  await expect(page).toHaveURL(/register\.html$/);
  await expect(page.locator('[data-registration-verification="true"]')).toContainText('Нужно подтвердить email');

  const pendingLead = await prisma.lead.findUniqueOrThrow({ where: { email } });
  expect(pendingLead).toMatchObject({
    consent: false,
    marketingConsent: false,
    marketingEmailConsent: false,
    marketingTelegramConsent: false,
  });
  const pendingRegistration = await prisma.registration.findFirstOrThrow({ where: { leadId: pendingLead.id } });
  expect(pendingRegistration).toMatchObject({ status: 'pending_verification', emailVerifiedAt: null });

  const token = await deliverNextEmailToken();
  await page.goto(`/crisis_premium/webinar.html#token=${token}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  const savedLead = await prisma.lead.findUniqueOrThrow({ where: { email } });
  expect(savedLead).toMatchObject({
    consent: true,
    marketingConsent: false,
    marketingEmailConsent: false,
    marketingTelegramConsent: false,
  });
  const savedRegistration = await prisma.registration.findFirstOrThrow({ where: { leadId: savedLead.id } });
  expect(savedRegistration.status).toBe('registered');
  expect(savedRegistration.emailVerifiedAt).toBeInstanceOf(Date);

  const access = await expectDailyRoomState(page);
  expect(['waiting', 'pre_live', 'live', 'replay']).toContain(access.accessStatus);
});

test('email unsubscribe preserves Telegram and personal-data consent', async ({ page }) => {
  const email = `unsubscribe-e2e-${Date.now()}@aspb.ru`;
  const lead = await prisma.lead.create({
    data: {
      name: 'E2E Отписка',
      phone: '+79990000002',
      email,
      consent: true,
      marketingConsent: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
      marketingEmailConsentAt: new Date(),
      marketingTelegramConsentAt: new Date(),
      telegramChatId: '777002',
      telegramBindingVersion: TELEGRAM_BINDING_VERSION,
    },
  });
  const token = buildUnsubscribeToken(email);

  await page.goto(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { name: 'Отписка от рассылок АСПБ' })).toBeVisible();
  await page.getByRole('link', { name: 'Отписаться' }).click();
  await expect(page.getByRole('heading', { name: 'Вы отписаны' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Организационные письма о вашем вебинаре это не затрагивает');

  const savedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  expect(savedLead).toMatchObject({
    consent: true,
    marketingConsent: true,
    marketingEmailConsent: false,
    marketingTelegramConsent: true,
    marketingEmailRevocationChannel: 'email_link',
    marketingEmailRevocationReason: 'recipient_request',
  });
  expect(savedLead.marketingEmailRevokedAt).toBeInstanceOf(Date);
  await expect(
    prisma.consentRecord.count({
      where: { leadId: lead.id, kind: 'marketing_email', action: 'revoke' },
    }),
  ).resolves.toBe(1);
});

test('exchange token is removed from URL and daily room stays cookie-only', async ({ page }) => {
  await installDeterministicMediaClock(page);
  const { exchangeToken } = await createExchangeRegistration(`exchange-${Date.now()}@aspb.ru`);

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  // The banner is intentionally above page controls until the visitor makes a
  // choice. Resolve it explicitly so this test exercises the player rather
  // than depending on whether the banner happens to overlap a control.
  const cookieBanner = page.getByRole('dialog', { name: 'Уведомление об использовании cookie' });
  if (await cookieBanner.isVisible()) {
    await cookieBanner.getByRole('button', { name: 'Отклонить' }).click();
    await expect(cookieBanner).toHaveCount(0);
  }

  const access = await expectDailyRoomState(page);
  expect(access.testMode).toBe(true);

  await expect(page.locator('#customSeekBarContainer')).toBeVisible();
  await expect(page.locator('#customSeekBarContainer')).toHaveAttribute('data-live-mode', 'test');
  await expect(page.locator('#customSeekBarAvailable')).toHaveAttribute('style', /width:\s*100%/);
  await expect(page.locator('#customLiveEdgeMarker')).toBeVisible();

  await page.locator('#videoPlayerContainer').click();
  await page.waitForTimeout(4200);
  const dvrBeforeSeek = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrBeforeSeek.livePosition).toBeGreaterThan(3);

  const seekBar = page.locator('#customSeekBarContainer');
  await page.mouse.move(0, 0);
  await page.locator('#videoPlayerContainer').hover();
  await expect(seekBar).toBeVisible();
  await seekBar.focus();
  await expect(seekBar).toBeFocused();
  await page.waitForTimeout(3200);
  await expect(seekBar).toBeVisible();
  const seekBarBox = await seekBar.boundingBox();
  expect(seekBarBox).not.toBeNull();
  await page.mouse.click(seekBarBox!.x + seekBarBox!.width * 0.25, seekBarBox!.y + seekBarBox!.height / 2);
  await expect(page.locator('#returnToLiveBtn')).toBeVisible();

  const dvrAfterSeek = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
    behindLive: node.dataset.behindLive,
  }));
  expect(dvrAfterSeek.viewerPosition).toBeLessThan(dvrBeforeSeek.livePosition - 2);
  expect(dvrAfterSeek.behindLive).toBe('true');

  await page.waitForTimeout(1800);
  const dvrAfterWait = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
    behindLive: node.dataset.behindLive,
  }));
  expect(dvrAfterWait.livePosition).toBeGreaterThan(dvrAfterSeek.livePosition);
  expect(dvrAfterWait.viewerPosition).toBeGreaterThanOrEqual(dvrAfterSeek.viewerPosition);
  expect(dvrAfterWait.livePosition - dvrAfterWait.viewerPosition).toBeGreaterThan(1);

  await page.locator('#returnToLiveBtn').click();
  await page.waitForTimeout(800);
  const dvrAfterReturn = await page.locator('#customSeekBarContainer').evaluate((node: HTMLElement) => ({
    livePosition: Number(node.dataset.livePosition || 0),
    viewerPosition: Number(node.dataset.viewerPosition || 0),
  }));
  expect(dvrAfterReturn.livePosition - dvrAfterReturn.viewerPosition).toBeLessThan(3);

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
    // Controls auto-hide after inactivity. Re-open them before the real
    // pointer click instead of bypassing hit testing with force: true.
    await page.locator('#videoPlayerContainer').hover();
    await expect(page.locator('#customPlayerControls')).toHaveClass(/pointer-events-auto/);
    await page.locator('#customPlayPauseBtn').click();
    await expect
      .poll(async () => page.locator('#webinarVideo').evaluate((node: HTMLVideoElement) => node.paused))
      .toBe(true);
    const pauseOverlay = page.locator('#videoPauseOverlay');
    await expect(pauseOverlay).toBeVisible();
    await page.waitForTimeout(1800);
    const videoTimeWhilePaused = await page
      .locator('#webinarVideo')
      .evaluate((node: HTMLVideoElement) => node.currentTime);
    expect(videoTimeWhilePaused).toBeGreaterThanOrEqual(videoTimeBeforePause);

    if (await pauseOverlay.isVisible()) {
      await pauseOverlay.click();
      await page.waitForTimeout(1200);
      const videoTimeAfterResume = await page
        .locator('#webinarVideo')
        .evaluate((node: HTMLVideoElement) => node.currentTime);
      expect(videoTimeAfterResume).toBeGreaterThan(videoTimeWhilePaused);
    }
  }

  await page.locator('#questionInput').fill('Как передать клиента с долгами?');
  await page.locator('#questionShowToParticipants').check();
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

test('unavailable video offers a keyboard retry without overflowing a 320px viewport', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`media-retry-${Date.now()}@aspb.ru`);
  let timelineRequests = 0;
  await page.route('**/api/webinar/timeline/session/current', async route => {
    timelineRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false }),
    });
  });

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  const fallback = page.locator('#videoFallback');
  const retryButton = page.getByRole('button', { name: 'Повторить подключение' });
  await expect(fallback).toBeVisible();
  await expect(retryButton).toBeVisible();
  const requestsBeforeRetry = timelineRequests;
  await retryButton.focus();
  await expect(retryButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => timelineRequests).toBeGreaterThan(requestsBeforeRetry);
  await expect(fallback).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('registered participant does not see registration CTA in landing header', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`landing-nav-${Date.now()}@aspb.ru`);

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);

  await page.goto('/crisis_premium/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header a[href*="register.html"]')).toHaveCount(0);
  await expect(page.locator('header a[data-participant-cta="true"]')).toContainText('Открыть комнату');
  await expect(page.locator('header a[data-participant-cta="true"]')).toHaveAttribute('href', /webinar\.html/);
});

test('published recording stays available before the daily broadcast', async ({ page }) => {
  const { exchangeToken, registration } = await createExchangeRegistration(`ended-${Date.now()}@aspb.ru`);
  await prisma.webinarRecording.create({
    data: {
      webinarSessionId: registration.webinarSessionId,
      title: 'Постоянная запись E2E',
      description: 'Эта запись доступна участнику после регистрации.',
      videoUrl: '/crisis_premium/assets/webinar.mp4',
      posterUrl: '/crisis_premium/assets/webinar-poster.jpg',
      durationSeconds: 568,
      publishedAt: new Date(Date.now() - 60 * 1000),
      visible: true,
      orderIndex: 1,
    },
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  expect(page.url()).not.toContain('token=');

  await page.goto('/crisis_premium/recordings.html', { waitUntil: 'domcontentloaded' });
  const recordingsResponse = await page.request.get('/api/recordings');
  expect(recordingsResponse.ok()).toBeTruthy();
  const recordingsPayload = await recordingsResponse.json();
  expect(recordingsPayload.locked).toBe(false);
  expect(recordingsPayload.recordings[0].video.src).toMatch(/^\/api\/media\/recording\/.+\/video$/);
  expect(recordingsPayload.recordings[0].video.hlsSrc).toBeNull();
  expect(recordingsPayload.recordings[0].durationSeconds).toBe(568);

  await expect(page.locator('#recordingsPlaylist')).toContainText('Постоянная запись E2E');
  await expect(page.locator('#recordingsCount')).toContainText('запис');
  await expect(page.locator('#recordingVideo')).toHaveAttribute('src', /\/api\/media\/recording\/.+\/video/);
  await expect(page.locator('#recordingVideoFallback')).toBeHidden();
});
