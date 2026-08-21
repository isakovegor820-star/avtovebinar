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
  DEFAULT_SYSTEM_OWNER_USER_ID,
  DEFAULT_WEBINAR_ID,
} from '../../src/lib/tenancy/constants.js';
import { hashWebinarAccessEmail } from '../../src/lib/tenancy/webinarAccess.js';
import { runMediaJobOnce } from '../../src/lib/tenancy/mediaPipeline.js';
import { runContentJobOnce } from '../../src/lib/tenancy/transcripts.js';

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, email_outbox_dead_letters, user_auth_tokens, user_sessions, user_auth_email_jobs, author_verification_evidence, author_verifications, author_profiles, organization_invitations, organization_invitation_tokens, organization_invitation_email_jobs, webinar_access_invitation_email_jobs, webinar_access_grant_tokens, webinar_access_grants, chat_scenario_messages, chat_scenarios, telegram_broadcast_jobs, telegram_broadcast_recipients, telegram_broadcast_dead_letters, telegram_news_posts, webinar_commands, webinar_slug_aliases, webinar_sources, webinar_practice_areas, webinar_schedules, webinars, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages, consent_records, legal_acceptances, retention_runs CASCADE;',
  );
  await prisma.organizationMembership.deleteMany({
    where: { userId: { not: DEFAULT_SYSTEM_OWNER_USER_ID } },
  });
  await prisma.organization.deleteMany({ where: { id: { not: DEFAULT_ORGANIZATION_ID } } });
  await prisma.user.deleteMany({ where: { id: { not: DEFAULT_SYSTEM_OWNER_USER_ID } } });
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
  await page.locator('#creatorJurisdiction').selectOption(jurisdiction.id);
  await page.locator('#creatorAudienceLevel').selectOption('PRACTITIONER');
  await page.locator('#creatorPrimaryArea').selectOption(rootArea.id);
  await page.locator('#creatorSpecialization').selectOption(specialization.id);
  await page.locator('#creatorTargetAudience').fill('Юристы, руководители и владельцы малого бизнеса');
  await page.locator('#creatorFormat').selectOption('PREMIERE');
  await page.locator('#creatorDuration').fill('60');
  await page.locator('#creatorFreshness').selectOption('CURRENT');
  await page.locator('#creatorCurrentAsOf').fill('2026-08-21');
  await page
    .locator('#creatorDisclaimer')
    .fill('Материал носит информационный характер и не заменяет индивидуальную юридическую консультацию.');
  await page
    .locator('#creatorSyntheticDisclosure')
    .fill('Подготовленные сообщения явно отмечены и не являются репликами реальных зрителей.');
  await page.locator('#creatorSaveButton').click();
  await expect(page.locator('#creatorMetadataStatus')).toContainText('Сведения сохранены');

  await page.locator('#creatorSourceTitle').fill('Официальный источник по договорному праву');
  await page.locator('#creatorSourceUrl').fill('https://example.org/legal-source');
  await page.locator('#creatorSourceButton').click();
  await expect(page.locator('#creatorSourcesList')).toContainText('Официальный источник по договорному праву');

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
  expect(uploadedPartNumbers).toEqual([1, 2, 2]);
  await expect(runMediaJobOnce(prisma)).resolves.toMatchObject({ checked: 1, ready: 1 });
  await page.locator('#creatorMediaRefreshButton').click();
  await expect(page.locator('#creatorMediaSummary')).toContainText('Готово');
  await page.locator('#creatorMediaActivateButton').click();
  await expect(page.locator('#creatorUploadStatus')).toContainText('включена');

  await page.locator('#creatorTranscriptGenerateButton').click();
  await expect.poll(async () => prisma.contentJob.count({ where: { type: 'TRANSCRIBE', status: 'PENDING' } })).toBe(1);
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

  await page.locator('#creatorScenarioAddButton').click();
  const scenarioRow = page.locator('.creator-scenario-row').first();
  await scenarioRow.locator('[data-field="offsetSeconds"]').fill('120');
  await scenarioRow.locator('[data-field="kind"]').selectOption('PREPARED_QUESTION');
  await scenarioRow.locator('[data-field="authorLabel"]').fill('Подготовленный вопрос');
  await scenarioRow
    .locator('[data-field="text"]')
    .fill('Какие условия договора чаще всего создают риск для предпринимателя?');
  await page.locator('#creatorScenarioSaveButton').click();
  await expect(page.locator('#creatorScenarioStatus')).toContainText('сохранён как черновик');
  await page.locator('#creatorScenarioPublishButton').click();
  await expect(page.locator('#creatorScenarioStatus')).toContainText('Сценарий опубликован');

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
  await page.getByRole('link', { name: webinar.title }).click();
  await expect(page.locator('body')).toHaveAttribute('data-detail-mode', 'content');
  await expect(page.locator('#detailTitle')).toBeVisible();
  await expect(page.locator('#detailTitle')).toHaveText(webinar.title);
  await expect(page.locator('#detailAuthor')).toHaveText('Мария Юристова');
  await expect(page.locator('#detailSources')).toContainText('Официальный источник по договорному праву');
  await expect(page.locator('#detailRegistrationButton')).toBeDisabled();
  await expect(page.locator('#detailRegistrationHint')).toContainText('не отправляет заявку');
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
