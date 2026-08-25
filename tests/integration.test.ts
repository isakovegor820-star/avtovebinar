process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { execSync } from 'node:child_process';
import { app } from '../src/app.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';
import {
  EMAIL_JOB_REMINDER,
  enqueueRegistrationEmail,
  enqueueReminderEmail,
  runEmailOutboxJobOnce,
} from '../src/lib/emailOutbox.js';
import { runReplayFollowupJobOnce, runTelegramLiveJobOnce } from '../src/lib/reminders.js';
import { handleParticipantTelegramUpdate } from '../src/lib/telegramParticipantBot.js';
import { runTelegramNewsJobOnce } from '../src/lib/telegramNews.js';
import { getDailyBroadcastDate } from '../src/lib/time.js';
import { findOrCreateWebinarSession } from '../src/lib/webinarSessions.js';
import { encryptMfaSecret, generateTotp } from '../src/lib/mfa.js';
import {
  MARKETING_EMAIL_CONSENT,
  MARKETING_TELEGRAM_CONSENT,
  PERSONAL_DATA_CONSENT,
  consentEvidenceData,
  legalAcceptanceEvidenceData,
} from '../src/lib/consentDocuments.js';
import { applyRetentionPolicy, RETENTION_POLICY_VERSION } from '../src/lib/retention.js';
import { buildUnsubscribeToken } from '../src/lib/unsubscribe.js';
import {
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_BINDING_VERSION,
  TELEGRAM_START_TOKEN_PURPOSE,
} from '../src/lib/roomLinks.js';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_SYSTEM_OWNER_USER_ID } from '../src/lib/tenancy/constants.js';
import { resolveTenantContext } from '../src/lib/tenancy/context.js';
import {
  removeOrganizationMembership,
  updateOrganizationMembershipRole,
} from '../src/lib/tenancy/membershipService.js';
import {
  getTenantWebinarSession,
  updateTenantWebinarSessionTitle,
} from '../src/lib/tenancy/webinarSessionRepository.js';

type TestAgent = ReturnType<typeof request.agent>;

async function getCsrfToken(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  expect(response.body.csrfToken).toEqual(expect.any(String));
  return response.body.csrfToken as string;
}

function getExchangeTokenFromUrl(value: string) {
  const url = new URL(value);
  return url.searchParams.get('token') || new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
}

async function deliverPendingEmails(now = new Date()) {
  const deliveries: Array<{ kind: string; input: any }> = [];
  const capture = (kind: string) => async (input: any) => {
    deliveries.push({ kind, input });
    return { sent: true, mode: 'send' as const };
  };
  const result = await runEmailOutboxJobOnce(now, {
    sendRegistrationEmail: capture('registration'),
    sendParticipantLoginEmail: capture('participant_login'),
    sendReminderEmail: capture('reminder'),
  });
  return { deliveries, result };
}

function getCookieValue(response: { headers: Record<string, string | string[] | number | undefined> }, name: string) {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  const cookie = cookies.find(item => item.startsWith(`${name}=`));
  return cookie?.split(';')[0]?.slice(name.length + 1) ?? null;
}

function setTestNow(value: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(value);
}

async function loginAdmin(role: string, email: string) {
  const password = `Test${role}Password123`;
  const mfaSecret = 'JBSWY3DPEHPK3PXP';
  const admin = await prisma.adminUser.create({
    data: {
      name: email,
      email,
      passwordHash: await hashPassword(password),
      role,
      isActive: true,
      mfaSecretEncrypted: encryptMfaSecret(mfaSecret),
      mfaEnabledAt: new Date(),
    },
  });
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  const loginResponse = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', csrfToken)
    .send({
      login: email,
      password,
      otp: generateTotp(mfaSecret),
    });
  expect(loginResponse.status).toBe(200);
  return { admin, agent, csrfToken };
}

async function createRegisteredParticipant(email: string, scheduledAt = new Date(Date.now() + 60 * 60 * 1000)) {
  const webinarSession = await prisma.webinarSession.create({
    data: {
      title: 'Passwordless access webinar',
      scheduledAt,
      status: scheduledAt <= new Date() ? 'live' : 'scheduled',
      videoDurationSeconds: 3860,
    },
  });

  const lead = await prisma.lead.create({
    data: {
      name: 'Passwordless Participant',
      phone: '+79990000002',
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
      webinarSessionId: webinarSession.id,
      accessTokenHash: hashToken(createAccessToken()),
      status: 'registered',
      emailVerifiedAt: new Date(),
    },
  });

  return { lead, registration, webinarSession };
}

async function createTenantFixture(input: {
  slug: string;
  email: string;
  role?: 'OWNER' | 'AUTHOR' | 'MODERATOR' | 'CRM_MANAGER' | 'ANALYST' | 'AUDITOR';
}) {
  const organization = await prisma.organization.create({
    data: { name: input.slug.toUpperCase(), slug: input.slug, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: input.email,
      displayName: input.email,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: input.role ?? 'OWNER',
      status: 'ACTIVE',
    },
  });
  return { organization, user, membership };
}

async function addHumanOwner(
  organizationId: string,
  emailNormalized: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE',
) {
  const user = await prisma.user.create({
    data: {
      emailNormalized,
      displayName: emailNormalized,
      status,
      emailVerifiedAt: status === 'ACTIVE' ? new Date() : null,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });
  return { user, membership };
}

beforeAll(async () => {
  // Guard the target and verify that the test schema is reproducible from committed migrations.
  execSync('node scripts/assert-test-database.mjs', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'ignore',
  });
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'ignore',
  });
}, 30_000);

