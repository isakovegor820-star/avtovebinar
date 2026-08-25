import { expect, test, type Page } from '@playwright/test';
import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../../src/lib/tokens.js';
import { encryptMfaSecret, generateTotp } from '../../src/lib/mfa.js';
import { buildUnsubscribeToken } from '../../src/lib/unsubscribe.js';
import { TELEGRAM_BINDING_VERSION } from '../../src/lib/roomLinks.js';
import { runEmailOutboxJobOnce } from '../../src/lib/emailOutbox.js';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_SYSTEM_OWNER_EMAIL,
  DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
  DEFAULT_SYSTEM_OWNER_USER_ID,
  DEFAULT_WEBINAR_ID,
} from '../../src/lib/tenancy/constants.js';
import { hashWebinarAccessEmail } from '../../src/lib/tenancy/webinarAccess.js';
import { runMediaJobOnce } from '../../src/lib/tenancy/mediaPipeline.js';
import { runContentJobOnce } from '../../src/lib/tenancy/transcripts.js';
import { linkVerifiedRegistrationToCrm } from '../../src/lib/tenancy/crm.js';
import {
  MARKETING_EMAIL_CONSENT,
  MARKETING_TELEGRAM_CONSENT,
  consentEvidenceData,
} from '../../src/lib/consentDocuments.js';

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE legal_holds, tenant_rollout_entries, author_service_notifications, author_review_tasks, webinar_material_uploads, webinar_materials, crm_deliveries, crm_bulk_actions, crm_contact_tags, crm_tags, crm_score_factors, crm_scoring_rules, crm_scoring_rule_sets, crm_tasks, crm_contact_events, crm_stage_transitions, crm_contacts, crm_stages, crm_pipelines, viewer_notification_preferences, viewer_webinar_notes, viewer_webinar_progress, viewer_webinar_favorites, leads, registrations, registration_tokens, email_outbox_jobs, email_outbox_dead_letters, user_auth_tokens, user_sessions, user_auth_email_jobs, author_verification_evidence, author_verifications, author_profiles, organization_invitations, organization_invitation_tokens, organization_invitation_email_jobs, webinar_access_invitation_email_jobs, webinar_access_grant_tokens, webinar_access_grants, chat_scenario_messages, chat_scenarios, telegram_broadcast_jobs, telegram_broadcast_recipients, telegram_broadcast_dead_letters, telegram_news_posts, webinar_commands, webinar_slug_aliases, webinar_sources, webinar_practice_areas, webinar_schedules, webinars, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages, consent_records, legal_acceptances, retention_runs CASCADE;',
  );
  // Admin rows own the control-plane audit metadata. The cascading reset therefore
  // removes the migration defaults as well; recreate them before exercising routes.
  await prisma.platformFeatureFlag.createMany({
    data: [
      { key: 'analytics_dashboard', enabled: true, description: 'Analytics E2E flag.' },
      { key: 'public_reporting', enabled: true, description: 'Reporting E2E flag.' },
      { key: 'moderation_actions', enabled: true, description: 'Moderation E2E flag.' },
      { key: 'provider_jobs', enabled: true, description: 'Provider jobs E2E flag.' },
    ],
    skipDuplicates: true,
  });
  await prisma.tenantRolloutPolicy.createMany({
    data: [
      { feature: 'PLATFORM_ACCOUNTS_ONBOARDING', mode: 'ENABLED' },
      { feature: 'CREATOR_DASHBOARD', mode: 'ENABLED' },
      { feature: 'PUBLIC_CATALOG', mode: 'ENABLED' },
      { feature: 'TENANT_CRM', mode: 'ENABLED' },
      { feature: 'TENANT_TELEGRAM', mode: 'ENABLED' },
      { feature: 'PROVIDER_JOBS', mode: 'ENABLED' },
      { feature: 'ANALYTICS_MODERATION', mode: 'ENABLED' },
    ],
    skipDuplicates: true,
  });
  await prisma.organizationIdempotencyRecord.deleteMany();
  await prisma.organizationMembership.deleteMany({
    where: { userId: { not: DEFAULT_SYSTEM_OWNER_USER_ID } },
  });
  await prisma.organization.deleteMany({ where: { id: { not: DEFAULT_ORGANIZATION_ID } } });
  await prisma.user.deleteMany({ where: { id: { not: DEFAULT_SYSTEM_OWNER_USER_ID } } });
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORGANIZATION_ID },
    update: { status: 'ACTIVE' },
    create: {
      id: DEFAULT_ORGANIZATION_ID,
      name: 'АСПБ',
      slug: DEFAULT_ORGANIZATION_SLUG,
      status: 'ACTIVE',
      settingsJson: { compatibilityMode: 'legacy', scopeVersion: 1 },
    },
  });
  await prisma.user.upsert({
    where: { id: DEFAULT_SYSTEM_OWNER_USER_ID },
    update: { status: 'ACTIVE' },
    create: {
      id: DEFAULT_SYSTEM_OWNER_USER_ID,
      emailNormalized: DEFAULT_SYSTEM_OWNER_EMAIL,
      displayName: 'Системный владелец АСПБ',
      kind: 'SYSTEM',
      status: 'ACTIVE',
    },
  });
  await prisma.organizationMembership.upsert({
    where: { id: DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID },
    update: { status: 'ACTIVE', role: 'OWNER' },
    create: {
      id: DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      userId: DEFAULT_SYSTEM_OWNER_USER_ID,
      role: 'OWNER',
      status: 'ACTIVE',
      permissionsJson: { systemBootstrap: true },
    },
  });
  await prisma.webinar.create({
    data: {
      id: DEFAULT_WEBINAR_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      slug: 'legacy-webinar',
      title: 'Ежедневный вебинар АСПБ',
      contentStatus: 'PUBLISHED',
      visibility: 'UNLISTED',
      legacyCompatibility: true,
      mediaStatus: 'READY',
      scenarioStatus: 'PUBLISHED',
    },
  });
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

async function deliverNextEmailUrl() {
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
  expect(deliveredUrl).toBeTruthy();
  return deliveredUrl;
}

