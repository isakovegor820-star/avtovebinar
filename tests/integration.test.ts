process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execSync } from 'node:child_process';
import { app } from '../src/app.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';
import { runEmailOutboxJobOnce } from '../src/lib/emailOutbox.js';
import { runReplayFollowupJobOnce } from '../src/lib/reminders.js';

type TestAgent = ReturnType<typeof request.agent>;

async function getCsrfToken(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  expect(response.body.csrfToken).toEqual(expect.any(String));
  return response.body.csrfToken as string;
}

beforeAll(async () => {
  // Sync prisma schema into 'test' PostgreSQL schema
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'ignore',
  });
});

beforeEach(async () => {
  // Truncate tables to guarantee absolute test isolation
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE leads, registrations, registration_tokens, email_outbox_jobs, telegram_broadcast_jobs, telegram_broadcast_dead_letters, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages CASCADE;',
  );
});

describe('critical path integration scenarios', () => {
  it('runs the full critical path integration scenario', async () => {
    const userAgent = request.agent(app);

    // 0. Seed a default admin user. Webinar session will be created automatically by /api/register
    // through findOrCreateWebinarSession(getNextWebinarDate(firstSeenAt)).
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
    expect(initialEmailJobs[0].webinarUrl).toContain('/crisis_premium/webinar.html?token=');
    expect(initialEmailJobs[0].partnerUrl).toContain('/crisis_premium/webinar.html?token=');
    expect(initialEmailJobs[0].partnerUrl).toContain('#partnerApplication');

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
    expect(accessTokenCount).toBeGreaterThanOrEqual(3);

    const tokenPurposes = await prisma.registrationToken.findMany({
      where: { registrationId: registrationsAfterRepeat[0].id },
      select: { purpose: true },
      orderBy: { purpose: 'asc' },
    });
    expect(tokenPurposes.filter(item => item.purpose === 'room_session').length).toBe(1);
    expect(tokenPurposes.filter(item => item.purpose === 'registration').length).toBeGreaterThanOrEqual(2);

    const activeConfirmationJobsAfterRepeat = await prisma.emailOutboxJob.findMany({
      where: {
        registrationId: registrationsAfterRepeat[0].id,
        type: 'registration_confirmation',
        status: { in: ['pending', 'failed'] },
      },
    });
    expect(activeConfirmationJobsAfterRepeat.length).toBe(1);
    expect(activeConfirmationJobsAfterRepeat[0].webinarUrl).toContain(
      'http://127.0.0.1:5174/crisis_premium/webinar.html?token=',
    );
    expect(activeConfirmationJobsAfterRepeat[0].partnerUrl).toContain('#partnerApplication');

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
    // Move the (unique) webinar session into the past so that the room is "live".
    // We update the single session created by /api/register by id to avoid touching
    // scheduledAt across multiple rows (unique constraint).
    const tenMinutesAgo = new Date();
    tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);

    const sessions = await prisma.webinarSession.findMany();
    expect(sessions.length).toBe(1);
    await prisma.webinarSession.update({
      where: { id: sessions[0].id },
      data: {
        scheduledAt: tenMinutesAgo,
        status: 'live',
      },
    });

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
    const exchangeToken = new URL(activeConfirmationJobsAfterRepeat[0].webinarUrl).searchParams.get('token');
    expect(exchangeToken).toEqual(expect.any(String));
    if (!exchangeToken) {
      throw new Error('Expected email outbox webinar URL to contain an exchange token');
    }
    const exchangeAgent = request.agent(app);
    const exchangeCsrfToken = await getCsrfToken(exchangeAgent);
    const exchangeResponse = await exchangeAgent
      .post(`/api/registration/exchange/${exchangeToken}`)
      .set('x-csrf-token', exchangeCsrfToken)
      .send({});
    expect(exchangeResponse.status).toBe(200);
    expect(exchangeResponse.body.token).toBeUndefined();
    expect(exchangeResponse.body.webinarUrl).not.toContain('token=');
    expect(exchangeResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const repeatExchangeAgent = request.agent(app);
    const repeatExchangeCsrfToken = await getCsrfToken(repeatExchangeAgent);
    const repeatExchangeResponse = await repeatExchangeAgent
      .post(`/api/registration/exchange/${exchangeToken}`)
      .set('x-csrf-token', repeatExchangeCsrfToken)
      .send({});
    expect(repeatExchangeResponse.status).toBe(404);

    const exchangedSessionResponse = await exchangeAgent.get('/api/registration/session/current?view=success');
    expect(exchangedSessionResponse.status).toBe(200);
    expect(exchangedSessionResponse.body.lead.email).toBe('alex.test@aspb.ru');

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
    expect(activeJobs[0].webinarUrl).toContain('http://127.0.0.1:5174/crisis_premium/webinar.html?token=');
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

    const csrfResponse = await request(app)
      .post('/api/registration/exchange/not-a-real-token-12345678901234567890')
      .send({});
    expect(csrfResponse.status).toBe(403);
    expect(csrfResponse.body).toMatchObject({ ok: false, code: 'csrf_invalid' });

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
    const scheduledAt = new Date(Date.now() - 2 * 60 * 1000);
    const session = await prisma.webinarSession.create({
      data: {
        title: 'Scripted chat test webinar',
        scheduledAt,
        status: 'live',
        videoDurationSeconds: 568,
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
    expect(response.body.messages.every((message: any) => message.offsetSeconds <= 568)).toBe(true);
    expect(response.body.messages[0]).toMatchObject({
      agentId: expect.any(String),
      answerStartSeconds: expect.any(Number),
      topic: expect.any(String),
      isSynthetic: true,
    });
  });
});