beforeEach(async () => {
  Object.assign(env, {
    TELEGRAM_NOTIFY_MODE: 'log',
    TELEGRAM_ADMIN_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
    TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: undefined,
    TELEGRAM_CONSULTANT_BOT_TOKEN: '',
    TELEGRAM_MANUAL_BROADCAST: 'off',
    EMAIL_MODE: 'log',
  });
  // Truncate tables to guarantee absolute test isolation
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, email_outbox_dead_letters, telegram_broadcast_jobs, telegram_broadcast_recipients, telegram_broadcast_dead_letters, telegram_news_posts, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages, consent_records, legal_acceptances, retention_runs, worker_subsystem_health CASCADE;',
  );
  await prisma.organizationMembership.deleteMany({
    where: { userId: { not: DEFAULT_SYSTEM_OWNER_USER_ID } },
  });
  await prisma.organization.deleteMany({ where: { id: { not: DEFAULT_ORGANIZATION_ID } } });
  await prisma.user.deleteMany({ where: { id: { not: DEFAULT_SYSTEM_OWNER_USER_ID } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('critical path integration scenarios', () => {
  it('runs the full critical path integration scenario', async () => {
    const userAgent = request.agent(app);
    env.EMAIL_MODE = 'send';
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));

    // 0. Seed a default admin user. Webinar session will be created automatically by /api/register
    // through findOrCreateWebinarSession(getDailyBroadcastDate(now)).
    // We must NOT pre-create a webinar session here, otherwise /api/register may create a second
    // one with a different scheduledAt, and later updateMany() will violate the unique constraint
    // on scheduled_at.
    const adminPasswordHash = await hashPassword('TestAdminPassword123');
    const adminMfaSecret = 'JBSWY3DPEHPK3PXP';
    const admin = await prisma.adminUser.create({
      data: {
        name: 'testadmin',
        email: 'testadmin@aspb.ru',
        passwordHash: adminPasswordHash,
        role: 'admin',
        isActive: true,
        mfaSecretEncrypted: encryptMfaSecret(adminMfaSecret),
        mfaEnabledAt: new Date(),
      },
    });

    // 1. REGISTRATION (POST /api/register)
    const userCsrfToken = await getCsrfToken(userAgent);
    const registerResponse = await userAgent.post('/api/register').set('x-csrf-token', userCsrfToken).send({
      name: 'Алексей Тестовый',
      phone: '+79998887766',
      email: 'alex.test@aspb.ru',
      city: 'Москва',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
      utmSource: 'yandex',
      utmMedium: 'cpc',
    });

    expect(registerResponse.status).toBe(202);
    expect(registerResponse.body.ok).toBe(true);
    expect(registerResponse.body.token).toBeUndefined();
    expect(registerResponse.body.verificationRequired).toBe(true);
    expect(registerResponse.body.registration).toBeUndefined();
    expect(getCookieValue(registerResponse, 'aspb_room_token')).toBeNull();

    const initialEmailJobs = await prisma.emailOutboxJob.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(initialEmailJobs.length).toBe(1);
    expect(initialEmailJobs[0].type).toBe('registration_confirmation');
    expect(initialEmailJobs[0].status).toBe('pending');
    expect(initialEmailJobs[0].webinarUrl).toBe('generated-at-delivery://email-link');
    expect(initialEmailJobs[0].partnerUrl).toBeNull();
    const pendingRegistration = await prisma.registration.findFirstOrThrow({
      where: { lead: { email: 'alex.test@aspb.ru' } },
      include: { lead: true },
    });
    expect(pendingRegistration).toMatchObject({
      status: 'pending_verification',
      emailVerifiedAt: null,
      lead: {
        consent: false,
        marketingConsent: false,
        marketingEmailConsent: false,
        marketingTelegramConsent: false,
      },
    });
    const pendingConsentEvidence = await prisma.consentRecord.findMany({
      where: { registrationId: pendingRegistration.id, action: 'pending_verification' },
      orderBy: { id: 'asc' },
    });
    expect(pendingConsentEvidence).toHaveLength(3);

    const initialDeliveryRun = await deliverPendingEmails(new Date());
    expect(initialDeliveryRun.result.sent).toBe(1);
    const initialDelivery = initialDeliveryRun.deliveries.find(delivery => delivery.kind === 'registration');
    expect(initialDelivery?.input.webinarUrl).toContain('/crisis_premium/webinar.html#token=');
    expect(initialDelivery?.input.partnerUrl).toContain('/crisis_premium/webinar.html#token=');
    const initialExchangeToken = getExchangeTokenFromUrl(initialDelivery?.input.webinarUrl ?? '');
    if (!initialExchangeToken) throw new Error('Expected registration confirmation token');
    vi.setSystemTime(new Date('2026-06-11T12:01:00.000Z'));
    const initialExchangeResponse = await userAgent
      .post('/api/registration/exchange')
      .set('x-csrf-token', userCsrfToken)
      .send({ token: initialExchangeToken });
    expect(initialExchangeResponse.status).toBe(200);
    const firstRoomToken = getCookieValue(initialExchangeResponse, 'aspb_room_token');
    expect(firstRoomToken).toEqual(expect.any(String));
    await expect(
      prisma.registration.findUniqueOrThrow({ where: { id: pendingRegistration.id } }),
    ).resolves.toMatchObject({
      status: 'registered',
      emailVerifiedAt: expect.any(Date),
    });

    // Check lead insertion
    const lead = await prisma.lead.findUnique({
      where: { email: 'alex.test@aspb.ru' },
    });
    expect(lead).toBeDefined();
    expect(lead?.name).toBe('Алексей Тестовый');
    expect(lead?.marketingConsent).toBe(true);
    expect(lead?.marketingEmailConsent).toBe(true);
    expect(lead?.marketingTelegramConsent).toBe(true);
    const grantConsentEvidence = await prisma.consentRecord.findMany({
      where: { leadId: lead?.id, action: 'grant' },
      orderBy: { id: 'asc' },
    });
    expect(grantConsentEvidence).toHaveLength(3);
    expect(grantConsentEvidence.every(record => record.sourceForm === '/api/registration/exchange')).toBe(true);
    expect(grantConsentEvidence.every(record => record.occurredAt > pendingConsentEvidence[0].occurredAt)).toBe(true);
    await expect(
      prisma.consentRecord.count({ where: { leadId: lead?.id, action: 'pending_verification' } }),
    ).resolves.toBe(3);
    await expect(prisma.legalAcceptance.count({ where: { leadId: lead?.id } })).resolves.toBe(1);

    // Re-submitting the same form for the same webinar refreshes access but does not create a duplicate registration.
    const repeatRegisterResponse = await userAgent.post('/api/register').set('x-csrf-token', userCsrfToken).send({
      name: 'Алексей Тестовый',
      phone: '+79998887766',
      email: 'alex.test@aspb.ru',
      city: 'Москва',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
      utmSource: 'yandex',
      utmMedium: 'cpc',
    });

    expect(repeatRegisterResponse.status).toBe(201);
    expect(repeatRegisterResponse.body.ok).toBe(true);
    expect(repeatRegisterResponse.body.registration.id).toBeDefined();

    const registrationsAfterRepeat = await prisma.registration.findMany({
      where: { leadId: lead?.id },
    });
    expect(registrationsAfterRepeat.length).toBe(1);
    expect(registrationsAfterRepeat[0].id).toBe(repeatRegisterResponse.body.registration.id);

    const accessTokenCount = await prisma.registrationToken.count({
      where: { registrationId: registrationsAfterRepeat[0].id },
    });
    // Consuming one confirmation link revokes every sibling registration link.
    // Only the two participant sessions plus the new Telegram start token remain
    // until the repeat email job mints fresh delivery-time links.
    expect(accessTokenCount).toBe(3);

    const tokenPurposes = await prisma.registrationToken.findMany({
      where: { registrationId: registrationsAfterRepeat[0].id },
      select: { purpose: true },
      orderBy: { purpose: 'asc' },
    });
    expect(tokenPurposes.filter(item => item.purpose === ROOM_SESSION_TOKEN_PURPOSE).length).toBe(2);
    expect(tokenPurposes.filter(item => item.purpose === 'registration').length).toBe(0);
    expect(tokenPurposes.filter(item => item.purpose === TELEGRAM_START_TOKEN_PURPOSE).length).toBe(1);

    if (!firstRoomToken) throw new Error('Expected initial room session cookie');
    const oldSessionAccessResponse = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', [`aspb_room_token=${firstRoomToken}`]);
    expect(oldSessionAccessResponse.status).toBe(200);
    expect(oldSessionAccessResponse.body.lead.email).toBe('alex.test@aspb.ru');

    const activeConfirmationJobsAfterRepeat = await prisma.emailOutboxJob.findMany({
      where: {
        registrationId: registrationsAfterRepeat[0].id,
        type: 'registration_confirmation',
        status: { in: ['pending', 'failed'] },
      },
    });
    expect(activeConfirmationJobsAfterRepeat.length).toBe(1);
    expect(activeConfirmationJobsAfterRepeat[0].webinarUrl).toBe('generated-at-delivery://email-link');
    expect(activeConfirmationJobsAfterRepeat[0].partnerUrl).toBeNull();

    const registrationBeforeEmailJob = await prisma.registration.findUnique({
      where: { id: registrationsAfterRepeat[0].id },
    });
    expect(registrationBeforeEmailJob?.emailSentAt).toBeDefined();

    const repeatDeliveryRun = await deliverPendingEmails(new Date());
    expect(repeatDeliveryRun.result.sent).toBeGreaterThanOrEqual(1);
    const repeatDelivery = repeatDeliveryRun.deliveries.find(delivery => delivery.kind === 'registration');
    expect(repeatDelivery).toBeDefined();

    const loggedEmailJob = await prisma.emailOutboxJob.findFirst({
      where: { registrationId: registrationsAfterRepeat[0].id, status: 'sent' },
      orderBy: { createdAt: 'desc' },
    });
    expect(loggedEmailJob?.sentAt).toBeDefined();
    expect(loggedEmailJob?.webinarUrl).toBe('redacted://email-link');

    const registrationAfterEmailJob = await prisma.registration.findUnique({
      where: { id: registrationsAfterRepeat[0].id },
    });
    expect(registrationAfterEmailJob?.emailSentAt).toBeDefined();
    expect(registrationAfterEmailJob?.confirmationSentAt).toBeDefined();

    // 2. SUCCESS VIEW (GET /api/registration/session/current)
    const successResponse = await userAgent.get('/api/registration/session/current?view=success');

    expect(successResponse.status).toBe(200);
    expect(successResponse.body.ok).toBe(true);
    expect(successResponse.body.lead.email).toBe('alex.test@aspb.ru');
    expect(successResponse.body.registration.status).toBe('registered');

    const regInDb = await prisma.registration.findFirst({
      where: { leadId: lead?.id },
    });
    expect(regInDb?.successViewedAt).toBeDefined();

    // 3. ENTER WEBINAR ROOM (GET /api/webinar/timeline/session/current)
    // The room is bound to the current daily broadcast slot, so move test time into the 19:30 MSK live window.
    setTestNow(new Date('2026-06-11T16:40:00.000Z'));

    const timelineResponse = await userAgent.get('/api/webinar/timeline/session/current');

    expect(timelineResponse.status).toBe(200);
    expect(timelineResponse.body.ok).toBe(true);
    expect(timelineResponse.body.timeline).toBeDefined();

    // Simulate page view for room to record entrance timestamp
    const roomViewResponse = await userAgent.get('/api/registration/session/current?view=room');

    expect(roomViewResponse.status).toBe(200);

    const regInDbAfterRoomView = await prisma.registration.findFirst({
      where: { leadId: lead?.id },
    });
    expect(regInDbAfterRoomView?.roomEnteredAt).toBeDefined();

    // 4. ASK A QUESTION (POST /api/questions)
    const questionResponse = await userAgent.post('/api/questions').set('x-csrf-token', userCsrfToken).send({
      text: 'Каковы особенности процедуры банкротства юрлиц?',
    });

    expect(questionResponse.status).toBe(201);
    expect(questionResponse.body.ok).toBe(true);
    expect(questionResponse.body.chatMessageId).toBeNull();

    const privateQuestions = await prisma.question.findMany({
      where: { leadId: lead?.id },
    });
    expect(privateQuestions.length).toBe(1);
    expect(privateQuestions[0].text).toBe('Каковы особенности процедуры банкротства юрлиц?');
    expect(privateQuestions[0].showToParticipants).toBe(false);
    expect(privateQuestions[0].publicationConsentRecordId).toBeNull();

    const publicQuestionResponse = await userAgent.post('/api/questions').set('x-csrf-token', userCsrfToken).send({
      text: 'Можно показать этот вопрос участникам?',
      showToParticipants: true,
      displayMode: 'pseudonym',
      publicationNoticeAccepted: true,
    });
    expect(publicQuestionResponse.status).toBe(201);
    expect(publicQuestionResponse.body.chatMessageId).toEqual(expect.any(String));
    const publicQuestion = await prisma.question.findUniqueOrThrow({
      where: { id: publicQuestionResponse.body.questionId },
    });
    expect(publicQuestion).toMatchObject({
      showToParticipants: true,
      displayMode: 'pseudonym',
      publishedName: 'Участник',
    });
    expect(publicQuestion.publicationConsentRecordId).toEqual(expect.any(String));
    await expect(
      prisma.consentRecord.count({
        where: { questionId: publicQuestion.id, kind: 'chat_publication', action: 'grant' },
      }),
    ).resolves.toBe(1);

    // 5. PARTNER APPLICATION (POST /api/partner-application)
    const appResponse = await userAgent.post('/api/partner-application').set('x-csrf-token', userCsrfToken).send({
      sphere: 'Финансы',
      city: 'Москва',
      clientFlow: '10-20 человек в месяц',
      experience: 'Более 5 лет',
      preferredFormat: 'Удаленный',
      comment: 'Хочу заключить договор партнерства',
    });

    expect(appResponse.status).toBe(201);
    expect(appResponse.body.ok).toBe(true);

    const apps = await prisma.partnerApplication.findMany({
      where: { leadId: lead?.id },
    });
    expect(apps.length).toBe(1);
    expect(apps[0].sphere).toBe('Финансы');

    const regInDbAfterApp = await prisma.registration.findFirst({
      where: { leadId: lead?.id },
    });
    expect(regInDbAfterApp?.crmStatus).toBe('contract_pending');

    // 5a. Email URL token exchange is one-time and moves access into an httpOnly cookie.
    const exchangeToken = getExchangeTokenFromUrl(repeatDelivery?.input.webinarUrl ?? '');
    const legacyExchangeToken = getExchangeTokenFromUrl(repeatDelivery?.input.partnerUrl ?? '');
    expect(exchangeToken).toEqual(expect.any(String));
    expect(legacyExchangeToken).toEqual(expect.any(String));
    if (!exchangeToken || !legacyExchangeToken) {
      throw new Error('Expected email outbox webinar URLs to contain exchange tokens');
    }
    const exchangeAgent = request.agent(app);
    const exchangeCsrfToken = await getCsrfToken(exchangeAgent);
    const exchangeResponse = await exchangeAgent
      .post('/api/registration/exchange')
      .set('x-csrf-token', exchangeCsrfToken)
      .send({ token: exchangeToken });
    expect(exchangeResponse.status).toBe(200);
    expect(exchangeResponse.body.token).toBeUndefined();
    expect(exchangeResponse.body.webinarUrl).not.toContain('token=');
    expect(exchangeResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const repeatExchangeAgent = request.agent(app);
    const repeatExchangeCsrfToken = await getCsrfToken(repeatExchangeAgent);
    const repeatExchangeResponse = await repeatExchangeAgent
      .post('/api/registration/exchange')
      .set('x-csrf-token', repeatExchangeCsrfToken)
      .send({ token: exchangeToken });
    expect(repeatExchangeResponse.status).toBe(404);

    const exchangedSessionResponse = await exchangeAgent.get('/api/registration/session/current?view=success');
    expect(exchangedSessionResponse.status).toBe(200);
    expect(exchangedSessionResponse.body.lead.email).toBe('alex.test@aspb.ru');

    const legacyExchangeAgent = request.agent(app);
    const legacyExchangeCsrfToken = await getCsrfToken(legacyExchangeAgent);
    const legacyExchangeResponse = await legacyExchangeAgent
      .post(`/api/registration/exchange/${legacyExchangeToken}`)
      .set('x-csrf-token', legacyExchangeCsrfToken)
      .send({});
    expect(legacyExchangeResponse.status).toBe(200);
    expect(legacyExchangeResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    await expect(request(app).get(`/api/registration/${exchangeToken}`)).resolves.toMatchObject({ status: 404 });
    await expect(request(app).get(`/api/webinar/timeline/${exchangeToken}`)).resolves.toMatchObject({ status: 404 });
    await expect(request(app).get(`/api/webinar/chat/${exchangeToken}`)).resolves.toMatchObject({ status: 404 });
    await expect(
      request(app).get(`/api/webinar/timeline/session/current?token=${exchangeToken}`),
    ).resolves.toMatchObject({ status: 401 });

    // 6. ADMIN LOGIN (POST /api/admin/login)
    const adminAgent = request.agent(app);
    const adminCsrfToken = await getCsrfToken(adminAgent);
    const loginResponse = await adminAgent
      .post('/api/admin/login')
      .set('x-csrf-token', adminCsrfToken)
      .send({
        login: 'testadmin',
        password: 'TestAdminPassword123',
        otp: generateTotp(adminMfaSecret),
      });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.ok).toBe(true);

    const setCookieHeaders = loginResponse.headers['set-cookie'];
    const adminCookie = Array.isArray(setCookieHeaders)
      ? setCookieHeaders.find((c: string) => c.startsWith('aspb_admin_session='))
      : typeof setCookieHeaders === 'string' && setCookieHeaders.startsWith('aspb_admin_session=')
        ? setCookieHeaders
        : undefined;
    expect(adminCookie).toBeDefined();

    // 7. ADMIN VIEW REGISTRATIONS (GET /api/admin/registrations)
    const crmStatusesResponse = await adminAgent.get('/api/admin/crm-statuses');
    expect(crmStatusesResponse.status).toBe(200);
    expect(crmStatusesResponse.body.statuses.length).toBeGreaterThan(0);

    const adminRegsResponse = await adminAgent.get('/api/admin/registrations');

    expect(adminRegsResponse.status).toBe(200);
    expect(adminRegsResponse.body.ok).toBe(true);
    expect(adminRegsResponse.body.registrations.length).toBeGreaterThan(0);

    const foundReg = adminRegsResponse.body.registrations.find((r: any) => r.lead.email === 'alex.test@aspb.ru');
    expect(foundReg).toBeDefined();
    expect(foundReg.crmStatus).toBe('contract_pending');
    expect(foundReg.questionCount).toBe(2);
    expect(foundReg.partnerApplicationCount).toBe(1);

    // 8. ADMIN CHANGE STATUS (PATCH /api/admin/registrations/:id/status)
    const statusChangeResponse = await adminAgent
      .patch(`/api/admin/registrations/${foundReg.id}/status`)
      .set('x-csrf-token', adminCsrfToken)
      .send({
        crmStatus: 'contract_signed',
      });

    expect(statusChangeResponse.status).toBe(200);
    expect(statusChangeResponse.body.ok).toBe(true);

    const finalReg = await prisma.registration.findUnique({
      where: { id: foundReg.id },
    });
    expect(finalReg?.crmStatus).toBe('contract_signed');

    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'registration', entityId: foundReg.id },
    });
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('registration.crm_status.update');
    expect(auditLogs[0].adminUserId).toBe(admin.id);
  }, 15_000);

  it('restores participant access with a passwordless email magic link', async () => {
    env.EMAIL_MODE = 'send';
    Object.assign(env, { TELEGRAM_PARTICIPANT_BOT_USERNAME: 'aspb_participant_bot' });
    const email = `restore-${Date.now()}@aspb.ru`;
    const { webinarSession } = await createRegisteredParticipant(email);

    const unknownAgent = request.agent(app);
    const unknownCsrfToken = await getCsrfToken(unknownAgent);
    const unknownResponse = await unknownAgent
      .post('/api/participant/login/request')
      .set('x-csrf-token', unknownCsrfToken)
      .send({ email: `unknown-${Date.now()}@aspb.ru` });

    expect(unknownResponse.status).toBe(202);
    expect(unknownResponse.body).toMatchObject({
      ok: true,
      message: expect.stringContaining('Если адрес зарегистрирован'),
    });

    const unknownJobs = await prisma.emailOutboxJob.count({
      where: { type: 'participant_access_login' },
    });
    expect(unknownJobs).toBe(0);

    const requestAgent = request.agent(app);
    const requestCsrfToken = await getCsrfToken(requestAgent);
    const requestResponse = await requestAgent
      .post('/api/participant/login/request')
      .set('x-csrf-token', requestCsrfToken)
      .send({ email });

    expect(requestResponse.status).toBe(202);
    expect(requestResponse.body).toEqual(unknownResponse.body);

    const loginJobs = await prisma.emailOutboxJob.findMany({
      where: { type: 'participant_access_login' },
    });
    expect(loginJobs.length).toBe(1);
    expect(loginJobs[0].webinarUrl).toBe('generated-at-delivery://email-link');

    const loginDeliveryRun = await deliverPendingEmails(new Date());
    const loginDelivery = loginDeliveryRun.deliveries.find(delivery => delivery.kind === 'participant_login');
    const magicToken = getExchangeTokenFromUrl(loginDelivery?.input.webinarUrl ?? '');
    expect(magicToken).toEqual(expect.any(String));
    if (!magicToken) throw new Error('Expected participant login URL to contain token');

    const restoreAgent = request.agent(app);
    const consumeCsrfToken = await getCsrfToken(restoreAgent);
    const consumeResponse = await restoreAgent
      .post('/api/participant/login/consume')
      .set('x-csrf-token', consumeCsrfToken)
      .send({ token: magicToken });

    expect(consumeResponse.status).toBe(200);
    expect(consumeResponse.body).toMatchObject({
      ok: true,
      purpose: 'participant_login',
      accessUrl: expect.stringContaining('/crisis_premium/access.html'),
      webinarUrl: expect.stringContaining('/crisis_premium/webinar.html'),
    });
    expect(consumeResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const repeatConsumeResponse = await restoreAgent
      .post('/api/participant/login/consume')
      .set('x-csrf-token', consumeCsrfToken)
      .send({ token: magicToken });
    expect(repeatConsumeResponse.status).toBe(404);

    const accessResponse = await restoreAgent.get('/api/participant/access/current');
    expect(accessResponse.status).toBe(200);
    expect(accessResponse.body.lead.email).toBe(email);
    expect(accessResponse.body.webinar.id).toBe(webinarSession.id);
    expect(accessResponse.body.webinar.scheduledAt).toBe(webinarSession.scheduledAt.toISOString());
    expect(accessResponse.body.telegram.subscribed).toBe(false);
    expect(accessResponse.body.telegram.botUrl).toContain('https://t.me/');

    await prisma.webinarSession.update({
      where: { id: webinarSession.id },
      data: {
        scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
        status: 'live',
      },
    });

    const roomAccessResponse = await restoreAgent.get('/api/registration/session/current?view=room');
    expect(roomAccessResponse.status).toBe(200);
    expect(roomAccessResponse.body.lead.email).toBe(email);

    const timelineResponse = await restoreAgent.get('/api/webinar/timeline/session/current');
    expect(timelineResponse.status).toBe(200);
    expect(timelineResponse.body.ok).toBe(true);

    const registrations = await prisma.registration.findMany({
      where: { webinarSessionId: webinarSession.id },
    });
    expect(registrations.length).toBe(1);
  });

  it('requires email verification before reusing an existing registration', async () => {
    env.EMAIL_MODE = 'send';
    const email = `known-email-${Date.now()}@aspb.ru`;
    const { lead, registration } = await createRegisteredParticipant(email);
    const attackerAgent = request.agent(app);
    const csrfToken = await getCsrfToken(attackerAgent);

    const response = await attackerAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Подменённое Имя',
      phone: '+70000000000',
      email,
      city: 'Подменённый город',
      professionalStatus: 'Подменённый статус',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      verificationRequired: true,
      accessUrl: expect.stringContaining('/crisis_premium/access.html'),
    });
    expect(response.body.registration).toBeUndefined();
    expect(response.body.telegramBotUrl).toBeUndefined();
    expect(getCookieValue(response, 'aspb_room_token')).toBeNull();

    const newEmail = `new-email-${Date.now()}@aspb.ru`;
    const newAgent = request.agent(app);
    const newCsrfToken = await getCsrfToken(newAgent);
    const newResponse = await newAgent.post('/api/register').set('x-csrf-token', newCsrfToken).send({
      name: 'Новый Участник',
      phone: '+79991112233',
      email: newEmail,
      city: 'Москва',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
    });
    expect(newResponse.status).toBe(202);
    expect(Object.keys(newResponse.body).sort()).toEqual(Object.keys(response.body).sort());
    expect(newResponse.body.message).toBe(response.body.message);
    expect(newResponse.body.verificationRequired).toBe(true);
    expect(getCookieValue(newResponse, 'aspb_room_token')).toBeNull();
    const newRegistration = await prisma.registration.findFirstOrThrow({ where: { lead: { email: newEmail } } });
    expect(newRegistration).toMatchObject({
      status: 'pending_verification',
      emailVerifiedAt: null,
    });
    const pendingLead = await prisma.lead.findUniqueOrThrow({ where: { email: newEmail } });
    expect(pendingLead).toMatchObject({
      consent: false,
      marketingConsent: false,
      marketingEmailConsent: false,
      marketingTelegramConsent: false,
    });
    await expect(
      prisma.consentRecord.count({ where: { registrationId: newRegistration.id, action: 'grant' } }),
    ).resolves.toBe(0);
    await expect(
      prisma.consentRecord.count({
        where: { registrationId: newRegistration.id, action: 'pending_verification' },
      }),
    ).resolves.toBe(3);

    const pendingRepeat = await newAgent.post('/api/register').set('x-csrf-token', newCsrfToken).send({
      name: 'Попытка Подмены',
      phone: '+70000000001',
      email: newEmail,
      city: 'Другой город',
      professionalStatus: 'Другое значение',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: false,
      marketingTelegramConsent: false,
    });
    expect(pendingRepeat.status).toBe(202);
    expect(Object.keys(pendingRepeat.body).sort()).toEqual(Object.keys(newResponse.body).sort());
    await expect(prisma.registration.count({ where: { leadId: pendingLead.id } })).resolves.toBe(1);
    await expect(prisma.consentRecord.count({ where: { registrationId: newRegistration.id } })).resolves.toBe(3);
    await expect(prisma.lead.findUniqueOrThrow({ where: { id: pendingLead.id } })).resolves.toMatchObject({
      name: 'Новый Участник',
      phone: '+79991112233',
      city: 'Москва',
      professionalStatus: 'Юрист',
    });
    await expect(
      prisma.registrationToken.count({
        where: { registrationId: newRegistration.id, purpose: ROOM_SESSION_TOKEN_PURPOSE },
      }),
    ).resolves.toBe(0);
    const newConfirmation = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { registrationId: newRegistration.id, type: 'registration_confirmation' },
    });
    expect(newConfirmation.webinarUrl).toBe('generated-at-delivery://email-link');
    expect(newConfirmation.partnerUrl).toBeNull();

    const unchangedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(unchangedLead).toMatchObject({
      name: lead.name,
      phone: lead.phone,
      city: lead.city,
      professionalStatus: lead.professionalStatus,
      marketingEmailConsent: lead.marketingEmailConsent,
      marketingTelegramConsent: lead.marketingTelegramConsent,
    });
    await expect(prisma.registration.count({ where: { leadId: lead.id } })).resolves.toBe(1);
    await expect(
      prisma.registrationToken.count({
        where: { registrationId: registration.id, purpose: ROOM_SESSION_TOKEN_PURPOSE },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.emailOutboxJob.count({
        where: { registrationId: registration.id, type: 'participant_access_login', status: 'pending' },
      }),
    ).resolves.toBe(1);

    const { agent: crmAdminAgent } = await loginAdmin('admin', `pending-crm-${Date.now()}@aspb.ru`);
    const crmBeforeVerification = await crmAdminAgent.get('/api/admin/registrations');
    expect(crmBeforeVerification.status).toBe(200);
    expect(crmBeforeVerification.body.registrations.map((item: { id: string }) => item.id)).toContain(registration.id);
    expect(crmBeforeVerification.body.registrations.map((item: { id: string }) => item.id)).not.toContain(
      newRegistration.id,
    );
    const summaryBeforeVerification = await crmAdminAgent.get('/api/admin/analytics/summary');
    expect(summaryBeforeVerification.status).toBe(200);
    expect(summaryBeforeVerification.body.summary.registrations).toBe(1);

    const pendingDeliveryRun = await deliverPendingEmails(new Date());
    const pendingConfirmationDelivery = pendingDeliveryRun.deliveries.find(
      delivery => delivery.kind === 'registration' && delivery.input.to === newEmail,
    );
    const pendingConfirmationToken = getExchangeTokenFromUrl(pendingConfirmationDelivery?.input.webinarUrl ?? '');
    if (!pendingConfirmationToken) throw new Error('Expected pending registration confirmation token');
    const verificationResponse = await newAgent
      .post('/api/registration/exchange')
      .set('x-csrf-token', newCsrfToken)
      .send({ token: pendingConfirmationToken });
    expect(verificationResponse.status).toBe(200);
    await expect(prisma.registration.findUniqueOrThrow({ where: { id: newRegistration.id } })).resolves.toMatchObject({
      status: 'registered',
      emailVerifiedAt: expect.any(Date),
      pendingMetadataJson: null,
    });
    await expect(prisma.lead.findUniqueOrThrow({ where: { id: pendingLead.id } })).resolves.toMatchObject({
      consent: true,
      marketingConsent: true,
      marketingEmailConsent: true,
      marketingTelegramConsent: true,
    });
    await expect(
      prisma.consentRecord.count({ where: { registrationId: newRegistration.id, action: 'grant' } }),
    ).resolves.toBe(3);

    const crmAfterVerification = await crmAdminAgent.get('/api/admin/registrations');
    expect(crmAfterVerification.status).toBe(200);
    expect(crmAfterVerification.body.registrations.map((item: { id: string }) => item.id)).toContain(
      newRegistration.id,
    );
    const summaryAfterVerification = await crmAdminAgent.get('/api/admin/analytics/summary');
    expect(summaryAfterVerification.status).toBe(200);
    expect(summaryAfterVerification.body.summary.registrations).toBe(2);

    const accessResponse = await attackerAgent.get('/api/participant/access/current');
    expect(accessResponse.status).toBe(401);
  });

  it('rejects participant sessions issued before the account-takeover remediation', async () => {
    const { registration } = await createRegisteredParticipant(`legacy-session-${Date.now()}@aspb.ru`);
    const legacyToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(legacyToken),
        purpose: 'room_session',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const response = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', `aspb_room_token=${legacyToken}`);
    expect(response.status).toBe(401);
  });

  it('assigns a returning visitor to the current slot instead of a stale first-seen slot', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const agent = request.agent(app);
    const firstVisit = await agent.get('/api/webinar/current');
    expect(firstVisit.status).toBe(200);
    expect(firstVisit.body.scheduledAt).toBe('2026-06-11T16:30:00.000Z');

    vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'));
    const csrfToken = await getCsrfToken(agent);
    const registrationResponse = await agent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Возвращающийся участник',
      phone: '+79990006655',
      email: 'returning-slot@aspb.ru',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
    });

    expect(registrationResponse.status).toBe(202);
    expect(getCookieValue(registrationResponse, 'aspb_room_token')).toBeNull();
    const registration = await prisma.registration.findFirstOrThrow({
      where: { lead: { email: 'returning-slot@aspb.ru' } },
      include: { webinarSession: true },
    });
    expect(registration.webinarSession.scheduledAt.toISOString()).toBe('2026-06-12T16:30:00.000Z');
  });

  it('counts unique visitors and builds a visitor cohort instead of counting page-view events', async () => {
    const firstVisitor = request.agent(app);
    const firstConsentResponse = await firstVisitor.get('/api/csrf').set('Cookie', 'aspb_cookie_consent=accepted');
    const firstVisitorId = getCookieValue(firstConsentResponse, 'aspb_visitor_id');
    expect(firstVisitorId).toEqual(expect.any(String));
    const firstCookies = `aspb_cookie_consent=accepted; aspb_visitor_id=${firstVisitorId}`;
    await firstVisitor.post('/api/events').set('Cookie', firstCookies).send({
      eventName: 'page_view',
      page: '/crisis_premium/index.html',
      source: 'search',
    });
    await firstVisitor.post('/api/events').set('Cookie', firstCookies).send({
      eventName: 'page_view',
      page: '/crisis_premium/index.html',
      source: 'newsletter',
    });

    const secondVisitor = request.agent(app);
    const secondConsentResponse = await secondVisitor.get('/api/csrf').set('Cookie', 'aspb_cookie_consent=accepted');
    const secondVisitorId = getCookieValue(secondConsentResponse, 'aspb_visitor_id');
    expect(secondVisitorId).toEqual(expect.any(String));
    await secondVisitor
      .post('/api/events')
      .set('Cookie', `aspb_cookie_consent=accepted; aspb_visitor_id=${secondVisitorId}`)
      .send({
        eventName: 'page_view',
        page: '/crisis_premium/index.html',
        source: 'direct',
      });

    await request(app)
      .post('/api/events')
      .send({
        eventName: 'page_view',
        page: '/crisis_premium/index.html',
        source: 'must-not-be-attributed',
        metadata: { campaign: 'must-not-be-stored' },
      });
    const aggregateOnlyEvent = await prisma.event.findFirstOrThrow({
      where: { source: null, eventName: 'page_view' },
      orderBy: { createdAt: 'desc' },
    });
    expect(aggregateOnlyEvent).toMatchObject({
      visitorId: null,
      ipHash: null,
      userAgent: null,
      metadataJson: null,
      source: null,
    });

    const { agent: adminAgent } = await loginAdmin('admin', 'analytics-admin@aspb.ru');
    const summaryResponse = await adminAgent.get('/api/admin/analytics/summary');
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body.summary.pageViews).toBe(4);
    expect(summaryResponse.body.summary.uniqueVisitors).toBe(2);

    const funnelResponse = await adminAgent.get('/api/admin/analytics/funnel?groupBy=source');
    expect(funnelResponse.status).toBe(200);
    expect(funnelResponse.body.summary.visitors).toBe(2);
    expect(funnelResponse.body.summary.legacyVisitors).toBe(0);
    expect(funnelResponse.body.attribution).toBe('firstTouch');
    expect(funnelResponse.body.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'search', visitors: 1 }),
        expect.objectContaining({ key: 'direct', visitors: 1 }),
      ]),
    );

    const lastTouchResponse = await adminAgent.get('/api/admin/analytics/funnel?groupBy=source&attribution=lastTouch');
    expect(lastTouchResponse.status).toBe(200);
    expect(lastTouchResponse.body.attribution).toBe('lastTouch');
    expect(lastTouchResponse.body.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'newsletter', visitors: 1 }),
        expect.objectContaining({ key: 'direct', visitors: 1 }),
      ]),
    );
  });

  it('keeps a claimed magic-link email valid when a newer login link is requested', async () => {
    env.EMAIL_MODE = 'send';
    const email = `magic-race-${Date.now()}@aspb.ru`;
    await createRegisteredParticipant(email);

    const firstRequestAgent = request.agent(app);
    const firstCsrfToken = await getCsrfToken(firstRequestAgent);
    const firstResponse = await firstRequestAgent
      .post('/api/participant/login/request')
      .set('x-csrf-token', firstCsrfToken)
      .send({ email });
    expect(firstResponse.status).toBe(202);

    let firstUrl = '';
    const ambiguousRun = await runEmailOutboxJobOnce(new Date(), {
      sendParticipantLoginEmail: async input => {
        firstUrl = input.webinarUrl;
        throw new Error('SMTP response was lost after DATA');
      },
    });
    expect(ambiguousRun.failed).toBe(1);
    const firstToken = getExchangeTokenFromUrl(firstUrl);
    if (!firstToken) throw new Error('Expected first participant login URL to contain token');

    const secondRequestAgent = request.agent(app);
    const secondCsrfToken = await getCsrfToken(secondRequestAgent);
    const secondResponse = await secondRequestAgent
      .post('/api/participant/login/request')
      .set('x-csrf-token', secondCsrfToken)
      .send({ email });
    expect(secondResponse.status).toBe(202);

    const consumeAgent = request.agent(app);
    const consumeCsrfToken = await getCsrfToken(consumeAgent);
    const consumeResponse = await consumeAgent
      .post('/api/participant/login/consume')
      .set('x-csrf-token', consumeCsrfToken)
      .send({ token: firstToken });

    expect(consumeResponse.status).toBe(200);
  });

  it('restores old registrations and keeps published recordings available before the daily broadcast', async () => {
    env.EMAIL_MODE = 'send';
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const scheduledAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const email = `closed-library-${Date.now()}@aspb.ru`;
    const { webinarSession } = await createRegisteredParticipant(email, scheduledAt);

    await prisma.webinarSession.update({
      where: { id: webinarSession.id },
      data: {
        status: 'finished',
        durationMinutes: 60,
        replayAvailableHours: 168,
      },
    });
    const recording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: webinarSession.id,
        title: 'Постоянная запись',
        videoUrl: '/crisis_premium/assets/webinar.mp4',
        durationSeconds: 568,
        visible: true,
        publishedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
      },
    });

    const requestAgent = request.agent(app);
    const requestCsrfToken = await getCsrfToken(requestAgent);
    const requestResponse = await requestAgent
      .post('/api/participant/login/request')
      .set('x-csrf-token', requestCsrfToken)
      .send({ email });
    expect(requestResponse.status).toBe(202);

    const loginJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { type: 'participant_access_login', toEmail: email },
      orderBy: { createdAt: 'desc' },
    });
    expect(loginJob.webinarUrl).toBe('generated-at-delivery://email-link');
    expect(loginJob.webinarSessionId).not.toBe(webinarSession.id);
    expect(loginJob.scheduledAt).toEqual(getDailyBroadcastDate(new Date()));
    const deliveryRun = await deliverPendingEmails(new Date());
    const loginDelivery = deliveryRun.deliveries.find(delivery => delivery.kind === 'participant_login');
    const magicToken = getExchangeTokenFromUrl(loginDelivery?.input.webinarUrl ?? '');
    expect(magicToken).toEqual(expect.any(String));
    if (!magicToken) throw new Error('Expected participant login URL to contain token');

    const restoreAgent = request.agent(app);
    const consumeCsrfToken = await getCsrfToken(restoreAgent);
    const consumeResponse = await restoreAgent
      .post('/api/participant/login/consume')
      .set('x-csrf-token', consumeCsrfToken)
      .send({ token: magicToken });
    expect(consumeResponse.status).toBe(200);

    const accessResponse = await restoreAgent.get('/api/participant/access/current');
    expect(accessResponse.status).toBe(200);
    expect(accessResponse.body.accessStatus).toBe('waiting');
    expect(accessResponse.body.recordings).toMatchObject({
      available: true,
      locked: false,
      count: expect.any(Number),
    });

    const recordingsResponse = await restoreAgent.get('/api/recordings');
    expect(recordingsResponse.status).toBe(200);
    expect(recordingsResponse.body.locked).toBe(false);
    expect(recordingsResponse.body.recordings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: recording.id, title: 'Постоянная запись' })]),
    );

    const detailResponse = await restoreAgent.get(`/api/recordings/${recording.id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.recording.id).toBe(recording.id);
  });

  it('rejects expired participant login tokens without creating a room session', async () => {
    const email = `expired-${Date.now()}@aspb.ru`;
    const { registration } = await createRegisteredParticipant(email);
    const expiredToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(expiredToken),
        purpose: 'participant_login',
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const consumeResponse = await agent
      .post('/api/participant/login/consume')
      .set('x-csrf-token', csrfToken)
      .send({ token: expiredToken });

    expect(consumeResponse.status).toBe(404);
    expect(consumeResponse.headers['set-cookie'] ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const accessResponse = await agent.get('/api/participant/access/current');
    expect(accessResponse.status).toBe(401);
  });

  it('uses Telegram start tokens once and keeps them isolated from room exchange', async () => {
    const originalTelegramEnv = {
      TELEGRAM_NOTIFY_MODE: env.TELEGRAM_NOTIFY_MODE,
      TELEGRAM_PARTICIPANT_BOT_USERNAME: env.TELEGRAM_PARTICIPANT_BOT_USERNAME,
      TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: env.TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME,
    };
    Object.assign(env, {
      TELEGRAM_NOTIFY_MODE: 'log',
      TELEGRAM_PARTICIPANT_BOT_USERNAME: 'aspb_participant_bot',
      TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: undefined,
      EMAIL_MODE: 'send',
    });

    try {
      const agent = request.agent(app);
      const csrfToken = await getCsrfToken(agent);
      const registerResponse = await agent.post('/api/register').set('x-csrf-token', csrfToken).send({
        name: 'Telegram Token',
        phone: '+79990004455',
        email: 'telegram-token@aspb.ru',
        city: 'Москва',
        professionalStatus: 'Юрист',
        personalDataConsent: true,
        termsAccepted: true,
      });

      expect(registerResponse.status).toBe(202);
      const confirmationRun = await deliverPendingEmails(new Date());
      const confirmation = confirmationRun.deliveries.find(delivery => delivery.kind === 'registration');
      const registrationToken = getExchangeTokenFromUrl(confirmation?.input.webinarUrl ?? '');
      if (!registrationToken) throw new Error('Expected registration confirmation token');
      const registrationExchange = await agent
        .post('/api/registration/exchange')
        .set('x-csrf-token', csrfToken)
        .send({ token: registrationToken });
      expect(registrationExchange.status).toBe(200);

      const successResponse = await agent.get('/api/registration/session/current?view=success');
      expect(successResponse.status).toBe(200);
      expect(successResponse.body.telegramBotUrl).toContain('https://t.me/aspb_participant_bot?start=');
      const telegramStartToken = new URL(successResponse.body.telegramBotUrl).searchParams.get('start');
      expect(telegramStartToken).toEqual(expect.any(String));
      if (!telegramStartToken) throw new Error('Expected Telegram start token');

      const registrationId = successResponse.body.registration.id as string;
      const telegramTokenRecord = await prisma.registrationToken.findUnique({
        where: { tokenHash: hashToken(telegramStartToken) },
      });
      expect(telegramTokenRecord?.purpose).toBe(TELEGRAM_START_TOKEN_PURPOSE);

      const exchangeAgent = request.agent(app);
      const exchangeCsrfToken = await getCsrfToken(exchangeAgent);
      const exchangeResponse = await exchangeAgent
        .post('/api/registration/exchange')
        .set('x-csrf-token', exchangeCsrfToken)
        .send({ token: telegramStartToken });
      expect(exchangeResponse.status).toBe(404);

      await handleParticipantTelegramUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${telegramStartToken}`,
          chat: { id: 111, type: 'private' },
          from: { id: 1001, username: 'first_user', first_name: 'First' },
        },
      });

      const leadAfterStart = await prisma.lead.findUniqueOrThrow({ where: { email: 'telegram-token@aspb.ru' } });
      expect(leadAfterStart.telegramChatId).toBe('111');
      expect(leadAfterStart.telegramUsername).toBe('first_user');
      expect(leadAfterStart.telegramBindingVersion).toBe(TELEGRAM_BINDING_VERSION);
      await expect(
        prisma.registrationToken.findUnique({ where: { tokenHash: hashToken(telegramStartToken) } }),
      ).resolves.toBeNull();

      const legacyTelegramStartToken = createAccessToken();
      await prisma.registrationToken.create({
        data: {
          registrationId,
          tokenHash: hashToken(legacyTelegramStartToken),
          purpose: 'telegram_start',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await handleParticipantTelegramUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          text: `/start ${legacyTelegramStartToken}`,
          chat: { id: 333, type: 'private' },
          from: { id: 1003, username: 'legacy_attacker', first_name: 'Legacy' },
        },
      });
      const leadAfterLegacyStart = await prisma.lead.findUniqueOrThrow({
        where: { email: 'telegram-token@aspb.ru' },
      });
      expect(leadAfterLegacyStart.telegramChatId).toBe('111');

      await handleParticipantTelegramUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          text: `/start ${telegramStartToken}`,
          chat: { id: 222, type: 'private' },
          from: { id: 1002, username: 'second_user', first_name: 'Second' },
        },
      });

      const leadAfterReplay = await prisma.lead.findUniqueOrThrow({ where: { email: 'telegram-token@aspb.ru' } });
      expect(leadAfterReplay.telegramChatId).toBe('111');
      expect(leadAfterReplay.telegramUsername).toBe('first_user');

      const wrongPurposeToken = createAccessToken();
      await prisma.registrationToken.create({
        data: {
          registrationId,
          tokenHash: hashToken(wrongPurposeToken),
          purpose: 'registration',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      await handleParticipantTelegramUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          text: `/start ${wrongPurposeToken}`,
          chat: { id: 333, type: 'private' },
          from: { id: 1003, username: 'wrong_purpose', first_name: 'Wrong' },
        },
      });

      const leadAfterWrongPurpose = await prisma.lead.findUniqueOrThrow({
        where: { email: 'telegram-token@aspb.ru' },
      });
      expect(leadAfterWrongPurpose.telegramChatId).toBe('111');
      expect(leadAfterWrongPurpose.telegramUsername).toBe('first_user');
      const wrongPurposeRecord = await prisma.registrationToken.findUnique({
        where: { tokenHash: hashToken(wrongPurposeToken) },
      });
      expect(wrongPurposeRecord?.purpose).toBe('registration');
    } finally {
      Object.assign(env, originalTelegramEnv);
    }
  });

  it('scopes admin registration PII by role', async () => {
    const managerAccess = await loginAdmin('manager', 'manager-scope@aspb.ru');
    const viewerAccess = await loginAdmin('viewer', 'viewer-scope@aspb.ru');
    const adminAccess = await loginAdmin('admin', 'admin-scope@aspb.ru');
    const otherManager = await prisma.adminUser.create({
      data: {
        name: 'other-manager',
        email: 'other-manager@aspb.ru',
        passwordHash: await hashPassword('OtherManagerPassword123'),
        role: 'manager',
        isActive: true,
      },
    });
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Role scope webinar',
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    async function createRegistration(email: string, overrides: Record<string, unknown> = {}) {
      const lead = await prisma.lead.create({
        data: {
          name: email.split('@')[0],
          phone: '+79990001111',
          email,
          consent: true,
        },
      });
      return prisma.registration.create({
        data: {
          leadId: lead.id,
          webinarSessionId: session.id,
          accessTokenHash: hashToken(createAccessToken()),
          emailVerifiedAt: new Date(),
          ...overrides,
        },
        include: { lead: true },
      });
    }

    const assignedToManager = await createRegistration('assigned-manager@aspb.ru', {
      assignedManagerId: managerAccess.admin.id,
    });
    const unassignedHot = await createRegistration('unassigned-hot@aspb.ru', {
      isHot: true,
    });
    const coldUnassigned = await createRegistration('cold-unassigned@aspb.ru');
    const quietUnassigned = await createRegistration('quiet-unassigned@aspb.ru');
    const assignedToOther = await createRegistration('assigned-other@aspb.ru', {
      assignedManagerId: otherManager.id,
      isHot: true,
    });
    const assignedQuestion = await prisma.question.create({
      data: {
        leadId: assignedToManager.leadId,
        registrationId: assignedToManager.id,
        webinarSessionId: session.id,
        text: 'Assigned manager question',
        adminNote: 'Internal answer note',
      },
    });
    const hotQuestion = await prisma.question.create({
      data: {
        leadId: unassignedHot.leadId,
        registrationId: unassignedHot.id,
        webinarSessionId: session.id,
        text: 'Unassigned hot question',
      },
    });
    const coldQuestion = await prisma.question.create({
      data: {
        leadId: coldUnassigned.leadId,
        registrationId: coldUnassigned.id,
        webinarSessionId: session.id,
        text: 'Cold question',
      },
    });
    const otherQuestion = await prisma.question.create({
      data: {
        leadId: assignedToOther.leadId,
        registrationId: assignedToOther.id,
        webinarSessionId: session.id,
        text: 'Other manager question',
      },
    });
    const assignedApplication = await prisma.partnerApplication.create({
      data: {
        leadId: assignedToManager.leadId,
        registrationId: assignedToManager.id,
        webinarSessionId: session.id,
        comment: 'Assigned application comment',
        status: 'new',
      },
    });
    const hotApplication = await prisma.partnerApplication.create({
      data: {
        leadId: unassignedHot.leadId,
        registrationId: unassignedHot.id,
        webinarSessionId: session.id,
        comment: 'Unassigned hot application',
        status: 'new',
      },
    });
    const coldApplication = await prisma.partnerApplication.create({
      data: {
        leadId: coldUnassigned.leadId,
        registrationId: coldUnassigned.id,
        webinarSessionId: session.id,
        comment: 'Cold application',
        status: 'new',
      },
    });
    const otherApplication = await prisma.partnerApplication.create({
      data: {
        leadId: assignedToOther.leadId,
        registrationId: assignedToOther.id,
        webinarSessionId: session.id,
        comment: 'Other application',
        status: 'new',
      },
    });

    const adminListResponse = await adminAccess.agent.get('/api/admin/registrations');
    expect(adminListResponse.status).toBe(200);
    expect(adminListResponse.body.registrations.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([
        assignedToManager.id,
        unassignedHot.id,
        coldUnassigned.id,
        quietUnassigned.id,
        assignedToOther.id,
      ]),
    );
    expect(adminListResponse.body.registrations.find((item: any) => item.id === assignedToOther.id).lead.email).toBe(
      'assigned-other@aspb.ru',
    );

    const managerListResponse = await managerAccess.agent.get('/api/admin/registrations');
    expect(managerListResponse.status).toBe(200);
    const managerRegistrationIds = managerListResponse.body.registrations.map((item: any) => item.id);
    expect(managerRegistrationIds).toEqual(expect.arrayContaining([assignedToManager.id, unassignedHot.id]));
    expect(managerRegistrationIds).not.toContain(coldUnassigned.id);
    expect(managerRegistrationIds).not.toContain(quietUnassigned.id);
    expect(managerRegistrationIds).not.toContain(assignedToOther.id);
    expect(
      managerListResponse.body.registrations.find((item: any) => item.id === assignedToManager.id).lead.email,
    ).toBe('assigned-manager@aspb.ru');

    const managerHotResponse = await managerAccess.agent.get('/api/admin/hot-leads');
    expect(managerHotResponse.status).toBe(200);
    const managerHotIds = managerHotResponse.body.registrations.map((item: any) => item.id);
    expect(managerHotIds).toContain(unassignedHot.id);
    expect(managerHotIds).not.toContain(assignedToOther.id);

    const managerAllowedDetail = await managerAccess.agent.get(`/api/admin/registrations/${assignedToManager.id}`);
    expect(managerAllowedDetail.status).toBe(200);
    expect(managerAllowedDetail.body.registration.lead.email).toBe('assigned-manager@aspb.ru');

    const managerColdDetail = await managerAccess.agent.get(`/api/admin/registrations/${quietUnassigned.id}`);
    expect(managerColdDetail.status).toBe(404);
    const managerOtherDetail = await managerAccess.agent.get(`/api/admin/registrations/${assignedToOther.id}`);
    expect(managerOtherDetail.status).toBe(404);

    const forbiddenStatusResponse = await managerAccess.agent
      .patch(`/api/admin/registrations/${assignedToOther.id}/status`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ crmStatus: 'paid' });
    expect(forbiddenStatusResponse.status).toBe(404);

    const forbiddenHotResponse = await managerAccess.agent
      .patch(`/api/admin/registrations/${assignedToOther.id}/hot`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ isHot: false });
    expect(forbiddenHotResponse.status).toBe(404);

    const forbiddenManagerResponse = await managerAccess.agent
      .patch(`/api/admin/registrations/${assignedToOther.id}/manager`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ assignedManagerId: managerAccess.admin.id });
    expect(forbiddenManagerResponse.status).toBe(404);

    const forbiddenReminderResponse = await managerAccess.agent
      .post(`/api/admin/registrations/${assignedToOther.id}/telegram-reminder`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ text: 'Reminder text' });
    expect(forbiddenReminderResponse.status).toBe(404);

    const forbiddenNoteResponse = await managerAccess.agent
      .patch(`/api/admin/registrations/${assignedToOther.id}/note`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ managerNote: 'Should not be saved' });
    expect(forbiddenNoteResponse.status).toBe(404);

    const forbiddenQuestionResponse = await managerAccess.agent
      .patch(`/api/admin/questions/${otherQuestion.id}`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ isAnswered: true, adminNote: 'Should not be saved' });
    expect(forbiddenQuestionResponse.status).toBe(404);

    const allowedQuestionResponse = await managerAccess.agent
      .patch(`/api/admin/questions/${assignedQuestion.id}`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ isAnswered: true, adminNote: 'Manager answer' });
    expect(allowedQuestionResponse.status).toBe(200);

    await prisma.lead.update({
      where: { id: assignedToManager.leadId },
      data: { telegramChatId: '123456789', telegramBindingVersion: TELEGRAM_BINDING_VERSION },
    });
    const allowedReminderResponse = await managerAccess.agent
      .post(`/api/admin/registrations/${assignedToManager.id}/telegram-reminder`)
      .set('x-csrf-token', managerAccess.csrfToken)
      .send({ text: 'Personal reminder' });
    expect(allowedReminderResponse.status).toBe(200);
    expect(allowedReminderResponse.body.webinarUrl).toContain('/crisis_premium/webinar.html#token=');
    expect(allowedReminderResponse.body.webinarUrl).not.toContain('?token=');

    const viewerWriteResponse = await viewerAccess.agent
      .patch(`/api/admin/registrations/${assignedToManager.id}/status`)
      .set('x-csrf-token', viewerAccess.csrfToken)
      .send({ crmStatus: 'paid' });
    expect(viewerWriteResponse.status).toBe(403);

    const untouchedOtherRegistration = await prisma.registration.findUniqueOrThrow({
      where: { id: assignedToOther.id },
    });
    expect(untouchedOtherRegistration.crmStatus).toBe('new');
    expect(untouchedOtherRegistration.isHot).toBe(true);
    expect(untouchedOtherRegistration.assignedManagerId).toBe(otherManager.id);
    expect(untouchedOtherRegistration.managerNote).toBeNull();

    const untouchedOtherQuestion = await prisma.question.findUniqueOrThrow({ where: { id: otherQuestion.id } });
    expect(untouchedOtherQuestion.isAnswered).toBe(false);
    expect(untouchedOtherQuestion.adminNote).toBeNull();

    const adminQuestionsResponse = await adminAccess.agent.get('/api/admin/questions');
    expect(adminQuestionsResponse.status).toBe(200);
    expect(adminQuestionsResponse.body.questions.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([assignedQuestion.id, hotQuestion.id, coldQuestion.id, otherQuestion.id]),
    );
    expect(adminQuestionsResponse.body.questions.find((item: any) => item.id === otherQuestion.id).text).toBe(
      'Other manager question',
    );

    const managerQuestionsResponse = await managerAccess.agent.get('/api/admin/questions');
    expect(managerQuestionsResponse.status).toBe(200);
    const managerQuestionIds = managerQuestionsResponse.body.questions.map((item: any) => item.id);
    expect(managerQuestionIds).toEqual(expect.arrayContaining([assignedQuestion.id, hotQuestion.id]));
    expect(managerQuestionIds).not.toContain(coldQuestion.id);
    expect(managerQuestionIds).not.toContain(otherQuestion.id);
    expect(managerQuestionsResponse.body.questions.find((item: any) => item.id === assignedQuestion.id).text).toBe(
      'Assigned manager question',
    );

    const viewerQuestionsResponse = await viewerAccess.agent.get('/api/admin/questions');
    expect(viewerQuestionsResponse.status).toBe(200);
    const viewerQuestion = viewerQuestionsResponse.body.questions.find((item: any) => item.id === assignedQuestion.id);
    expect(viewerQuestion.text).toBe('[hidden]');
    expect(viewerQuestion.adminNote).toBe('[hidden]');
    expect(viewerQuestion.lead.email).not.toBe('assigned-manager@aspb.ru');
    expect(viewerQuestion.lead.phone).not.toBe('+79990001111');

    const adminApplicationsResponse = await adminAccess.agent.get('/api/admin/partner-applications');
    expect(adminApplicationsResponse.status).toBe(200);
    expect(adminApplicationsResponse.body.applications.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([assignedApplication.id, hotApplication.id, coldApplication.id, otherApplication.id]),
    );
    expect(
      adminApplicationsResponse.body.applications.find((item: any) => item.id === otherApplication.id).comment,
    ).toBe('Other application');

    const managerApplicationsResponse = await managerAccess.agent.get('/api/admin/partner-applications');
    expect(managerApplicationsResponse.status).toBe(200);
    const managerApplicationIds = managerApplicationsResponse.body.applications.map((item: any) => item.id);
    expect(managerApplicationIds).toEqual(expect.arrayContaining([assignedApplication.id, hotApplication.id]));
    expect(managerApplicationIds).not.toContain(coldApplication.id);
    expect(managerApplicationIds).not.toContain(otherApplication.id);

    const viewerApplicationsResponse = await viewerAccess.agent.get('/api/admin/partner-applications');
    expect(viewerApplicationsResponse.status).toBe(200);
    const viewerApplication = viewerApplicationsResponse.body.applications.find(
      (item: any) => item.id === assignedApplication.id,
    );
    expect(viewerApplication.comment).toBe('[hidden]');
    expect(viewerApplication.lead.email).not.toBe('assigned-manager@aspb.ru');
    expect(viewerApplication.lead.phone).not.toBe('+79990001111');

    const viewerListResponse = await viewerAccess.agent.get('/api/admin/registrations');
    expect(viewerListResponse.status).toBe(200);
    const viewerAssigned = viewerListResponse.body.registrations.find((item: any) => item.id === assignedToManager.id);
    expect(viewerAssigned.lead.email).not.toBe('assigned-manager@aspb.ru');
    expect(viewerAssigned.lead.phone).not.toBe('+79990001111');

    const viewerDetailResponse = await viewerAccess.agent.get(`/api/admin/registrations/${assignedToManager.id}`);
    expect(viewerDetailResponse.status).toBe(200);
    expect(viewerDetailResponse.body.registration.lead.email).not.toBe('assigned-manager@aspb.ru');
    expect(viewerDetailResponse.body.auditLogs).toEqual([]);
  });

  it('issues a stable CSRF cookie once and tracks visitors only after analytics consent', async () => {
    const anonymousAgent = request.agent(app);
    const firstCsrfResponse = await anonymousAgent.get('/api/csrf');
    expect(firstCsrfResponse.status).toBe(200);
    const firstCsrfCookieHeaders = firstCsrfResponse.headers['set-cookie'] ?? [];
    expect(firstCsrfCookieHeaders).toHaveLength(1);
    expect(firstCsrfCookieHeaders[0]).toContain('aspb_csrf_token=');
    expect(firstCsrfCookieHeaders[0]).not.toContain('aspb_visitor_id=');

    const repeatCsrfResponse = await anonymousAgent.get('/api/csrf');
    expect(repeatCsrfResponse.status).toBe(200);
    expect(repeatCsrfResponse.body.csrfToken).toBe(firstCsrfResponse.body.csrfToken);
    expect(repeatCsrfResponse.headers['set-cookie']).toBeUndefined();

    const consentedResponse = await request(app).get('/api/csrf').set('Cookie', 'aspb_cookie_consent=accepted');
    const consentedVisitorId = getCookieValue(consentedResponse, 'aspb_visitor_id');
    expect(consentedVisitorId).toEqual(expect.any(String));

    const declinedResponse = await request(app)
      .get('/api/csrf')
      .set('Cookie', `aspb_cookie_consent=declined; aspb_visitor_id=${consentedVisitorId}`);
    expect(declinedResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^aspb_visitor_id=;/)]),
    );
  });

  it('revokes email marketing independently and preserves Telegram consent', async () => {
    const grantedAt = new Date();
    const lead = await prisma.lead.create({
      data: {
        name: 'Канальный отзыв',
        phone: '+79991112233',
        email: 'channel-revoke@aspb.ru',
        consent: true,
        marketingConsent: true,
        marketingEmailConsent: true,
        marketingTelegramConsent: true,
        marketingEmailConsentAt: grantedAt,
        marketingTelegramConsentAt: grantedAt,
        telegramChatId: '777001',
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      },
    });
    for (const [document, kind] of [
      [MARKETING_EMAIL_CONSENT, 'marketing_email'],
      [MARKETING_TELEGRAM_CONSENT, 'marketing_telegram'],
    ] as const) {
      await prisma.consentRecord.create({
        data: consentEvidenceData(document, {
          leadId: lead.id,
          email: lead.email,
          kind,
          sourceForm: 'integration-test',
          req: { headers: { 'user-agent': 'vitest' }, socket: {} },
          occurredAt: grantedAt,
        }),
      });
    }

    const token = buildUnsubscribeToken(lead.email);
    const unsubscribeResponse = await request(app).get(`/api/unsubscribe?token=${token}&confirm=1`);
    expect(unsubscribeResponse.status).toBe(200);

    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead).toMatchObject({
      consent: true,
      marketingConsent: true,
      marketingEmailConsent: false,
      marketingTelegramConsent: true,
    });
    expect(updatedLead.marketingEmailRevokedAt).toBeInstanceOf(Date);
    expect(updatedLead.marketingTelegramRevokedAt).toBeNull();
    await expect(
      prisma.consentRecord.count({
        where: { leadId: lead.id, kind: 'marketing_email', action: 'revoke' },
      }),
    ).resolves.toBe(1);
  });

  it('requires CSRF for registration and ignores honeypot submissions', async () => {
    const userAgent = request.agent(app);
    const csrfToken = await getCsrfToken(userAgent);

    const missingHeaderResponse = await userAgent.post('/api/register').send({
      name: 'Без CSRF',
      phone: '+79990001122',
      email: 'missing-csrf@aspb.ru',
      personalDataConsent: true,
      termsAccepted: true,
    });
    expect(missingHeaderResponse.status).toBe(403);
    expect(missingHeaderResponse.body).toMatchObject({ ok: false, code: 'csrf_invalid' });

    const honeypotResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Spam Bot',
      phone: '+79990001123',
      email: 'spam-bot@aspb.ru',
      companyWebsite: 'https://spam.example.com',
      personalDataConsent: true,
      termsAccepted: true,
    });
    expect(honeypotResponse.status).toBe(202);
    expect(honeypotResponse.body.ok).toBe(true);

    await expect(prisma.lead.findUnique({ where: { email: 'spam-bot@aspb.ru' } })).resolves.toBeNull();
    await expect(prisma.registration.count()).resolves.toBe(0);
    await expect(prisma.emailOutboxJob.count()).resolves.toBe(0);
  });

  it('does not turn explicit false strings into consent grants', async () => {
    const userAgent = request.agent(app);
    const csrfToken = await getCsrfToken(userAgent);
    const email = 'false-consent@aspb.ru';

    const response = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Отказ От Согласия',
      phone: '+79990001124',
      email,
      personalDataConsent: 'false',
      termsAccepted: 'true',
      marketingEmailConsent: 'false',
      marketingTelegramConsent: 'false',
    });

    expect(response.status).toBe(400);
    await expect(prisma.lead.findUnique({ where: { email } })).resolves.toBeNull();
    await expect(prisma.consentRecord.count()).resolves.toBe(0);
    await expect(prisma.legalAcceptance.count()).resolves.toBe(0);
  });

  it('keeps failed email jobs in the outbox and retries them later', async () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Test webinar',
        scheduledAt,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Мария Outbox',
        email: 'outbox@aspb.ru',
        phone: '+79990001122',
        consent: true,
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
    await prisma.emailOutboxJob.create({
      data: {
        type: 'registration_confirmation',
        status: 'pending',
        registrationId: registration.id,
        webinarSessionId: session.id,
        toEmail: lead.email,
        toName: lead.name,
        scheduledAt,
        webinarUrl: 'http://127.0.0.1:5174/crisis_premium/webinar.html',
        nextAttemptAt: new Date('2026-05-21T09:00:00.000Z'),
      },
    });

    const failingRun = await runEmailOutboxJobOnce(
      new Date('2026-05-21T09:00:00.000Z'),
      {
        sendRegistrationEmail: async () => {
          throw new Error('SMTP temporarily unavailable');
        },
      },
      undefined,
      () => new Date('2026-05-21T09:00:00.000Z'),
    );
    expect(failingRun.failed).toBe(1);

    const failedJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(failedJob.status).toBe('failed');
    expect(failedJob.attempts).toBe(1);
    expect(failedJob.lastError).toContain('SMTP temporarily unavailable');
    expect(failedJob.sentAt).toBeNull();

    const retryRun = await runEmailOutboxJobOnce(
      new Date('2026-05-21T09:03:00.000Z'),
      {
        sendRegistrationEmail: async () => ({ sent: true, mode: 'send' as const }),
      },
      undefined,
      () => new Date('2026-05-21T09:03:00.000Z'),
    );
    expect(retryRun.sent).toBe(1);

    const retriedJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(retriedJob.status).toBe('sent');
    expect(retriedJob.attempts).toBe(2);
    expect(retriedJob.sentAt).toBeDefined();
  });

  it('replaces stale pending and failed registration confirmation jobs on repeat registration', async () => {
    setTestNow(new Date('2026-07-30T10:00:00.000Z'));
    env.EMAIL_MODE = 'send';
    const userAgent = request.agent(app);
    const csrfToken = await getCsrfToken(userAgent);
    const email = 'repeat-outbox@aspb.ru';

    const firstResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Повторная Регистрация',
      phone: '+79990003344',
      email,
      city: 'Москва',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
    });
    expect(firstResponse.status).toBe(202);

    const registration = await prisma.registration.findFirstOrThrow({
      where: { lead: { email } },
    });
    const firstJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: {
        registrationId: registration.id,
        type: 'registration_confirmation',
        status: 'pending',
      },
    });

    const firstDeliveryRun = await deliverPendingEmails(new Date());
    const firstDelivery = firstDeliveryRun.deliveries.find(delivery => delivery.kind === 'registration');
    const firstRegistrationToken = getExchangeTokenFromUrl(firstDelivery?.input.webinarUrl ?? '');
    if (!firstRegistrationToken) throw new Error('Expected registration confirmation token');
    const firstExchangeResponse = await userAgent
      .post('/api/registration/exchange')
      .set('x-csrf-token', csrfToken)
      .send({ token: firstRegistrationToken });
    expect(firstExchangeResponse.status).toBe(200);

    await prisma.emailOutboxJob.update({
      where: { id: firstJob.id },
      data: {
        status: 'failed',
        webinarUrl: 'http://127.0.0.1:5174/crisis_premium/webinar.html?legacy=obsolete',
        lastError: 'old SMTP error',
        attempts: 1,
        nextAttemptAt: new Date(),
      },
    });
    await prisma.emailOutboxJob.create({
      data: {
        type: 'registration_confirmation',
        status: 'sent',
        registrationId: registration.id,
        webinarSessionId: registration.webinarSessionId,
        toEmail: email,
        toName: 'Повторная Регистрация',
        scheduledAt: new Date('2026-05-22T08:00:00.000Z'),
        webinarUrl: 'redacted://email-link',
        sentAt: new Date(),
        attempts: 1,
      },
    });

    vi.setSystemTime(new Date('2026-07-30T10:16:00.000Z'));
    const repeatResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Повторная Регистрация',
      phone: '+79990003344',
      email,
      city: 'Москва',
      professionalStatus: 'Юрист',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: true,
    });
    expect(repeatResponse.status).toBe(201);

    const jobs = await prisma.emailOutboxJob.findMany({
      where: {
        registrationId: registration.id,
        type: 'registration_confirmation',
      },
      orderBy: { createdAt: 'asc' },
    });
    const activeJobs = jobs.filter(job => ['pending', 'failed'].includes(job.status));
    const sentJobs = jobs.filter(job => job.status === 'sent');

    expect(activeJobs.length).toBe(1);
    expect(activeJobs[0].status).toBe('pending');
    expect(activeJobs[0].webinarUrl).toBe('generated-at-delivery://email-link');
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0].webinarUrl).toBe('redacted://email-link');
  });

  it('does not queue replay follow-up email for registered no-shows', async () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    const now = new Date('2026-05-22T10:30:00.000Z');
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Replay webinar',
        scheduledAt,
        durationMinutes: 120,
        replayEnabled: true,
        replayAvailableHours: 168,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Ноу Шоу',
        email: 'replay-noshow@aspb.ru',
        phone: '+79990007788',
        consent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
        roomEnteredAt: null,
      },
    });

    const firstRun = await runReplayFollowupJobOnce(now);
    expect(firstRun.emailQueued).toBe(0);
    expect(firstRun.telegramSent).toBe(0);
    expect(firstRun.disabled).toBe(true);

    const secondRun = await runReplayFollowupJobOnce(now);
    expect(secondRun.emailQueued).toBe(0);

    const replayJobCount = await prisma.emailOutboxJob.count({
      where: { registrationId: registration.id, type: 'webinar_replay' },
    });
    expect(replayJobCount).toBe(0);
  });

  it('queues a reminder email at most once per kind even when enqueued twice (idempotent)', async () => {
    const { registration, webinarSession } = await createRegisteredParticipant('reminder-idempotent@aspb.ru');

    const enqueue24h = () =>
      prisma.$transaction(tx =>
        enqueueReminderEmail(tx, {
          kind: '24h',
          registrationId: registration.id,
          webinarSessionId: webinarSession.id,
          toEmail: 'reminder-idempotent@aspb.ru',
          toName: 'Reminder Participant',
          scheduledAt: webinarSession.scheduledAt,
        }),
      );

    // Повторная постановка того же напоминания не создаёт дубль: уникальный индекс
    // (registrationId, type, reminderKind) + skipDuplicates → createMany возвращает 0.
    expect(await enqueue24h()).toBe(1);
    expect(await enqueue24h()).toBe(0);

    const jobs = await prisma.emailOutboxJob.findMany({
      where: { registrationId: registration.id, type: EMAIL_JOB_REMINDER },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reminderKind).toBe('24h');

    // Другой вид напоминания (3h) — отдельная джоба, ограничение его не блокирует.
    const otherKindCount = await prisma.$transaction(tx =>
      enqueueReminderEmail(tx, {
        kind: '3h',
        registrationId: registration.id,
        webinarSessionId: webinarSession.id,
        toEmail: 'reminder-idempotent@aspb.ru',
        toName: 'Reminder Participant',
        scheduledAt: webinarSession.scheduledAt,
      }),
    );
    expect(otherKindCount).toBe(1);
    await expect(
      prisma.emailOutboxJob.count({ where: { registrationId: registration.id, type: EMAIL_JOB_REMINDER } }),
    ).resolves.toBe(2);
  });

  it('sends the live "эфир начался" telegram message once per registration (idempotent)', async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000); // эфир начался 5 минут назад
    const { registration, lead } = await createRegisteredParticipant('live-notify@aspb.ru', startedAt);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { telegramChatId: '900900900', telegramBindingVersion: TELEGRAM_BINDING_VERSION },
    });

    // NOTIFY_MODE=log в тестах → отправка не уходит в сеть, но CAS-claim метки отрабатывает.
    expect((await runTelegramLiveJobOnce(new Date())).sent).toBe(1);
    expect((await runTelegramLiveJobOnce(new Date())).sent).toBe(0);

    const updated = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
    expect(updated.telegramLiveSentAt).not.toBeNull();
  });

  it('serves published recordings to registered account sessions only', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const anonymousResponse = await request(app).get('/api/recordings');
    expect(anonymousResponse.status).toBe(401);

    const endedSession = await prisma.webinarSession.create({
      data: {
        title: 'Прошедший вебинар',
        scheduledAt: new Date('2026-05-22T08:00:00.000Z'),
        durationMinutes: 120,
        videoDurationSeconds: 3860,
        videoUrl: 'https://aspb-partners.ru/crisis_premium/assets/media/vasiliy-artin-2026-06-10/video.mp4',
        posterUrl: '/crisis_premium/assets/webinar-poster.jpg',
      },
    });
    const futureSession = await prisma.webinarSession.create({
      data: {
        title: 'Будущий вебинар',
        scheduledAt: new Date('2099-05-22T08:00:00.000Z'),
        durationMinutes: 120,
      },
    });
    const draftSession = await prisma.webinarSession.create({
      data: {
        title: 'Черновик вебинара',
        scheduledAt: new Date('2026-05-23T08:00:00.000Z'),
        durationMinutes: 120,
      },
    });

    const visibleRecording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: endedSession.id,
        title: 'Запись прошедшего вебинара',
        description: 'Материалы вебинара.',
        videoUrl: '/crisis_premium/assets/webinar.mp4',
        visible: true,
        publishedAt: new Date('2026-05-22T10:05:00.000Z'),
        durationSeconds: 568,
        orderIndex: 1,
        category: 'webinar',
      },
    });
    const futureRecording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: futureSession.id,
        title: 'Запись будущего вебинара',
        visible: true,
        publishedAt: new Date('2099-05-22T10:05:00.000Z'),
      },
    });
    const draftRecording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: draftSession.id,
        title: 'Черновик записи',
        visible: true,
        publishedAt: null,
      },
    });
    const hiddenRecording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: endedSession.id,
        title: 'Скрытая запись',
        visible: false,
        publishedAt: new Date('2026-05-22T10:10:00.000Z'),
      },
    });
    const missingMediaRecording = await prisma.webinarRecording.create({
      data: {
        webinarSessionId: endedSession.id,
        title: 'Опубликованная запись без файла',
        visible: true,
        publishedAt: new Date('2026-05-22T10:15:00.000Z'),
      },
    });

    const lead = await prisma.lead.create({
      data: {
        name: 'Записи Тест',
        phone: '+79990001122',
        email: 'recordings-test@aspb.ru',
        consent: true,
        marketingConsent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: endedSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const accountCookie = [`aspb_room_token=${sessionToken}`];

    const listResponse = await request(app).get('/api/recordings').set('Cookie', accountCookie);
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers['cache-control']).toContain('private');
    expect(listResponse.body.recordings).toHaveLength(1);
    expect(listResponse.body.recordings[0]).toMatchObject({
      id: visibleRecording.id,
      title: 'Запись прошедшего вебинара',
      status: 'available',
    });
    expect(listResponse.body.recordings[0].video).toMatchObject({
      src: `/api/media/recording/${visibleRecording.id}/video`,
      hlsSrc: null,
      poster: '/crisis_premium/assets/webinar-poster.jpg',
      durationSeconds: 568,
    });
    expect(JSON.stringify(listResponse.body.recordings[0])).not.toContain('vasiliy-artin-2026-06-10');
    expect(JSON.stringify(listResponse.body.recordings[0])).not.toContain('/crisis_premium/assets/webinar.mp4');
    expect(JSON.stringify(listResponse.body.recordings)).not.toContain('Опубликованная запись без файла');

    const detailResponse = await request(app)
      .get(`/api/recordings/${visibleRecording.id}`)
      .set('Cookie', accountCookie);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.currentIndex).toBe(0);
    expect(detailResponse.body.playlist).toHaveLength(1);

    const draftDetailResponse = await request(app)
      .get(`/api/recordings/${draftRecording.id}`)
      .set('Cookie', accountCookie);
    expect(draftDetailResponse.status).toBe(404);

    const futureDetailResponse = await request(app)
      .get(`/api/recordings/${futureRecording.id}`)
      .set('Cookie', accountCookie);
    expect(futureDetailResponse.status).toBe(404);

    const hiddenDetailResponse = await request(app)
      .get(`/api/recordings/${hiddenRecording.id}`)
      .set('Cookie', accountCookie);
    expect(hiddenDetailResponse.status).toBe(404);

    const missingMediaDetailResponse = await request(app)
      .get(`/api/recordings/${missingMediaRecording.id}`)
      .set('Cookie', accountCookie);
    expect(missingMediaDetailResponse.status).toBe(404);

    const anonymousMediaResponse = await request(app).get(`/api/media/recording/${visibleRecording.id}/video`);
    expect(anonymousMediaResponse.status).toBe(401);

    const authorizedMediaResponse = await request(app)
      .get(`/api/media/recording/${visibleRecording.id}/video`)
      .set('Cookie', accountCookie)
      .set('Range', 'bytes=0-0');
    expect(authorizedMediaResponse.status).toBe(206);
    expect(authorizedMediaResponse.headers['content-range']).toMatch(/^bytes 0-0\//);

    const directMediaResponse = await request(app).get('/crisis_premium/assets/webinar.mp4');
    expect(directMediaResponse.status).toBe(404);
    const directMediaHeadResponse = await request(app).head('/crisis_premium/assets/webinar.mp4');
    expect(directMediaHeadResponse.status).toBe(404);
    const directMediaRangeResponse = await request(app)
      .get('/crisis_premium/assets/webinar.mp4')
      .set('Range', 'bytes=0-0');
    expect(directMediaRangeResponse.status).toBe(404);
  });

  it('gates room media before start and keeps the same session available for replay', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const dailyScheduledAt = new Date('2026-06-11T16:30:00.000Z');
    const registrationSession = await prisma.webinarSession.create({
      data: {
        title: 'Media gated webinar',
        scheduledAt: dailyScheduledAt,
        status: 'scheduled',
        videoDurationSeconds: 3860,
        replayAvailableHours: 168,
        posterUrl: '/crisis_premium/assets/webinar-poster.jpg',
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Media Gate',
        phone: '+79990007766',
        email: 'media-gate@aspb.ru',
        consent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: registrationSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      },
    });
    const accountCookie = [`aspb_room_token=${sessionToken}`];

    const waitingResponse = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(waitingResponse.status).toBe(200);
    expect(waitingResponse.body.accessStatus).toBe('waiting');
    expect(waitingResponse.body.roomState).toBe('waiting');
    expect(waitingResponse.body.countdown.totalSeconds).toBeGreaterThan(0);
    expect(waitingResponse.body.video).toBeUndefined();
    expect(waitingResponse.body.timeline).toBeUndefined();
    expect(JSON.stringify(waitingResponse.body)).not.toContain('/crisis_premium/assets/webinar.mp4');
    expect(JSON.stringify(waitingResponse.body)).not.toContain('webinar-poster.jpg');
    expect(waitingResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());

    setTestNow(new Date('2026-06-11T16:32:00.000Z'));
    const liveResponse = await request(app).get('/api/webinar/timeline/session/current').set('Cookie', accountCookie);
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.accessStatus).toBe('live');
    expect(liveResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());
    expect(liveResponse.body.video).toMatchObject({
      src: expect.stringMatching(/^\/api\/media\/webinar\/.+\/video$/),
      poster: '/crisis_premium/assets/webinar-poster.jpg',
      expected: true,
    });
    expect(JSON.stringify(liveResponse.body.video)).not.toContain('/crisis_premium/assets/webinar.mp4');
    expect(JSON.stringify(liveResponse.body.video)).not.toContain('vasiliy-artin-2026-06-10/video.mp4');
    expect(liveResponse.body.timeline).toBeDefined();

    setTestNow(new Date('2026-06-11T18:00:00.000Z'));
    const afterBroadcastResponse = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(afterBroadcastResponse.status).toBe(200);
    expect(afterBroadcastResponse.body.accessStatus).toBe('replay');
    expect(afterBroadcastResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());
    expect(afterBroadcastResponse.body.replayExpiresAt).toBe('2026-06-18T17:35:00.000Z');
    expect(afterBroadcastResponse.body.video).toBeDefined();
    expect(afterBroadcastResponse.body.timeline).toBeDefined();

    setTestNow(new Date('2026-06-18T17:34:00.000Z'));
    const finalReplayMinute = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(finalReplayMinute.status).toBe(200);
    expect(finalReplayMinute.body.accessStatus).toBe('replay');
    expect(finalReplayMinute.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());

    setTestNow(new Date('2026-06-18T17:36:00.000Z'));
    const nextSlotResponse = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(nextSlotResponse.status).toBe(200);
    expect(nextSlotResponse.body.liveState.scheduledAt).toBe(getDailyBroadcastDate(new Date()).toISOString());
    expect(nextSlotResponse.body.liveState.scheduledAt).not.toBe(dailyScheduledAt.toISOString());
  });

  it('repairs legacy daily broadcast media without overwriting custom session media', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const dailyScheduledAt = getDailyBroadcastDate(new Date());
    const legacySession = await prisma.webinarSession.create({
      data: {
        title: 'Legacy daily media',
        scheduledAt: dailyScheduledAt,
        status: 'scheduled',
        durationMinutes: 65,
        videoUrl: '/crisis_premium/assets/webinar.mp4',
        posterUrl: '/crisis_premium/assets/webinar-poster.jpg',
        videoDurationSeconds: 568,
      },
    });

    const repairedSession = await findOrCreateWebinarSession(dailyScheduledAt, new Date());
    expect(repairedSession.id).toBe(legacySession.id);
    expect(repairedSession.videoUrl).toContain('vasiliy-artin-2026-06-10/video.mp4');
    expect(repairedSession.posterUrl).toContain('vasiliy-artin-2026-06-10/poster.jpg');
    expect(repairedSession.videoDurationSeconds).toBe(3860);

    const customScheduledAt = new Date('2026-06-12T16:00:00.000Z');
    const customSession = await prisma.webinarSession.create({
      data: {
        title: 'Custom daily media',
        scheduledAt: customScheduledAt,
        status: 'finished',
        durationMinutes: 47,
        videoUrl: 'https://cdn.example.com/custom-daily.mp4',
        posterUrl: 'https://cdn.example.com/custom-daily.jpg',
        videoDurationSeconds: 777,
      },
    });

    const untouchedSession = await findOrCreateWebinarSession(customScheduledAt, new Date('2026-06-12T12:00:00.000Z'));
    expect(untouchedSession.id).toBe(customSession.id);
    expect(untouchedSession.title).toBe('Custom daily media');
    expect(untouchedSession.durationMinutes).toBe(47);
    expect(untouchedSession.videoUrl).toBe('https://cdn.example.com/custom-daily.mp4');
    expect(untouchedSession.posterUrl).toBe('https://cdn.example.com/custom-daily.jpg');
    expect(untouchedSession.videoDurationSeconds).toBe(777);
    expect(untouchedSession.status).toBe('scheduled');
  });

  it('keeps room timeline and chat bound to the current daily broadcast, not the old registration session', async () => {
    setTestNow(new Date('2026-06-11T16:32:00.000Z'));
    const dailyScheduledAt = getDailyBroadcastDate(new Date());
    const oldScheduledAt = new Date('2026-06-01T16:00:00.000Z');
    const oldSession = await prisma.webinarSession.create({
      data: {
        title: 'Old registered webinar',
        scheduledAt: oldScheduledAt,
        status: 'scheduled',
        videoDurationSeconds: 3860,
        replayAvailableHours: 168,
      },
    });
    const dailySession = await prisma.webinarSession.create({
      data: {
        title: 'Daily webinar',
        scheduledAt: dailyScheduledAt,
        status: 'scheduled',
        videoDurationSeconds: 3860,
      },
    });
    await prisma.webinarTimelineEvent.create({
      data: {
        webinarSessionId: oldSession.id,
        offsetSeconds: 0,
        title: 'Old registration event',
        text: 'This event belongs to the old registration session',
        type: 'message',
      },
    });
    await prisma.webinarTimelineEvent.create({
      data: {
        webinarSessionId: dailySession.id,
        offsetSeconds: 0,
        title: 'Daily broadcast event',
        text: 'This event belongs to the current daily broadcast',
        type: 'message',
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Bound Session',
        phone: '+79990001234',
        email: 'bound-session@aspb.ru',
        consent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: oldSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.webinarChatMessage.create({
      data: {
        webinarSessionId: oldSession.id,
        registrationId: registration.id,
        kind: 'participant',
        authorName: 'Bound Session',
        message: 'Persisted message from old registration session',
        isSynthetic: false,
        visibleAt: new Date(Date.now() - 60 * 1000),
      },
    });
    await prisma.webinarChatMessage.create({
      data: {
        webinarSessionId: dailySession.id,
        registrationId: registration.id,
        kind: 'participant',
        authorName: 'Bound Session',
        message: 'Persisted message from daily broadcast',
        isSynthetic: false,
        visibleAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      },
    });
    const accountCookie = [`aspb_room_token=${sessionToken}`];

    const timelineResponse = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(timelineResponse.status).toBe(200);
    expect(timelineResponse.body.accessStatus).toBe('live');
    expect(timelineResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());
    expect(timelineResponse.body.timeline.map((event: any) => event.title)).toContain('Daily broadcast event');
    expect(timelineResponse.body.timeline.map((event: any) => event.title)).not.toContain('Old registration event');

    const chatResponse = await request(app).get('/api/webinar/chat/session/current').set('Cookie', accountCookie);
    expect(chatResponse.status).toBe(200);
    expect(chatResponse.body.accessStatus).toBe('live');
    expect(chatResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());
    expect(
      chatResponse.body.messages.some((message: any) => message.message === 'Persisted message from daily broadcast'),
    ).toBe(true);
    expect(
      chatResponse.body.messages.some(
        (message: any) => message.message === 'Persisted message from old registration session',
      ),
    ).toBe(false);

    const roomStateResponse = await request(app)
      .get('/api/registration/session/current?view=room')
      .set('Cookie', accountCookie);
    expect(roomStateResponse.status).toBe(200);
    const roomOpenEvent = await prisma.event.findFirstOrThrow({
      where: { registrationId: registration.id, eventName: 'webinar_room_open' },
      orderBy: { createdAt: 'desc' },
    });
    expect(roomOpenEvent.webinarSessionId).toBe(dailySession.id);
    expect(roomOpenEvent.webinarSessionId).not.toBe(oldSession.id);

    const browserEventResponse = await request(app)
      .post('/api/events')
      .set('Cookie', [...accountCookie, 'aspb_cookie_consent=accepted'])
      .send({ eventName: 'video_start', page: '/crisis_premium/webinar.html' });
    expect(browserEventResponse.status).toBe(201);
    const browserEvent = await prisma.event.findFirstOrThrow({
      where: { registrationId: registration.id, eventName: 'video_start' },
      orderBy: { createdAt: 'desc' },
    });
    expect(browserEvent.webinarSessionId).toBe(dailySession.id);
    expect(browserEvent.webinarSessionId).not.toBe(oldSession.id);
  });

  it('does not expose persisted chat messages before broadcast start', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const dailyScheduledAt = new Date('2026-06-11T16:30:00.000Z');
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Pre-live chat gate',
        scheduledAt: dailyScheduledAt,
        status: 'scheduled',
        videoDurationSeconds: 3860,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Chat Gate',
        phone: '+79990006677',
        email: 'chat-gate@aspb.ru',
        consent: true,
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
    await prisma.webinarChatMessage.create({
      data: {
        webinarSessionId: session.id,
        registrationId: registration.id,
        kind: 'participant',
        authorName: 'Chat Gate',
        message: 'Persisted pre-live message must stay hidden',
        isSynthetic: false,
        visibleAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      },
    });
    const accountCookie = [`aspb_room_token=${sessionToken}`];

    const waitingResponse = await request(app).get('/api/webinar/chat/session/current').set('Cookie', accountCookie);
    expect(waitingResponse.status).toBe(200);
    expect(waitingResponse.body.accessStatus).toBe('waiting');
    expect(waitingResponse.body.liveState.chatStatus).toBe('locked');
    expect(waitingResponse.body.messages).toEqual([]);

    setTestNow(new Date('2026-06-11T16:32:00.000Z'));
    const liveResponse = await request(app).get('/api/webinar/chat/session/current').set('Cookie', accountCookie);
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.accessStatus).toBe('live');
    expect(
      liveResponse.body.messages.some(
        (message: any) => message.message === 'Persisted pre-live message must stay hidden',
      ),
    ).toBe(true);
  });

  it('persists Telegram broadcast jobs outside process memory', async () => {
    const adminPasswordHash = await hashPassword('BroadcastAdminPassword123');
    const mfaSecret = 'JBSWY3DPEHPK3PXP';
    await prisma.adminUser.create({
      data: {
        name: 'broadcast-admin',
        email: 'broadcast-admin@aspb.ru',
        passwordHash: adminPasswordHash,
        role: 'admin',
        isActive: true,
        mfaSecretEncrypted: encryptMfaSecret(mfaSecret),
        mfaEnabledAt: new Date(),
      },
    });
    const telegramLead = await prisma.lead.create({
      data: {
        name: 'Telegram Lead',
        email: 'telegram-lead@aspb.ru',
        phone: '+79990005566',
        consent: true,
        marketingConsent: true,
        marketingTelegramConsent: true,
        marketingTelegramConsentAt: new Date(),
        telegramChatId: '123456',
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      },
    });
    await prisma.consentRecord.create({
      data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
        leadId: telegramLead.id,
        email: telegramLead.email,
        kind: 'marketing_telegram',
        sourceForm: 'integration-test',
        req: { headers: { 'user-agent': 'vitest' }, socket: {} },
      }),
    });
    const telegramSession = await prisma.webinarSession.create({
      data: {
        title: 'Telegram broadcast eligibility',
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.registration.create({
      data: {
        leadId: telegramLead.id,
        webinarSessionId: telegramSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    env.TELEGRAM_MANUAL_BROADCAST = 'on';

    const adminAgent = request.agent(app);
    const csrfToken = await getCsrfToken(adminAgent);
    const loginResponse = await adminAgent
      .post('/api/admin/login')
      .set('x-csrf-token', csrfToken)
      .send({
        login: 'broadcast-admin@aspb.ru',
        password: 'BroadcastAdminPassword123',
        otp: generateTotp(mfaSecret),
      });
    expect(loginResponse.status).toBe(200);

    const previewResponse = await adminAgent
      .post('/api/admin/telegram/broadcast/preview')
      .set('x-csrf-token', csrfToken)
      .send({
        text: 'Новость для участников вебинара',
      });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.total).toBe(1);

    const response = await adminAgent.post('/api/admin/telegram/broadcast').set('x-csrf-token', csrfToken).send({
      text: 'Новость для участников вебинара',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
      confirmRecipientCount: previewResponse.body.total,
    });
    expect(response.status).toBe(202);
    expect(response.body.jobId).toBeDefined();

    const persistedJob = await prisma.telegramBroadcastJob.findUniqueOrThrow({
      where: { id: response.body.jobId },
    });
    expect(persistedJob.total).toBe(1);
    expect(persistedJob.status).toMatch(/pending|sending|completed/);

    const statusResponse = await adminAgent.get('/api/admin/telegram/broadcast/current');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.job.id).toBe(response.body.jobId);
  });

  it('does not duplicate Telegram news broadcasts for concurrent or repeated ticks', async () => {
    const originalNewsEnv = {
      TELEGRAM_NOTIFY_MODE: env.TELEGRAM_NOTIFY_MODE,
      TELEGRAM_NEWS_BROADCAST: env.TELEGRAM_NEWS_BROADCAST,
      TELEGRAM_NEWS_TIMES: env.TELEGRAM_NEWS_TIMES,
      TELEGRAM_NEWS_RSS_URLS: env.TELEGRAM_NEWS_RSS_URLS,
    };
    Object.assign(env, {
      TELEGRAM_NOTIFY_MODE: 'log',
      TELEGRAM_NEWS_BROADCAST: 'on',
      TELEGRAM_NEWS_TIMES: '09:00',
      TELEGRAM_NEWS_RSS_URLS: '',
    });

    try {
      const newsLead = await prisma.lead.create({
        data: {
          name: 'News Subscriber',
          phone: '+79990009988',
          email: 'news-subscriber@aspb.ru',
          consent: true,
          marketingConsent: true,
          marketingTelegramConsent: true,
          marketingTelegramConsentAt: new Date(),
          telegramChatId: '555001',
          telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        },
      });
      await prisma.consentRecord.create({
        data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
          leadId: newsLead.id,
          email: newsLead.email,
          kind: 'marketing_telegram',
          sourceForm: 'integration-test',
          req: { headers: { 'user-agent': 'vitest' }, socket: {} },
        }),
      });

      const now = new Date('2026-05-22T06:30:00.000Z');
      const results = await Promise.all([runTelegramNewsJobOnce(now), runTelegramNewsJobOnce(now)]);
      expect(results.filter(result => !result.skipped).length).toBe(1);
      expect(results.filter(result => result.skipped).length).toBe(1);

      const posts = await prisma.telegramNewsPost.findMany({ where: { slotKey: '2026-05-22:09:00' } });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        status: 'sent',
        recipientCount: 1,
        failedCount: 0,
      });

      const repeat = await runTelegramNewsJobOnce(now);
      expect(repeat).toMatchObject({ skipped: true, reason: 'already_sent', slotKey: '2026-05-22:09:00' });
      await expect(prisma.telegramNewsPost.count({ where: { slotKey: '2026-05-22:09:00' } })).resolves.toBe(1);
    } finally {
      Object.assign(env, originalNewsEnv);
    }
  });

  it('exposes operations health, metrics and csrf error codes', async () => {
    const liveResponse = await request(app).get('/health/live');
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.ok).toBe(true);

    const readyResponse = await request(app).get('/health/ready');
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body.ok).toBe(true);
    expect(readyResponse.body.checks.database.ok).toBe(true);
    expect(readyResponse.body.checks.smtp).toBeUndefined();

    const dependencyResponse = await request(app).get('/health/dependencies');
    expect(dependencyResponse.status).toBe(503);
    expect(dependencyResponse.body).toEqual({
      ok: false,
      status: 'degraded',
    });

    const dependencyDetailsResponse = await request(app).get('/health/dependencies/details');
    expect(dependencyDetailsResponse.status).toBe(503);
    expect(dependencyDetailsResponse.body.checks.smtp.ok).toBe(false);
    expect(dependencyDetailsResponse.body.checks.workerSubsystems).toMatchObject({
      ok: false,
      missing: ['reminders'],
    });

    const bodyExchangeCsrfResponse = await request(app)
      .post('/api/registration/exchange')
      .send({ token: 'not-a-real-token-12345678901234567890' });
    expect(bodyExchangeCsrfResponse.status).toBe(403);
    expect(bodyExchangeCsrfResponse.body).toMatchObject({ ok: false, code: 'csrf_invalid' });

    const legacyExchangeCsrfResponse = await request(app)
      .post('/api/registration/exchange/not-a-real-token-12345678901234567890')
      .send({});
    expect(legacyExchangeCsrfResponse.status).toBe(403);
    expect(legacyExchangeCsrfResponse.body).toMatchObject({ ok: false, code: 'csrf_invalid' });

    const metricsResponse = await request(app).get('/metrics');
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.text).toContain('aspb_http_requests_total');
    expect(metricsResponse.text).toContain('aspb_queue_depth');

    const originalNodeEnv = env.NODE_ENV;
    const originalMetricsToken = env.METRICS_TOKEN;
    env.NODE_ENV = 'production';
    env.METRICS_TOKEN = 'test-metrics-token-123456';
    try {
      const missingTokenResponse = await request(app).get('/metrics');
      expect(missingTokenResponse.status).toBe(401);

      const invalidTokenResponse = await request(app)
        .get('/metrics')
        .set('authorization', 'Bearer wrong-metrics-token');
      expect(invalidTokenResponse.status).toBe(403);

      const missingDependencyTokenResponse = await request(app).get('/health/dependencies/details');
      expect(missingDependencyTokenResponse.status).toBe(401);

      const validDependencyTokenResponse = await request(app)
        .get('/health/dependencies/details')
        .set('authorization', `Bearer ${env.METRICS_TOKEN}`);
      expect(validDependencyTokenResponse.status).toBe(503);
      expect(validDependencyTokenResponse.body.checks.smtp.ok).toBe(false);

      const validTokenResponse = await request(app).get('/metrics').set('authorization', `Bearer ${env.METRICS_TOKEN}`);
      expect(validTokenResponse.status).toBe(200);
      expect(validTokenResponse.text).toContain('aspb_http_requests_total');
    } finally {
      env.NODE_ENV = originalNodeEnv;
      env.METRICS_TOKEN = originalMetricsToken;
    }
  });

  it('applies the versioned retention policy and records proof of execution', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const old = new Date('2022-01-01T00:00:00.000Z');
    const inactiveLead = await prisma.lead.create({
      data: {
        name: 'Старый лид',
        phone: '+79990000000',
        email: 'retention-old@aspb.ru',
        consent: true,
        source: 'old-campaign',
        utmSource: 'old-source',
        createdAt: old,
        updatedAt: old,
      },
    });
    await prisma.event.create({
      data: {
        eventName: 'page_view',
        visitorId: 'retention_visitor_identifier_1234567890',
        source: 'old-campaign',
        createdAt: old,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: 'retention.test',
        entityType: 'test',
        ipHash: 'old-ip-hash',
        userAgent: 'old-user-agent',
        createdAt: old,
      },
    });
    const terminalEmailJob = await prisma.emailOutboxJob.create({
      data: {
        type: 'participant_access_login',
        status: 'dead_letter',
        toEmail: 'expired-dead-letter@aspb.ru',
        toName: 'Устаревший адресат',
        scheduledAt: old,
        webinarUrl: 'redacted://email-link',
        attempts: 10,
        lastError: '550 mailbox expired-dead-letter@aspb.ru does not exist',
        nextAttemptAt: null,
        createdAt: old,
        updatedAt: old,
      },
    });
    await prisma.emailOutboxDeadLetter.create({
      data: {
        jobId: terminalEmailJob.id,
        reason: '550 mailbox expired-dead-letter@aspb.ru does not exist',
        payloadJson: { registrationId: 'expired-registration-id', attempts: 10 },
        createdAt: old,
      },
    });

    const result = await applyRetentionPolicy(now);
    expect(result.detailedEventsDeleted).toBe(1);
    expect(result.auditTechnicalTracesCleared).toBe(1);
    expect(result.leadsAnonymized).toBe(1);
    expect(result.terminalEmailJobsDeleted).toBe(1);
    expect(result.terminalEmailDeadLettersDeleted).toBe(1);
    await expect(prisma.emailOutboxJob.findUnique({ where: { id: terminalEmailJob.id } })).resolves.toBeNull();
    await expect(
      prisma.emailOutboxDeadLetter.findUnique({ where: { jobId: terminalEmailJob.id } }),
    ).resolves.toBeNull();

    const anonymizedLead = await prisma.lead.findUniqueOrThrow({ where: { id: inactiveLead.id } });
    expect(anonymizedLead).toMatchObject({
      name: 'Удалённый пользователь',
      phone: '',
      consent: false,
      marketingConsent: false,
      source: null,
      utmSource: null,
    });
    expect(anonymizedLead.email).toBe(`anonymized-${inactiveLead.id}@deleted.invalid`);

    const retentionRun = await prisma.retentionRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(retentionRun).toMatchObject({
      status: 'completed',
      policyVersion: RETENTION_POLICY_VERSION,
    });
    expect(retentionRun.completedAt).toBeInstanceOf(Date);
    expect(retentionRun.resultJson).toMatchObject({ leadsAnonymized: 1 });
  });

  it('anonymizes abandoned pending verification data after its confirmation links expire', async () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const pendingSince = new Date('2026-06-01T12:00:00.000Z');
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Pending retention session',
        scheduledAt: new Date('2026-06-02T16:30:00.000Z'),
        status: 'finished',
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Неподтверждённый лид',
        phone: '+79990001122',
        email: 'expired-pending@aspb.ru',
        consent: false,
        marketingConsent: false,
        marketingEmailConsent: false,
        marketingTelegramConsent: false,
        createdAt: pendingSince,
        updatedAt: pendingSince,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        accessTokenHash: hashToken(createAccessToken()),
        status: 'pending_verification',
        emailVerifiedAt: null,
        pendingMetadataJson: { clientsProblem: 'Содержит временные персональные сведения' },
        registeredAt: pendingSince,
      },
    });
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(createAccessToken()),
        purpose: 'registration',
        expiresAt: new Date('2026-07-20T12:00:00.000Z'),
      },
    });
    await prisma.consentRecord.create({
      data: {
        ...consentEvidenceData(PERSONAL_DATA_CONSENT, {
          leadId: lead.id,
          registrationId: registration.id,
          email: lead.email,
          kind: 'personal_data',
          sourceForm: 'integration-test',
          req: { headers: { 'user-agent': 'vitest' }, socket: {} },
          occurredAt: pendingSince,
        }),
        action: 'pending_verification',
      },
    });
    await prisma.legalAcceptance.create({
      data: legalAcceptanceEvidenceData({
        leadId: lead.id,
        registrationId: registration.id,
        email: lead.email,
        sourceForm: 'integration-test',
        req: { headers: { 'user-agent': 'vitest' }, socket: {} },
        acceptedAt: pendingSince,
      }),
    });
    await enqueueRegistrationEmail(prisma, {
      registrationId: registration.id,
      webinarSessionId: session.id,
      toEmail: lead.email,
      toName: lead.name,
      scheduledAt: session.scheduledAt,
    });

    const result = await applyRetentionPolicy(now);
    expect(result.pendingVerificationLeadsAnonymized).toBe(1);
    // Compliance evidence remains immutable and follows its own documented
    // legal-retention term; operational participant PII is anonymized below.
    await expect(prisma.consentRecord.count({ where: { registrationId: registration.id } })).resolves.toBe(1);
    await expect(prisma.legalAcceptance.count({ where: { registrationId: registration.id } })).resolves.toBe(1);
    const retainedRegistration = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
    expect(retainedRegistration).toMatchObject({ status: 'anonymized', pendingMetadataJson: null });
    const retainedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(retainedLead.email).toBe(`anonymized-${lead.id}@deleted.invalid`);
    const retainedJob = await prisma.emailOutboxJob.findFirstOrThrow({ where: { registrationId: registration.id } });
    expect(retainedJob).toMatchObject({
      status: 'cancelled',
      toEmail: `anonymized-${lead.id}@deleted.invalid`,
      webinarUrl: 'redacted://email-link',
      partnerUrl: null,
    });
  });

  it('returns validated scripted chat messages for the current room session', async () => {
    setTestNow(new Date('2026-06-11T16:32:00.000Z'));
    const scheduledAt = getDailyBroadcastDate(new Date());
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Scripted chat test webinar',
        scheduledAt,
        status: 'live',
        videoDurationSeconds: 3860,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Чат Тест',
        phone: '+79990002233',
        email: 'chat-scripted@aspb.ru',
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
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await request(app)
      .get('/api/webinar/chat/session/current')
      .set('Cookie', [`aspb_room_token=${sessionToken}`]);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.headers['cache-control']).toContain('max-age=4');
    expect(response.body.messages.length).toBeGreaterThan(0);
    expect(response.body.messages.some((message: any) => message.kind === 'prepared_question')).toBe(true);
    expect(response.body.messages.every((message: any) => message.offsetSeconds <= 3860)).toBe(true);
    const scriptedQuestion = response.body.messages.find((message: any) => message.kind === 'prepared_question');
    expect(scriptedQuestion).toMatchObject({
      id: expect.any(String),
      authorName: expect.any(String),
      authorRole: 'подготовленный вопрос',
      message: expect.any(String),
    });
    expect(scriptedQuestion).not.toHaveProperty('agentId');
    expect(scriptedQuestion).not.toHaveProperty('answerStartSeconds');
    expect(scriptedQuestion).not.toHaveProperty('topic');
    expect(scriptedQuestion).not.toHaveProperty('isSynthetic');
  });

  it('keeps the ASPB bootstrap tenant and legacy webinar creation compatible', async () => {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: DEFAULT_ORGANIZATION_ID },
    });
    const systemUser = await prisma.user.findUniqueOrThrow({
      where: { id: DEFAULT_SYSTEM_OWNER_USER_ID },
    });
    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: DEFAULT_ORGANIZATION_ID,
          userId: DEFAULT_SYSTEM_OWNER_USER_ID,
        },
      },
    });
    expect(organization).toMatchObject({ slug: 'aspb', status: 'ACTIVE' });
    expect(systemUser).toMatchObject({ kind: 'SYSTEM', status: 'ACTIVE' });
    expect(membership).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });

    const legacySession = await prisma.webinarSession.create({
      data: {
        title: 'Legacy create without tenant input',
        scheduledAt: new Date('2030-01-01T10:00:00.000Z'),
      },
    });
    expect(legacySession.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
  });

  it('selects an active organization explicitly and keeps AdminUser outside tenant identity', async () => {
    const primary = await createTenantFixture({ slug: 'tenant-context-a', email: 'shared@example.test' });
    const secondaryOrganization = await prisma.organization.create({
      data: { name: 'TENANT CONTEXT B', slug: 'tenant-context-b', status: 'ACTIVE' },
    });
    const secondaryMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: secondaryOrganization.id,
        userId: primary.user.id,
        role: 'ANALYST',
        status: 'ACTIVE',
      },
    });
    const platformAdmin = await prisma.adminUser.create({
      data: {
        name: 'Independent platform operator',
        email: primary.user.emailNormalized,
        passwordHash: 'not-used-in-this-test',
        role: 'owner',
      },
    });

    await expect(resolveTenantContext(prisma, { userId: primary.user.id })).rejects.toMatchObject({
      statusCode: 401,
      code: 'tenant_context_required',
    });
    const primaryContext = await resolveTenantContext(prisma, {
      userId: primary.user.id,
      activeOrganizationId: primary.organization.id,
      correlationId: 'req_tenant_context_primary',
    });
    const secondaryContext = await resolveTenantContext(prisma, {
      userId: primary.user.id,
      activeOrganizationId: secondaryOrganization.id,
      correlationId: 'req_tenant_context_secondary',
    });
    expect(primaryContext).toMatchObject({
      organizationId: primary.organization.id,
      membershipId: primary.membership.id,
      role: 'OWNER',
    });
    expect(secondaryContext).toMatchObject({
      organizationId: secondaryOrganization.id,
      membershipId: secondaryMembership.id,
      role: 'ANALYST',
    });
    expect(platformAdmin.id).not.toBe(primary.user.id);
    await expect(
      resolveTenantContext(prisma, {
        userId: platformAdmin.id,
        activeOrganizationId: primary.organization.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'tenant_context_unavailable' });
  });

  it('returns the same safe 404 for cross-tenant session read and write', async () => {
    const tenantA = await createTenantFixture({ slug: 'isolation-a', email: 'owner-a@example.test' });
    const tenantB = await createTenantFixture({ slug: 'isolation-b', email: 'owner-b@example.test' });
    const sessionA = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        title: 'Tenant A webinar',
        scheduledAt: new Date('2030-02-01T10:00:00.000Z'),
      },
    });
    const sessionB = await prisma.webinarSession.create({
      data: {
        organizationId: tenantB.organization.id,
        title: 'Tenant B webinar',
        scheduledAt: new Date('2030-02-02T10:00:00.000Z'),
      },
    });
    const contextA = await resolveTenantContext(prisma, {
      userId: tenantA.user.id,
      activeOrganizationId: tenantA.organization.id,
      correlationId: 'req_tenant_isolation_a',
    });

    await expect(getTenantWebinarSession(prisma, contextA, sessionA.id)).resolves.toMatchObject({
      id: sessionA.id,
      organizationId: tenantA.organization.id,
    });
    await expect(getTenantWebinarSession(prisma, contextA, sessionB.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'tenant_resource_not_found',
    });
    await expect(
      updateTenantWebinarSessionTitle(prisma, contextA, {
        webinarSessionId: sessionA.id,
        title: 'Client-forged tenant field',
        organizationId: tenantB.organization.id,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      updateTenantWebinarSessionTitle(prisma, contextA, {
        webinarSessionId: sessionB.id,
        title: 'Forged cross-tenant update',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'tenant_resource_not_found' });
    await expect(prisma.webinarSession.findUniqueOrThrow({ where: { id: sessionB.id } })).resolves.toMatchObject({
      title: 'Tenant B webinar',
    });
    await expect(
      resolveTenantContext(prisma, {
        userId: tenantA.user.id,
        activeOrganizationId: tenantB.organization.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'tenant_context_unavailable' });
  });

  it('audits membership changes, hides foreign members, and preserves the last available human owner', async () => {
    const tenantA = await createTenantFixture({ slug: 'members-a', email: 'members-owner-a@example.test' });
    const memberUser = await prisma.user.create({
      data: { emailNormalized: 'member-a@example.test', status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const member = await prisma.organizationMembership.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: memberUser.id,
        role: 'AUTHOR',
        status: 'ACTIVE',
      },
    });
    const tenantB = await createTenantFixture({ slug: 'members-b', email: 'members-owner-b@example.test' });
    const contextA = await resolveTenantContext(prisma, {
      userId: tenantA.user.id,
      activeOrganizationId: tenantA.organization.id,
      correlationId: 'req_membership_audit_123',
    });

    await expect(
      updateOrganizationMembershipRole(prisma, contextA, {
        membershipId: member.id,
        role: 'MODERATOR',
        organizationId: tenantB.organization.id,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      updateOrganizationMembershipRole(prisma, contextA, {
        membershipId: member.id,
        role: 'MODERATOR',
      }),
    ).resolves.toMatchObject({ role: 'MODERATOR' });
    const roleAudit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: member.id, action: 'organization_membership.role_changed' },
    });
    expect(roleAudit).toMatchObject({
      userId: tenantA.user.id,
      organizationId: tenantA.organization.id,
      correlationId: 'req_membership_audit_123',
      beforeJson: expect.objectContaining({ role: 'AUTHOR' }),
      afterJson: expect.objectContaining({ role: 'MODERATOR' }),
    });

    const auditCountBeforeForeignAttempt = await prisma.auditLog.count();
    await expect(
      updateOrganizationMembershipRole(prisma, contextA, {
        membershipId: tenantB.membership.id,
        role: 'AUTHOR',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'organization_membership_not_found' });
    await expect(prisma.auditLog.count()).resolves.toBe(auditCountBeforeForeignAttempt);
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: tenantB.membership.id } }),
    ).resolves.toMatchObject({ role: 'OWNER' });

    await expect(removeOrganizationMembership(prisma, contextA, { membershipId: member.id })).resolves.toMatchObject({
      status: 'REMOVED',
      removedAt: expect.any(Date),
    });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: member.id, action: 'organization_membership.removed' },
      }),
    ).resolves.toMatchObject({
      userId: tenantA.user.id,
      organizationId: tenantA.organization.id,
      correlationId: 'req_membership_audit_123',
    });

    const rejectedAuditCountBefore = await prisma.auditLog.count({
      where: { entityId: tenantA.membership.id },
    });
    await expect(
      updateOrganizationMembershipRole(prisma, contextA, {
        membershipId: tenantA.membership.id,
        role: 'AUTHOR',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
    await expect(
      removeOrganizationMembership(prisma, contextA, { membershipId: tenantA.membership.id }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: tenantA.membership.id } }),
    ).resolves.toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    await expect(prisma.auditLog.count({ where: { entityId: tenantA.membership.id } })).resolves.toBe(
      rejectedAuditCountBefore,
    );
  });

  it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
    'does not count a second owner whose User is %s as available',
    async userStatus => {
      const suffix = userStatus.toLowerCase();
      const tenant = await createTenantFixture({
        slug: `unavailable-owner-${suffix}`,
        email: `available-${suffix}@example.test`,
      });
      const unavailableOwner = await addHumanOwner(
        tenant.organization.id,
        `unavailable-${suffix}@example.test`,
        userStatus,
      );
      const context = await resolveTenantContext(prisma, {
        userId: tenant.user.id,
        activeOrganizationId: tenant.organization.id,
        correlationId: `req_unavailable_owner_${suffix}`,
      });
      const auditCountBefore = await prisma.auditLog.count();

      await expect(
        updateOrganizationMembershipRole(prisma, context, {
          membershipId: tenant.membership.id,
          role: 'AUTHOR',
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
      await expect(
        removeOrganizationMembership(prisma, context, { membershipId: tenant.membership.id }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
      await expect(
        prisma.organizationMembership.findUniqueOrThrow({ where: { id: tenant.membership.id } }),
      ).resolves.toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
      await expect(
        prisma.organizationMembership.findUniqueOrThrow({ where: { id: unavailableOwner.membership.id } }),
      ).resolves.toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
      await expect(prisma.auditLog.count()).resolves.toBe(auditCountBefore);
    },
  );

  it('does not let the ASPB SYSTEM owner mask removal of the last HUMAN owner', async () => {
    const humanOwner = await addHumanOwner(DEFAULT_ORGANIZATION_ID, 'aspb-human-owner@example.test');
    const context = await resolveTenantContext(prisma, {
      userId: humanOwner.user.id,
      activeOrganizationId: DEFAULT_ORGANIZATION_ID,
      correlationId: 'req_aspb_system_owner_guard',
    });
    const auditCountBefore = await prisma.auditLog.count();

    await expect(
      updateOrganizationMembershipRole(prisma, context, {
        membershipId: humanOwner.membership.id,
        role: 'AUTHOR',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
    await expect(
      removeOrganizationMembership(prisma, context, { membershipId: humanOwner.membership.id }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'last_organization_owner' });
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: humanOwner.membership.id } }),
    ).resolves.toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    await expect(prisma.auditLog.count()).resolves.toBe(auditCountBefore);
  });

  it('allows one of two available HUMAN owners to be demoted or removed', async () => {
    const tenant = await createTenantFixture({ slug: 'two-human-owners', email: 'two-owner-a@example.test' });
    const second = await addHumanOwner(tenant.organization.id, 'two-owner-b@example.test');
    const context = await resolveTenantContext(prisma, {
      userId: tenant.user.id,
      activeOrganizationId: tenant.organization.id,
      correlationId: 'req_two_human_owners',
    });

    await expect(
      updateOrganizationMembershipRole(prisma, context, {
        membershipId: second.membership.id,
        role: 'AUTHOR',
      }),
    ).resolves.toMatchObject({ role: 'AUTHOR' });
    await expect(
      updateOrganizationMembershipRole(prisma, context, {
        membershipId: second.membership.id,
        role: 'OWNER',
      }),
    ).resolves.toMatchObject({ role: 'OWNER' });
    await expect(
      removeOrganizationMembership(prisma, context, { membershipId: second.membership.id }),
    ).resolves.toMatchObject({ status: 'REMOVED' });
    await expect(
      prisma.organizationMembership.count({
        where: {
          organizationId: tenant.organization.id,
          role: 'OWNER',
          status: 'ACTIVE',
          user: { kind: 'HUMAN', status: 'ACTIVE' },
        },
      }),
    ).resolves.toBe(1);
  });

  it.each([
    ['demotion', 'demotion'],
    ['removal', 'removal'],
    ['demotion', 'removal'],
  ] as const)(
    'serializes concurrent owner %s/%s so one available HUMAN owner remains',
    async (firstAction, secondAction) => {
      const slug = `owner-race-${firstAction}-${secondAction}`;
      const first = await createTenantFixture({ slug, email: `${slug}-a@example.test` });
      const second = await addHumanOwner(first.organization.id, `${slug}-b@example.test`);
      const firstContext = await resolveTenantContext(prisma, {
        userId: first.user.id,
        activeOrganizationId: first.organization.id,
        correlationId: 'req_owner_race_first',
      });
      const secondContext = await resolveTenantContext(prisma, {
        userId: second.user.id,
        activeOrganizationId: first.organization.id,
        correlationId: 'req_owner_race_second',
      });

      const mutate = (
        action: 'demotion' | 'removal',
        context: Awaited<ReturnType<typeof resolveTenantContext>>,
        membershipId: string,
      ) =>
        action === 'demotion'
          ? updateOrganizationMembershipRole(prisma, context, { membershipId, role: 'AUTHOR' })
          : removeOrganizationMembership(prisma, context, { membershipId });

      const results = await Promise.allSettled([
        mutate(firstAction, firstContext, first.membership.id),
        mutate(secondAction, secondContext, second.membership.id),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        statusCode: 409,
        code: 'last_organization_owner',
      });
      await expect(
        prisma.organizationMembership.count({
          where: {
            organizationId: first.organization.id,
            role: 'OWNER',
            status: 'ACTIVE',
            user: { kind: 'HUMAN', status: 'ACTIVE' },
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.auditLog.count({
          where: {
            organizationId: first.organization.id,
            action: { in: ['organization_membership.role_changed', 'organization_membership.removed'] },
          },
        }),
      ).resolves.toBe(1);
    },
  );
});