async function deliverNextEmailToken() {
  const deliveredUrl = await deliverNextEmailUrl();
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
  await expect(page.locator('#roomLearningContent')).toBeHidden();
  await expect(page.locator('#roomMaterialsPanel')).toBeHidden();
  await expect(page.locator('#liveChatMessages')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#webinarStatusText')).toContainText('Войдите по email');
  await expect(page.locator('header')).toBeVisible();

  await page.goto('/crisis_premium/account.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-account-mode', 'error');
  await expect(page.getByRole('heading', { level: 1, name: 'Кабинет недоступен' })).toBeVisible();
  await expect(page.locator('#accountErrorText')).toContainText('безопасной ссылке из письма');

  await page.goto('/crisis_premium/recordings.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Записи вебинаров' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Войдите в “Мой доступ”, чтобы смотреть записи' }),
  ).toBeVisible();
  await expect(page.locator('#recordingResources')).toBeHidden();
  await expect(page.locator('.viewer-nav a[aria-current="page"]')).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(
    await page.locator('.platform-skip-link').evaluate(element => element.getBoundingClientRect().top),
  ).toBeLessThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('platform magic link creates a cookie-only tenant session and removes the fragment token', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const organization = await prisma.organization.create({
    data: { name: 'Команда E2E', slug: `platform-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `platform-e2e-${Date.now()}@example.test`,
      displayName: 'Елена Тестовая',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await expect(page.locator('#platformUserName')).toHaveText('Елена Тестовая');
  await expect(page.locator('#platformOrganizationName')).toHaveText('Команда E2E');
  await expect(page.locator('#platformRole')).toHaveText('Владелец');
  expect(page.url()).not.toContain(rawToken);
  expect(new URL(page.url()).hash).toBe('');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === 'aspb_user_session');
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  const sessionResponse = await page.request.get('/api/v1/auth/session');
  expect(sessionResponse.ok()).toBeTruthy();
  await expect(sessionResponse.json()).resolves.toMatchObject({
    activeOrganizationId: organization.id,
    user: { id: user.id },
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await page.locator('#platformLogoutButton').click();
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'login');
  expect((await page.context().cookies()).find(cookie => cookie.name === 'aspb_user_session')).toBeUndefined();
});

test('role-aware platform overview composes real tenant data and stays usable at 320px', async ({ page }) => {
  await prisma.tenantRolloutPolicy.updateMany({ data: { mode: 'ENABLED', revision: { increment: 1 } } });
  const organization = await prisma.organization.create({
    data: {
      name: 'Правовая студия E2E',
      slug: `overview-e2e-${Date.now()}`,
      status: 'ACTIVE',
      settingsJson: { defaultTimezone: 'Europe/Amsterdam' },
    },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `overview-author-${Date.now()}@example.test`,
      displayName: 'Мария Правова',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  const author = await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      slug: `overview-author-${Date.now()}`,
      publicName: 'Мария Правова',
      verificationStatus: 'VERIFIED',
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: author.id,
      slug: `overview-webinar-${Date.now()}`,
      title: 'Договорные риски в 2026 году',
      description: 'Практический разбор договорных рисков для юридической команды.',
      contentStatus: 'DRAFT',
      visibility: 'PRIVATE',
      durationMinutes: 60,
    },
  });
  await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: 'Премьера для команды',
      scheduledAt: new Date(Date.now() + 24 * 60 * 60_000),
      timezone: 'Europe/Amsterdam',
      durationMinutes: 60,
    },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#platformOverviewLink').click();
  await expect(page.locator('body')).toHaveAttribute('data-overview-mode', 'content');
  await expect(page.locator('#overviewGreeting')).toHaveText('Здравствуйте, Мария');
  await expect(page.locator('#overviewOrganizationCopy')).toContainText('Правовая студия E2E');
  await expect(page.locator('#nextSessionWebinar')).toHaveText('Договорные риски в 2026 году');
  await expect(page.locator('#readinessSteps > li')).toHaveCount(8);
  await expect(page.locator('[data-platform-navigation]')).toContainText('Профиль автора');
  await expect(page.locator('[data-platform-navigation]')).not.toContainText('Команда и настройки');

  await page.setViewportSize({ width: 320, height: 760 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const menuButton = page.locator('[data-platform-open]');
  await menuButton.click();
  await expect(page.locator('#platformSidebar')).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Escape');
  await expect(menuButton).toBeFocused();
});

test('creator wizard preserves the exact eight steps, autosaves and follows browser history', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await prisma.tenantRolloutPolicy.updateMany({ data: { mode: 'ENABLED', revision: { increment: 1 } } });
  const organization = await prisma.organization.create({
    data: { name: 'Команда мастера E2E', slug: `wizard-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `wizard-e2e-${Date.now()}@example.test`,
      displayName: 'Автор мастера',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      slug: `wizard-author-${Date.now()}`,
      publicName: 'Автор мастера',
      verificationStatus: 'VERIFIED',
    },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await page.goto('/crisis_premium/creator-webinars.html#create', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-creator-mode', 'content');
  await page.locator('#creatorNewTitle').fill('Восьмишаговый вебинар');
  await page.locator('#creatorNewSlug').fill(`wizard-webinar-${Date.now()}`);
  await page.locator('#creatorCreateButton').click();
  await expect(page.locator('#creatorEditor')).toBeVisible();

  const expectedLabels = [
    'Основная информация',
    'Юридическая классификация и актуальность',
    'Видео',
    'Транскрипт и главы',
    'Источники и материалы',
    'Подготовленный чат',
    'Расписание и доступ',
    'Проверка и публикация',
  ];
  const wizardButtons = page.locator('#creatorWizardSteps button');
  await expect(wizardButtons).toHaveCount(8);
  for (let index = 0; index < expectedLabels.length; index += 1) {
    await expect(wizardButtons.nth(index)).toContainText(expectedLabels[index]);
  }

  await wizardButtons.nth(1).click();
  await expect(page.locator('#creatorWizardStep2Fields')).toBeVisible();
  await expect(page).toHaveURL(/step=2/);
  await page.locator('#creatorWizardNext').click();
  await expect(page.locator('#creatorWizardStep2')).toBeVisible();
  await expect(page).toHaveURL(/step=3/);
  await page.goBack();
  await expect(page.locator('#creatorWizardStep2Fields')).toBeVisible();
  await expect(page).toHaveURL(/step=2/);
  await page.goForward();
  await expect(page.locator('#creatorWizardStep2')).toBeVisible();

  await wizardButtons.nth(0).click();
  const autosaveResponse = page.waitForResponse(
    response =>
      response.request().method() === 'PATCH' &&
      /\/api\/v1\/creator\/webinars\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page
    .locator('#creatorDescription')
    .fill('Полное описание, достаточное для безопасного автоматического сохранения.');
  await page.locator('#creatorOutcome').fill('Участник получит проверяемый практический результат.');
  await page.locator('#creatorTargetAudience').fill('Практикующие юристы');
  await page.locator('#creatorFormat').selectOption('ON_DEMAND');
  await page.locator('#creatorDuration').fill('60');
  await page.locator('#creatorMetadataHeading').click();
  const autosave = await autosaveResponse;
  expect(autosave.status(), await autosave.text()).toBe(200);
  expect(autosave.request().headers()['idempotency-key']).toMatch(/^webinar-metadata:/);
  await expect(page.locator('#creatorMetadataStatus')).toContainText('сохранены автоматически');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator('#creatorWizardPrevious')).toBeVisible();
  await expect(page.locator('#creatorWizardNext')).toBeVisible();
});

test('owner filters tenant CRM, manages a task and records an audited stage transition', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const organization = await prisma.organization.create({
    data: { name: 'CRM-команда E2E', slug: `crm-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const owner = await prisma.user.create({
    data: {
      emailNormalized: `crm-e2e-owner-${Date.now()}@example.test`,
      displayName: 'Владелец CRM',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      memberships: {
        create: {
          organizationId: organization.id,
          role: 'OWNER',
          status: 'ACTIVE',
          permissionsJson: { crm: { export: true } },
        },
      },
    },
  });
  const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({
    where: { organizationId: organization.id, userId: owner.id },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      slug: `crm-e2e-webinar-${Date.now()}`,
      title: 'Договорные риски для CRM',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
    },
  });
  const session = await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: webinar.title,
      scheduledAt: new Date('2032-01-15T16:30:00.000Z'),
      timezone: 'Europe/Moscow',
    },
  });
  const participant = await prisma.user.create({
    data: {
      emailNormalized: `crm-e2e-contact-${Date.now()}@example.test`,
      displayName: 'Мария Договорова',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const lead = await prisma.lead.create({
    data: {
      name: 'Мария Договорова',
      phone: '+7 999 555-44-33',
      email: participant.emailNormalized,
      source: 'crm_browser_e2e',
      consent: true,
      marketingConsent: true,
      marketingEmailConsent: true,
      marketingEmailConsentAt: new Date(),
      marketingTelegramConsent: true,
      marketingTelegramConsentAt: new Date(),
      telegramChatId: '777000555',
      telegramBindingVersion: TELEGRAM_BINDING_VERSION,
    },
  });
  const registration = await prisma.registration.create({
    data: {
      leadId: lead.id,
      webinarSessionId: session.id,
      organizationId: organization.id,
      webinarId: webinar.id,
      userId: participant.id,
      accessPolicy: 'PUBLIC_CATALOG',
      accessTokenHash: hashToken(createAccessToken()),
      status: 'registered',
      emailVerifiedAt: new Date('2026-08-21T12:05:00.000Z'),
      roomEnteredAt: new Date('2026-08-21T12:10:00.000Z'),
    },
  });
  const contact = await prisma.$transaction(tx =>
    linkVerifiedRegistrationToCrm(tx, registration.id, new Date('2026-08-21T12:05:00.000Z')),
  );
  await prisma.viewerNotificationPreference.create({
    data: {
      organizationId: organization.id,
      userId: participant.id,
      marketingEmailEnabled: true,
      marketingTelegramEnabled: true,
    },
  });
  const consentReq = { headers: { 'user-agent': 'crm-e2e' }, ip: '127.0.0.1' };
  await prisma.consentRecord.createMany({
    data: [
      consentEvidenceData(MARKETING_EMAIL_CONSENT, {
        leadId: lead.id,
        registrationId: registration.id,
        email: lead.email,
        kind: 'marketing_email',
        sourceForm: 'crm-e2e',
        req: consentReq,
      }),
      consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
        leadId: lead.id,
        registrationId: registration.id,
        email: lead.email,
        kind: 'marketing_telegram',
        sourceForm: 'crm-e2e',
        req: consentReq,
      }),
    ],
  });
  await prisma.question.create({
    data: {
      leadId: lead.id,
      registrationId: registration.id,
      webinarSessionId: session.id,
      text: 'Какие условия договора проверить?',
    },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: owner.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await page.goto('/crisis_premium/crm.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-crm-mode', 'content');
  await expect(page.locator('#crmContactCount')).toHaveText('Найдено контактов: 1');

  await page.locator('#crmFilters input[name="source"]').fill('crm_browser_e2e');
  const filteredContactsResponse = page.waitForResponse(
    response => response.url().includes('/api/v1/crm/contacts?') && response.status() === 200,
  );
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await filteredContactsResponse;
  await expect(page).toHaveURL(/source=crm_browser_e2e/);
  const contactButton = page.locator('.crm-contact-button');
  await contactButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#crmContactName')).toHaveText('Мария Договорова');
  await expect(page.locator('#crmTimeline')).toContainText('Какие условия договора проверить?');
  await expect(page.locator('#crmScoreValue')).toHaveText('10 баллов');
  await expect(page.locator('#crmScoreFactors')).toContainText('Регистрация: 1 × 10 = 10');

  const crmEmailSubject = 'Материалы по договорным рискам';
  const crmEmailMessage = 'В кабинете доступен новый материал по теме вебинара.';
  await expect(page.locator('#crmDeliveryForm select[name="registrationId"]')).toHaveAccessibleName(
    'Регистрация и сессия',
  );
  await page.locator('#crmDeliveryForm select[name="channel"]').selectOption('EMAIL');
  await page.locator('#crmDeliveryForm input[name="subject"]').fill(crmEmailSubject);
  await page.locator('#crmDeliveryForm textarea[name="message"]').fill(crmEmailMessage);
  await page.locator('#crmDeliverySubmit').click();
  await expect(page.locator('#crmDeliveryStatus')).toContainText('Worker повторно проверит согласие');
  await expect(page.locator('#crmDeliveryList')).toContainText('Email · ожидает');
  await expect(page.locator('#crmTimeline')).toContainText('Email поставлено в очередь');
  await expect(page.locator('#crmDeliverySection')).not.toContainText(crmEmailSubject);
  await expect(page.locator('#crmDeliverySection')).not.toContainText(crmEmailMessage);
  await expect(
    prisma.cRMDelivery.findFirstOrThrow({ where: { organizationId: organization.id, contactId: contact!.id } }),
  ).resolves.toMatchObject({ status: 'PENDING', registrationId: registration.id, channel: 'EMAIL' });

  await page.locator('#crmCreateTagForm input[name="name"]').fill('Нужна консультация');
  await page.locator('#crmCreateTagForm select[name="colorToken"]').selectOption('amber');
  await page.locator('#crmCreateTagForm button[type="submit"]').click();
  await expect(page.locator('#crmTagManagementStatus')).toHaveText('Тег создан внутри организации.');
  await page.locator('#crmAssignTagForm select[name="tagId"]').selectOption({ label: 'Нужна консультация' });
  await page.locator('#crmAssignTagForm button[type="submit"]').click();
  await expect(page.locator('#crmAssignTagStatus')).toHaveText('Тег добавлен к контакту.');
  await expect(page.locator('#crmContactTags')).toContainText('Нужна консультация');

  await page.locator('#crmManualHotForm select[name="mode"]').selectOption('HOT');
  await page.locator('#crmManualHotForm textarea[name="reason"]').fill('Подтверждён запрос на консультацию');
  await page.locator('#crmManualHotForm button[type="submit"]').click();
  await expect(page.locator('#crmManualHotStatus')).toHaveText('Ручное решение сохранено с причиной.');
  await expect(page.locator('#crmHotStatus')).toContainText('Горячий — ручное решение');
  await expect(page.locator('#crmHotStatus')).toContainText('Подтверждён запрос на консультацию');
  await expect(
    prisma.auditLog.count({
      where: {
        organizationId: organization.id,
        entityId: contact!.id,
        action: { in: ['crm.contact.tag_assigned', 'crm.contact.manual_hot_changed'] },
      },
    }),
  ).resolves.toBe(2);

  await page.locator('#crmCreateTagForm input[name="name"]').fill('Массовая проверка');
  await page.locator('#crmCreateTagForm select[name="colorToken"]').selectOption('blue');
  await page.locator('#crmCreateTagForm button[type="submit"]').click();
  await expect(page.locator('#crmTagManagementStatus')).toHaveText('Тег создан внутри организации.');
  await page.locator('#crmBulkForm select[name="tagId"]').selectOption({ label: 'Массовая проверка' });
  await page.locator('#crmBulkPreviewButton').click();
  await expect(page.locator('#crmBulkPreviewStatus')).toContainText('Проверено: 1 контакт.');
  await expect(page.locator('#crmBulkExecuteButton')).toBeEnabled();
  await page.locator('#crmBulkExecuteButton').click();
  await expect(page.locator('#crmBulkResultSummary')).toHaveText('Успешно: 1. Не выполнено: 0.');
  await expect(page.locator('#crmContactTags')).toContainText('Массовая проверка');
  await expect(
    prisma.auditLog.count({
      where: { organizationId: organization.id, action: 'crm.bulk.executed' },
    }),
  ).resolves.toBe(1);

  const exportDownload = page.waitForEvent('download');
  await page.locator('#crmExportButton').click();
  const download = await exportDownload;
  expect(download.suggestedFilename()).toMatch(/^crm-contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.locator('#crmExportStatus')).toHaveText('CSV сформирован. Строк данных: 1.');
  await expect(
    prisma.auditLog.count({
      where: { organizationId: organization.id, action: 'crm.contacts.exported' },
    }),
  ).resolves.toBe(1);

  await expect(page.locator('#crmQueueWithoutTask strong')).toHaveText('1');
  await page.locator('#crmTaskForm input[name="title"]').fill('Позвонить по условиям договора');
  await page.locator('#crmTaskForm select[name="assigneeMembershipId"]').selectOption(ownerMembership.id);
  await page.locator('#crmTaskForm select[name="priority"]').selectOption('HIGH');
  await page.locator('#crmTaskForm input[name="dueLocal"]').fill('2031-01-15T16:00');
  await page.locator('#crmTaskForm input[name="reminderLocal"]').fill('2031-01-15T15:00');
  await page.locator('#crmTaskForm textarea[name="description"]').fill('Уточнить перечень документов');
  await page.locator('#crmTaskForm button[type="submit"]').click();
  await expect(page.locator('#crmTaskFormStatus')).toHaveText('Задача создана.');
  await expect(page.locator('#crmTaskList')).toContainText('Позвонить по условиям договора');
  await expect(page.locator('#crmTaskList')).toContainText('высокий');
  await expect(page.locator('#crmNextContact')).toContainText('2031');
  await expect(page.locator('#crmQueueWithoutTask strong')).toHaveText('0');
  await page.getByRole('button', { name: 'Завершить задачу «Позвонить по условиям договора»' }).click();
  await expect(page.locator('#crmTaskFormStatus')).toHaveText('Задача завершена.');
  await expect(page.locator('#crmTaskList')).toContainText('завершена');
  await expect(page.locator('#crmNextContact')).toHaveText('Не назначен');
  await expect(page.locator('#crmQueueWithoutTask strong')).toHaveText('1');
  await expect(
    prisma.auditLog.count({
      where: {
        organizationId: organization.id,
        entityType: 'crm_task',
        action: { in: ['crm.task.created', 'crm.task.updated'] },
      },
    }),
  ).resolves.toBe(2);

  const lostStage = await prisma.cRMStage.findFirstOrThrow({
    where: { organizationId: organization.id, pipelineId: contact!.pipelineId, code: 'lost' },
  });
  await page.locator('#crmStageForm select[name="stageId"]').selectOption(lostStage.id);
  await expect(page.locator('#crmLostReasonField')).toBeVisible();
  await page.locator('#crmLostReasonField textarea').fill('Нет подтверждённой потребности');
  await page.locator('#crmStageForm button[type="submit"]').click();
  await expect(page.locator('#crmStageStatus')).toHaveText('Этап контакта сохранён.');
  await expect(prisma.registration.findUniqueOrThrow({ where: { id: registration.id } })).resolves.toMatchObject({
    crmStatus: 'lost',
  });
  await expect(
    prisma.auditLog.count({
      where: { organizationId: organization.id, entityId: contact!.id, action: 'crm.contact.stage_changed' },
    }),
  ).resolves.toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('organization invitation creates the bound membership and signs the invitee in', async ({ page }) => {
  const organization = await prisma.organization.create({
    data: { name: 'Команда авторов', slug: `invitation-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const owner = await prisma.user.create({
    data: {
      emailNormalized: `invitation-owner-${Date.now()}@example.test`,
      displayName: 'E2E owner',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId: organization.id,
      emailNormalized: `invited-author-${Date.now()}@example.test`,
      role: 'AUTHOR',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: owner.id,
    },
  });
  const rawToken = createAccessToken();
  await prisma.organizationInvitationToken.create({
    data: {
      invitationId: invitation.id,
      tokenHash: hashToken(rawToken),
      expiresAt: invitation.expiresAt,
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#invite=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await expect(page.locator('#platformOrganizationName')).toHaveText('Команда авторов');
  await expect(page.locator('#platformRole')).toHaveText('Автор');
  expect(page.url()).not.toContain(rawToken);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'aspb_user_session')).toMatchObject({
    httpOnly: true,
  });
  const accepted = await prisma.organizationInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  expect(accepted).toMatchObject({ status: 'ACCEPTED', acceptedByUserId: expect.any(String) });
  await expect(
    prisma.organizationMembership.findUniqueOrThrow({ where: { id: accepted.membershipId! } }),
  ).resolves.toMatchObject({ organizationId: organization.id, role: 'AUTHOR', status: 'ACTIVE' });
});

test('private Webinar invitation survives passwordless sign-in and opens only for the invited email', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const [webinarOrganization, viewerOrganization] = await Promise.all([
    prisma.organization.create({
      data: { name: 'Закрытые вебинары', slug: `private-webinar-e2e-${Date.now()}`, status: 'ACTIVE' },
    }),
    prisma.organization.create({
      data: { name: 'Команда зрителя', slug: `private-viewer-e2e-${Date.now()}`, status: 'ACTIVE' },
    }),
  ]);
  const owner = await prisma.user.create({
    data: {
      emailNormalized: `private-owner-${Date.now()}@example.test`,
      displayName: 'Владелец вебинара',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      memberships: {
        create: { organizationId: webinarOrganization.id, role: 'OWNER', status: 'ACTIVE' },
      },
    },
  });
  const invitedEmail = `private-viewer-${Date.now()}@example.test`;
  const viewer = await prisma.user.create({
    data: {
      emailNormalized: invitedEmail,
      displayName: 'Алина Зритель',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      memberships: {
        create: { organizationId: viewerOrganization.id, role: 'AUDITOR', status: 'ACTIVE' },
      },
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: webinarOrganization.id,
      slug: `private-invitation-e2e-${Date.now()}`,
      title: 'Закрытый вебинар о договорах',
      visibility: 'PRIVATE',
    },
  });
  const grant = await prisma.webinarAccessGrant.create({
    data: {
      organizationId: webinarOrganization.id,
      webinarId: webinar.id,
      emailHash: hashWebinarAccessEmail(invitedEmail),
      purpose: 'VIEW',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      invitedByUserId: owner.id,
    },
  });
  const invitationToken = createAccessToken();
  await prisma.webinarAccessGrantToken.create({
    data: {
      grantId: grant.id,
      tokenHash: hashToken(invitationToken),
      expiresAt: grant.expiresAt,
    },
  });
  const loginToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: viewer.id,
      tokenHash: hashToken(loginToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#webinarInvite=${invitationToken}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'login');
  await expect(page.locator('#platformLoginTitle')).toHaveText('Войдите, чтобы принять приглашение');
  await expect(page.locator('#platformContinueInviteButton')).toBeVisible();
  expect(page.url()).not.toContain(invitationToken);

  await page.goto(`/crisis_premium/platform-access.html#token=${loginToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await expect(page.locator('#platformWebinarAccess')).toBeVisible();
  await expect(page.locator('#platformWebinarAccessName')).toHaveText(webinar.title);
  await expect(page.locator('#platformWebinarAccessExpiry')).toContainText('Приглашение действует до');
  expect(await page.evaluate(() => sessionStorage.getItem('aspb.pendingWebinarInvite'))).toBeNull();
  expect(new URL(page.url()).hash).toBe('');
  await expect(prisma.webinarAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).resolves.toMatchObject({
    userId: viewer.id,
    acceptedAt: expect.any(Date),
  });
  await expect(
    prisma.webinarAccessGrantToken.findFirstOrThrow({ where: { grantId: grant.id } }),
  ).resolves.toMatchObject({ consumedAt: expect.any(Date), invalidatedAt: null });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('owner MFA challenge hides tenant data until the one-time code is verified', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const mfaSecret = 'JBSWY3DPEHPK3PXP';
  const organization = await prisma.organization.create({
    data: { name: 'Защищённая команда', slug: `mfa-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `mfa-owner-${Date.now()}@example.test`,
      displayName: 'Владелец с MFA',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      mfaSecretEncrypted: encryptMfaSecret(mfaSecret),
      mfaEnabledAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'mfa');
  await expect(page.locator('#platformOrganizationName')).not.toBeVisible();
  expect(page.url()).not.toContain(rawToken);

  await page.locator('#platformMfaOtp').fill(generateTotp(mfaSecret));
  await page.locator('#platformMfaButton').click();
  await expect(page.locator('body')).toHaveAttribute('data-platform-mode', 'ready');
  await expect(page.locator('#platformUserName')).toHaveText('Владелец с MFA');
  await expect(page.locator('#platformOrganizationName')).toHaveText('Защищённая команда');
  await expect(page.locator('#platformMfaSettingsDescription')).toContainText('MFA включена');
  await expect(page.locator('#platformMfaDisableForm')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('author saves a profile, uploads private evidence and submits it for review', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const organization = await prisma.organization.create({
    data: { name: 'Юридическая команда', slug: `author-profile-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `author-profile-${Date.now()}@example.test`,
      displayName: 'Автор E2E',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#platformAuthorProfileLink')).toBeVisible();
  await page.locator('#platformAuthorProfileLink').click();
  await expect(page.locator('body')).toHaveAttribute('data-author-mode', 'content');

  await page.locator('#authorPublicName').fill('Мария Юрист');
  await page
    .locator('#authorBio')
    .fill('Практикующий юрист по корпоративному праву и договорной работе, сопровождающий российский бизнес.');
  await page.locator('#authorSpecializations').fill('Корпоративное право\nДоговорная работа');
  await page.locator('#authorOrganization').fill('Коллегия юристов');
  await page.locator('#authorRegion').fill('Москва');
  await page
    .locator('#authorExperience')
    .fill('Десять лет сопровождаю сделки, корпоративные процедуры и арбитражные споры.');
  const saveResponsePromise = page.waitForResponse(
    response => response.url().endsWith('/api/v1/author-profile') && response.request().method() === 'PATCH',
  );
  await page.locator('#authorSaveButton').click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status(), await saveResponse.text()).toBe(200);
  await expect(page.locator('#authorProfileStatus')).toContainText('Черновик сохранён');

  await page.locator('#authorEvidenceFile').setInputFiles({
    name: 'qualification.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nE2E private evidence\n%%EOF'),
  });
  await page.locator('#authorEvidenceButton').click();
  await expect(page.locator('#authorEvidenceList')).toContainText('qualification.pdf');
  await expect(page.locator('#authorEvidenceStatus')).toContainText('доступен только вам');

  await page.locator('#authorSubmitButton').click();
  await expect(page.locator('#authorStatusLabel')).toHaveText('На проверке');
  await expect(page.locator('#authorSubmitStatus')).toContainText('Профиль отправлен на проверку');
  await expect(page.locator('#authorPublicName')).toBeDisabled();
  const profile = await prisma.authorProfile.findFirstOrThrow({ where: { userId: user.id } });
  expect(profile.verificationStatus).toBe('PENDING');
  await expect(prisma.authorVerificationEvidence.count({ where: { profileId: profile.id } })).resolves.toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const overflowSources = await page.locator('body *').evaluateAll(elements =>
    elements
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          id: element.id,
          className: element.className,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter(rect => rect.left < -1 || rect.right > window.innerWidth + 1)
      .slice(0, 10),
  );
  expect(overflow, JSON.stringify(overflowSources)).toBeLessThanOrEqual(1);
});

test('creator builds a private Webinar scenario and previews it without participant side effects', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const organization = await prisma.organization.create({
    data: { name: 'Редакция юридических вебинаров', slug: `creator-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `creator-owner-${Date.now()}@example.test`,
      displayName: 'Владелец редакции',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });
  await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      slug: `creator-owner-${Date.now()}`,
      publicName: 'Елена Правовед',
      verificationStatus: 'VERIFIED',
    },
  });
  const rootArea = await prisma.legalPracticeArea.upsert({
    where: { slug: 'creator-e2e-law' },
    update: { status: 'ACTIVE' },
    create: { slug: 'creator-e2e-law', name: 'Предпринимательское право', status: 'ACTIVE' },
  });
  const specialization = await prisma.legalPracticeArea.upsert({
    where: { slug: 'creator-e2e-contracts' },
    update: { parentId: rootArea.id, status: 'ACTIVE' },
    create: {
      parentId: rootArea.id,
      slug: 'creator-e2e-contracts',
      name: 'Договорные споры',
      status: 'ACTIVE',
    },
  });
  const jurisdiction = await prisma.jurisdiction.upsert({
    where: { code: 'CREATOR-E2E-RU' },
    update: { status: 'ACTIVE' },
    create: { code: 'CREATOR-E2E-RU', name: 'Российская Федерация', status: 'ACTIVE' },
  });
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await page.goto(`/crisis_premium/platform-access.html#token=${rawToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#platformCreatorWebinarsLink')).toBeVisible();
  await page.locator('#platformCreatorWebinarsLink').click();
  await expect(page.locator('body')).toHaveAttribute('data-creator-mode', 'content');
  await expect(page.locator('#creatorOrganizationSummary')).toContainText('Редакция юридических вебинаров');
  await page.getByText('Создать вебинар', { exact: true }).click();
  await page.locator('#creatorNewTitle').fill('Договорные риски для бизнеса');
  await page.locator('#creatorNewSlug').fill('dogovornye-riski');
  await page.locator('#creatorCreateButton').click();
  await expect(page.locator('#creatorOverviewHeading')).toHaveText('Договорные риски для бизнеса');

  await page
    .locator('#creatorDescription')
    .fill('Практический вебинар о проверке условий договора и снижении юридических рисков бизнеса.');
  await page.locator('#creatorOutcome').fill('Слушатель сможет проверить ключевые условия договора до подписания.');
  await page.locator('#creatorTargetAudience').fill('Юристы, руководители и владельцы малого бизнеса');
  await page.locator('#creatorFormat').selectOption('PREMIERE');
  await page.locator('#creatorDuration').fill('60');
  const creatorWizardButtons = page.locator('#creatorWizardSteps button');
  await creatorWizardButtons.nth(1).click();
  await page.locator('#creatorJurisdiction').selectOption(jurisdiction.id);
  await page.locator('#creatorAudienceLevel').selectOption('PRACTITIONER');
  await page.locator('#creatorPrimaryArea').selectOption(rootArea.id);
  await page.locator('#creatorSpecialization').selectOption(specialization.id);
  await page.locator('#creatorFreshness').selectOption('CURRENT');
  await page.locator('#creatorCurrentAsOf').fill('2026-08-21');
  await page
    .locator('#creatorDisclaimer')
    .fill('Материал носит информационный характер и не заменяет индивидуальную юридическую консультацию.');
  await creatorWizardButtons.nth(5).click();
  await page
    .locator('#creatorSyntheticDisclosure')
    .fill('Подготовленные сообщения явно отмечены и не являются репликами реальных зрителей.');
  await creatorWizardButtons.nth(1).click();
  await page.locator('#creatorSaveButton').click();
  await expect(page.locator('#creatorMetadataStatus')).toContainText('Сведения сохранены');

  await creatorWizardButtons.nth(4).click();
  await page.locator('#creatorSourceTitle').fill('Официальный источник по договорному праву');
  await page.locator('#creatorSourceUrl').fill('https://example.org/legal-source');
  await page.locator('#creatorSourceButton').click();
  await expect(page.locator('#creatorSourcesList')).toContainText('Официальный источник по договорному праву');

  await creatorWizardButtons.nth(3).click();
  await page.locator('.creator-tools-disclosure > summary').click();
  await page.locator('#creatorTerm').fill('АПК РФ');
  await page.locator('#creatorTermExpansion').fill('Арбитражный процессуальный кодекс Российской Федерации');
  await page.locator('#creatorTermButton').click();
  await expect(page.locator('#creatorTermsList')).toContainText('АПК РФ');

  const uploadedPartNumbers: number[] = [];
  let interruptSecondPart = true;
  await page.route('https://private-storage.invalid/**', route => {
    const partNumber = Number(new URL(route.request().url()).pathname.split('/').pop());
    uploadedPartNumbers.push(partNumber);
    if (partNumber === 2 && interruptSecondPart) {
      return route.fulfill({ status: 503, body: '' });
    }
    return route.fulfill({
      status: 200,
      headers: {
        etag: `"creator-e2e-part-${partNumber}"`,
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'etag',
      },
      body: '',
    });
  });
  await creatorWizardButtons.nth(2).click();
  await page.locator('#creatorVideoFile').setInputFiles({
    name: 'creator-e2e.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(16_777_216, 1),
  });
  await page.locator('#creatorUploadButton').click();
  await expect(page.locator('#creatorUploadStatus')).toContainText('Не удалось загрузить видео');
  await expect
    .poll(async () => {
      const upload = await prisma.mediaUpload.findFirst({ orderBy: { createdAt: 'desc' } });
      return upload?.uploadedPartsJson;
    })
    .toEqual([{ partNumber: 1, etag: '"creator-e2e-part-1"' }]);
  interruptSecondPart = false;
  await page.locator('#creatorUploadButton').click();
  await expect.poll(async () => prisma.mediaJob.count({ where: { status: 'PENDING' } })).toBe(1);
  expect(uploadedPartNumbers).toEqual([1, 2, 2, 2, 2]);
  await expect(runMediaJobOnce(prisma)).resolves.toMatchObject({ checked: 1, ready: 1 });
  await page.locator('#creatorMediaRefreshButton').click();
  await expect(page.locator('#creatorMediaSummary')).toContainText('Готово');
  await page.locator('#creatorMediaActivateButton').click();
  await expect(page.locator('#creatorUploadStatus')).toContainText('включена');

  await creatorWizardButtons.nth(3).click();
  await page.locator('#creatorTranscriptGenerateButton').click();
  await expect.poll(async () => prisma.contentJob.count({ where: { type: 'TRANSCRIBE', status: 'PENDING' } })).toBe(1);
  await expect(runContentJobOnce(prisma)).resolves.toMatchObject({ checked: 1, succeeded: 0 });
  await prisma.contentJob.updateMany({
    where: { type: 'TRANSCRIBE', status: 'PENDING' },
    data: { nextAttemptAt: new Date(0) },
  });
  await expect(runContentJobOnce(prisma)).resolves.toMatchObject({ checked: 1, succeeded: 1 });
  await expect(page.locator('#creatorTranscriptForm')).toBeVisible();
  await expect(page.locator('.creator-transcript-segment')).toHaveCount(3);
  const firstTranscriptSegment = page.locator('.creator-transcript-segment').first();
  await firstTranscriptSegment.locator('[data-field="text"]').fill('Проверенное введение в договорное право.');
  await firstTranscriptSegment.getByRole('button', { name: 'Перейти к таймкоду' }).click();
  await expect(page.locator('#creatorTranscriptPosition')).toContainText('00:00');
  await page.locator('#creatorTranscriptReviewButton').click();
  await expect(page.locator('#creatorTranscriptStatus')).toContainText('проверенная');
  await page.locator('#creatorTranscriptPublishButton').click();
  await expect(page.locator('#creatorTranscriptStatus')).toContainText('опубликована');
  await expect(page.locator('#creatorTranscriptTxtLink')).toHaveAttribute('aria-disabled', 'false');

  await page.locator('#creatorAiGenerateButton').click();
  await expect.poll(async () => prisma.contentJob.count({ where: { type: 'AI_ENRICH', status: 'PENDING' } })).toBe(1);
  await expect(runContentJobOnce(prisma)).resolves.toMatchObject({ checked: 1, succeeded: 1 });
  await expect(page.locator('.creator-ai-suggestion')).toHaveCount(7);
  const titleSuggestion = page.locator('.creator-ai-suggestion').filter({ hasText: 'Название' }).first();
  await titleSuggestion.getByRole('button', { name: 'Принять после проверки' }).click();
  await expect(page.locator('#creatorAiStatus')).toContainText('ручное решение');

  await creatorWizardButtons.nth(5).click();
  await page.locator('#creatorScenarioAddButton').click();
  const scenarioRow = page.locator('.creator-scenario-row').first();
  await scenarioRow.locator('[data-field="offsetSeconds"]').fill('120');
  await scenarioRow.locator('[data-field="kind"]').selectOption('PREPARED_QUESTION');
  await scenarioRow.locator('[data-field="status"]').selectOption('APPROVED');
  await scenarioRow
    .locator('[data-field="text"]')
    .fill('Какие условия договора чаще всего создают риск для предпринимателя?');
  await page.locator('#creatorScenarioSaveButton').click();
  await expect(page.locator('#creatorScenarioStatus')).toContainText('сохранён как черновик');
  await page.locator('#creatorScenarioPublishButton').click();
  await expect(page.locator('#creatorScenarioStatus')).toContainText('Сценарий опубликован');

  await creatorWizardButtons.nth(6).click();
  await page.locator('#creatorRecurrence').selectOption('ONCE');
  await page.locator('#creatorStartsOn').fill('2032-01-15');
  await page.locator('#creatorScheduleButton').click();
  await expect(page.locator('#creatorScheduleStatus')).toContainText('Расписание создано');
  await expect(page.locator('#creatorSessionsList')).toContainText('Europe/Moscow');

  await page.locator('#creatorAccessEmail').fill('private-viewer@example.test');
  await page.locator('#creatorAccessButton').click();
  await expect(page.locator('#creatorAccessList')).toContainText('Получатель скрыт');
  await expect(page.locator('#creatorAccessList')).not.toContainText('private-viewer@example.test');

  const sideEffectsBefore = await Promise.all([
    prisma.lead.count(),
    prisma.registration.count(),
    prisma.event.count(),
    prisma.emailOutboxJob.count(),
  ]);
  await creatorWizardButtons.nth(7).click();
  await page.locator('#creatorPreviewLink').click();
  await expect(page.locator('body')).toHaveAttribute('data-preview-mode', 'content');
  await expect(page.locator('#previewTitle')).toHaveText('Практический разбор: Договорные риски для бизнеса');
  await expect(page.locator('#previewScenario')).toContainText('Подготовленный вопрос');
  await expect(page.locator('#previewScenario')).toContainText('Какие условия договора');
  await expect(
    Promise.all([
      prisma.lead.count(),
      prisma.registration.count(),
      prisma.event.count(),
      prisma.emailOutboxJob.count(),
    ]),
  ).resolves.toEqual(sideEffectsBefore);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('public catalog restores URL filters and never exposes closed Webinar records', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const organization = await prisma.organization.create({
    data: { name: 'Публичная юридическая редакция', slug: `catalog-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `catalog-e2e-${Date.now()}@example.test`,
      displayName: 'Автор каталога',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  const author = await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      slug: `catalog-e2e-author-${Date.now()}`,
      publicName: 'Мария Юристова',
      bio: 'Практикующий юрист по договорному праву.',
      experience: '12 лет практики',
      verificationStatus: 'VERIFIED',
    },
  });
  const rootArea = await prisma.legalPracticeArea.upsert({
    where: { slug: 'catalog-e2e-business-law' },
    update: { status: 'ACTIVE' },
    create: { slug: 'catalog-e2e-business-law', name: 'Предпринимательское право', status: 'ACTIVE' },
  });
  const specialization = await prisma.legalPracticeArea.upsert({
    where: { slug: 'catalog-e2e-contracts' },
    update: { parentId: rootArea.id, status: 'ACTIVE' },
    create: { parentId: rootArea.id, slug: 'catalog-e2e-contracts', name: 'Договорные споры', status: 'ACTIVE' },
  });
  const jurisdiction = await prisma.jurisdiction.upsert({
    where: { code: 'CATALOG-E2E-RU' },
    update: { status: 'ACTIVE' },
    create: { code: 'CATALOG-E2E-RU', name: 'Российская Федерация', status: 'ACTIVE' },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: author.id,
      jurisdictionId: jurisdiction.id,
      slug: 'public-contract-risks',
      title: 'Публичный вебинар о договорных рисках',
      description: 'Практический разбор условий договора и способов снизить риски бизнеса.',
      outcomeDescription: 'Вы сможете проверить ключевые условия договора до подписания.',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      freshnessStatus: 'CURRENT',
      audienceLevel: 'PRACTITIONER',
      targetAudience: 'Юристы, руководители и владельцы бизнеса',
      format: 'PREMIERE',
      durationMinutes: 60,
      currentAsOf: new Date('2026-08-21T00:00:00.000Z'),
      disclaimer: 'Материал носит информационный характер и не заменяет индивидуальную юридическую консультацию.',
      syntheticDisclosure: 'Подготовленные сообщения явно отмечены и не являются репликами реальных зрителей.',
      publishedAt: new Date(),
      practiceAreas: {
        create: [
          { practiceAreaId: rootArea.id, isPrimary: true },
          { practiceAreaId: specialization.id, isPrimary: false },
        ],
      },
      sources: {
        create: {
          type: 'OFFICIAL_SOURCE',
          title: 'Официальный источник по договорному праву',
          url: 'https://example.org/contract-law',
        },
      },
    },
  });
  await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: webinar.title,
      scheduledAt: new Date('2032-01-15T16:30:00.000Z'),
      timezone: 'Europe/Moscow',
      durationMinutes: 60,
    },
  });
  for (const hidden of [
    {
      slug: 'hidden-unlisted-e2e',
      title: 'Скрытый unlisted вебинар',
      visibility: 'UNLISTED' as const,
      contentStatus: 'PUBLISHED' as const,
    },
    {
      slug: 'hidden-private-e2e',
      title: 'Скрытый private вебинар',
      visibility: 'PRIVATE' as const,
      contentStatus: 'PUBLISHED' as const,
    },
    {
      slug: 'hidden-draft-e2e',
      title: 'Скрытый черновик',
      visibility: 'PUBLIC' as const,
      contentStatus: 'DRAFT' as const,
    },
  ]) {
    await prisma.webinar.create({
      data: {
        organizationId: organization.id,
        authorProfileId: author.id,
        slug: hidden.slug,
        title: hidden.title,
        visibility: hidden.visibility,
        contentStatus: hidden.contentStatus,
      },
    });
  }
  const sideEffectsBefore = await Promise.all([
    prisma.lead.count(),
    prisma.registration.count(),
    prisma.event.count(),
    prisma.emailOutboxJob.count(),
  ]);

  await page.goto('/crisis_premium/catalog.html?q=%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%D0%BD%D1%8B%D1%85', {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('body')).toHaveAttribute('data-catalog-mode', 'content');
  await expect(page.getByRole('link', { name: webinar.title })).toBeVisible();
  await expect(page.locator('#catalogGrid')).not.toContainText('Скрытый unlisted вебинар');
  await expect(page.locator('#catalogGrid')).not.toContainText('Скрытый private вебинар');
  await expect(page.locator('#catalogGrid')).not.toContainText('Скрытый черновик');
  await expect(page.locator('#catalogQuery')).toHaveValue('договорных');
  await page.locator('#catalogPracticeArea').selectOption(rootArea.slug);
  await page.locator('#catalogSpecialization').selectOption(specialization.slug);
  await page.locator('#catalogJurisdiction').selectOption(jurisdiction.code);
  await page.locator('#catalogFormat').selectOption('PREMIERE');
  await page.locator('#catalogAvailability').selectOption('UPCOMING');
  await page.locator('.catalog-more-filters > summary').click();
  await page.locator('#catalogDateFrom').fill('2032-01-01');
  await page.locator('#catalogDateTo').fill('2032-01-31');
  await page.locator('#catalogApplyButton').click();
  await expect(page).toHaveURL(new RegExp(`practiceArea=${rootArea.slug}`));
  await expect(page).toHaveURL(new RegExp(`specialization=${specialization.slug}`));
  await expect(page).toHaveURL(/availability=UPCOMING/);
  await expect(page).toHaveURL(/dateFrom=2032-01-01/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#catalogPracticeArea')).toHaveValue(rootArea.slug);
  await expect(page.locator('#catalogSpecialization')).toHaveValue(specialization.slug);
  await expect(page.locator('#catalogJurisdiction')).toHaveValue(jurisdiction.code);
  await expect(page.locator('#catalogAvailability')).toHaveValue('UPCOMING');
  await expect(page.getByRole('link', { name: webinar.title })).toBeVisible();
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#catalogQuery')).toHaveValue('договорных');
  await expect(page.locator('#catalogPracticeArea')).toHaveValue('');
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#catalogPracticeArea')).toHaveValue(rootArea.slug);
  await expect(page.getByRole('link', { name: webinar.title })).toBeVisible();
  for (const sort of ['RELEVANCE', 'UPCOMING', 'NEWEST', 'UPDATED']) {
    await page.locator('#catalogSort').focus();
    await expect(page.locator('#catalogSort')).toBeFocused();
    await page.locator('#catalogSort').selectOption(sort);
    await page.locator('#catalogApplyButton').click();
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#catalogSort')).toHaveValue(sort);
    await expect(page.getByRole('link', { name: webinar.title })).toBeVisible();
    const sortOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sortOverflow).toBeLessThanOrEqual(1);
  }
  await page.getByRole('link', { name: webinar.title }).click();
  await expect(page.locator('body')).toHaveAttribute('data-detail-mode', 'content');
  await expect(page.locator('#detailTitle')).toBeVisible();
  await expect(page.locator('#detailTitle')).toHaveText(webinar.title);
  await expect(page.locator('#detailAuthor')).toHaveText('Мария Юристова');
  await expect(page.locator('#detailSources')).toContainText('Официальный источник по договорному праву');
  await expect(page.locator('#detailRegistrationButton')).toBeEnabled();
  await expect(page.locator('#detailRegistrationButton')).toHaveText('Зарегистрироваться');
  await expect(page.locator('#detailRegistrationName')).toHaveAccessibleName('Имя');
  await expect(page.locator('#detailRegistrationEmail')).toHaveAccessibleName('Email');
  await expect(page.locator('#detailRegistrationPhone')).toHaveAccessibleName('Телефон');
  await expect(page.locator('#detailRegistrationHint')).toContainText('подтвердите email');
  await expect(
    Promise.all([
      prisma.lead.count(),
      prisma.registration.count(),
      prisma.event.count(),
      prisma.emailOutboxJob.count(),
    ]),
  ).resolves.toEqual(sideEffectsBefore);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('analytics filters survive reload and browser history with keyboard and 320px layout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.route('**/api/v1/analytics/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/overview')
      ? {
          metrics: {
            registrations: 3,
            uniqueEntries: 3,
            liveViews: 3,
            replayViews: 2,
            averageWatchSeconds: 60,
            questions: 1,
            ctaActions: 1,
            completion: { numerator: 1, denominator: 3, rate: 1 / 3 },
          },
          period: { from: '2026-08-01T00:00:00.000Z', toExclusive: '2026-09-01T00:00:00.000Z', timezone: 'UTC' },
          formulas: {
            registrations: 'Trusted registrations in the UTC interval.',
            completion: 'Completed identities divided by unique viewers.',
          },
        }
      : path.endsWith('/retention')
        ? {
            privacyThreshold: 3,
            intervals: [
              { fromPercent: 0, viewers: 3, suppressed: false },
              { fromPercent: 25, viewers: null, suppressed: true },
            ],
          }
        : path.endsWith('/live')
          ? {
              activeViewers: 3,
              algorithm: 'Visible playing heartbeat in the last 45 seconds.',
              refreshDelaySeconds: 10,
            }
          : {
              popularChapters: [{ title: 'Введение', count: 3 }],
              transcriptSearches: [{ query: 'договор', count: 3 }],
            };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/crisis_premium/analytics.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#analyticsContent')).toBeVisible();
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
  await page.locator('[name="webinarId"]').fill('webinar-1');
  await page.locator('[name="source"]').focus();
  await expect(page.locator('[name="source"]')).toBeFocused();
  await page.locator('[name="source"]').selectOption('room');
  await page.locator('[name="from"]').fill('2026-08-01');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(page).toHaveURL(/webinarId=webinar-1/);
  await expect(page).toHaveURL(/source=room/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[name="webinarId"]')).toHaveValue('webinar-1');
  await page.goBack();
  await expect(page.locator('[name="webinarId"]')).toHaveValue('');
  await page.goForward();
  await expect(page.locator('[name="webinarId"]')).toHaveValue('webinar-1');
  await expect(page.getByText(/Скрыто: меньше 3/)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('platform moderation is keyboard-usable, revisioned and confirmed at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const mutations: Array<Record<string, unknown>> = [];
  await page.route('**/api/admin/moderation/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET') mutations.push(request.postDataJSON());
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'report-1',
              targetType: 'WEBINAR',
              webinarId: 'webinar-1',
              authorProfileId: null,
              category: 'CONTENT',
              description: 'Проверяемое описание публичной жалобы.',
              status: 'NEW',
              revision: 0,
              createdAt: '2026-08-23T10:00:00.000Z',
              webinar: { moderationRevision: 4, authorProfile: { moderationRevision: 2 } },
              authorProfile: null,
            },
          ],
          pagination: { page: 1, pageSize: 25, total: 1 },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/crisis_premium/platform-moderation.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Контроль платформы' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Жалобы' })).toBeVisible();
  await expect(page.getByText('Проверяемое описание публичной жалобы.')).toBeVisible();
  await page.locator('#reportStatus').focus();
  await expect(page.locator('#reportStatus')).toBeFocused();
  await page.locator('#reportStatus').selectOption('NEW');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page).toHaveURL(/status=NEW/);
  await page.goBack();
  await expect(page.locator('#reportStatus')).toHaveValue('');
  await page.getByRole('textbox', { name: 'Основание', exact: true }).fill('Проверено platform admin');
  await page.getByRole('combobox', { name: 'Критическое действие' }).selectOption('SUSPEND_AUTHOR');
  await page.getByRole('checkbox', { name: /Я проверил основание/ }).check();
  await page.getByRole('button', { name: 'Применить критическое действие' }).click();
  expect(mutations.at(-1)).toMatchObject({
    confirmation: 'APPLY_MODERATION_ACTION',
    expectedRevision: 0,
    expectedTargetRevision: 2,
    action: 'SUSPEND_AUTHOR',
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('public report is keyboard-usable, privacy-labeled and safe at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/v1/reports', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        report: { id: 'report-public-1', category: 'RIGHTS', status: 'NEW', createdAt: '2026-08-23T10:00:00.000Z' },
        correlationId: 'public_report_e2e',
      }),
    });
  });

  await page.goto('/crisis_premium/report.html?targetType=WEBINAR&targetId=webinar-public-1', {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Сообщить о нарушении' })).toBeVisible();
  await expect(page.getByLabel(/Email для уточнений/)).toHaveAccessibleName(/необязательно/);
  await page.getByLabel('Категория').selectOption('RIGHTS');
  await page.getByLabel('Описание').fill('Материал нарушает исключительные права правообладателя.');
  await page.getByLabel(/Email для уточнений/).fill('reporter@example.test');
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByRole('status')).toContainText('report-public-1');
  await expect(page.getByRole('heading', { level: 1, name: 'Сообщить о нарушении' })).toBeFocused();
  expect(submitted).toEqual({
    targetType: 'WEBINAR',
    targetId: 'webinar-public-1',
    category: 'RIGHTS',
    description: 'Материал нарушает исключительные права правообладателя.',
    reporterContact: 'reporter@example.test',
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('catalog registration opens a private viewer account with progress, notes and separate consent settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await installDeterministicMediaClock(page);
  const suffix = Date.now();
  const organization = await prisma.organization.create({
    data: { name: 'Кабинет юридической практики', slug: `viewer-flow-${suffix}`, status: 'ACTIVE' },
  });
  const authorUser = await prisma.user.create({
    data: {
      emailNormalized: `viewer-flow-author-${suffix}@example.test`,
      displayName: 'Автор кабинета',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: authorUser.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  const author = await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: authorUser.id,
      slug: `viewer-flow-author-${suffix}`,
      publicName: 'Анна Правова',
      verificationStatus: 'VERIFIED',
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: author.id,
      slug: `viewer-flow-webinar-${suffix}`,
      title: 'Договорная работа без лишних рисков',
      description: 'Практический вебинар для проверки полного пути зрителя.',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      freshnessStatus: 'CURRENT',
      format: 'PREMIERE',
      durationMinutes: 65,
      publishedAt: new Date(),
    },
  });
  const session = await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: webinar.title,
      scheduledAt: new Date(Date.now() - 70 * 60_000),
      timezone: 'Europe/Moscow',
      durationMinutes: 65,
      videoDurationSeconds: 3860,
      replayAvailableHours: 168,
    },
  });
  const mediaAsset = await prisma.mediaAsset.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      createdByUserId: authorUser.id,
      version: 1,
      status: 'READY',
      progressPercent: 100,
      originalFileName: 'viewer-replay.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1_024n,
      checksumSha256: 'a'.repeat(64),
      storageKey: `e2e/viewer-replay-${suffix}/source.mp4`,
      manifestStorageKey: `e2e/viewer-replay-${suffix}/master.m3u8`,
      posterStorageKey: `e2e/viewer-replay-${suffix}/poster.jpg`,
      durationSeconds: 3860,
      readyAt: new Date(),
      integrityVerifiedAt: new Date(),
    },
  });
  await prisma.webinar.update({
    where: { id: webinar.id },
    data: { currentMediaAssetId: mediaAsset.id, mediaStatus: 'READY' },
  });
  const viewerEmail = `viewer-flow-${suffix}@example.test`;
  const detailUrl = `/crisis_premium/catalog-webinar.html?organization=${organization.slug}&webinar=${webinar.slug}`;

  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-detail-mode', 'content');
  await page.locator('#detailRegistrationName').fill('Зритель Кабинета');
  await page.locator('#detailRegistrationEmail').fill(viewerEmail);
  await page.locator('#detailRegistrationPhone').fill('+79990001234');
  await page.locator('input[name="personalDataConsent"]').check();
  await page.locator('input[name="termsAccepted"]').check();
  await page.locator('#detailRegistrationButton').click();
  await expect(page.locator('#detailRegistrationStatus')).toContainText('Проверьте почту');

  await expect
    .poll(() =>
      prisma.registration.findFirst({
        where: { webinarSessionId: session.id },
        select: { id: true, organizationId: true, webinarId: true, userId: true, status: true },
      }),
    )
    .toMatchObject({
      organizationId: organization.id,
      webinarId: webinar.id,
      userId: expect.any(String),
      status: 'pending_verification',
    });

  const token = await deliverNextEmailToken();
  await page.goto(`/crisis_premium/webinar.html#token=${token}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  await expect(page.locator('#roomNoteForm')).toBeVisible();
  await expect(page.locator('#roomNotesPanel [data-room-block-state]')).toContainText('Заметок пока нет');

  await page.locator('#webinarVideo').evaluate(async element => {
    const video = element as HTMLVideoElement;
    await video.play();
    video.currentTime = 125;
  });
  await expect
    .poll(
      async () =>
        (
          await prisma.viewerWebinarProgress.findUnique({
            where: {
              userId_organizationId_webinarSessionId: {
                userId: (await prisma.registration.findFirstOrThrow({ where: { webinarSessionId: session.id } }))
                  .userId!,
                organizationId: organization.id,
                webinarSessionId: session.id,
              },
            },
          })
        )?.positionMs ?? 0,
    )
    .toBeGreaterThanOrEqual(124_000);
  await page.locator('#webinarVideo').evaluate(element => {
    const video = element as HTMLVideoElement;
    video.pause();
    video.currentTime = 125;
  });
  await expect(page.locator('#roomNoteTimestamp')).toContainText('02:05');
  await page.locator('#roomNoteBody').fill('Проверить условие о неустойке <script>');
  await page.getByRole('button', { name: 'Сохранить заметку' }).click();
  await expect(page.locator('#roomNotesList')).toContainText('Проверить условие о неустойке <script>');
  await expect(page.locator('#roomNotesList script')).toHaveCount(0);

  const activeRegistration = await prisma.registration.findFirstOrThrow({
    where: { webinarSessionId: session.id },
  });
  const expiredWebinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: author.id,
      slug: `viewer-expired-${suffix}`,
      title: 'Запись с истёкшим сроком',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      publishedAt: new Date(),
    },
  });
  const revokedWebinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: author.id,
      slug: `viewer-revoked-${suffix}`,
      title: 'Вебинар с отозванным доступом',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      publishedAt: new Date(),
    },
  });
  const [expiredSession, revokedSession] = await Promise.all([
    prisma.webinarSession.create({
      data: {
        organizationId: organization.id,
        webinarId: expiredWebinar.id,
        title: expiredWebinar.title,
        scheduledAt: new Date(Date.now() - 14 * 24 * 60 * 60_000),
        durationMinutes: 60,
        replayAvailableHours: 1,
        timezone: 'Europe/Moscow',
      },
    }),
    prisma.webinarSession.create({
      data: {
        organizationId: organization.id,
        webinarId: revokedWebinar.id,
        title: revokedWebinar.title,
        scheduledAt: new Date(Date.now() + 24 * 60 * 60_000),
        durationMinutes: 60,
        timezone: 'Asia/Yekaterinburg',
      },
    }),
  ]);
  await prisma.registration.createMany({
    data: [
      {
        leadId: activeRegistration.leadId,
        webinarSessionId: expiredSession.id,
        organizationId: organization.id,
        webinarId: expiredWebinar.id,
        userId: activeRegistration.userId,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
      {
        leadId: activeRegistration.leadId,
        webinarSessionId: revokedSession.id,
        organizationId: organization.id,
        webinarId: revokedWebinar.id,
        userId: activeRegistration.userId,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'revoked',
        emailVerifiedAt: new Date(),
      },
    ],
  });

  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-detail-mode', 'content');
  await page.locator('#detailFavoriteButton').click();
  await expect(page.locator('#detailFavoriteButton')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detailRegistrationStatus')).toContainText('не меняет правила доступа');

  await page.goto('/crisis_premium/account.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-account-mode', 'content');
  await expect(page.getByRole('heading', { level: 1, name: 'Мои вебинары' })).toBeVisible();
  await expect(page.locator('#accountRecordings')).toContainText(webinar.title);
  await expect(page.locator('#accountWatched')).toContainText(webinar.title);
  await expect(page.locator('#accountWatched')).toContainText('1 заметка');
  await expect(page.locator('#accountSaved')).toContainText(webinar.title);
  await expect(page.locator('#accountRecordings')).toContainText('Europe/Moscow');
  await expect(page.locator('#accountRecordings progress')).toHaveAttribute(
    'aria-label',
    /Прогресс просмотра: [1-9]\d*%/,
  );
  await expect(page.locator('#accountUpcomingEmpty')).toContainText('Нет предстоящих вебинаров');
  await expect(page.locator('#accountUnavailable')).toContainText(expiredWebinar.title);
  await expect(page.locator('#accountUnavailable')).toContainText(revokedWebinar.title);
  await expect(page.locator('#accountUnavailable button[data-action="activate-registration"]')).toHaveCount(0);
  await expect(page.locator('input[name="serviceEmailEnabled"]')).toBeChecked();
  await expect(page.locator('input[name="marketingEmailEnabled"]')).not.toBeChecked();
  await page.locator('input[name="marketingEmailEnabled"]').check();
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.locator('#accountSettingsStatus')).toContainText('Настройки сохранены');
  await expect(page.locator('input[name="serviceEmailEnabled"]')).toBeChecked();
  await expect(
    prisma.viewerNotificationPreference.findFirstOrThrow({
      where: { organizationId: organization.id, marketingEmailEnabled: true },
    }),
  ).resolves.toMatchObject({ serviceEmailEnabled: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Продолжить просмотр' }).first().click();
  await expect(page).toHaveURL(/webinar\.html$/);
  await expect
    .poll(() => page.locator('#webinarVideo').evaluate(element => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThanOrEqual(124);
  await expect(page.locator('#roomNotesList')).toContainText('Проверить условие о неустойке');
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

test('browser analytics retry reuses one versioned operation key without persisting it', async ({ page }) => {
  const deliveries: Array<Record<string, unknown>> = [];
  await page.route('**/api/events', async route => {
    deliveries.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    if (deliveries.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accepted: true,
        replayed: false,
        schemaVersion: 1,
        correlationId: 'e2e-correlation',
      }),
    });
  });

  await page.goto('/crisis_premium/index.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => deliveries.length).toBe(2);
  expect(deliveries[0]).toEqual(deliveries[1]);
  expect(deliveries[0]).toMatchObject({
    schemaVersion: 1,
    eventName: 'page_view',
    source: 'web',
    attributes: {},
  });
  expect(deliveries[0].dedupKey).toMatch(/^web:page_view:[A-Za-z0-9._:-]+$/);
  expect(JSON.stringify(deliveries)).not.toMatch(/email|phone|token|signed.?url|storage.?key/i);
  expect(await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)).not.toContain(
    String(deliveries[0].dedupKey),
  );
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
  const admin = await prisma.adminUser.create({
    data: {
      name: 'E2E Администратор',
      email,
      passwordHash: await hashPassword(password),
      role: 'owner',
      isActive: true,
    },
  });
  const organization = await prisma.organization.create({
    data: { name: 'Организация автора E2E', slug: `admin-author-e2e-${Date.now()}`, status: 'ACTIVE' },
  });
  const author = await prisma.user.create({
    data: {
      emailNormalized: `admin-review-author-${Date.now()}@example.test`,
      displayName: 'Автор для проверки',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: author.id, role: 'AUTHOR', status: 'ACTIVE' },
  });
  const authorProfile = await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: author.id,
      slug: `author-${'a'.repeat(24)}`,
      publicName: 'Анна Автор',
      bio: 'Практикующий юрист с опытом корпоративного и договорного сопровождения бизнеса.',
      specializations: ['Корпоративное право'],
      professionalOrganization: 'Коллегия юристов',
      region: 'Москва',
      experience: 'Более десяти лет сопровождения компаний и арбитражных споров.',
      verificationStatus: 'PENDING',
    },
  });
  const verification = await prisma.authorVerification.create({
    data: {
      profileId: authorProfile.id,
      organizationId: organization.id,
      submittedByUserId: author.id,
      status: 'PENDING',
    },
  });
  await prisma.authorVerificationEvidence.create({
    data: {
      profileId: authorProfile.id,
      organizationId: organization.id,
      verificationId: verification.id,
      kind: 'LICENSE',
      originalName: 'qualification.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 14,
      checksumSha256: 'b'.repeat(64),
      content: Buffer.from('%PDF-1.7\n%%EOF'),
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
  await expect(page.locator('#authorVerificationSection')).toBeVisible();
  await expect(page.locator('#authorVerificationList')).toContainText('Анна Автор');
  await expect(page.locator('#authorVerificationList')).toContainText('qualification.pdf');
  await page.setViewportSize({ width: 320, height: 760 });
  const reviewPanelOverflow = await page
    .locator('#authorVerificationSection')
    .evaluate(element => element.scrollWidth - element.clientWidth);
  expect(reviewPanelOverflow).toBeLessThanOrEqual(1);
  const reviewStatusSelect = page.locator(`#verification-status-${verification.id}`);
  await expect(reviewStatusSelect).toHaveAccessibleName(/Решение/);
  await reviewStatusSelect.selectOption('NEEDS_INFO');
  const publicComment = page.locator(`#verification-public-${verification.id}`);
  await expect(publicComment).toHaveAccessibleName(/Комментарий автору/);
  await publicComment.fill('Добавьте сведения о судебной практике.');
  const internalReason = page.locator(`#verification-internal-${verification.id}`);
  await expect(internalReason).toHaveAccessibleName(/Внутренняя причина/);
  await internalReason.fill('Недостаточно деталей для решения.');
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect
    .poll(async () => (await prisma.authorVerification.findUniqueOrThrow({ where: { id: verification.id } })).status)
    .toBe('NEEDS_INFO');
  await expect(prisma.authorVerification.findUniqueOrThrow({ where: { id: verification.id } })).resolves.toMatchObject({
    reviewedByAdminUserId: admin.id,
    publicComment: 'Добавьте сведения о судебной практике.',
    internalReason: 'Недостаточно деталей для решения.',
  });
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

  const confirmationUrl = await deliverNextEmailUrl();
  await page.goto(confirmationUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/account\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Мои вебинары' })).toBeVisible();
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

  await page.getByRole('button', { name: 'Открыть страницу сессии' }).click();
  await expect(page).toHaveURL(/webinar\.html$/);
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

test('published room content, captions and player controls stay consistent and keyboard accessible', async ({
  page,
}) => {
  await installDeterministicMediaClock(page);
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    HTMLElement.prototype.requestFullscreen = function requestFullscreen() {
      fullscreenElement = document.getElementById('videoPlayerContainer');
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    document.exitFullscreen = function exitFullscreen() {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
  });

  const mediaAsset = await prisma.mediaAsset.create({
    data: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      webinarId: DEFAULT_WEBINAR_ID,
      createdByUserId: DEFAULT_SYSTEM_OWNER_USER_ID,
      version: 1,
      status: 'VALIDATING',
      originalFileName: 'published-room.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1_024n,
      storageKey: `e2e/published-room-${Date.now()}.mp4`,
      durationSeconds: 3_860,
    },
  });
  await prisma.webinar.update({
    where: { id: DEFAULT_WEBINAR_ID },
    data: { currentMediaAssetId: mediaAsset.id, mediaStatus: 'READY', transcriptStatus: 'PUBLISHED' },
  });
  const draft = await prisma.transcript.create({
    data: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      webinarId: DEFAULT_WEBINAR_ID,
      mediaAssetId: mediaAsset.id,
      createdByUserId: DEFAULT_SYSTEM_OWNER_USER_ID,
      version: 1,
      status: 'DRAFT',
      segments: {
        create: {
          orderIndex: 0,
          startMs: 0,
          endMs: 500,
          speaker: 'Черновик',
          text: 'СЕКРЕТНЫЙ ЧЕРНОВИК',
        },
      },
    },
  });
  const published = await prisma.transcript.create({
    data: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      webinarId: DEFAULT_WEBINAR_ID,
      mediaAssetId: mediaAsset.id,
      createdByUserId: DEFAULT_SYSTEM_OWNER_USER_ID,
      reviewedByUserId: DEFAULT_SYSTEM_OWNER_USER_ID,
      version: 2,
      revision: 3,
      status: 'PUBLISHED',
      reviewedAt: new Date(),
      publishedAt: new Date(),
      segments: {
        create: [
          {
            orderIndex: 0,
            startMs: 0,
            endMs: 500,
            speaker: 'Эксперт АСПБ',
            text: 'Проверенное введение в тему.',
          },
          {
            orderIndex: 1,
            startMs: 500,
            endMs: 1_500,
            speaker: 'Эксперт АСПБ',
            text: 'Субсидиарная ответственность: основные признаки.',
          },
        ],
      },
    },
  });
  await prisma.webinarChapter.createMany({
    data: [
      {
        organizationId: DEFAULT_ORGANIZATION_ID,
        webinarId: DEFAULT_WEBINAR_ID,
        transcriptId: published.id,
        startMs: 500,
        title: 'Основные признаки',
        orderIndex: 0,
      },
      {
        organizationId: DEFAULT_ORGANIZATION_ID,
        webinarId: DEFAULT_WEBINAR_ID,
        transcriptId: published.id,
        startMs: 999_000,
        title: 'За текущим моментом премьеры',
        orderIndex: 1,
      },
    ],
  });
  await prisma.webinarSource.create({
    data: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      webinarId: DEFAULT_WEBINAR_ID,
      type: 'OFFICIAL_SOURCE',
      title: 'Официальный источник E2E',
      url: 'https://example.test/e2e-source',
      accessedAt: new Date('2026-08-21T00:00:00.000Z'),
      orderIndex: 0,
    },
  });

  const { exchangeToken, session } = await createExchangeRegistration(`published-room-${Date.now()}@aspb.ru`);
  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);
  const cookieBanner = page.getByRole('dialog', { name: 'Уведомление об использовании cookie' });
  if (await cookieBanner.isVisible()) {
    await cookieBanner.getByRole('button', { name: 'Отклонить' }).click();
  }

  await expect(page.locator('#roomTranscriptPanel')).toContainText('Проверенное введение');
  await expect(page.locator('#roomTranscriptPanel')).not.toContainText('СЕКРЕТНЫЙ ЧЕРНОВИК');
  await expect(page.locator('#roomTranscriptVersion')).toHaveText('Версия 2');
  await expect(page.locator('#roomChaptersList .room-chapter-item')).toHaveCount(2);
  await expect(page.locator('#roomMaterialsPanel')).toContainText('Официальный источник E2E');
  await expect(page.locator('#roomMaterialsPanel')).toContainText('Официальный источник');
  await page.locator('#webinarVideo').dispatchEvent('waiting');
  await expect(page.locator('#playerStateIndicator')).toHaveText('Видео загружается…');
  await page.locator('#webinarVideo').dispatchEvent('canplay');
  await expect(page.locator('#playerStateIndicator')).toBeHidden();

  const search = page.locator('#roomTranscriptSearch');
  await search.fill('субсидиарная');
  await expect(page.locator('#roomTranscriptResultCount')).toHaveText('Найдено результатов: 1');
  await search.press('ArrowDown');
  await expect(page.locator('#roomTranscriptResults .room-transcript-seek')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#roomContentActionStatus')).toContainText('Переходим к 00:00');
  const transcriptSeek = await page.locator('#customSeekBarContainer').evaluate((element: HTMLElement) => ({
    live: Number(element.dataset.livePosition || 0),
    viewer: Number(element.dataset.viewerPosition || 0),
  }));
  expect(transcriptSeek.viewer).toBeGreaterThanOrEqual(0);
  expect(transcriptSeek.viewer).toBeLessThanOrEqual(transcriptSeek.live + 0.5);

  const lateChapter = page.getByRole('button', { name: /За текущим моментом премьеры/ });
  await lateChapter.click();
  const liveBounded = await page.locator('#customSeekBarContainer').evaluate((element: HTMLElement) => ({
    live: Number(element.dataset.livePosition || 0),
    viewer: Number(element.dataset.viewerPosition || 0),
  }));
  expect(liveBounded.viewer).toBeLessThanOrEqual(liveBounded.live + 0.5);

  await page.locator('#videoPlayerContainer').hover();
  const captions = page.locator('#customCaptionsBtn');
  await expect(captions).toBeEnabled();
  await captions.focus();
  await page.keyboard.press('Enter');
  await expect(captions).toHaveAttribute('aria-pressed', 'true');

  const playPause = page.locator('#customPlayPauseBtn');
  await playPause.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.locator('#webinarVideo').evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(false);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('#webinarVideo').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);

  const mute = page.locator('#customMuteBtn');
  await mute.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('#webinarVideo').evaluate((video: HTMLVideoElement) => video.muted)).toBe(false);

  const seek = page.locator('#customSeekBarContainer');
  await seek.focus();
  const beforeKeyboardSeek = await page
    .locator('#webinarVideo')
    .evaluate((video: HTMLVideoElement) => video.currentTime);
  await page.keyboard.press('ArrowLeft');
  const afterKeyboardSeek = await page
    .locator('#webinarVideo')
    .evaluate((video: HTMLVideoElement) => video.currentTime);
  expect(afterKeyboardSeek).toBeLessThanOrEqual(beforeKeyboardSeek);

  const fullscreen = page.locator('#customFullscreenBtn');
  await fullscreen.focus();
  await page.keyboard.press('Enter');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Выйти из полноэкранного режима');
  await page.keyboard.press('Enter');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Открыть видео на весь экран');

  const captionsResponse = await page.request.get(`/api/media/webinar/${session.id}/captions/${published.id}`);
  expect(captionsResponse.ok()).toBeTruthy();
  expect(await captionsResponse.text()).not.toContain('СЕКРЕТНЫЙ ЧЕРНОВИК');
  expect(draft.id).not.toBe(published.id);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('player renders safe processing, error and unavailable states', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`media-states-${Date.now()}@aspb.ru`);
  let mediaState: 'processing' | 'error' | 'unavailable' = 'processing';
  await page.route('**/api/webinar/timeline/session/current', async route => {
    const upstream = await route.fetch();
    const payload = await upstream.json();
    await route.fulfill({
      response: upstream,
      json: {
        ...payload,
        video: {
          ...(payload.video || {}),
          state: mediaState,
          expected: false,
          src: null,
          hlsSrc: null,
        },
      },
    });
  });

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#videoProcessing')).toBeVisible();
  await expect(page.locator('#videoProcessing')).toContainText('Видео обрабатывается');

  mediaState = 'error';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#videoFallback')).toBeVisible();
  await expect(page.locator('#videoFallback')).toContainText('Не удалось подготовить запись');

  mediaState = 'unavailable';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#videoFallback')).toBeVisible();
  await expect(page.locator('#videoFallback')).toContainText('Запись для этой сессии пока недоступна');
});

