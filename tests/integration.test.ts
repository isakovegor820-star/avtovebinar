process.env.DATABASE_URL = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execSync } from 'node:child_process';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';

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
    'TRUNCATE TABLE leads, registrations, registration_tokens, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages CASCADE;',
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
    const registerResponse = await userAgent.post('/api/register').send({
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

    // Check lead insertion
    const lead = await prisma.lead.findUnique({
      where: { email: 'alex.test@aspb.ru' },
    });
    expect(lead).toBeDefined();
    expect(lead?.name).toBe('Алексей Тестовый');
    expect(lead?.marketingConsent).toBe(true);

    // Re-submitting the same form for the same webinar refreshes access but does not create a duplicate registration.
    const repeatRegisterResponse = await userAgent.post('/api/register').send({
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
    expect(accessTokenCount).toBe(2);

    const tokenPurposes = await prisma.registrationToken.findMany({
      where: { registrationId: registrationsAfterRepeat[0].id },
      select: { purpose: true },
      orderBy: { purpose: 'asc' },
    });
    expect(tokenPurposes.map(item => item.purpose)).toEqual(['registration', 'room_session']);

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
    const questionResponse = await userAgent.post('/api/questions').send({
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
    const appResponse = await userAgent.post('/api/partner-application').send({
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

    // 5a. URL token exchange is one-time and moves access into an httpOnly cookie.
    const exchangeToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registrationsAfterRepeat[0].id,
        tokenHash: hashToken(exchangeToken),
        purpose: 'registration',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const exchangeAgent = request.agent(app);
    const exchangeResponse = await exchangeAgent.post(`/api/registration/exchange/${exchangeToken}`).send({});
    expect(exchangeResponse.status).toBe(200);
    expect(exchangeResponse.body.token).toBeUndefined();
    expect(exchangeResponse.body.webinarUrl).not.toContain('token=');
    expect(exchangeResponse.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('aspb_room_token=')]),
    );

    const repeatExchangeResponse = await request(app).post(`/api/registration/exchange/${exchangeToken}`).send({});
    expect(repeatExchangeResponse.status).toBe(404);

    const exchangedSessionResponse = await exchangeAgent.get('/api/registration/session/current?view=success');
    expect(exchangedSessionResponse.status).toBe(200);
    expect(exchangedSessionResponse.body.lead.email).toBe('alex.test@aspb.ru');

    // 6. ADMIN LOGIN (POST /api/admin/login)
    const loginResponse = await request(app).post('/api/admin/login').send({
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
    const adminRegsResponse = await request(app).get('/api/admin/registrations').set('Cookie', [adminCookie!]);

    expect(adminRegsResponse.status).toBe(200);
    expect(adminRegsResponse.body.ok).toBe(true);
    expect(adminRegsResponse.body.registrations.length).toBeGreaterThan(0);

    const foundReg = adminRegsResponse.body.registrations.find((r: any) => r.lead.email === 'alex.test@aspb.ru');
    expect(foundReg).toBeDefined();
    expect(foundReg.crmStatus).toBe('contract_pending');
    expect(foundReg.questionCount).toBe(1);
    expect(foundReg.partnerApplicationCount).toBe(1);

    // 8. ADMIN CHANGE STATUS (PATCH /api/admin/registrations/:id/status)
    const statusChangeResponse = await request(app)
      .patch(`/api/admin/registrations/${foundReg.id}/status`)
      .set('Cookie', [adminCookie!])
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
});
