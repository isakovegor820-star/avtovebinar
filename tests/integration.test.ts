process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
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
import { runEmailOutboxJobOnce } from '../src/lib/emailOutbox.js';
import { runReplayFollowupJobOnce } from '../src/lib/reminders.js';
import { handleParticipantTelegramUpdate } from '../src/lib/telegramParticipantBot.js';
import { runTelegramNewsJobOnce } from '../src/lib/telegramNews.js';
import { getDailyBroadcastDate } from '../src/lib/time.js';

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

function setTestNow(value: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(value);
}

async function loginAdmin(role: string, email: string) {
  const password = `Test${role}Password123`;
  const admin = await prisma.adminUser.create({
    data: {
      name: email,
      email,
      passwordHash: await hashPassword(password),
      role,
      isActive: true,
    },
  });
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  const loginResponse = await agent.post('/api/admin/login').set('x-csrf-token', csrfToken).send({
    login: email,
    password,
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
    },
  });

  return { lead, registration, webinarSession };
}

beforeAll(async () => {
  // Sync prisma schema into 'test' PostgreSQL schema
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
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
  });
  // Truncate tables to guarantee absolute test isolation
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, telegram_broadcast_jobs, telegram_broadcast_dead_letters, telegram_news_posts, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages CASCADE;',
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('critical path integration scenarios', () => {
  it('runs the full critical path integration scenario', async () => {
    const userAgent = request.agent(app);

    // 0. Seed a default admin user. Webinar session will be created automatically by /api/register
    // through findOrCreateWebinarSession(getDailyBroadcastDate(firstSeenAt)).
    // We must NOT pre-create a webinar session here, otherwise /api/register may create a second
    // one with a different scheduledAt, and later updateMany() will violate the unique constraint
    // on scheduled_at.
    const adminPasswordHash = await hashPassword('TestAdminPassword123');
    const admin = await prisma.adminUser.create({
      data: {
        name: 'testadmin',
        email: 'testadmin@aspb.ru',
        passwordHash: adminPasswordHash,
        role: 'admin',
        isActive: true,
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
      consent: true,
      marketingConsent: true,
      utmSource: 'yandex',
      utmMedium: 'cpc',
    });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.ok).toBe(true);
    expect(registerResponse.body.token).toBeUndefined();
    expect(registerResponse.body.successUrl).not.toContain('token=');
    expect(registerResponse.body.webinarUrl).not.toContain('token=');
    expect(registerResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const initialEmailJobs = await prisma.emailOutboxJob.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(initialEmailJobs.length).toBe(1);
    expect(initialEmailJobs[0].type).toBe('registration_confirmation');
    expect(initialEmailJobs[0].status).toBe('pending');
    expect(initialEmailJobs[0].webinarUrl).toContain('/crisis_premium/webinar.html#token=');
    expect(initialEmailJobs[0].partnerUrl).toContain('/crisis_premium/webinar.html#token=');
    expect(new URLSearchParams(new URL(initialEmailJobs[0].partnerUrl!).hash.replace(/^#/, '')).get('anchor')).toBe(
      'partnerApplication',
    );

    // Check lead insertion
    const lead = await prisma.lead.findUnique({
      where: { email: 'alex.test@aspb.ru' },
    });
    expect(lead).toBeDefined();
    expect(lead?.name).toBe('Алексей Тестовый');
    expect(lead?.marketingConsent).toBe(true);

    // Re-submitting the same form for the same webinar refreshes access but does not create a duplicate registration.
    const repeatRegisterResponse = await userAgent.post('/api/register').set('x-csrf-token', userCsrfToken).send({
      name: 'Алексей Тестовый',
      phone: '+79998887766',
      email: 'alex.test@aspb.ru',
      city: 'Москва',
      professionalStatus: 'Юрист',
      consent: true,
      marketingConsent: true,
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
    expect(accessTokenCount).toBeGreaterThanOrEqual(4);

    const tokenPurposes = await prisma.registrationToken.findMany({
      where: { registrationId: registrationsAfterRepeat[0].id },
      select: { purpose: true },
      orderBy: { purpose: 'asc' },
    });
    expect(tokenPurposes.filter(item => item.purpose === 'room_session').length).toBe(1);
    expect(tokenPurposes.filter(item => item.purpose === 'registration').length).toBeGreaterThanOrEqual(2);
    expect(tokenPurposes.filter(item => item.purpose === 'telegram_start').length).toBe(1);

    const activeConfirmationJobsAfterRepeat = await prisma.emailOutboxJob.findMany({
      where: {
        registrationId: registrationsAfterRepeat[0].id,
        type: 'registration_confirmation',
        status: { in: ['pending', 'failed'] },
      },
    });
    expect(activeConfirmationJobsAfterRepeat.length).toBe(1);
    expect(activeConfirmationJobsAfterRepeat[0].webinarUrl).toContain(
      'http://127.0.0.1:5174/crisis_premium/webinar.html#token=',
    );
    expect(
      new URLSearchParams(new URL(activeConfirmationJobsAfterRepeat[0].partnerUrl!).hash.replace(/^#/, '')).get(
        'anchor',
      ),
    ).toBe('partnerApplication');

    const registrationBeforeEmailJob = await prisma.registration.findUnique({
      where: { id: registrationsAfterRepeat[0].id },
    });
    expect(registrationBeforeEmailJob?.emailSentAt).toBeNull();

    const emailJobResult = await runEmailOutboxJobOnce(new Date());
    expect(emailJobResult.sent).toBeGreaterThanOrEqual(1);

    const sentEmailJob = await prisma.emailOutboxJob.findFirst({
      where: { registrationId: registrationsAfterRepeat[0].id, status: 'sent' },
    });
    expect(sentEmailJob?.sentAt).toBeDefined();

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
    // The room is bound to the current daily broadcast slot, so move test time into the 19:00 MSK live window.
    setTestNow(new Date('2026-06-11T16:10:00.000Z'));

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

    const questions = await prisma.question.findMany({
      where: { leadId: lead?.id },
    });
    expect(questions.length).toBe(1);
    expect(questions[0].text).toBe('Каковы особенности процедуры банкротства юрлиц?');

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
    const exchangeToken = getExchangeTokenFromUrl(activeConfirmationJobsAfterRepeat[0].webinarUrl);
    const legacyExchangeToken = getExchangeTokenFromUrl(activeConfirmationJobsAfterRepeat[0].partnerUrl ?? '');
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
    const loginResponse = await adminAgent.post('/api/admin/login').set('x-csrf-token', adminCsrfToken).send({
      login: 'testadmin',
      password: 'TestAdminPassword123',
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
    expect(foundReg.questionCount).toBe(1);
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
  });

  it('restores participant access with a passwordless email magic link', async () => {
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
      message: expect.stringContaining('Если этот email зарегистрирован'),
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
    expect(loginJobs[0].webinarUrl).toContain('/crisis_premium/access.html#token=');

    const magicToken = getExchangeTokenFromUrl(loginJobs[0].webinarUrl);
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
    expect(accessResponse.body.webinar.id).not.toBe(webinarSession.id);
    expect(accessResponse.body.webinar.scheduledAt).toBe(getDailyBroadcastDate(new Date()).toISOString());
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

  it('restores old registrations and keeps published recordings available before the daily broadcast', async () => {
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
    const magicToken = getExchangeTokenFromUrl(loginJob.webinarUrl);
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
        consent: true,
      });

      expect(registerResponse.status).toBe(201);
      expect(registerResponse.body.telegramBotUrl).toContain('https://t.me/aspb_participant_bot?start=');
      const telegramStartToken = new URL(registerResponse.body.telegramBotUrl).searchParams.get('start');
      expect(telegramStartToken).toEqual(expect.any(String));
      if (!telegramStartToken) throw new Error('Expected Telegram start token');

      const registrationId = registerResponse.body.registration.id as string;
      const telegramTokenRecord = await prisma.registrationToken.findUnique({
        where: { tokenHash: hashToken(telegramStartToken) },
      });
      expect(telegramTokenRecord?.purpose).toBe('telegram_start');

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
      await expect(
        prisma.registrationToken.findUnique({ where: { tokenHash: hashToken(telegramStartToken) } }),
      ).resolves.toBeNull();

      await handleParticipantTelegramUpdate({
        update_id: 2,
        message: {
          message_id: 2,
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
        update_id: 3,
        message: {
          message_id: 3,
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
      data: { telegramChatId: '123456789' },
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

  it('requires CSRF for registration and ignores honeypot submissions', async () => {
    const userAgent = request.agent(app);
    const csrfToken = await getCsrfToken(userAgent);

    const missingHeaderResponse = await userAgent.post('/api/register').send({
      name: 'Без CSRF',
      phone: '+79990001122',
      email: 'missing-csrf@aspb.ru',
      consent: true,
    });
    expect(missingHeaderResponse.status).toBe(403);
    expect(missingHeaderResponse.body).toMatchObject({ ok: false, code: 'csrf_invalid' });

    const honeypotResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Spam Bot',
      phone: '+79990001123',
      email: 'spam-bot@aspb.ru',
      companyWebsite: 'https://spam.example.com',
      consent: true,
    });
    expect(honeypotResponse.status).toBe(202);
    expect(honeypotResponse.body.ok).toBe(true);

    await expect(prisma.lead.findUnique({ where: { email: 'spam-bot@aspb.ru' } })).resolves.toBeNull();
    await expect(prisma.registration.count()).resolves.toBe(0);
    await expect(prisma.emailOutboxJob.count()).resolves.toBe(0);
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

    const failingRun = await runEmailOutboxJobOnce(new Date('2026-05-21T09:00:00.000Z'), {
      sendRegistrationEmail: async () => {
        throw new Error('SMTP temporarily unavailable');
      },
    });
    expect(failingRun.failed).toBe(1);

    const failedJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(failedJob.status).toBe('failed');
    expect(failedJob.attempts).toBe(1);
    expect(failedJob.lastError).toContain('SMTP temporarily unavailable');
    expect(failedJob.sentAt).toBeNull();

    const retryRun = await runEmailOutboxJobOnce(new Date('2026-05-21T09:03:00.000Z'), {
      sendRegistrationEmail: async () => ({ sent: true, mode: 'send' as const }),
    });
    expect(retryRun.sent).toBe(1);

    const retriedJob = await prisma.emailOutboxJob.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(retriedJob.status).toBe('sent');
    expect(retriedJob.attempts).toBe(2);
    expect(retriedJob.sentAt).toBeDefined();
  });

  it('replaces stale pending and failed registration confirmation jobs on repeat registration', async () => {
    const userAgent = request.agent(app);
    const csrfToken = await getCsrfToken(userAgent);
    const email = 'repeat-outbox@aspb.ru';

    const firstResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Повторная Регистрация',
      phone: '+79990003344',
      email,
      city: 'Москва',
      professionalStatus: 'Юрист',
      consent: true,
      marketingConsent: true,
    });
    expect(firstResponse.status).toBe(201);

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
        webinarUrl: 'http://127.0.0.1:5174/crisis_premium/webinar.html?legacy=already-sent',
        sentAt: new Date(),
        attempts: 1,
      },
    });

    const repeatResponse = await userAgent.post('/api/register').set('x-csrf-token', csrfToken).send({
      name: 'Повторная Регистрация',
      phone: '+79990003344',
      email,
      city: 'Москва',
      professionalStatus: 'Юрист',
      consent: true,
      marketingConsent: true,
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
    expect(activeJobs[0].webinarUrl).toContain('http://127.0.0.1:5174/crisis_premium/webinar.html#token=');
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0].webinarUrl).toContain('already-sent');
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

  it('serves published recordings to registered account sessions only', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const anonymousResponse = await request(app).get('/api/recordings');
    expect(anonymousResponse.status).toBe(401);

    const endedSession = await prisma.webinarSession.create({
      data: {
        title: 'Прошедший вебинар',
        scheduledAt: new Date('2026-05-22T08:00:00.000Z'),
        durationMinutes: 120,
        videoDurationSeconds: 3600,
        videoUrl: '/crisis_premium/assets/webinar.mp4',
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
        visible: true,
        publishedAt: new Date('2026-05-22T10:05:00.000Z'),
        durationSeconds: 3600,
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
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: 'room_session',
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
      src: '/crisis_premium/assets/webinar.mp4',
      poster: '/crisis_premium/assets/webinar-poster.jpg',
      durationSeconds: 3600,
    });

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
  });

  it('does not expose room media before the daily broadcast and closes room replay after it ends', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const dailyScheduledAt = getDailyBroadcastDate(new Date());
    const registrationSession = await prisma.webinarSession.create({
      data: {
        title: 'Media gated webinar',
        scheduledAt: new Date('2026-06-01T16:00:00.000Z'),
        status: 'scheduled',
        videoDurationSeconds: 600,
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
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: 'room_session',
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

    setTestNow(new Date('2026-06-11T16:02:00.000Z'));
    const liveResponse = await request(app).get('/api/webinar/timeline/session/current').set('Cookie', accountCookie);
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.accessStatus).toBe('live');
    expect(liveResponse.body.liveState.scheduledAt).toBe(dailyScheduledAt.toISOString());
    expect(liveResponse.body.video).toMatchObject({
      src: '/crisis_premium/assets/webinar.mp4',
      expected: true,
    });
    expect(liveResponse.body.timeline).toBeDefined();

    setTestNow(new Date('2026-06-11T18:00:00.000Z'));
    const afterBroadcastResponse = await request(app)
      .get('/api/webinar/timeline/session/current')
      .set('Cookie', accountCookie);
    expect(afterBroadcastResponse.status).toBe(200);
    expect(afterBroadcastResponse.body.accessStatus).toBe('waiting');
    expect(afterBroadcastResponse.body.liveState.scheduledAt).toBe('2026-06-12T16:00:00.000Z');
    expect(afterBroadcastResponse.body.video).toBeUndefined();
    expect(afterBroadcastResponse.body.timeline).toBeUndefined();
  });

  it('keeps room timeline and chat bound to the current daily broadcast, not the old registration session', async () => {
    setTestNow(new Date('2026-06-11T16:02:00.000Z'));
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
        purpose: 'room_session',
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
  });

  it('does not expose persisted chat messages before broadcast start', async () => {
    setTestNow(new Date('2026-06-11T12:00:00.000Z'));
    const dailyScheduledAt = getDailyBroadcastDate(new Date());
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
        purpose: 'room_session',
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      },
    });
    const accountCookie = [`aspb_room_token=${sessionToken}`];

    const waitingResponse = await request(app).get('/api/webinar/chat/session/current').set('Cookie', accountCookie);
    expect(waitingResponse.status).toBe(200);
    expect(waitingResponse.body.accessStatus).toBe('waiting');
    expect(waitingResponse.body.liveState.chatStatus).toBe('locked');
    expect(waitingResponse.body.messages).toEqual([]);

    setTestNow(new Date('2026-06-11T16:02:00.000Z'));
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
    await prisma.adminUser.create({
      data: {
        name: 'broadcast-admin',
        email: 'broadcast-admin@aspb.ru',
        passwordHash: adminPasswordHash,
        role: 'admin',
        isActive: true,
      },
    });
    await prisma.lead.create({
      data: {
        name: 'Telegram Lead',
        email: 'telegram-lead@aspb.ru',
        phone: '+79990005566',
        consent: true,
        telegramChatId: '123456',
      },
    });

    const adminAgent = request.agent(app);
    const csrfToken = await getCsrfToken(adminAgent);
    const loginResponse = await adminAgent.post('/api/admin/login').set('x-csrf-token', csrfToken).send({
      login: 'broadcast-admin@aspb.ru',
      password: 'BroadcastAdminPassword123',
    });
    expect(loginResponse.status).toBe(200);

    const response = await adminAgent.post('/api/admin/telegram/broadcast').set('x-csrf-token', csrfToken).send({
      text: 'Новость для участников вебинара',
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
      await prisma.lead.create({
        data: {
          name: 'News Subscriber',
          phone: '+79990009988',
          email: 'news-subscriber@aspb.ru',
          consent: true,
          telegramChatId: '555001',
        },
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
    expect(dependencyResponse.status).toBe(200);
    expect(dependencyResponse.body.checks.smtp.ok).toBe(true);

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

      const validTokenResponse = await request(app).get('/metrics').set('authorization', `Bearer ${env.METRICS_TOKEN}`);
      expect(validTokenResponse.status).toBe(200);
      expect(validTokenResponse.text).toContain('aspb_http_requests_total');
    } finally {
      env.NODE_ENV = originalNodeEnv;
      env.METRICS_TOKEN = originalMetricsToken;
    }
  });

  it('returns validated scripted chat messages for the current room session', async () => {
    setTestNow(new Date('2026-06-11T16:02:00.000Z'));
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
      },
    });
    const sessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(sessionToken),
        purpose: 'room_session',
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
    expect(response.body.messages.some((message: any) => message.kind === 'agent_question')).toBe(true);
    expect(response.body.messages.every((message: any) => message.offsetSeconds <= 3860)).toBe(true);
    expect(response.body.messages[0]).toMatchObject({
      agentId: expect.any(String),
      answerStartSeconds: expect.any(Number),
      topic: expect.any(String),
      isSynthetic: true,
    });
  });
});