test('registered participant does not see registration CTA in landing header', async ({ page }) => {
  const { exchangeToken } = await createExchangeRegistration(`landing-nav-${Date.now()}@aspb.ru`);

  await page.goto(`/crisis_premium/webinar.html?token=${exchangeToken}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/webinar\.html$/);

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/crisis_premium/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header a[href*="register.html"]')).toHaveCount(0);
  await expect(page.locator('header a[data-participant-cta="true"]')).toContainText('Мои вебинары');
  await expect(page.locator('header a[data-participant-cta="true"]')).toHaveAttribute('href', /account\.html/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
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

test('tenant moderator hides a message with a reason and keeps the screen usable at 320px', async ({ page }) => {
  let hidden = false;
  let revision = 0;
  let mutationPayload: Record<string, unknown> | null = null;
  await page.route('**/api/v1/auth/session', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        authenticated: true,
        activeOrganizationId: 'org_e2e',
        memberships: [{ organizationId: 'org_e2e', role: 'MODERATOR' }],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessions: [
          {
            id: 'session_e2e',
            webinarId: 'webinar_e2e',
            webinarTitle: 'Безопасный чат',
            title: 'Сессия модерации',
            scheduledAt: '2026-08-21T18:00:00.000Z',
            timezone: 'Europe/Moscow',
            lifecycleStatus: 'SCHEDULED',
            messageCount: 1,
            hiddenCount: hidden ? 1 : 0,
            blockedRegistrationCount: 0,
          },
        ],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/messages', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        session: {
          id: 'session_e2e',
          webinarId: 'webinar_e2e',
          title: 'Сессия модерации',
          scheduledAt: '2026-08-21T18:00:00.000Z',
          timezone: 'Europe/Moscow',
        },
        messages: [
          {
            id: 'message_e2e',
            registrationId: 'registration_e2e',
            type: 'PARTICIPANT',
            authorName: 'Участник',
            authorRole: null,
            message: 'Сообщение с персональными данными',
            isSynthetic: false,
            visibleAt: '2026-08-21T18:01:00.000Z',
            hiddenAt: hidden ? '2026-08-21T18:02:00.000Z' : null,
            hiddenReason: hidden ? 'Персональные данные' : null,
            hiddenBy: hidden ? 'Модератор' : null,
            moderationRevision: revision,
            registrationChatBlockedAt: null,
            registrationChatBlockedReason: null,
          },
        ],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/questions?queue=*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, queue: 'new', questions: [] }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/messages/message_e2e', async route => {
    mutationPayload = route.request().postDataJSON();
    hidden = true;
    revision += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        message: {
          id: 'message_e2e',
          hiddenAt: '2026-08-21T18:02:00.000Z',
          hiddenReason: 'Персональные данные',
          moderationRevision: revision,
        },
      }),
    });
  });

  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/crisis_premium/moderation.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Модерация вебинара', level: 1 })).toBeVisible();
  await expect(page.getByText('Сообщение с персональными данными')).toBeVisible();
  await expect(page.getByText('Участник', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: 'Скрыть сообщение' }).click();
  await expect(page.locator('#moderationActionStatus')).toContainText('Укажите причину');
  await expect(page.locator('[id^="moderationReason-"]')).toBeFocused();
  await page.locator('[id^="moderationReason-"]').fill('Персональные данные');
  await page.getByRole('button', { name: 'Скрыть сообщение' }).press('Enter');
  await expect(page.locator('#moderationActionStatus')).toContainText('Сообщение скрыто');
  expect(mutationPayload).toEqual({ action: 'HIDE', reason: 'Персональные данные', expectedRevision: 0 });
  await expect(page.getByText('Скрыто', { exact: true })).toBeVisible();
  const overflowingElements = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.right > window.innerWidth + 1 || rect.left < -1;
      })
      .map(element => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        width: element.getBoundingClientRect().width,
      })),
  );
  expect(overflowingElements).toEqual([]);
});

test('tenant moderator reviews a grounded question draft by keyboard at 320px', async ({ page }) => {
  let revision = 0;
  let status = 'NEW';
  let suggestion: Record<string, unknown> | null = null;
  let generatePayload: Record<string, unknown> | null = null;
  let reviewPayload: Record<string, unknown> | null = null;
  await page.route('**/api/v1/auth/session', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        authenticated: true,
        activeOrganizationId: 'org_e2e',
        memberships: [{ organizationId: 'org_e2e', role: 'MODERATOR' }],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessions: [
          {
            id: 'session_e2e',
            webinarId: 'webinar_e2e',
            webinarTitle: 'Основанная модерация',
            title: 'Сессия вопросов',
            scheduledAt: '2026-08-21T18:00:00.000Z',
            timezone: 'Europe/Moscow',
            lifecycleStatus: 'SCHEDULED',
            messageCount: 0,
            hiddenCount: 0,
            blockedRegistrationCount: 0,
          },
        ],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/messages', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        session: {
          id: 'session_e2e',
          webinarId: 'webinar_e2e',
          title: 'Сессия вопросов',
          scheduledAt: '2026-08-21T18:00:00.000Z',
          timezone: 'Europe/Moscow',
        },
        messages: [],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/questions?queue=*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        queue: 'new',
        questions: [
          {
            id: 'question_e2e',
            registrationId: 'registration_e2e',
            text: 'Какие признаки субсидиарной ответственности названы?',
            participantLabel: 'Участник',
            showToParticipants: false,
            status,
            priority: 'NORMAL',
            revision,
            repeatCount: 2,
            createdAt: '2026-08-21T18:01:00.000Z',
            suggestion,
          },
        ],
      }),
    });
  });
  await page.route('**/api/v1/moderation/sessions/session_e2e/questions/question_e2e/suggestions', async route => {
    generatePayload = route.request().postDataJSON();
    revision = 1;
    status = 'IN_REVIEW';
    suggestion = {
      id: 'suggestion_e2e',
      status: 'PENDING',
      revision: 1,
      answer: 'В опубликованной расшифровке найден связанный фрагмент.',
      outcome: 'GROUNDED',
      handoffRequired: false,
      grounding: {
        type: 'transcript',
        transcriptId: 'transcript_e2e',
        transcriptVersion: 3,
        segmentId: 'segment_e2e',
        timestampSeconds: 42,
        label: '0:42',
      },
      createdAt: '2026-08-21T18:02:00.000Z',
      reviewedAt: null,
      publishedChatMessageId: null,
    };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, suggestion }),
    });
  });
  await page.route(
    '**/api/v1/moderation/sessions/session_e2e/questions/question_e2e/suggestions/suggestion_e2e/review',
    async route => {
      reviewPayload = route.request().postDataJSON();
      revision = 2;
      status = 'RESOLVED';
      suggestion = {
        ...suggestion,
        status: 'ACCEPTED',
        reviewedAt: '2026-08-21T18:03:00.000Z',
        publishedChatMessageId: 'message_e2e',
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          suggestion,
          question: { id: 'question_e2e', moderationStatus: status, moderationRevision: revision },
        }),
      });
    },
  );

  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/crisis_premium/moderation.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Очередь вопросов' })).toBeVisible();
  await expect(page.getByText('Повторяется: 2')).toBeVisible();
  await page.getByRole('button', { name: 'Подготовить основанный черновик' }).press('Enter');
  await expect(page.getByText('Черновик AI-модератора', { exact: true })).toBeVisible();
  await expect(page.getByText(/опубликованная расшифровка, версия 3, таймкод 0:42/)).toBeVisible();
  expect(generatePayload).toEqual({ expectedRevision: 0 });

  await page.getByRole('button', { name: 'Опубликовать после проверки' }).press('Enter');
  await expect(page.locator('#moderationQuestionActionStatus')).toContainText('Укажите причину');
  await expect(page.locator('#questionReason-question_e2e')).toBeFocused();
  await page.locator('#questionReason-question_e2e').fill('Основание и формулировка проверены');
  await page.getByRole('button', { name: 'Опубликовать после проверки' }).press('Enter');
  await expect(page.locator('#moderationQuestionActionStatus')).toContainText('опубликован');
  expect(reviewPayload).toEqual({
    action: 'PUBLISH',
    reason: 'Основание и формулировка проверены',
    expectedQuestionRevision: 1,
  });
  await expect(page.locator('.moderation-message-state', { hasText: 'Решён' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подготовить основанный черновик' })).toHaveCount(0);
  const overflowingElements = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.right > window.innerWidth + 1 || rect.left < -1;
      })
      .map(element => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        width: element.getBoundingClientRect().width,
      })),
  );
  expect(overflowingElements).toEqual([]);
});
