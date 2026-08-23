process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';
process.env.NODE_ENV = 'test';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { execSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../src/app.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/passwords.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';
import {
  EMAIL_JOB_REMINDER,
  EMAIL_JOB_SESSION_CANCELLED,
  EMAIL_JOB_SESSION_RESCHEDULED,
  enqueueRegistrationEmail,
  enqueueReminderEmail,
  runEmailOutboxJobOnce,
} from '../src/lib/emailOutbox.js';
import { runReminderJobOnce, runReplayFollowupJobOnce, runTelegramLiveJobOnce } from '../src/lib/reminders.js';
import { handleParticipantTelegramUpdate } from '../src/lib/telegramParticipantBot.js';
import { handleAdminTelegramUpdate } from '../src/lib/telegramAdminBot.js';
import { handleConsultantTelegramUpdate } from '../src/lib/telegramConsultantBot.js';
import { runTelegramNewsJobOnce } from '../src/lib/telegramNews.js';
import { runTelegramBroadcastJobOnce } from '../src/lib/telegramBroadcastWorker.js';
import { getDailyBroadcastDate } from '../src/lib/time.js';
import { findOrCreateWebinarSession } from '../src/lib/webinarSessions.js';
import {
  cleanupExpiredMediaUploads,
  completeMediaUpload,
  recordMediaUploadPart,
  resumeMediaUpload,
  runMediaJobOnce,
} from '../src/lib/tenancy/mediaPipeline.js';
import { SafeMediaProviderError } from '../src/lib/mediaStorageS3.js';
import { getPublishedTranscript, runContentJobOnce } from '../src/lib/tenancy/transcripts.js';
import { encryptMfaSecret, generateTotp } from '../src/lib/mfa.js';
import {
  createTelegramManagerCallback,
  executeTelegramManagerCallback,
  hashTelegramManagerChatId,
} from '../src/lib/tenancy/telegramBots.js';
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
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_SYSTEM_OWNER_USER_ID,
  DEFAULT_WEBINAR_ID,
} from '../src/lib/tenancy/constants.js';
import { resolveTenantContext } from '../src/lib/tenancy/context.js';
import {
  removeOrganizationMembership,
  updateOrganizationMembershipRole,
} from '../src/lib/tenancy/membershipService.js';
import { runUserAuthEmailOutboxJobOnce } from '../src/lib/tenancy/userAuthEmailOutbox.js';
import { runOrganizationInvitationEmailOutboxJobOnce } from '../src/lib/tenancy/organizationInvitationEmailOutbox.js';
import {
  getTenantWebinarSession,
  updateTenantWebinarSessionTitle,
} from '../src/lib/tenancy/webinarSessionRepository.js';
import { assertAuthorCanPublish } from '../src/lib/tenancy/authorVerification.js';
import { runWebinarAccessInvitationEmailOutboxJobOnce } from '../src/lib/tenancy/webinarAccessInvitationEmailOutbox.js';
import { cleanupExpiredWebinarAccessGrants, hashWebinarAccessEmail } from '../src/lib/tenancy/webinarAccess.js';
import { linkVerifiedRegistrationToCrm, recordCrmScoreSignalForRegistration } from '../src/lib/tenancy/crm.js';
import { runCrmDeliveryJobsOnce } from '../src/lib/tenancy/crmDelivery.js';

type TestAgent = ReturnType<typeof request.agent>;

async function getCsrfToken(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  expect(response.body.csrfToken).toEqual(expect.any(String));
  return response.body.csrfToken as string;
}

function getExchangeTokenFromUrl(value: string) {
  const url = new URL(value);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  return url.searchParams.get('token') || hash.get('token') || hash.get('invite');
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
    sendSessionChangeEmail: capture('session_change'),
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

async function loginPlatformUser(userId: string) {
  env.PLATFORM_ACCOUNTS_ENABLED = 'on';
  const rawToken = createAccessToken();
  await prisma.userAuthToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      purpose: 'PASSWORDLESS_LOGIN',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  const response = await agent
    .post('/api/v1/auth/passwordless/consume')
    .set('x-csrf-token', csrfToken)
    .send({ token: rawToken });
  expect(response.status).toBe(200);
  return { agent, csrfToken, response };
}

async function ensureLegalTaxonomyFixture() {
  const root = await prisma.legalPracticeArea.upsert({
    where: { id: 'practice_test_root' },
    update: { status: 'ACTIVE' },
    create: {
      id: 'practice_test_root',
      slug: 'test-legal-area',
      name: 'Тестовая отрасль права',
      status: 'ACTIVE',
    },
  });
  const specialization = await prisma.legalPracticeArea.upsert({
    where: { id: 'practice_test_specialization' },
    update: { status: 'ACTIVE', parentId: root.id },
    create: {
      id: 'practice_test_specialization',
      parentId: root.id,
      slug: 'test-legal-specialization',
      name: 'Тестовая специализация',
      status: 'ACTIVE',
    },
  });
  const jurisdiction = await prisma.jurisdiction.upsert({
    where: { id: 'jurisdiction_test_ru' },
    update: { status: 'ACTIVE' },
    create: {
      id: 'jurisdiction_test_ru',
      code: 'TEST-RU',
      name: 'Тестовая юрисдикция РФ',
      status: 'ACTIVE',
    },
  });
  return { root, specialization, jurisdiction };
}

beforeAll(async () => {
  if (process.env.ASPB_SKIP_TEST_MIGRATION_DEPLOY === 'on' && process.env.NODE_ENV === 'test') return;
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
    TELEGRAM_ADMIN_BOT_USERNAME: undefined,
    TELEGRAM_CALLBACK_SECRET: undefined,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
    TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: undefined,
    TELEGRAM_CONSULTANT_BOT_TOKEN: '',
    TELEGRAM_MANUAL_BROADCAST: 'off',
    EMAIL_MODE: 'log',
    PLATFORM_ACCOUNTS_ENABLED: 'off',
    PLATFORM_TENANCY_ENFORCEMENT: 'off',
    CREATOR_DASHBOARD_ENABLED: 'off',
    PUBLIC_CATALOG_ENABLED: 'off',
    TENANT_CRM_ENABLED: 'off',
    TENANT_TELEGRAM_BOTS_ENABLED: 'off',
    MEDIA_STORAGE_PROVIDER: 'unconfigured',
    MEDIA_LOCAL_ROOT: undefined,
    STT_PROVIDER: 'unconfigured',
    AI_ENRICHMENT_PROVIDER: 'unconfigured',
  });
  // Truncate tables to guarantee absolute test isolation
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE telegram_broadcast_previews, telegram_broadcast_templates, telegram_consultant_messages, telegram_bot_events, telegram_manager_callbacks, telegram_manager_chat_binding_tokens, telegram_manager_chat_bindings, crm_deliveries, crm_bulk_actions, crm_contact_tags, crm_tags, crm_score_factors, crm_scoring_rules, crm_scoring_rule_sets, crm_tasks, crm_contact_events, crm_stage_transitions, crm_contacts, crm_stages, crm_pipelines, viewer_notification_preferences, viewer_webinar_notes, viewer_webinar_progress, viewer_webinar_favorites, leads, registrations, registration_tokens, email_outbox_jobs, email_outbox_dead_letters, author_verification_evidence, author_verifications, author_profiles, organization_invitations, organization_invitation_tokens, organization_invitation_email_jobs, webinar_access_invitation_email_jobs, webinar_access_grant_tokens, webinar_access_grants, chat_scenario_messages, chat_scenarios, telegram_broadcast_jobs, telegram_broadcast_recipients, telegram_broadcast_dead_letters, telegram_news_posts, webinar_commands, webinar_slug_aliases, webinar_sources, webinar_practice_areas, webinar_schedules, webinars, webinar_sessions, questions, events, partner_applications, admin_users, audit_logs, webinar_timeline_events, webinar_chat_messages, consent_records, legal_acceptances, retention_runs, worker_subsystem_health CASCADE;',
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
});

describe('tenant chat moderation batch', () => {
  it('keeps approved chat, spam controls and moderator actions exact-session and tenant-scoped', async () => {
    const now = new Date();
    const tenant = await createTenantFixture({
      slug: `chat-moderation-${Date.now()}`,
      email: `chat-owner-${Date.now()}@example.test`,
    });
    const foreignTenant = await createTenantFixture({
      slug: `chat-foreign-${Date.now()}`,
      email: `chat-foreign-${Date.now()}@example.test`,
    });
    const participant = await prisma.user.create({
      data: {
        emailNormalized: `chat-participant-${Date.now()}@example.test`,
        displayName: 'Зритель чата',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        slug: `chat-webinar-${Date.now()}`,
        title: 'Безопасная модерация чата',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        scenarioStatus: 'PUBLISHED',
        syntheticDisclosure: 'Подготовленные сообщения отмечены отдельно.',
        publishedAt: now,
      },
    });
    const session = await prisma.webinarSession.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        title: webinar.title,
        scheduledAt: new Date(now.getTime() - 60_000),
        videoDurationSeconds: 3_600,
        replayAvailableHours: 24,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Зритель чата',
        phone: '+79990007701',
        email: participant.emailNormalized,
        professionalStatus: 'Юрист',
        consent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        userId: participant.id,
        leadId: lead.id,
        webinarSessionId: session.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: now,
      },
    });
    const roomToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(roomToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });
    const participantMessage = await prisma.webinarChatMessage.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        webinarSessionId: session.id,
        registrationId: registration.id,
        kind: 'participant',
        messageType: 'PARTICIPANT',
        authorName: 'Зритель чата',
        message: 'Обычный вопрос участника',
        isSynthetic: false,
        visibleAt: new Date(now.getTime() - 30_000),
      },
    });
    await prisma.chatScenario.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        version: 1,
        status: 'PUBLISHED',
        createdById: tenant.user.id,
        approvedById: tenant.user.id,
        approvedAt: now,
        messages: {
          create: [
            {
              orderIndex: 0,
              offsetSeconds: 10,
              kind: 'PREPARED_QUESTION',
              status: 'APPROVED',
              text: 'Одобренный подготовленный вопрос',
              authorLabel: 'Подготовленный вопрос',
              isSynthetic: true,
            },
            {
              orderIndex: 1,
              offsetSeconds: 20,
              kind: 'PREPARED_QUESTION',
              status: 'REJECTED',
              text: 'Отклонённое сообщение не должно попасть в комнату',
              authorLabel: 'Подготовленный вопрос',
              isSynthetic: true,
            },
          ],
        },
      },
    });

    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const moderator = await loginPlatformUser(tenant.user.id);
    const foreignModerator = await loginPlatformUser(foreignTenant.user.id);
    const roomCookie = [`aspb_room_token=${roomToken}`];

    const initialRoom = await request(app).get('/api/webinar/chat/session/current').set('Cookie', roomCookie);
    expect(initialRoom.status).toBe(200);
    expect(initialRoom.body.scenarioVersion).toBe(1);
    expect(initialRoom.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: participantMessage.id, kind: 'participant', isSynthetic: false }),
        expect.objectContaining({
          kind: 'prepared_question',
          authorName: 'Подготовленный вопрос',
          authorRole: 'Подготовленный вопрос',
          isSynthetic: true,
          message: 'Одобренный подготовленный вопрос',
        }),
      ]),
    );
    expect(initialRoom.body.messages.map((message: any) => message.message)).not.toContain(
      'Отклонённое сообщение не должно попасть в комнату',
    );

    const foreignRead = await foreignModerator.agent.get(`/api/v1/moderation/sessions/${session.id}/messages`);
    expect(foreignRead.status).toBe(404);
    const forgedScope = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/messages/${participantMessage.id}`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({
        action: 'HIDE',
        reason: 'Персональные данные',
        expectedRevision: 0,
        organizationId: foreignTenant.organization.id,
      });
    expect(forgedScope.status).toBe(400);

    const hidden = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/messages/${participantMessage.id}`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ action: 'HIDE', reason: 'Персональные данные', expectedRevision: 0 });
    expect(hidden.status).toBe(200);
    expect(hidden.body.message).toMatchObject({ hiddenAt: expect.any(String), moderationRevision: 1 });
    const hiddenRoom = await request(app).get('/api/webinar/chat/session/current').set('Cookie', roomCookie);
    expect(hiddenRoom.body.messages.map((message: any) => message.id)).not.toContain(participantMessage.id);

    const participantAgent = request.agent(app);
    participantAgent.jar.setCookie(`aspb_room_token=${roomToken}; Path=/`, '127.0.0.1', '/');
    const participantCsrf = await getCsrfToken(participantAgent);
    const markup = await participantAgent
      .post('/api/questions')
      .set('x-csrf-token', participantCsrf)
      .send({ text: '<script>alert(1)</script>' });
    expect(markup.status).toBe(400);
    expect(markup.body.code).toBe('chat_markup_not_allowed');
    const safeQuestion = await participantAgent
      .post('/api/questions')
      .set('x-csrf-token', participantCsrf)
      .send({ text: 'Какие документы нужны для первичной проверки?' });
    expect(safeQuestion.status).toBe(201);
    const duplicateQuestion = await participantAgent
      .post('/api/questions')
      .set('x-csrf-token', participantCsrf)
      .send({ text: '  Какие документы нужны для первичной проверки?  ' });
    expect(duplicateQuestion.status).toBe(429);
    expect(duplicateQuestion.body.code).toBe('chat_duplicate_limited');

    const blocked = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/registrations/${registration.id}/chat-access`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ action: 'BLOCK', reason: 'Повторный спам' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.registration.chatBannedAt).toEqual(expect.any(String));
    const blockedQuestion = await participantAgent
      .post('/api/questions')
      .set('x-csrf-token', participantCsrf)
      .send({ text: 'Другой вопрос после блокировки' });
    expect(blockedQuestion.status).toBe(403);
    expect(blockedQuestion.body.code).toBe('chat_registration_blocked');

    const restoredAccess = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/registrations/${registration.id}/chat-access`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ action: 'RESTORE', reason: 'Нарушение устранено' });
    expect(restoredAccess.status).toBe(200);
    expect(restoredAccess.body.registration.chatBannedAt).toBeNull();
    const restoredMessage = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/messages/${participantMessage.id}`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ action: 'RESTORE', reason: 'Персональные данные удалены', expectedRevision: 1 });
    expect(restoredMessage.status).toBe(200);
    expect(restoredMessage.body.message).toMatchObject({ hiddenAt: null, moderationRevision: 2 });

    const restoredRoom = await request(app).get('/api/webinar/chat/session/current').set('Cookie', roomCookie);
    expect(restoredRoom.body.messages.map((message: any) => message.id)).toContain(participantMessage.id);
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenant.organization.id,
          action: {
            in: [
              'chat.message.hidden',
              'chat.message.restored',
              'chat.registration.blocked',
              'chat.registration.restored',
            ],
          },
        },
      }),
    ).resolves.toBe(4);
  });

  it('grounds moderator drafts, blocks personalized advice and synchronizes question queues with CRM', async () => {
    const now = new Date();
    const suffix = Date.now();
    const tenant = await createTenantFixture({
      slug: `question-moderation-${suffix}`,
      email: `question-owner-${suffix}@example.test`,
    });
    const foreignTenant = await createTenantFixture({
      slug: `question-foreign-${suffix}`,
      email: `question-foreign-${suffix}@example.test`,
    });
    const sameTenantAuthorUser = await prisma.user.create({
      data: {
        emailNormalized: `question-author-${suffix}@example.test`,
        displayName: 'Автор без прав модератора',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: tenant.organization.id,
        userId: sameTenantAuthorUser.id,
        role: 'AUTHOR',
        status: 'ACTIVE',
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        slug: `question-webinar-${suffix}`,
        title: 'Основанная модерация вопросов',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        publishedAt: now,
      },
    });
    const session = await prisma.webinarSession.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        title: webinar.title,
        scheduledAt: new Date(now.getTime() - 60_000),
        videoDurationSeconds: 3_600,
        replayAvailableHours: 24,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Участник модерации',
        phone: '+79990007711',
        email: `question-viewer-${suffix}@example.test`,
        consent: true,
      },
    });
    const participantUser = await prisma.user.create({
      data: {
        emailNormalized: lead.email,
        displayName: lead.name,
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        userId: participantUser.id,
        leadId: lead.id,
        webinarSessionId: session.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: now,
      },
    });
    await prisma.$transaction(tx => linkVerifiedRegistrationToCrm(tx, registration.id, now));
    const roomToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(roomToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });
    const asset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenant.user.id,
        version: 1,
        originalFileName: 'questions.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024n,
        storageKey: `organizations/${tenant.organization.id}/questions/source`,
      },
    });
    await prisma.transcript.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        mediaAssetId: asset.id,
        createdByUserId: tenant.user.id,
        version: 1,
        status: 'DRAFT',
        segments: {
          create: {
            orderIndex: 0,
            startMs: 5_000,
            endMs: 12_000,
            text: 'Секретный черновой алгоритм, который нельзя показывать зрителю.',
          },
        },
      },
    });
    const publishedTranscript = await prisma.transcript.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        mediaAssetId: asset.id,
        createdByUserId: tenant.user.id,
        reviewedByUserId: tenant.user.id,
        version: 2,
        status: 'PUBLISHED',
        reviewedAt: now,
        publishedAt: now,
        segments: {
          create: {
            orderIndex: 0,
            startMs: 42_000,
            endMs: 55_000,
            text: 'Субсидиарная ответственность руководителя: основные признаки устанавливаются по опубликованным материалам дела.',
          },
        },
      },
    });
    await prisma.webinarSource.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        type: 'OFFICIAL_SOURCE',
        title: 'Порядок подачи заявления о несостоятельности',
        url: 'https://pravo.gov.ru/',
      },
    });
    const groundedQuestion = await prisma.question.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        text: 'Какие основные признаки субсидиарной ответственности названы?',
      },
    });
    const personalQuestion = await prisma.question.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        text: 'Что мне делать с моим договором и стоит ли подавать иск?',
      },
    });
    const draftOnlyQuestion = await prisma.question.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        text: 'Какой секретный черновой алгоритм описан?',
      },
    });
    const sourceQuestion = await prisma.question.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        text: 'Где найти порядок подачи заявления о несостоятельности?',
      },
    });

    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const moderator = await loginPlatformUser(tenant.user.id);
    const foreignModerator = await loginPlatformUser(foreignTenant.user.id);
    const sameTenantAuthor = await loginPlatformUser(sameTenantAuthorUser.id);
    const authorRead = await sameTenantAuthor.agent.get(
      `/api/v1/moderation/sessions/${session.id}/questions?queue=all`,
    );
    expect(authorRead.status).toBe(403);
    const foreignRead = await foreignModerator.agent.get(
      `/api/v1/moderation/sessions/${session.id}/questions?queue=all`,
    );
    expect(foreignRead.status).toBe(404);
    const forgedBody = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 0, organizationId: foreignTenant.organization.id });
    expect(forgedBody.status).toBe(400);
    const foreignGenerate = await foreignModerator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions`)
      .set('x-csrf-token', foreignModerator.csrfToken)
      .send({ expectedRevision: 0 });
    expect(foreignGenerate.status).toBe(404);

    const grounded = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 0 });
    expect(grounded.status).toBe(201);
    expect(grounded.body.suggestion).toMatchObject({
      status: 'PENDING',
      outcome: 'GROUNDED',
      grounding: {
        type: 'transcript',
        transcriptId: publishedTranscript.id,
        transcriptVersion: 2,
        timestampSeconds: 42,
      },
    });
    const creatorSuggestions = await moderator.agent.get(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions`);
    expect(creatorSuggestions.status).toBe(200);
    expect(creatorSuggestions.body.suggestions.map((item: any) => item.id)).not.toContain(grounded.body.suggestion.id);
    await expect(
      prisma.webinarChatMessage.count({ where: { webinarSessionId: session.id, messageType: 'AI_MODERATOR' } }),
    ).resolves.toBe(0);
    const groundedAgain = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 1 });
    expect(groundedAgain.status).toBe(201);
    expect(groundedAgain.body.suggestion.id).toBe(grounded.body.suggestion.id);

    const personal = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${personalQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 0 });
    expect(personal.status).toBe(201);
    expect(personal.body.suggestion).toMatchObject({
      outcome: 'PERSONALIZED_LEGAL_ADVICE',
      handoffRequired: true,
      grounding: null,
    });
    const draftOnly = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${draftOnlyQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 0 });
    expect(draftOnly.status).toBe(201);
    expect(draftOnly.body.suggestion).toMatchObject({ outcome: 'NO_BASIS', grounding: null });
    expect(JSON.stringify(draftOnly.body)).not.toContain('Секретный черновой алгоритм, который нельзя показывать');
    const source = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${sourceQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 0 });
    expect(source.status).toBe(201);
    expect(source.body.suggestion).toMatchObject({
      outcome: 'GROUNDED',
      grounding: {
        type: 'source',
        title: 'Порядок подачи заявления о несостоятельности',
        url: 'https://pravo.gov.ru/',
      },
    });

    const prioritized = await moderator.agent
      .patch(`/api/v1/moderation/sessions/${session.id}/questions/${personalQuestion.id}`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ priority: 'HIGH', reason: 'Требуется ответ автора', expectedRevision: 1 });
    expect(prioritized.status).toBe(200);
    expect(prioritized.body.question).toMatchObject({
      moderationStatus: 'ACTION_REQUIRED',
      priority: 'HIGH',
      moderationRevision: 2,
    });
    await prisma.question.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        text: personalQuestion.text,
      },
    });
    const priorityQueue = await moderator.agent.get(
      `/api/v1/moderation/sessions/${session.id}/questions?queue=priority`,
    );
    expect(priorityQueue.status).toBe(200);
    expect(priorityQueue.body.questions.map((question: any) => question.id)).toContain(personalQuestion.id);
    const repeatingQueue = await moderator.agent.get(
      `/api/v1/moderation/sessions/${session.id}/questions?queue=repeating`,
    );
    expect(repeatingQueue.status).toBe(200);
    expect(repeatingQueue.body.questions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: personalQuestion.id, repeatCount: 2 })]),
    );

    const published = await moderator.agent
      .post(
        `/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions/${grounded.body.suggestion.id}/review`,
      )
      .set('x-csrf-token', moderator.csrfToken)
      .send({ action: 'PUBLISH', reason: 'Основание и формулировка проверены', expectedQuestionRevision: 1 });
    expect(published.status).toBe(200);
    expect(published.body.question).toMatchObject({ moderationStatus: 'RESOLVED', moderationRevision: 2 });
    const terminalGenerate = await moderator.agent
      .post(`/api/v1/moderation/sessions/${session.id}/questions/${groundedQuestion.id}/suggestions`)
      .set('x-csrf-token', moderator.csrfToken)
      .send({ expectedRevision: 2 });
    expect(terminalGenerate.status).toBe(409);
    expect(terminalGenerate.body.code).toBe('question_terminal_state');
    const room = await request(app)
      .get('/api/webinar/chat/session/current')
      .set('Cookie', [`aspb_room_token=${roomToken}`]);
    expect(room.status).toBe(200);
    expect(room.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ai_moderator',
          authorName: 'AI-модератор',
          isSynthetic: true,
          grounding: { type: 'transcript', timestampSeconds: 42, label: '0:42' },
        }),
      ]),
    );
    await expect(
      prisma.questionModerationEvent.count({ where: { organizationId: tenant.organization.id } }),
    ).resolves.toBeGreaterThanOrEqual(6);
    await expect(
      prisma.cRMContactEvent.count({
        where: { organizationId: tenant.organization.id, type: 'question_moderation' },
      }),
    ).resolves.toBeGreaterThanOrEqual(6);
  });
});

describe('tenant CRM contact and pipeline batch', () => {
  it('keeps contact, filters, timeline and stage writes tenant-scoped and auditable', async () => {
    const tenantA = await createTenantFixture({
      slug: `crm-a-${Date.now()}`,
      email: `crm-owner-a-${Date.now()}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `crm-b-${Date.now()}`,
      email: `crm-owner-b-${Date.now()}@example.test`,
    });
    const analyst = await prisma.user.create({
      data: {
        emailNormalized: `crm-analyst-${Date.now()}@example.test`,
        displayName: 'Аналитик CRM',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: analyst.id,
        role: 'ANALYST',
        status: 'ACTIVE',
      },
    });
    const crmManager = await prisma.user.create({
      data: {
        emailNormalized: `crm-manager-${Date.now()}@example.test`,
        displayName: 'Менеджер CRM',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        memberships: {
          create: { organizationId: tenantA.organization.id, role: 'CRM_MANAGER', status: 'ACTIVE' },
        },
      },
    });
    const tenantAuthor = await prisma.user.create({
      data: {
        emailNormalized: `crm-author-${Date.now()}@example.test`,
        displayName: 'Автор без CRM-доступа',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        memberships: {
          create: { organizationId: tenantA.organization.id, role: 'AUTHOR', status: 'ACTIVE' },
        },
      },
    });
    const ownerA = await loginPlatformUser(tenantA.user.id);
    const ownerB = await loginPlatformUser(tenantB.user.id);
    const analystSession = await loginPlatformUser(analyst.id);
    const managerSession = await loginPlatformUser(crmManager.id);
    const authorSession = await loginPlatformUser(tenantAuthor.id);

    const disabled = await ownerA.agent.get('/api/v1/crm/contacts');
    expect(disabled.status).toBe(404);
    expect(disabled.body.code).toBe('tenant_crm_disabled');
    env.TENANT_CRM_ENABLED = 'on';

    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `crm-webinar-${Date.now()}`,
        title: 'CRM webinar',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const webinarSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'CRM session',
        scheduledAt: new Date('2026-08-21T12:00:00.000Z'),
        timezone: 'Europe/Amsterdam',
      },
    });
    const participant = await prisma.user.create({
      data: {
        emailNormalized: 'same-contact@example.test',
        displayName: 'Мария Контакт',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Мария Контакт',
        phone: '+7 (999) 555-44-33',
        email: 'same-contact@example.test',
        source: 'crm_e2e_source',
        consent: true,
        marketingConsent: true,
        marketingEmailConsent: true,
        marketingTelegramConsent: true,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: webinarSession.id,
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        userId: participant.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date('2026-08-21T12:05:00.000Z'),
        roomEnteredAt: new Date('2026-08-21T12:10:00.000Z'),
        telegramFollowupSentAt: new Date('2026-08-21T12:07:00.000Z'),
        crmStatus: 'qualified',
      },
    });
    const contact = await prisma.$transaction(tx =>
      linkVerifiedRegistrationToCrm(tx, registration.id, new Date('2026-08-21T12:05:00.000Z')),
    );
    expect(contact).not.toBeNull();
    await prisma.cRMPipeline.update({ where: { id: contact!.pipelineId }, data: { timezone: 'Europe/Amsterdam' } });
    const mismatchedLead = await prisma.lead.create({
      data: {
        name: 'Другой контакт',
        phone: '+79995550011',
        email: `crm-scope-mismatch-${Date.now()}@example.test`,
        consent: true,
      },
    });
    await expect(
      prisma.registration.create({
        data: {
          leadId: mismatchedLead.id,
          webinarSessionId: webinarSession.id,
          organizationId: tenantA.organization.id,
          webinarId: webinar.id,
          accessTokenHash: hashToken(createAccessToken()),
          status: 'registered',
          emailVerifiedAt: new Date(),
          crmContactId: contact!.id,
        },
      }),
    ).rejects.toThrow();
    await prisma.event.create({
      data: {
        eventName: 'participant_login',
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: webinarSession.id,
        source: 'passwordless',
      },
    });
    const scoreQuestion = await prisma.question.create({
      data: {
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: webinarSession.id,
        text: '<script>не исполнять</script> Как оформить договор?',
      },
    });
    const scoreCta = await prisma.partnerApplication.create({
      data: {
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: webinarSession.id,
        status: 'new',
      },
    });
    const scoreProgress = await prisma.viewerWebinarProgress.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        webinarSessionId: webinarSession.id,
        userId: participant.id,
        positionMs: 120_000,
        durationMs: 200_000,
      },
    });
    await prisma.$transaction(async tx => {
      await recordCrmScoreSignalForRegistration(
        tx,
        registration.id,
        'room_entered',
        'registration',
        registration.id,
        registration.roomEnteredAt!,
      );
      await recordCrmScoreSignalForRegistration(
        tx,
        registration.id,
        'viewed_50_percent',
        'viewer_progress',
        scoreProgress.id,
        scoreProgress.lastObservedAt,
      );
      await recordCrmScoreSignalForRegistration(
        tx,
        registration.id,
        'question',
        'question',
        scoreQuestion.id,
        scoreQuestion.createdAt,
      );
      await recordCrmScoreSignalForRegistration(
        tx,
        registration.id,
        'cta',
        'partner_application',
        scoreCta.id,
        scoreCta.createdAt,
      );
      await recordCrmScoreSignalForRegistration(
        tx,
        registration.id,
        'cta',
        'partner_application',
        scoreCta.id,
        scoreCta.createdAt,
      );
    });
    await prisma.viewerWebinarNote.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        webinarSessionId: webinarSession.id,
        userId: participant.id,
        timestampMs: 125_000,
        body: 'Личная заметка, которую CRM не должна раскрывать',
      },
    });
    await prisma.emailOutboxJob.create({
      data: {
        type: 'registration_confirmation',
        status: 'sent',
        registrationId: registration.id,
        webinarSessionId: webinarSession.id,
        toEmail: lead.email,
        toName: lead.name,
        scheduledAt: webinarSession.scheduledAt,
        webinarUrl: 'https://example.test/room',
        sentAt: new Date('2026-08-21T12:06:00.000Z'),
      },
    });
    const telegramJob = await prisma.telegramBroadcastJob.create({
      data: { text: 'CRM test', chatIds: [], total: 1, status: 'completed' },
    });
    await prisma.telegramBroadcastRecipient.create({
      data: {
        jobId: telegramJob.id,
        leadId: lead.id,
        chatId: '999000111',
        consentDocumentVersion: 'test-v1',
        inclusionReason: 'explicit_test_consent',
        status: 'sent',
        sentAt: new Date('2026-08-21T12:07:00.000Z'),
      },
    });

    const pipelineB = await prisma.cRMPipeline.create({
      data: {
        organizationId: tenantB.organization.id,
        name: 'Основная воронка',
        isDefault: true,
      },
    });
    const stageB = await prisma.cRMStage.create({
      data: {
        organizationId: tenantB.organization.id,
        pipelineId: pipelineB.id,
        code: 'new',
        name: 'Новый',
        semanticCategory: 'OPEN',
        orderIndex: 10,
        isProtected: true,
      },
    });
    const foreignContact = await prisma.cRMContact.create({
      data: {
        organizationId: tenantB.organization.id,
        pipelineId: pipelineB.id,
        stageId: stageB.id,
        emailNormalized: 'same-contact@example.test',
        displayName: 'Иной tenant',
      },
    });
    const foreignScoring = await ownerB.agent
      .post('/api/v1/crm/scoring/versions')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({
        name: 'Модель tenant B',
        hotThreshold: 60,
        points: { registration: 10, roomEntered: 15, viewed50Percent: 25, question: 25, cta: 35 },
        idempotencyKey: 'score-tenant-b-v1',
      });
    expect(foreignScoring.status).toBe(201);
    expect(foreignContact.emailNormalized).toBe(contact?.emailNormalized);
    await expect(
      prisma.cRMContact.create({
        data: {
          organizationId: tenantA.organization.id,
          pipelineId: contact!.pipelineId,
          stageId: contact!.stageId,
          emailNormalized: contact!.emailNormalized,
          displayName: 'Дубликат внутри tenant',
        },
      }),
    ).rejects.toThrow();

    const reference = await ownerA.agent.get('/api/v1/crm/reference-data');
    expect(reference.status).toBe(200);
    expect(reference.body).toMatchObject({
      maskedPersonalData: false,
      canEditContacts: true,
      canEditTasks: true,
      canManageStages: true,
      pipelines: [expect.objectContaining({ timezone: 'Europe/Amsterdam' })],
    });
    expect(reference.body.pipelines[0].stages.map((stage: any) => stage.code)).toEqual(
      expect.arrayContaining(['new', 'qualified', 'contacted', 'won', 'lost', 'not_target']),
    );
    const forgedTenantQuery = await ownerA.agent
      .get('/api/v1/crm/contacts')
      .query({ organizationId: tenantB.organization.id });
    expect(forgedTenantQuery.status).toBe(400);
    const authorRead = await authorSession.agent.get('/api/v1/crm/contacts');
    expect(authorRead.status).toBe(403);

    expect(reference.body).toMatchObject({ canEditTags: true, canManageScoring: true });
    const initialScoring = await ownerA.agent.get('/api/v1/crm/scoring');
    expect(initialScoring.status).toBe(200);
    expect(initialScoring.body.active).toMatchObject({
      version: 1,
      hotThreshold: 60,
      rules: expect.arrayContaining([
        { code: 'registration', label: 'Регистрация', points: 10 },
        { code: 'room_entered', label: 'Вход в комнату', points: 15 },
        { code: 'viewed_50_percent', label: 'Просмотрено не менее 50%', points: 25 },
        { code: 'question', label: 'Задан вопрос', points: 25 },
        { code: 'cta', label: 'Нажата CTA и отправлена заявка', points: 35 },
      ]),
    });
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact!.id } })).resolves.toMatchObject({
      score: 110,
    });
    await expect(
      prisma.cRMScoreFactor.count({ where: { organizationId: tenantA.organization.id, contactId: contact!.id } }),
    ).resolves.toBe(5);
    await expect(prisma.registration.findUniqueOrThrow({ where: { id: registration.id } })).resolves.toMatchObject({
      isHot: true,
    });
    await expect(
      prisma.cRMScoreFactor.updateMany({
        where: { organizationId: tenantA.organization.id, contactId: contact!.id },
        data: { signalCode: 'registration' },
      }),
    ).rejects.toThrow();

    const manualHotBody = {
      mode: 'NOT_HOT',
      reason: 'Менеджер подтвердил отсутствие актуальной потребности',
      idempotencyKey: 'crm-hot-not-1',
    };
    const foreignManualHot = await ownerA.agent
      .patch(`/api/v1/crm/contacts/${foreignContact.id}/hot`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send(manualHotBody);
    const unknownManualHot = await ownerA.agent
      .patch('/api/v1/crm/contacts/crm-contact-does-not-exist/hot')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(manualHotBody);
    expect(foreignManualHot.status).toBe(404);
    expect(unknownManualHot.status).toBe(404);
    expect(foreignManualHot.body.code).toBe(unknownManualHot.body.code);
    const analystManualHot = await analystSession.agent
      .patch(`/api/v1/crm/contacts/${contact!.id}/hot`)
      .set('x-csrf-token', analystSession.csrfToken)
      .send(manualHotBody);
    expect(analystManualHot.status).toBe(403);
    const manualHot = await managerSession.agent
      .patch(`/api/v1/crm/contacts/${contact!.id}/hot`)
      .set('x-csrf-token', managerSession.csrfToken)
      .send(manualHotBody);
    expect(manualHot.status).toBe(200);
    expect(manualHot.body).toMatchObject({
      replayed: false,
      scoring: { value: 110, manualOverride: 'NOT_HOT', automaticHot: true, effectiveHot: false },
    });
    const manualHotReplay = await managerSession.agent
      .patch(`/api/v1/crm/contacts/${contact!.id}/hot`)
      .set('x-csrf-token', managerSession.csrfToken)
      .send(manualHotBody);
    expect(manualHotReplay.body.replayed).toBe(true);
    await expect(
      prisma.cRMContactEvent.count({
        where: { organizationId: tenantA.organization.id, contactId: contact!.id, type: 'manual_hot_changed' },
      }),
    ).resolves.toBe(1);
    await expect(prisma.registration.findUniqueOrThrow({ where: { id: registration.id } })).resolves.toMatchObject({
      isHot: false,
    });

    const managerScoringWrite = await managerSession.agent
      .post('/api/v1/crm/scoring/versions')
      .set('x-csrf-token', managerSession.csrfToken)
      .send({
        name: 'Недоступная модель',
        hotThreshold: 10,
        points: { registration: 1, roomEntered: 1, viewed50Percent: 1, question: 1, cta: 1 },
        idempotencyKey: 'score-version-manager-denied',
      });
    expect(managerScoringWrite.status).toBe(403);
    const scoringVersionBody = {
      name: 'Консервативная модель',
      hotThreshold: 10,
      points: { registration: 1, roomEntered: 1, viewed50Percent: 1, question: 1, cta: 1 },
      idempotencyKey: 'score-version-2',
    };
    const scoringVersion = await ownerA.agent
      .post('/api/v1/crm/scoring/versions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(scoringVersionBody);
    expect(scoringVersion.status).toBe(201);
    expect(scoringVersion.body.ruleSet).toMatchObject({ version: 2, hotThreshold: 10, status: 'ACTIVE' });
    const scoringVersionReplay = await ownerA.agent
      .post('/api/v1/crm/scoring/versions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(scoringVersionBody);
    expect(scoringVersionReplay.status).toBe(200);
    expect(scoringVersionReplay.body).toMatchObject({ replayed: true, ruleSet: { version: 2 } });
    await expect(prisma.cRMScoringRuleSet.count({ where: { organizationId: tenantA.organization.id } })).resolves.toBe(
      2,
    );
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact!.id } })).resolves.toMatchObject({
      score: 5,
      manualHot: false,
    });
    const automaticHot = await managerSession.agent
      .patch(`/api/v1/crm/contacts/${contact!.id}/hot`)
      .set('x-csrf-token', managerSession.csrfToken)
      .send({
        mode: 'AUTOMATIC',
        reason: 'Возвращаем вычисление по утверждённой модели',
        idempotencyKey: 'crm-hot-auto-1',
      });
    expect(automaticHot.body.scoring).toMatchObject({
      value: 5,
      ruleSetVersion: 2,
      manualOverride: 'AUTOMATIC',
      effectiveHot: false,
    });

    const foreignTag = await ownerB.agent
      .post('/api/v1/crm/tags')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ name: 'Приоритет', colorToken: 'red' });
    expect(foreignTag.status).toBe(201);
    const forgedTag = await ownerA.agent
      .post('/api/v1/crm/tags')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Нельзя доверять tenant', colorToken: 'slate', organizationId: tenantB.organization.id });
    expect(forgedTag.status).toBe(400);
    const createdTag = await managerSession.agent
      .post('/api/v1/crm/tags')
      .set('x-csrf-token', managerSession.csrfToken)
      .send({ name: 'Приоритет', colorToken: 'amber' });
    expect(createdTag.status).toBe(201);
    const tagId = createdTag.body.tag.id as string;
    const duplicateTag = await ownerA.agent
      .post('/api/v1/crm/tags')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: '  ПРИОРИТЕТ  ', colorToken: 'blue' });
    expect(duplicateTag.status).toBe(409);
    expect(duplicateTag.body.code).toBe('crm_tag_name_conflict');
    const foreignTagAssignment = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/${foreignTag.body.tag.id}`)
      .set('x-csrf-token', ownerA.csrfToken);
    const unknownTagAssignment = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/crm-tag-does-not-exist`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(foreignTagAssignment.status).toBe(404);
    expect(unknownTagAssignment.status).toBe(404);
    expect(foreignTagAssignment.body.code).toBe(unknownTagAssignment.body.code);
    const foreignTagContact = await ownerA.agent
      .post(`/api/v1/crm/contacts/${foreignContact.id}/tags/${tagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    const unknownTagContact = await ownerA.agent
      .post(`/api/v1/crm/contacts/crm-contact-does-not-exist/tags/${tagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(foreignTagContact.status).toBe(404);
    expect(unknownTagContact.status).toBe(404);
    expect(foreignTagContact.body.code).toBe(unknownTagContact.body.code);
    const analystTag = await analystSession.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/${tagId}`)
      .set('x-csrf-token', analystSession.csrfToken);
    expect(analystTag.status).toBe(403);
    const assignedTag = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/${tagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(assignedTag.status).toBe(201);
    const assignedTagReplay = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/${tagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(assignedTagReplay.status).toBe(200);
    expect(assignedTagReplay.body.replayed).toBe(true);
    const tenantATags = await ownerA.agent.get('/api/v1/crm/tags').query({ includeArchived: 'true' });
    expect(tenantATags.body.tags.map((item: any) => item.id)).toEqual([tagId]);
    expect(JSON.stringify(tenantATags.body)).not.toContain(foreignTag.body.tag.id);
    const archivedTag = await ownerA.agent
      .patch(`/api/v1/crm/tags/${tagId}`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ status: 'ARCHIVED' });
    expect(archivedTag.body.tag.status).toBe('ARCHIVED');
    await expect(prisma.cRMTag.delete({ where: { id: tagId } })).rejects.toThrow();

    const removableTag = await ownerA.agent
      .post('/api/v1/crm/tags')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'На уточнении', colorToken: 'blue' });
    const removableTagId = removableTag.body.tag.id as string;
    await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/tags/${removableTagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    const removedTag = await ownerA.agent
      .delete(`/api/v1/crm/contacts/${contact!.id}/tags/${removableTagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(removedTag.body).toMatchObject({ assigned: false, replayed: false });
    const removedTagReplay = await ownerA.agent
      .delete(`/api/v1/crm/contacts/${contact!.id}/tags/${removableTagId}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(removedTagReplay.body).toMatchObject({ assigned: false, replayed: true });

    setTestNow(new Date('2026-08-21T12:30:00.000Z'));
    const initialQueues = await ownerA.agent.get('/api/v1/crm/queues');
    expect(initialQueues.status).toBe(200);
    expect(initialQueues.body).toMatchObject({
      timezone: 'Europe/Amsterdam',
      localDate: '2026-08-21',
      counts: { today: 0, overdue: 0, withoutTask: 1, remindersDue: 0 },
    });
    const forgedTask = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        organizationId: tenantB.organization.id,
        title: 'Нельзя доверять tenant из клиента',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'NORMAL',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    expect(forgedTask.status).toBe(400);
    const foreignTaskContact = await ownerA.agent
      .post(`/api/v1/crm/contacts/${foreignContact.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Чужой контакт',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'NORMAL',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    const unknownTaskContact = await ownerA.agent
      .post('/api/v1/crm/contacts/crm-contact-does-not-exist/tasks')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Неизвестный контакт',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'NORMAL',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    expect(foreignTaskContact.status).toBe(404);
    expect(unknownTaskContact.status).toBe(404);
    expect(foreignTaskContact.body.code).toBe(unknownTaskContact.body.code);
    const foreignAssignee = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Чужой исполнитель',
        assigneeMembershipId: tenantB.membership.id,
        priority: 'NORMAL',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    expect(foreignAssignee.status).toBe(404);
    expect(foreignAssignee.body.code).toBe('crm_assignee_not_found');
    const authorTask = await authorSession.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', authorSession.csrfToken)
      .send({
        title: 'Недоступная задача',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'NORMAL',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    expect(authorTask.status).toBe(403);
    const invalidReminder = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Неверное напоминание',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'HIGH',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T16:30',
      });
    expect(invalidReminder.status).toBe(400);
    expect(invalidReminder.body.code).toBe('crm_task_reminder_after_due');

    const createdTask = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Позвонить по договору',
        description: 'Уточнить перечень документов',
        assigneeMembershipId: tenantA.membership.id,
        priority: 'HIGH',
        dueLocal: '2026-08-21T16:00',
        reminderLocal: '2026-08-21T14:30',
      });
    expect(createdTask.status).toBe(201);
    expect(createdTask.body.task).toMatchObject({
      title: 'Позвонить по договору',
      description: 'Уточнить перечень документов',
      priority: 'HIGH',
      status: 'OPEN',
      timezone: 'Europe/Amsterdam',
      dueAt: '2026-08-21T14:00:00.000Z',
      reminderAt: '2026-08-21T12:30:00.000Z',
      assignee: { id: tenantA.membership.id },
    });
    const createdTaskId = createdTask.body.task.id as string;
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact!.id } })).resolves.toMatchObject({
      nextContactAt: new Date('2026-08-21T14:00:00.000Z'),
    });
    const todayQueues = await ownerA.agent.get('/api/v1/crm/queues');
    expect(todayQueues.body.counts).toMatchObject({ today: 1, overdue: 0, withoutTask: 0, remindersDue: 1 });
    const todayContacts = await ownerA.agent.get('/api/v1/crm/contacts').query({ queue: 'today' });
    expect(todayContacts.body.contacts.map((item: any) => item.id)).toEqual([contact?.id]);
    const foreignTaskRead = await ownerB.agent
      .patch(`/api/v1/crm/tasks/${createdTaskId}`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ status: 'COMPLETED' });
    const unknownTaskRead = await ownerB.agent
      .patch('/api/v1/crm/tasks/crm-task-does-not-exist')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ status: 'COMPLETED' });
    expect(foreignTaskRead.status).toBe(404);
    expect(unknownTaskRead.status).toBe(404);
    expect(foreignTaskRead.body.code).toBe(unknownTaskRead.body.code);
    const completedTask = await managerSession.agent
      .patch(`/api/v1/crm/tasks/${createdTaskId}`)
      .set('x-csrf-token', managerSession.csrfToken)
      .send({ status: 'COMPLETED' });
    expect(completedTask.status).toBe(200);
    expect(completedTask.body.task).toMatchObject({ status: 'COMPLETED', completedAt: '2026-08-21T12:30:00.000Z' });
    await expect(prisma.cRMTask.delete({ where: { id: createdTaskId } })).rejects.toThrow();

    const managerMembership = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: tenantA.organization.id, userId: crmManager.id },
    });
    const overdueTask = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact?.id}/tasks`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        title: 'Проверить просроченный срок',
        assigneeMembershipId: managerMembership.id,
        priority: 'URGENT',
        dueLocal: '2026-08-21T14:00',
        reminderLocal: '2026-08-21T13:30',
      });
    expect(overdueTask.status).toBe(201);
    const overdueQueues = await ownerA.agent.get('/api/v1/crm/queues');
    expect(overdueQueues.body.counts).toMatchObject({ today: 0, overdue: 1, withoutTask: 0, remindersDue: 1 });
    const overdueContacts = await ownerA.agent.get('/api/v1/crm/contacts').query({ queue: 'overdue' });
    expect(overdueContacts.body.contacts.map((item: any) => item.id)).toEqual([contact?.id]);
    const cancelledTask = await ownerA.agent
      .patch(`/api/v1/crm/tasks/${overdueTask.body.task.id}`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ status: 'CANCELLED' });
    expect(cancelledTask.body.task.status).toBe('CANCELLED');
    const withoutTaskContacts = await ownerA.agent.get('/api/v1/crm/contacts').query({ queue: 'without_task' });
    expect(withoutTaskContacts.body.contacts.map((item: any) => item.id)).toEqual([contact?.id]);
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact!.id } })).resolves.toMatchObject({
      nextContactAt: null,
    });

    for (const query of [
      { search: 'Мария' },
      { search: '5554433' },
      { webinarId: webinar.id },
      { sessionId: webinarSession.id },
      { source: 'crm_e2e_source' },
      { hasQuestion: 'true' },
      { hasCta: 'true' },
      { activity: 'viewed' },
      { activity: 'note' },
      { activity: 'telegram' },
    ]) {
      const filtered = await ownerA.agent.get('/api/v1/crm/contacts').query(query);
      expect(filtered.status).toBe(200);
      expect(filtered.body.contacts.map((item: any) => item.id)).toEqual([contact?.id]);
    }
    const nonPhoneSearch = await ownerA.agent.get('/api/v1/crm/contacts').query({ search: 'нет такого' });
    expect(nonPhoneSearch.status).toBe(200);
    expect(nonPhoneSearch.body.contacts).toEqual([]);

    const detail = await ownerA.agent.get(`/api/v1/crm/contacts/${contact?.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.timeline.map((item: any) => item.type)).toEqual(
      expect.arrayContaining([
        'registration',
        'room_entered',
        'participant_login',
        'question',
        'cta',
        'view_progress',
        'viewer_note_created',
        'email_delivery',
        'telegram_delivery',
        'task_created',
        'task_completed',
        'task_cancelled',
        'manual_hot_changed',
        'tag_assigned',
        'tag_removed',
      ]),
    );
    expect(detail.body.contact).toMatchObject({
      score: { value: 5, ruleSetVersion: 2, hotThreshold: 10, effectiveHot: false },
      tags: [expect.objectContaining({ id: tagId, name: 'Приоритет', colorToken: 'amber', status: 'ARCHIVED' })],
    });
    expect(detail.body.scoring).toMatchObject({
      value: 5,
      ruleSetVersion: 2,
      effectiveHot: false,
      factors: expect.arrayContaining([
        expect.objectContaining({ code: 'registration', pointsEach: 1, count: 1, subtotal: 1 }),
        expect.objectContaining({ code: 'room_entered', pointsEach: 1, count: 1, subtotal: 1 }),
        expect.objectContaining({ code: 'viewed_50_percent', pointsEach: 1, count: 1, subtotal: 1 }),
        expect.objectContaining({ code: 'question', pointsEach: 1, count: 1, subtotal: 1 }),
        expect.objectContaining({ code: 'cta', pointsEach: 1, count: 1, subtotal: 1 }),
      ]),
    });
    expect(detail.body.tasks).toHaveLength(2);
    expect(detail.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Позвонить по договору', status: 'COMPLETED' }),
        expect.objectContaining({ title: 'Проверить просроченный срок', status: 'CANCELLED' }),
      ]),
    );
    expect(detail.body.timeline.filter((item: any) => item.type === 'telegram_delivery')).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain('Личная заметка, которую CRM не должна раскрывать');
    expect(JSON.stringify(detail.body)).not.toContain('999000111');

    const analystDetail = await analystSession.agent.get(`/api/v1/crm/contacts/${contact?.id}`);
    expect(analystDetail.status).toBe(200);
    expect(analystDetail.body.contact.email).toMatch(/^s\*\*\*@/);
    expect(analystDetail.body.contact.phone).toBe('***4433');
    expect(JSON.stringify(analystDetail.body.timeline)).not.toContain('Как оформить договор?');
    expect(analystDetail.body.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Задача CRM', description: null })]),
    );
    expect(JSON.stringify(analystDetail.body)).not.toContain('Уточнить перечень документов');
    const analystReference = await analystSession.agent.get('/api/v1/crm/reference-data');
    expect(analystReference.body).toMatchObject({
      maskedPersonalData: true,
      canEditContacts: false,
      canEditTasks: false,
      canEditTags: false,
      canManageScoring: false,
      canManageStages: false,
    });
    const analystWrite = await analystSession.agent
      .patch(`/api/v1/crm/contacts/${contact?.id}/stage`)
      .set('x-csrf-token', analystSession.csrfToken)
      .send({ stageId: contact?.stageId });
    expect(analystWrite.status).toBe(403);
    const managerNoChange = await managerSession.agent
      .patch(`/api/v1/crm/contacts/${contact?.id}/stage`)
      .set('x-csrf-token', managerSession.csrfToken)
      .send({ stageId: contact?.stageId });
    expect(managerNoChange.status).toBe(200);
    expect(managerNoChange.body.changed).toBe(false);
    const analystSearch = await analystSession.agent.get('/api/v1/crm/contacts').query({ search: 'same-contact' });
    expect(analystSearch.status).toBe(403);
    expect(analystSearch.body.code).toBe('crm_pii_search_denied');

    const bulkContactA = await prisma.cRMContact.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: contact!.pipelineId,
        stageId: contact!.stageId,
        emailNormalized: 'bulk-a@example.test',
        displayName: 'Bulk A',
        source: 'crm_bulk_partial',
      },
    });
    const bulkContactB = await prisma.cRMContact.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: contact!.pipelineId,
        stageId: contact!.stageId,
        emailNormalized: 'bulk-b@example.test',
        displayName: 'Bulk B',
        source: 'crm_bulk_partial',
      },
    });
    const bulkTagPreviewBody = {
      mode: 'PREVIEW',
      filters: { source: 'crm_bulk_partial' },
      action: { type: 'ADD_TAG', tagId: removableTagId },
      idempotencyKey: 'crm-bulk-tag-preview-1',
    };
    const bulkTagPreview = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(bulkTagPreviewBody);
    expect(bulkTagPreview.status).toBe(201);
    expect(bulkTagPreview.body.bulkAction).toMatchObject({ expectedCount: 2, status: 'PREVIEWED' });
    const bulkPreviewAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'crm.bulk.previewed', entityId: bulkTagPreview.body.bulkAction.id },
    });
    expect(bulkPreviewAudit.afterJson).toMatchObject({ filterKeys: ['source'], expectedCount: 2 });
    expect(JSON.stringify(bulkPreviewAudit.afterJson)).not.toContain('crm_bulk_partial');
    const bulkTagPreviewReplay = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(bulkTagPreviewBody);
    expect(bulkTagPreviewReplay.status).toBe(200);
    expect(bulkTagPreviewReplay.body.replayed).toBe(true);
    const conflictingPreview = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ ...bulkTagPreviewBody, filters: { source: 'crm_e2e_source' } });
    expect(conflictingPreview.status).toBe(409);
    expect(conflictingPreview.body.code).toBe('crm_bulk_idempotency_conflict');
    await prisma.cRMContact.update({ where: { id: bulkContactB.id }, data: { archivedAt: new Date() } });
    const bulkTagExecute = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ mode: 'EXECUTE', previewId: bulkTagPreview.body.bulkAction.id });
    expect(bulkTagExecute.body.bulkAction).toMatchObject({ status: 'PARTIAL' });
    expect(bulkTagExecute.body.bulkAction.results.successes).toEqual([{ contactId: bulkContactA.id }]);
    expect(bulkTagExecute.body.bulkAction.results.failures).toEqual([
      { contactId: bulkContactB.id, code: 'crm_contact_not_found' },
    ]);
    const bulkTagExecuteReplay = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ mode: 'EXECUTE', previewId: bulkTagPreview.body.bulkAction.id });
    expect(bulkTagExecuteReplay.body).toMatchObject({ replayed: true, bulkAction: { status: 'PARTIAL' } });
    await expect(
      prisma.cRMContactTag.count({ where: { organizationId: tenantA.organization.id, tagId: removableTagId } }),
    ).resolves.toBe(1);

    const expiringPreview = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        mode: 'PREVIEW',
        filters: { source: 'crm_e2e_source' },
        action: { type: 'ADD_TAG', tagId: removableTagId },
        idempotencyKey: 'crm-bulk-expiring-preview-1',
      });
    await expect(
      prisma.cRMBulkAction.update({
        where: { id: expiringPreview.body.bulkAction.id },
        data: {
          status: 'COMPLETED',
          resultsJson: { successes: [], failures: [] },
          executedAt: new Date('2026-08-21T12:30:00.000Z'),
        },
      }),
    ).rejects.toThrow();
    setTestNow(new Date('2026-08-21T12:41:00.000Z'));
    const expiredPreview = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ mode: 'EXECUTE', previewId: expiringPreview.body.bulkAction.id });
    expect(expiredPreview.status).toBe(409);
    expect(expiredPreview.body.code).toBe('crm_bulk_preview_expired');
    await expect(
      prisma.cRMBulkAction.findUniqueOrThrow({ where: { id: expiringPreview.body.bulkAction.id } }),
    ).resolves.toMatchObject({ status: 'EXPIRED', resultsJson: null });
    setTestNow(new Date('2026-08-21T12:30:00.000Z'));

    const foreignBulk = await ownerB.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ mode: 'EXECUTE', previewId: bulkTagPreview.body.bulkAction.id });
    const unknownBulk = await ownerB.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ mode: 'EXECUTE', previewId: 'crm-bulk-does-not-exist' });
    expect(foreignBulk.status).toBe(404);
    expect(unknownBulk.status).toBe(404);
    expect(foreignBulk.body.code).toBe(unknownBulk.body.code);
    const foreignBulkTarget = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        mode: 'PREVIEW',
        filters: { source: 'crm_e2e_source' },
        action: { type: 'ADD_TAG', tagId: foreignTag.body.tag.id },
        idempotencyKey: 'crm-bulk-foreign-tag-1',
      });
    const unknownBulkTarget = await ownerA.agent
      .post('/api/v1/crm/bulk-actions')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        mode: 'PREVIEW',
        filters: { source: 'crm_e2e_source' },
        action: { type: 'ADD_TAG', tagId: 'crm-tag-does-not-exist' },
        idempotencyKey: 'crm-bulk-unknown-tag-1',
      });
    expect(foreignBulkTarget.status).toBe(404);
    expect(unknownBulkTarget.status).toBe(404);
    expect(foreignBulkTarget.body.code).toBe(unknownBulkTarget.body.code);

    const managerMembershipForBulk = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: tenantA.organization.id, userId: crmManager.id },
    });
    const bulkActions = [
      {
        key: 'crm-bulk-manager-1',
        action: { type: 'ASSIGN_MANAGER', assigneeMembershipId: managerMembershipForBulk.id },
      },
      {
        key: 'crm-bulk-task-1',
        action: {
          type: 'CREATE_TASK',
          task: {
            title: 'Проверить документы массово',
            description: null,
            assigneeMembershipId: managerMembershipForBulk.id,
            priority: 'NORMAL',
            dueLocal: '2031-08-21T16:00',
            reminderLocal: '2031-08-21T15:00',
          },
        },
      },
      {
        key: 'crm-bulk-stage-1',
        action: {
          type: 'CHANGE_STAGE',
          stageId: reference.body.pipelines[0].stages.find((stage: any) => stage.code === 'contacted').id,
        },
      },
    ];
    for (const bulk of bulkActions) {
      const preview = await ownerA.agent
        .post('/api/v1/crm/bulk-actions')
        .set('x-csrf-token', ownerA.csrfToken)
        .send({
          mode: 'PREVIEW',
          filters: { source: 'crm_e2e_source' },
          action: bulk.action,
          idempotencyKey: bulk.key,
        });
      expect(preview.body.bulkAction.expectedCount).toBe(1);
      const executed = await ownerA.agent
        .post('/api/v1/crm/bulk-actions')
        .set('x-csrf-token', ownerA.csrfToken)
        .send({ mode: 'EXECUTE', previewId: preview.body.bulkAction.id });
      expect(executed.body.bulkAction).toMatchObject({ status: 'COMPLETED' });
      expect(executed.body.bulkAction.results).toMatchObject({ successes: [{ contactId: contact!.id }], failures: [] });
    }
    await expect(
      prisma.cRMTask.count({ where: { organizationId: tenantA.organization.id, bulkActionId: { not: null } } }),
    ).resolves.toBe(1);
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact!.id } })).resolves.toMatchObject({
      ownerMembershipId: managerMembershipForBulk.id,
    });

    const exportDenied = await ownerA.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ filters: { source: 'crm_e2e_source' } });
    expect(exportDenied.status).toBe(403);
    expect(exportDenied.body.code).toBe('crm_export_permission_required');
    await prisma.organizationMembership.update({
      where: { id: tenantA.membership.id },
      data: { permissionsJson: { crm: { export: true } } },
    });
    await prisma.cRMContact.update({
      where: { id: contact!.id },
      data: { displayName: '=HYPERLINK("https://invalid.example")' },
    });
    const ownerExport = await ownerA.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ filters: { source: 'crm_e2e_source' } });
    expect(ownerExport.status).toBe(200);
    expect(ownerExport.headers['cache-control']).toContain('no-store');
    expect(ownerExport.headers['content-type']).toContain('text/csv');
    expect(ownerExport.headers['content-disposition']).toContain('attachment; filename="crm-contacts-');
    expect(ownerExport.headers['x-crm-export-row-count']).toBe('1');
    expect(ownerExport.text).toContain('"\'=HYPERLINK(""https://invalid.example"")"');
    expect(ownerExport.text).toContain(contact!.emailNormalized);
    const ownerExportAudit = await prisma.auditLog.findUniqueOrThrow({
      where: { id: String(ownerExport.headers['x-crm-export-audit-id']) },
    });
    expect(ownerExportAudit.afterJson).toMatchObject({ filterKeys: ['source'], rowCount: 1, masked: false });
    expect(JSON.stringify(ownerExportAudit.afterJson)).not.toContain('crm_e2e_source');
    expect(JSON.stringify(ownerExportAudit.afterJson)).not.toContain(contact!.emailNormalized);
    const forgedExport = await ownerA.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ organizationId: tenantB.organization.id, filters: {} });
    expect(forgedExport.status).toBe(400);
    await prisma.organizationMembership.update({
      where: { organizationId_userId: { organizationId: tenantA.organization.id, userId: analyst.id } },
      data: { permissionsJson: { crm: { export: true } } },
    });
    const analystExport = await analystSession.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', analystSession.csrfToken)
      .send({ filters: { source: 'crm_e2e_source' } });
    expect(analystExport.status).toBe(200);
    expect(analystExport.text).not.toContain(contact!.emailNormalized);
    expect(analystExport.text).toContain('s***@example.test');
    const foreignStageExport = await ownerA.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ filters: { stageId: stageB.id } });
    const unknownStageExport = await ownerA.agent
      .post('/api/v1/crm/exports')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ filters: { stageId: 'crm-stage-does-not-exist' } });
    expect(foreignStageExport.headers['x-crm-export-row-count']).toBe('0');
    expect(unknownStageExport.headers['x-crm-export-row-count']).toBe('0');
    expect(foreignStageExport.text).toBe(unknownStageExport.text);
    await expect(
      prisma.auditLog.count({ where: { organizationId: tenantA.organization.id, action: 'crm.contacts.exported' } }),
    ).resolves.toBe(4);
    await expect(
      prisma.auditLog.count({ where: { organizationId: tenantA.organization.id, action: 'crm.bulk.executed' } }),
    ).resolves.toBe(4);

    const foreignRead = await ownerA.agent.get(`/api/v1/crm/contacts/${foreignContact.id}`);
    const unknownRead = await ownerA.agent.get('/api/v1/crm/contacts/crm-contact-does-not-exist');
    expect(foreignRead.status).toBe(404);
    expect(unknownRead.status).toBe(404);
    expect(foreignRead.body.code).toBe(unknownRead.body.code);

    const lostStage = reference.body.pipelines[0].stages.find((stage: any) => stage.code === 'lost');
    const noReason = await ownerA.agent
      .patch(`/api/v1/crm/contacts/${contact?.id}/stage`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ stageId: lostStage.id });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('crm_lost_reason_required');
    const foreignStage = await ownerA.agent
      .patch(`/api/v1/crm/contacts/${contact?.id}/stage`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ stageId: stageB.id, reason: 'Неверный tenant' });
    const unknownStage = await ownerA.agent
      .patch('/api/v1/crm/contacts/crm-contact-does-not-exist/stage')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ stageId: lostStage.id, reason: 'Нет объекта' });
    expect(foreignStage.status).toBe(404);
    expect(unknownStage.status).toBe(404);
    expect(foreignStage.body.code).toBe(unknownStage.body.code);

    const transitioned = await ownerA.agent
      .patch(`/api/v1/crm/contacts/${contact?.id}/stage`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ stageId: lostStage.id, reason: 'Нет подтверждённой потребности' });
    expect(transitioned.status).toBe(200);
    expect(transitioned.body.changed).toBe(true);
    await expect(prisma.registration.findUniqueOrThrow({ where: { id: registration.id } })).resolves.toMatchObject({
      crmStatus: 'lost',
    });
    await expect(
      prisma.auditLog.count({
        where: { organizationId: tenantA.organization.id, action: 'crm.contact.stage_changed', entityId: contact?.id },
      }),
    ).resolves.toBe(2);

    const customStage = await ownerA.agent
      .post('/api/v1/crm/stages')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Проверка документов', semanticCategory: 'OPEN' });
    expect(customStage.status).toBe(201);
    expect(customStage.body.stage.code).toMatch(/^custom_[a-f0-9]+$/);
    const editedStage = await ownerA.agent
      .patch(`/api/v1/crm/stages/${customStage.body.stage.id}`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Документы проверяются', position: 1 });
    expect(editedStage.status).toBe(200);
    expect(editedStage.body.stage).toMatchObject({ name: 'Документы проверяются', orderIndex: 20 });
    const archivedStage = await ownerA.agent
      .patch(`/api/v1/crm/stages/${customStage.body.stage.id}`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ status: 'ARCHIVED' });
    expect(archivedStage.status).toBe(200);
    const protectedArchive = await ownerA.agent
      .patch(`/api/v1/crm/stages/${lostStage.id}`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ status: 'ARCHIVED' });
    expect(protectedArchive.status).toBe(409);
    expect(protectedArchive.body.code).toBe('crm_stage_protected');
    await expect(
      prisma.cRMStage.update({ where: { id: lostStage.id }, data: { isProtected: false } }),
    ).rejects.toThrow();
    await expect(
      prisma.cRMStage.update({ where: { id: lostStage.id }, data: { semanticCategory: 'OPEN' } }),
    ).rejects.toThrow();
    await expect(prisma.cRMStage.delete({ where: { id: lostStage.id } })).rejects.toThrow();

    const tenantBList = await ownerB.agent.get('/api/v1/crm/contacts');
    expect(tenantBList.status).toBe(200);
    expect(tenantBList.body.contacts.map((item: any) => item.id)).toEqual([foreignContact.id]);
  }, 60_000);

  it('rechecks tenant channel consent at enqueue and send while exposing safe retry/dead-letter state', async () => {
    const tenantA = await createTenantFixture({
      slug: `crm-delivery-a-${Date.now()}`,
      email: `crm-delivery-owner-a-${Date.now()}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `crm-delivery-b-${Date.now()}`,
      email: `crm-delivery-owner-b-${Date.now()}@example.test`,
    });
    const ownerA = await loginPlatformUser(tenantA.user.id);
    const ownerB = await loginPlatformUser(tenantB.user.id);
    env.TENANT_CRM_ENABLED = 'on';

    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `crm-delivery-webinar-${Date.now()}`,
        title: 'CRM consent delivery webinar',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const webinarSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'CRM consent delivery session',
        scheduledAt: new Date('2026-09-01T10:00:00.000Z'),
        timezone: 'Europe/Amsterdam',
      },
    });
    const participant = await prisma.user.create({
      data: {
        emailNormalized: `crm-delivery-participant-${Date.now()}@example.test`,
        displayName: 'Получатель CRM',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const consentAt = new Date(Date.now() - 10_000);
    const lead = await prisma.lead.create({
      data: {
        name: 'Получатель CRM',
        phone: '+79990000444',
        email: participant.emailNormalized,
        consent: true,
        marketingConsent: true,
        marketingEmailConsent: true,
        marketingEmailConsentAt: consentAt,
        marketingTelegramConsent: true,
        marketingTelegramConsentAt: consentAt,
        telegramChatId: '777000444',
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: webinarSession.id,
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        userId: participant.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    const contact = await prisma.$transaction(tx => linkVerifiedRegistrationToCrm(tx, registration.id));
    expect(contact).not.toBeNull();
    await prisma.viewerNotificationPreference.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: participant.id,
        marketingEmailEnabled: true,
        marketingTelegramEnabled: true,
      },
    });
    const rejectedWithoutConsent = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        channel: 'EMAIL',
        registrationId: registration.id,
        subject: 'Сообщение без согласия',
        message: 'Эта запись не должна появиться в очереди.',
        idempotencyKey: 'crm-delivery-without-consent',
      });
    expect(rejectedWithoutConsent.status).toBe(409);
    expect(rejectedWithoutConsent.body.code).toBe('crm_delivery_consent_required');
    await expect(prisma.cRMDelivery.count({ where: { organizationId: tenantA.organization.id } })).resolves.toBe(0);
    const consentReq = { headers: { 'user-agent': 'crm-delivery-integration' }, ip: '127.0.0.1' };
    const emailGrant = await prisma.consentRecord.create({
      data: consentEvidenceData(MARKETING_EMAIL_CONSENT, {
        leadId: lead.id,
        registrationId: registration.id,
        email: lead.email,
        kind: 'marketing_email',
        sourceForm: 'crm-delivery-integration',
        req: consentReq,
        occurredAt: consentAt,
      }),
    });
    const telegramGrant = await prisma.consentRecord.create({
      data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
        leadId: lead.id,
        registrationId: registration.id,
        email: lead.email,
        kind: 'marketing_telegram',
        sourceForm: 'crm-delivery-integration',
        req: consentReq,
        occurredAt: consentAt,
      }),
    });

    const foreignPipeline = await prisma.cRMPipeline.create({
      data: { organizationId: tenantB.organization.id, name: 'Foreign delivery pipeline', isDefault: true },
    });
    const foreignStage = await prisma.cRMStage.create({
      data: {
        organizationId: tenantB.organization.id,
        pipelineId: foreignPipeline.id,
        code: 'new',
        name: 'Новый',
        orderIndex: 10,
        isProtected: true,
      },
    });
    const foreignContact = await prisma.cRMContact.create({
      data: {
        organizationId: tenantB.organization.id,
        pipelineId: foreignPipeline.id,
        stageId: foreignStage.id,
        emailNormalized: `foreign-delivery-${Date.now()}@example.test`,
      },
    });
    const emailBody = {
      channel: 'EMAIL',
      registrationId: registration.id,
      subject: 'Материалы по вебинару',
      message: 'Новый материал доступен в кабинете участника.',
      idempotencyKey: 'crm-delivery-email-001',
    };
    const foreignEnqueue = await ownerA.agent
      .post(`/api/v1/crm/contacts/${foreignContact.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send(emailBody);
    const unknownEnqueue = await ownerA.agent
      .post('/api/v1/crm/contacts/crm-contact-does-not-exist/deliveries')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(emailBody);
    expect(foreignEnqueue.status).toBe(404);
    expect(unknownEnqueue.status).toBe(404);
    expect(foreignEnqueue.body.code).toBe(unknownEnqueue.body.code);
    const forgedTenant = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ ...emailBody, organizationId: tenantB.organization.id });
    expect(forgedTenant.status).toBe(400);

    const queuedEmail = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send(emailBody);
    expect(queuedEmail.status).toBe(201);
    expect(queuedEmail.body).toMatchObject({ replayed: false, delivery: { channel: 'EMAIL', status: 'PENDING' } });
    const emailReplay = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send(emailBody);
    expect(emailReplay.status).toBe(200);
    expect(emailReplay.body.replayed).toBe(true);
    const emailConflict = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ ...emailBody, message: 'Другой текст с тем же ключом.' });
    expect(emailConflict.status).toBe(409);
    expect(emailConflict.body.code).toBe('crm_delivery_idempotency_conflict');

    const emailSender = vi.fn(async () => ({ sent: true, mode: 'send' as const }));
    const emailRun = await runCrmDeliveryJobsOnce(new Date(Date.now() + 1_000), { sendEmail: emailSender });
    expect(emailRun).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    expect(emailSender).toHaveBeenCalledWith({
      to: participant.emailNormalized,
      subject: emailBody.subject,
      text: emailBody.message,
    });
    await expect(
      prisma.cRMDelivery.findUniqueOrThrow({ where: { id: queuedEmail.body.delivery.id } }),
    ).resolves.toMatchObject({
      status: 'SENT',
      attempts: 1,
      consentRecordId: emailGrant.id,
      lastErrorCode: null,
    });

    const telegramBody = {
      channel: 'TELEGRAM',
      registrationId: registration.id,
      message: 'Напоминание о новом материале в кабинете.',
      idempotencyKey: 'crm-delivery-telegram-001',
    };
    const queuedTelegram = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send(telegramBody);
    expect(queuedTelegram.status).toBe(201);
    const revokedAt = new Date(Date.now() + 2_000);
    await prisma.$transaction(async tx => {
      await tx.viewerNotificationPreference.update({
        where: { userId_organizationId: { userId: participant.id, organizationId: tenantA.organization.id } },
        data: { marketingTelegramEnabled: false },
      });
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          marketingTelegramConsent: false,
          marketingTelegramConsentAt: null,
          marketingTelegramRevokedAt: revokedAt,
        },
      });
      await tx.consentRecord.create({
        data: {
          ...consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
            leadId: lead.id,
            registrationId: registration.id,
            email: lead.email,
            kind: 'marketing_telegram',
            action: 'revoke',
            sourceForm: 'crm-delivery-integration',
            req: consentReq,
            occurredAt: revokedAt,
            revocationChannel: 'viewer_account',
            revocationReason: 'integration_revoke',
            revokedConsentId: telegramGrant.id,
          }),
        },
      });
    });
    const telegramSender = vi.fn(async () => ({ sent: true, mode: 'send' as const }));
    const blockedRun = await runCrmDeliveryJobsOnce(new Date(Date.now() + 3_000), {
      sendTelegram: telegramSender,
    });
    expect(blockedRun).toMatchObject({ checked: 1, sent: 0, blocked: 1 });
    expect(telegramSender).not.toHaveBeenCalled();
    await expect(
      prisma.cRMDelivery.findUniqueOrThrow({ where: { id: queuedTelegram.body.delivery.id } }),
    ).resolves.toMatchObject({ status: 'BLOCKED', lastErrorCode: 'crm_delivery_consent_required' });
    const retryWhileRevoked = await ownerA.agent
      .post(`/api/v1/crm/deliveries/${queuedTelegram.body.delivery.id}/retry`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-retry-revoked' });
    expect(retryWhileRevoked.status).toBe(409);
    expect(retryWhileRevoked.body.code).toBe('crm_delivery_consent_required');

    const restoredAt = new Date(Date.now() + 4_000);
    const restoredGrant = await prisma.$transaction(async tx => {
      await tx.viewerNotificationPreference.update({
        where: { userId_organizationId: { userId: participant.id, organizationId: tenantA.organization.id } },
        data: { marketingTelegramEnabled: true },
      });
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          marketingTelegramConsent: true,
          marketingTelegramConsentAt: restoredAt,
          marketingTelegramRevokedAt: null,
        },
      });
      return tx.consentRecord.create({
        data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
          leadId: lead.id,
          registrationId: registration.id,
          email: lead.email,
          kind: 'marketing_telegram',
          sourceForm: 'crm-delivery-integration',
          req: consentReq,
          occurredAt: restoredAt,
        }),
      });
    });
    const retryTelegram = await ownerA.agent
      .post(`/api/v1/crm/deliveries/${queuedTelegram.body.delivery.id}/retry`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-retry-restored' });
    expect(retryTelegram.status).toBe(200);
    expect(retryTelegram.body).toMatchObject({ replayed: false, delivery: { status: 'PENDING', attempts: 0 } });
    const retryTelegramReplay = await ownerA.agent
      .post(`/api/v1/crm/deliveries/${queuedTelegram.body.delivery.id}/retry`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-retry-restored' });
    expect(retryTelegramReplay.body.replayed).toBe(true);
    const telegramRun = await runCrmDeliveryJobsOnce(new Date(Date.now() + 5_000), {
      sendTelegram: telegramSender,
    });
    expect(telegramRun.sent).toBe(1);
    expect(telegramSender).toHaveBeenCalledWith('777000444', telegramBody.message, { attempts: 1 });
    await expect(
      prisma.cRMDelivery.findUniqueOrThrow({ where: { id: queuedTelegram.body.delivery.id } }),
    ).resolves.toMatchObject({ status: 'SENT', consentRecordId: restoredGrant.id });

    const failingEmail = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        ...emailBody,
        subject: 'Проверка durable retry',
        message: 'Текст не должен попадать в timeline или provider error.',
        idempotencyKey: 'crm-delivery-email-failure-001',
      });
    expect(failingEmail.status).toBe(201);
    const providerFailure = vi.fn(async () => {
      throw new Error(`SMTP failed for ${participant.emailNormalized} token=raw-secret`);
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await prisma.cRMDelivery.findUniqueOrThrow({ where: { id: failingEmail.body.delivery.id } });
      const runAt = new Date((current.nextAttemptAt?.getTime() ?? Date.now()) + 1_000);
      await runCrmDeliveryJobsOnce(runAt, { sendEmail: providerFailure });
    }
    const deadLetter = await prisma.cRMDelivery.findUniqueOrThrow({ where: { id: failingEmail.body.delivery.id } });
    expect(deadLetter).toMatchObject({
      status: 'DEAD_LETTER',
      attempts: 5,
      lastErrorCode: 'crm_delivery_provider_temporary_failure',
    });
    expect(JSON.stringify(deadLetter.lastErrorCode)).not.toContain(participant.emailNormalized);
    expect(JSON.stringify(deadLetter.lastErrorCode)).not.toContain('raw-secret');
    const foreignRetry = await ownerB.agent
      .post(`/api/v1/crm/deliveries/${deadLetter.id}/retry`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-foreign-retry' });
    const unknownRetry = await ownerB.agent
      .post('/api/v1/crm/deliveries/crm-delivery-does-not-exist/retry')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-unknown-retry' });
    expect(foreignRetry.status).toBe(404);
    expect(unknownRetry.status).toBe(404);
    expect(foreignRetry.body.code).toBe(unknownRetry.body.code);

    const retryDeadLetter = await ownerA.agent
      .post(`/api/v1/crm/deliveries/${deadLetter.id}/retry`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ idempotencyKey: 'crm-delivery-dead-letter-retry' });
    expect(retryDeadLetter.body.delivery.status).toBe('PENDING');
    const recovered = await runCrmDeliveryJobsOnce(new Date(Date.now() + 60_000), { sendEmail: emailSender });
    expect(recovered.sent).toBe(1);

    const logModeEmail = await ownerA.agent
      .post(`/api/v1/crm/contacts/${contact!.id}/deliveries`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        ...emailBody,
        subject: 'Проверка отключённого provider',
        message: 'Log mode не должен считаться реальной доставкой.',
        idempotencyKey: 'crm-delivery-email-log-mode',
      });
    expect(logModeEmail.status).toBe(201);
    const logModeRun = await runCrmDeliveryJobsOnce(new Date(Date.now() + 120_000));
    expect(logModeRun).toMatchObject({ checked: 1, sent: 0, cancelled: 1 });
    await expect(
      prisma.cRMDelivery.findUniqueOrThrow({ where: { id: logModeEmail.body.delivery.id } }),
    ).resolves.toMatchObject({
      status: 'CANCELLED',
      lastErrorCode: 'crm_delivery_provider_disabled',
    });

    const detail = await ownerA.agent.get(`/api/v1/crm/contacts/${contact!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'EMAIL', status: 'SENT', canRetry: false }),
        expect.objectContaining({ channel: 'TELEGRAM', status: 'SENT', canRetry: false }),
      ]),
    );
    expect(detail.body.timeline.map((item: any) => item.type)).toEqual(
      expect.arrayContaining([
        'delivery_queued',
        'sent',
        'blocked',
        'delivery_retry_requested',
        'retry_scheduled',
        'dead_lettered',
      ]),
    );
    expect(JSON.stringify(detail.body)).not.toContain(emailBody.subject);
    expect(JSON.stringify(detail.body)).not.toContain(emailBody.message);
    expect(JSON.stringify(detail.body)).not.toContain(telegramBody.message);
    expect(JSON.stringify(detail.body)).not.toContain('777000444');
    await expect(
      prisma.auditLog.count({ where: { organizationId: tenantA.organization.id, entityType: 'crm_delivery' } }),
    ).resolves.toBeGreaterThan(8);
    await expect(
      prisma.cRMDelivery.update({
        where: { id: queuedEmail.body.delivery.id },
        data: { organizationId: tenantB.organization.id },
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe('tenant Telegram manager bot foundation', () => {
  it('requires owner-confirmed chat binding and executes signed exact-scope callbacks idempotently', async () => {
    const tenantA = await createTenantFixture({
      slug: `telegram-manager-a-${Date.now()}`,
      email: `telegram-owner-a-${Date.now()}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `telegram-manager-b-${Date.now()}`,
      email: `telegram-owner-b-${Date.now()}@example.test`,
    });
    const managerUser = await prisma.user.create({
      data: {
        emailNormalized: `telegram-manager-${Date.now()}@example.test`,
        displayName: 'Менеджер Telegram',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const managerMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: managerUser.id,
        role: 'CRM_MANAGER',
        status: 'ACTIVE',
      },
    });
    const ownerA = await loginPlatformUser(tenantA.user.id);
    const ownerB = await loginPlatformUser(tenantB.user.id);

    expect((await ownerA.agent.get('/api/v1/telegram/manager-bindings')).status).toBe(404);
    env.TENANT_CRM_ENABLED = 'on';
    env.TENANT_TELEGRAM_BOTS_ENABLED = 'on';
    env.TELEGRAM_ADMIN_BOT_USERNAME = 'aspb_test_manager_bot';

    const created = await ownerA.agent
      .post('/api/v1/telegram/manager-bindings')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ membershipId: managerMembership.id });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toContain('no-store');
    expect(created.body.binding).toMatchObject({
      membershipId: managerMembership.id,
      status: 'PENDING_CHAT',
      chatHint: null,
    });
    expect(JSON.stringify(created.body)).not.toContain('TELEGRAM_CALLBACK_SECRET');
    const startPayload = new URL(created.body.startUrl).searchParams.get('start');
    expect(startPayload).toMatch(/^mgr_[A-Za-z0-9_-]{43}$/);
    const tokenRow = await prisma.telegramManagerChatBindingToken.findFirstOrThrow({
      where: { bindingId: created.body.binding.id },
    });
    expect(tokenRow.tokenHash).toBe(hashToken(startPayload!.slice(4)));
    expect(tokenRow.tokenHash).not.toContain(startPayload!.slice(4));

    const foreignConfirm = await ownerB.agent
      .post(`/api/v1/telegram/manager-bindings/${created.body.binding.id}/confirm`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    const unknownConfirm = await ownerB.agent
      .post('/api/v1/telegram/manager-bindings/telegram-binding-unknown/confirm')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    expect(foreignConfirm.status).toBe(404);
    expect(unknownConfirm.status).toBe(404);
    expect(foreignConfirm.body.code).toBe(unknownConfirm.body.code);

    await handleAdminTelegramUpdate({
      update_id: 501,
      message: {
        message_id: 7001,
        text: `/start ${startPayload}`,
        chat: { id: 9001001, type: 'private' },
      },
    });
    const claimed = await prisma.telegramManagerChatBinding.findUniqueOrThrow({
      where: { id: created.body.binding.id },
    });
    expect(claimed).toMatchObject({ status: 'PENDING_OWNER', chatId: '9001001' });

    await handleAdminTelegramUpdate({
      update_id: 502,
      message: {
        message_id: 7002,
        text: `/start ${startPayload}`,
        chat: { id: 9001002, type: 'private' },
      },
    });
    await expect(
      prisma.telegramManagerChatBinding.findUniqueOrThrow({ where: { id: created.body.binding.id } }),
    ).resolves.toMatchObject({ status: 'PENDING_OWNER', chatId: '9001001' });

    const confirmed = await ownerA.agent
      .post(`/api/v1/telegram/manager-bindings/${created.body.binding.id}/confirm`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ binding: { status: 'ACTIVE', chatHint: '***1001' }, replayed: false });
    const confirmReplay = await ownerA.agent
      .post(`/api/v1/telegram/manager-bindings/${created.body.binding.id}/confirm`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(confirmReplay.body.replayed).toBe(true);
    const foreignList = await ownerB.agent.get('/api/v1/telegram/manager-bindings');
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.bindings).toEqual([]);

    const pipeline = await prisma.cRMPipeline.create({
      data: {
        organizationId: tenantA.organization.id,
        name: 'Telegram pipeline',
        isDefault: true,
        timezone: 'Europe/Amsterdam',
      },
    });
    const newStage = await prisma.cRMStage.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: pipeline.id,
        code: 'new',
        name: 'Новый',
        semanticCategory: 'OPEN',
        orderIndex: 0,
        isProtected: true,
      },
    });
    const contactedStage = await prisma.cRMStage.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: pipeline.id,
        code: 'contacted',
        name: 'Связались',
        semanticCategory: 'OPEN',
        orderIndex: 1,
        isProtected: true,
      },
    });
    const contact = await prisma.cRMContact.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: pipeline.id,
        stageId: newStage.id,
        emailNormalized: `telegram-participant-${Date.now()}@example.test`,
        displayName: 'Участник Telegram',
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `telegram-webinar-${Date.now()}`,
        title: 'Telegram scoped webinar',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const session = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'Telegram scoped session',
        scheduledAt: new Date('2026-08-23T12:00:00.000Z'),
        timezone: 'Europe/Amsterdam',
      },
    });
    const lead = await prisma.lead.create({
      data: {
        name: 'Участник Telegram',
        phone: '+79990000123',
        email: contact.emailNormalized!,
        consent: true,
        consentAt: new Date(),
      },
    });
    const participantUser = await prisma.user.create({
      data: {
        emailNormalized: lead.email,
        displayName: lead.name,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.cRMContact.update({ where: { id: contact.id }, data: { legacyLeadId: lead.id } });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        userId: participantUser.id,
        accessPolicy: 'PUBLIC_CATALOG',
        crmContactId: contact.id,
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    const contextA = {
      userId: tenantA.user.id,
      organizationId: tenantA.organization.id,
      membershipId: tenantA.membership.id,
      role: tenantA.membership.role,
      permissions: null,
      correlationId: 'telegram-manager-test-a',
    } as const;
    const contextB = {
      userId: tenantB.user.id,
      organizationId: tenantB.organization.id,
      membershipId: tenantB.membership.id,
      role: tenantB.membership.role,
      permissions: null,
      correlationId: 'telegram-manager-test-b',
    } as const;

    await expect(
      createTelegramManagerCallback(prisma, contextB, {
        bindingId: claimed.id,
        registrationId: registration.id,
        crmContactId: contact.id,
        action: 'ACCEPT_CONTACT',
        idempotencyKey: 'telegram-foreign-callback',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'telegram_manager_binding_unavailable' });

    const acceptCallback = await createTelegramManagerCallback(prisma, contextA, {
      bindingId: claimed.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      action: 'ACCEPT_CONTACT',
      idempotencyKey: 'telegram-accept-contact-001',
    });
    expect(acceptCallback.callbackData).toMatch(/^tm1:[a-z0-9]{20,32}:[A-Za-z0-9_-]{16}$/);
    const wrongChat = await executeTelegramManagerCallback(prisma, {
      callbackData: acceptCallback.callbackData,
      chatId: '9001002',
      providerCallbackId: 'callback-wrong-chat-001',
    });
    expect(wrongChat).toMatchObject({ accepted: false, code: 'telegram_manager_callback_unavailable' });
    await expect(
      prisma.telegramManagerCallback.findUniqueOrThrow({ where: { id: acceptCallback.callbackId } }),
    ).resolves.toMatchObject({ status: 'PENDING', consumedAt: null });

    const accepted = await executeTelegramManagerCallback(prisma, {
      callbackData: acceptCallback.callbackData,
      chatId: '9001001',
      providerCallbackId: 'callback-accept-001',
    });
    expect(accepted).toMatchObject({ accepted: true, replayed: false, code: 'contact_accepted' });
    const acceptedReplay = await executeTelegramManagerCallback(prisma, {
      callbackData: acceptCallback.callbackData,
      chatId: '9001001',
      providerCallbackId: 'callback-accept-001',
    });
    expect(acceptedReplay).toMatchObject({ accepted: true, replayed: true, code: 'contact_accepted' });
    await expect(prisma.cRMContact.findUniqueOrThrow({ where: { id: contact.id } })).resolves.toMatchObject({
      ownerMembershipId: managerMembership.id,
    });

    const stageCallback = await createTelegramManagerCallback(prisma, contextA, {
      bindingId: claimed.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      action: 'CHANGE_STAGE',
      payload: { stageId: contactedStage.id, reason: 'Связались через Telegram' },
      idempotencyKey: 'telegram-change-stage-001',
    });
    expect(
      await executeTelegramManagerCallback(prisma, {
        callbackData: stageCallback.callbackData,
        chatId: '9001001',
        providerCallbackId: 'callback-stage-001',
      }),
    ).toMatchObject({ accepted: true, code: 'stage_changed' });

    const hotCallback = await createTelegramManagerCallback(prisma, contextA, {
      bindingId: claimed.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      action: 'MARK_HOT',
      payload: { reason: 'Высокий приоритет после вопроса' },
      idempotencyKey: 'telegram-mark-hot-001',
    });
    expect(
      await executeTelegramManagerCallback(prisma, {
        callbackData: hotCallback.callbackData,
        chatId: '9001001',
        providerCallbackId: 'callback-hot-001',
      }),
    ).toMatchObject({ accepted: true, code: 'hot_marked' });

    const taskCallback = await createTelegramManagerCallback(prisma, contextA, {
      bindingId: claimed.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      action: 'CREATE_TASK',
      payload: {
        title: 'Связаться с участником',
        priority: 'HIGH',
        dueAt: '2026-08-24T10:00:00.000Z',
        reminderAt: '2026-08-24T09:00:00.000Z',
      },
      idempotencyKey: 'telegram-create-task-001',
    });
    expect(
      await executeTelegramManagerCallback(prisma, {
        callbackData: taskCallback.callbackData,
        chatId: '9001001',
        providerCallbackId: 'callback-task-001',
      }),
    ).toMatchObject({ accepted: true, code: 'task_created' });
    await expect(
      prisma.cRMTask.count({ where: { organizationId: tenantA.organization.id, contactId: contact.id } }),
    ).resolves.toBe(1);

    const pendingBeforeRevoke = await createTelegramManagerCallback(prisma, contextA, {
      bindingId: claimed.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      action: 'MARK_HOT',
      payload: { reason: 'Повторная проверка доступа' },
      idempotencyKey: 'telegram-revoke-fence-001',
    });
    const revoked = await ownerA.agent
      .delete(`/api/v1/telegram/manager-bindings/${claimed.id}`)
      .set('x-csrf-token', ownerA.csrfToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body.binding.status).toBe('REVOKED');
    expect(
      await executeTelegramManagerCallback(prisma, {
        callbackData: pendingBeforeRevoke.callbackData,
        chatId: '9001001',
        providerCallbackId: 'callback-after-revoke-001',
      }),
    ).toMatchObject({ accepted: false, code: 'telegram_manager_callback_unavailable' });

    const events = await prisma.telegramBotEvent.findMany({
      where: { organizationId: tenantA.organization.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map(event => event.eventType)).toEqual(
      expect.arrayContaining([
        'manager_binding_requested',
        'manager_binding_chat_claimed',
        'manager_binding_claim_acknowledged',
        'manager_binding_confirmed',
        'manager_callback_issued',
        'manager_callback_completed',
        'manager_binding_revoked',
      ]),
    );
    for (const event of events) {
      expect(event.correlationId.length).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(event.metadataJson ?? {})).not.toMatch(/chatId|email|phone|token|signedUrl/i);
    }
    await expect(
      prisma.auditLog.count({
        where: { organizationId: tenantA.organization.id, action: { startsWith: 'telegram.' } },
      }),
    ).resolves.toBeGreaterThanOrEqual(8);
  }, 60_000);
});

describe('tenant Telegram consultant classification', () => {
  it('classifies an exact-scope message, hands it to confirmed managers and keeps corrections tenant-isolated', async () => {
    const suffix = Date.now();
    const tenantA = await createTenantFixture({
      slug: `telegram-consultant-a-${suffix}`,
      email: `telegram-consultant-owner-a-${suffix}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `telegram-consultant-b-${suffix}`,
      email: `telegram-consultant-owner-b-${suffix}@example.test`,
    });
    const ownerA = await loginPlatformUser(tenantA.user.id);
    const ownerB = await loginPlatformUser(tenantB.user.id);
    env.TENANT_CRM_ENABLED = 'on';
    env.TENANT_TELEGRAM_BOTS_ENABLED = 'on';

    const pipeline = await prisma.cRMPipeline.create({
      data: {
        organizationId: tenantA.organization.id,
        name: 'Telegram consultant pipeline',
        isDefault: true,
        timezone: 'Europe/Amsterdam',
      },
    });
    const stage = await prisma.cRMStage.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: pipeline.id,
        code: 'new',
        name: 'Новый',
        semanticCategory: 'OPEN',
        orderIndex: 0,
        isProtected: true,
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `telegram-consultant-webinar-${suffix}`,
        title: 'Tenant consultant webinar',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const webinarSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'Tenant consultant session',
        scheduledAt: new Date('2026-08-24T12:00:00.000Z'),
        timezone: 'Europe/Amsterdam',
      },
    });
    const chatId = '880020001';
    const lead = await prisma.lead.create({
      data: {
        name: 'Участник консультанта',
        phone: '+79990002001',
        email: `telegram-consultant-participant-${suffix}@example.test`,
        consent: true,
        consentAt: new Date(),
        telegramChatId: chatId,
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        telegramSubscribedAt: new Date(),
      },
    });
    const participantUser = await prisma.user.create({
      data: {
        emailNormalized: lead.email,
        displayName: lead.name,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const contact = await prisma.cRMContact.create({
      data: {
        organizationId: tenantA.organization.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        emailNormalized: lead.email,
        displayName: lead.name,
        legacyLeadId: lead.id,
      },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: webinarSession.id,
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        userId: participantUser.id,
        accessPolicy: 'PUBLIC_CATALOG',
        crmContactId: contact.id,
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    const now = new Date();
    const managerBinding = await prisma.telegramManagerChatBinding.create({
      data: {
        organizationId: tenantA.organization.id,
        membershipId: tenantA.membership.id,
        status: 'ACTIVE',
        chatId: '880029999',
        chatIdHash: hashTelegramManagerChatId('880029999'),
        requestedByUserId: tenantA.user.id,
        confirmedByUserId: tenantA.user.id,
        claimedAt: now,
        confirmedAt: now,
      },
    });

    const privateText = 'У меня завтра суд по долгам — что мне делать? private-user@example.test +79990009999';
    const update = {
      update_id: 9101,
      message: {
        message_id: 9201,
        text: privateText,
        chat: { id: Number(chatId), type: 'private' },
        from: { id: 9301, username: 'private_user', first_name: 'Private name' },
      },
    };
    await handleConsultantTelegramUpdate(update);
    await handleConsultantTelegramUpdate(update);

    const stored = await prisma.telegramConsultantMessage.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      organizationId: tenantA.organization.id,
      webinarId: webinar.id,
      webinarSessionId: webinarSession.id,
      registrationId: registration.id,
      crmContactId: contact.id,
      providerMessageId: '9201',
      text: privateText,
      topic: 'debt',
      intent: 'legal_question',
      urgency: 'high',
      classificationModel: 'local_policy',
      classificationVersion: 'telegram-intent-v1',
      status: 'HANDED_TO_HUMAN',
    });
    expect(stored[0].chatIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0].chatIdHash).not.toContain(chatId);
    await expect(
      prisma.telegramConsultantMessage.update({ where: { id: stored[0].id }, data: { topic: 'tax' } }),
    ).rejects.toThrow();

    const callbacks = await prisma.telegramManagerCallback.findMany({ orderBy: { action: 'asc' } });
    expect(callbacks).toHaveLength(2);
    expect(callbacks.map(callback => callback.action)).toEqual(['ACCEPT_CONTACT', 'MARK_HOT']);
    for (const callback of callbacks) {
      expect(callback).toMatchObject({
        organizationId: tenantA.organization.id,
        bindingId: managerBinding.id,
        membershipId: tenantA.membership.id,
        webinarId: webinar.id,
        webinarSessionId: webinarSession.id,
        registrationId: registration.id,
        crmContactId: contact.id,
      });
    }
    await expect(
      prisma.telegramBotEvent.count({
        where: { organizationId: tenantA.organization.id, eventType: 'consultant_handoff_notified' },
      }),
    ).resolves.toBe(1);

    const legacyEvents = await prisma.event.findMany({ where: { eventName: 'telegram_consultant_message' } });
    expect(legacyEvents).toHaveLength(1);
    const botEvents = await prisma.telegramBotEvent.findMany({
      where: { eventType: { in: ['consultant_message_classified', 'consultant_handoff_notified'] } },
    });
    expect(botEvents).toHaveLength(2);
    for (const event of [...legacyEvents, ...botEvents]) {
      const metadata = JSON.stringify(event.metadataJson ?? {});
      expect(metadata).not.toContain(privateText);
      expect(metadata).not.toMatch(/chatId|private_user|private-user@example\.test|79990009999|telegramUserId/i);
    }
    expect(botEvents.find(event => event.eventType === 'consultant_message_classified')).toMatchObject({
      organizationId: tenantA.organization.id,
      providerMessageId: '9201',
      correlationId: expect.any(String),
    });

    const listA = await ownerA.agent.get('/api/v1/telegram/consultant/messages?urgency=high');
    expect(listA.status).toBe(200);
    expect(listA.headers['cache-control']).toContain('no-store');
    expect(listA.body.messages).toEqual([
      expect.objectContaining({
        id: stored[0].id,
        text: privateText,
        classification: expect.objectContaining({ topic: 'debt', intent: 'legal_question', urgency: 'high' }),
      }),
    ]);
    const listB = await ownerB.agent.get('/api/v1/telegram/consultant/messages');
    expect(listB.status).toBe(200);
    expect(listB.body.messages).toEqual([]);

    const foreignCorrection = await ownerB.agent
      .patch(`/api/v1/telegram/consultant/messages/${stored[0].id}/classification`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ topic: 'tax', reason: 'Исправлено менеджером другой организации' });
    const missingCorrection = await ownerB.agent
      .patch('/api/v1/telegram/consultant/messages/telegram-consultant-missing/classification')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ topic: 'tax', reason: 'Проверка неизвестного сообщения' });
    expect(foreignCorrection.status).toBe(404);
    expect(missingCorrection.status).toBe(404);
    expect(foreignCorrection.body).toMatchObject({
      code: 'telegram_consultant_message_unavailable',
      error: missingCorrection.body.error,
    });

    const corrected = await ownerA.agent
      .patch(`/api/v1/telegram/consultant/messages/${stored[0].id}/classification`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ topic: 'tax', urgency: 'normal', reason: 'Менеджер уточнил тему обращения' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.message.classification).toMatchObject({
      topic: 'tax',
      intent: 'legal_question',
      urgency: 'normal',
      original: { topic: 'debt', intent: 'legal_question', urgency: 'high' },
      corrected: true,
      correctionReason: 'Менеджер уточнил тему обращения',
    });
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: 'telegram.consultant_classification.corrected',
          entityId: stored[0].id,
        },
      }),
    ).resolves.toBe(1);
  }, 60_000);
});

describe('tenant Telegram broadcast flow', () => {
  it('requires a published safe template and expiring preview before exact-scope queueing', async () => {
    const suffix = Date.now();
    const tenantA = await createTenantFixture({
      slug: `telegram-broadcast-a-${suffix}`,
      email: `telegram-broadcast-owner-a-${suffix}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `telegram-broadcast-b-${suffix}`,
      email: `telegram-broadcast-owner-b-${suffix}@example.test`,
    });
    const ownerA = await loginPlatformUser(tenantA.user.id);
    const ownerB = await loginPlatformUser(tenantB.user.id);
    env.TENANT_CRM_ENABLED = 'on';
    env.TENANT_TELEGRAM_BOTS_ENABLED = 'on';
    env.TELEGRAM_MANUAL_BROADCAST = 'on';

    const unknownVariable = await ownerA.agent
      .post('/api/v1/telegram/broadcast-templates')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Неверная переменная', text: 'Здравствуйте, {{email}}. Ссылка: {{room_link}}' });
    expect(unknownVariable.status).toBe(400);
    expect(unknownVariable.body.code).toBe('telegram_template_variable_invalid');

    const missingLinkDraft = await ownerA.agent
      .post('/api/v1/telegram/broadcast-templates')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Без ссылки', text: 'Здравствуйте, {{participant_name}}' });
    expect(missingLinkDraft.status).toBe(201);
    const missingLinkPublish = await ownerA.agent
      .post(`/api/v1/telegram/broadcast-templates/${missingLinkDraft.body.template.id}/publish`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(missingLinkPublish.status).toBe(400);
    expect(missingLinkPublish.body.code).toBe('telegram_template_link_required');

    const templateText = [
      '{{participant_name}}, для вас доступен вебинар «{{webinar_title}}».',
      'Сессия: {{session_datetime}}',
      '{{room_link}}',
    ].join('\n');
    const createdTemplate = await ownerA.agent
      .post('/api/v1/telegram/broadcast-templates')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ name: 'Точное напоминание', text: templateText });
    expect(createdTemplate.status).toBe(201);
    expect(createdTemplate.headers['cache-control']).toContain('no-store');
    expect(createdTemplate.body.template).toMatchObject({
      status: 'draft',
      variables: ['participant_name', 'room_link', 'session_datetime', 'webinar_title'],
    });
    const templateId = createdTemplate.body.template.id as string;

    const foreignPublish = await ownerB.agent
      .post(`/api/v1/telegram/broadcast-templates/${templateId}/publish`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    const missingPublish = await ownerB.agent
      .post('/api/v1/telegram/broadcast-templates/telegram-template-missing/publish')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    expect(foreignPublish.status).toBe(404);
    expect(missingPublish.status).toBe(404);
    expect(foreignPublish.body).toMatchObject({
      code: 'tenant_telegram_template_unavailable',
      error: missingPublish.body.error,
    });

    const published = await ownerA.agent
      .post(`/api/v1/telegram/broadcast-templates/${templateId}/publish`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ template: { status: 'published' }, replayed: false });

    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `telegram-broadcast-webinar-${suffix}`,
        title: 'Безопасная tenant-рассылка',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const webinarSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'Tenant broadcast session',
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        timezone: 'Europe/Amsterdam',
      },
    });
    const registrations: Array<{ leadId: string; registrationId: string; chatId: string; grantId: string }> = [];
    for (const index of [1, 2]) {
      const email = `telegram-broadcast-participant-${index}-${suffix}@example.test`;
      const chatId = `66001000${index}`;
      const lead = await prisma.lead.create({
        data: {
          name: `Получатель ${index}`,
          phone: `+7999000100${index}`,
          email,
          consent: true,
          consentAt: new Date(),
          marketingTelegramConsent: true,
          marketingTelegramConsentAt: new Date(),
          telegramChatId: chatId,
          telegramBindingVersion: TELEGRAM_BINDING_VERSION,
          telegramSubscribedAt: new Date(),
        },
      });
      const participant = await prisma.user.create({
        data: { emailNormalized: email, displayName: lead.name, status: 'ACTIVE', emailVerifiedAt: new Date() },
      });
      const registration = await prisma.registration.create({
        data: {
          leadId: lead.id,
          webinarSessionId: webinarSession.id,
          organizationId: tenantA.organization.id,
          webinarId: webinar.id,
          userId: participant.id,
          accessPolicy: 'PUBLIC_CATALOG',
          accessTokenHash: hashToken(createAccessToken()),
          status: 'registered',
          emailVerifiedAt: new Date(),
        },
      });
      const grant = await prisma.consentRecord.create({
        data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
          leadId: lead.id,
          registrationId: registration.id,
          email,
          kind: 'marketing_telegram',
          sourceForm: 'tenant-telegram-broadcast-test',
          req: { headers: { 'user-agent': 'vitest' }, socket: {} },
        }),
      });
      registrations.push({ leadId: lead.id, registrationId: registration.id, chatId, grantId: grant.id });
    }

    const previewBody = {
      templateId,
      webinarId: webinar.id,
      webinarSessionId: webinarSession.id,
      segment: 'registered_session',
    };
    const foreignPreview = await ownerB.agent
      .post('/api/v1/telegram/broadcasts/preview')
      .set('x-csrf-token', ownerB.csrfToken)
      .send(previewBody);
    const unknownPreview = await ownerB.agent
      .post('/api/v1/telegram/broadcasts/preview')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ ...previewBody, webinarId: 'telegram-webinar-missing', webinarSessionId: 'telegram-session-missing' });
    expect(foreignPreview.status).toBe(404);
    expect(unknownPreview.status).toBe(404);
    expect(foreignPreview.body.code).toBe(unknownPreview.body.code);

    const preview = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/preview')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(previewBody);
    expect(preview.status).toBe(201);
    expect(preview.headers['cache-control']).toContain('no-store');
    expect(preview.body.preview).toMatchObject({
      total: 2,
      segment: 'registered_session',
      webinarId: webinar.id,
      webinarSessionId: webinarSession.id,
      previewToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const previewId = preview.body.preview.previewId as string;
    const previewToken = preview.body.preview.previewToken as string;
    const storedPreview = await prisma.telegramBroadcastPreview.findUniqueOrThrow({ where: { id: previewId } });
    expect(storedPreview.tokenHash).toBe(hashToken(previewToken));
    expect(storedPreview.tokenHash).not.toContain(previewToken);
    await expect(prisma.telegramBroadcastJob.count()).resolves.toBe(0);

    const wrongConfirm = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/confirm')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        previewId,
        previewToken: createAccessToken(),
        confirm: true,
        idempotencyKey: '10000000-0000-4000-8000-000000000001',
      });
    expect(wrongConfirm.status).toBe(404);
    await expect(prisma.telegramBroadcastJob.count()).resolves.toBe(0);

    const confirmInput = {
      previewId,
      previewToken,
      confirm: true,
      idempotencyKey: '10000000-0000-4000-8000-000000000002',
    };
    const confirmed = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/confirm')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(confirmInput);
    expect(confirmed.status).toBe(202);
    expect(confirmed.body).toMatchObject({ replayed: false, job: { status: 'pending', progress: { total: 2 } } });
    const jobId = confirmed.body.job.id as string;
    const confirmReplay = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/confirm')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(confirmInput);
    expect(confirmReplay.status).toBe(200);
    expect(confirmReplay.body).toMatchObject({ replayed: true, job: { id: jobId } });
    const recipients = await prisma.telegramBroadcastRecipient.findMany({ where: { jobId } });
    expect(recipients).toHaveLength(2);
    for (const recipient of recipients) {
      expect(recipient).toMatchObject({
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        webinarSessionId: webinarSession.id,
        registrationId: expect.any(String),
        correlationId: expect.any(String),
      });
    }

    const paused = await ownerA.agent
      .post(`/api/v1/telegram/broadcasts/${jobId}/pause`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(paused.status).toBe(200);
    expect(paused.body.job.status).toBe('paused');
    expect((await runTelegramBroadcastJobOnce()).checked).toBe(0);
    const resumed = await ownerA.agent
      .post(`/api/v1/telegram/broadcasts/${jobId}/resume`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ confirm: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.job.status).toBe('pending');

    const revokedAt = new Date();
    await prisma.$transaction(async tx => {
      await tx.lead.update({
        where: { id: registrations[1].leadId },
        data: { marketingTelegramConsent: false, marketingTelegramRevokedAt: revokedAt },
      });
      const revokedLead = await tx.lead.findUniqueOrThrow({ where: { id: registrations[1].leadId } });
      await tx.consentRecord.create({
        data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
          leadId: registrations[1].leadId,
          registrationId: registrations[1].registrationId,
          email: revokedLead.email,
          kind: 'marketing_telegram',
          action: 'revoke',
          sourceForm: 'tenant-telegram-broadcast-test',
          req: { headers: { 'user-agent': 'vitest' }, socket: {} },
          occurredAt: revokedAt,
          revocationChannel: 'viewer_account',
          revocationReason: 'integration_revoke',
          revokedConsentId: registrations[1].grantId,
        }),
      });
    });
    const run = await runTelegramBroadcastJobOnce(new Date(Date.now() + 1_000), { jobId });
    expect(run).toMatchObject({ checked: 1, sent: 1, failed: 0, deadLettered: 0 });
    await expect(prisma.telegramBroadcastJob.findUniqueOrThrow({ where: { id: jobId } })).resolves.toMatchObject({
      status: 'completed',
      total: 2,
      sent: 1,
      nextIndex: 2,
      lastError: null,
    });
    const processedRecipients = await prisma.telegramBroadcastRecipient.findMany({
      where: { jobId },
      orderBy: { status: 'asc' },
    });
    expect(processedRecipients.map(recipient => recipient.status).sort()).toEqual(['sent', 'skipped_revoked']);
    expect(processedRecipients.find(recipient => recipient.status === 'sent')).toMatchObject({
      registrationId: registrations[0].registrationId,
      providerMessageId: null,
    });
    expect(processedRecipients.find(recipient => recipient.status === 'skipped_revoked')?.lastError).toBe(
      'recipient_no_longer_eligible',
    );
    await expect(
      prisma.registrationToken.count({
        where: { registrationId: registrations[0].registrationId, purpose: 'registration' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.registrationToken.count({
        where: { registrationId: registrations[1].registrationId, purpose: 'registration' },
      }),
    ).resolves.toBe(0);
    const deliveryEvent = await prisma.telegramBotEvent.findFirstOrThrow({
      where: { eventType: 'tenant_broadcast_recipient_delivered', registrationId: registrations[0].registrationId },
    });
    expect(deliveryEvent).toMatchObject({
      organizationId: tenantA.organization.id,
      webinarId: webinar.id,
      webinarSessionId: webinarSession.id,
      status: 'logged',
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(deliveryEvent.metadataJson ?? {})).not.toMatch(/chatId|email|phone|token|signedUrl|text/i);

    const secondPreview = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/preview')
      .set('x-csrf-token', ownerA.csrfToken)
      .send(previewBody);
    expect(secondPreview.body.preview.total).toBe(1);
    const secondConfirmed = await ownerA.agent
      .post('/api/v1/telegram/broadcasts/confirm')
      .set('x-csrf-token', ownerA.csrfToken)
      .send({
        previewId: secondPreview.body.preview.previewId,
        previewToken: secondPreview.body.preview.previewToken,
        confirm: true,
        idempotencyKey: '10000000-0000-4000-8000-000000000003',
      });
    const secondJobId = secondConfirmed.body.job.id as string;
    const cancelled = await ownerA.agent
      .post(`/api/v1/telegram/broadcasts/${secondJobId}/cancel`)
      .set('x-csrf-token', ownerA.csrfToken)
      .send({ reason: 'Рассылка отменена владельцем после проверки' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Рассылка отменена владельцем после проверки',
    });
    await expect(
      prisma.telegramBroadcastRecipient.count({ where: { jobId: secondJobId, status: 'cancelled' } }),
    ).resolves.toBe(1);

    const foreignPause = await ownerB.agent
      .post(`/api/v1/telegram/broadcasts/${secondJobId}/pause`)
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    const missingPause = await ownerB.agent
      .post('/api/v1/telegram/broadcasts/telegram-job-missing/pause')
      .set('x-csrf-token', ownerB.csrfToken)
      .send({ confirm: true });
    expect(foreignPause.status).toBe(404);
    expect(missingPause.status).toBe(404);
    expect(foreignPause.body).toMatchObject({
      code: 'tenant_telegram_broadcast_unavailable',
      error: missingPause.body.error,
    });
    const tenantAJobs = await ownerA.agent.get('/api/v1/telegram/broadcasts');
    const tenantBJobs = await ownerB.agent.get('/api/v1/telegram/broadcasts');
    expect(tenantAJobs.status).toBe(200);
    expect(tenantAJobs.headers['cache-control']).toContain('no-store');
    expect(tenantAJobs.body.jobs).toHaveLength(2);
    expect(JSON.stringify(tenantAJobs.body)).not.toContain(templateText);
    expect(JSON.stringify(tenantAJobs.body)).not.toContain(registrations[0].chatId);
    expect(tenantBJobs.body.jobs).toEqual([]);
    await expect(
      prisma.auditLog.count({
        where: { organizationId: tenantA.organization.id, action: { startsWith: 'telegram.broadcast.' } },
      }),
    ).resolves.toBeGreaterThanOrEqual(7);
    await expect(
      prisma.auditLog.count({
        where: { organizationId: tenantA.organization.id, action: { startsWith: 'telegram.broadcast_template.' } },
      }),
    ).resolves.toBeGreaterThanOrEqual(3);
  }, 60_000);
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

  it('scopes participant bot commands to current accessible Webinar sessions', async () => {
    const suffix = Date.now();
    const tenantA = await createTenantFixture({
      slug: `telegram-participant-a-${suffix}`,
      email: `telegram-participant-owner-a-${suffix}@example.test`,
    });
    const tenantB = await createTenantFixture({
      slug: `telegram-participant-b-${suffix}`,
      email: `telegram-participant-owner-b-${suffix}@example.test`,
    });
    const participantEmail = `telegram-participant-commands-${suffix}@example.test`;
    const chatId = '770010001';
    const lead = await prisma.lead.create({
      data: {
        name: 'Участник команд Telegram',
        phone: '+79990001001',
        email: participantEmail,
        consent: true,
        consentAt: new Date(),
        marketingTelegramConsent: true,
        marketingTelegramConsentAt: new Date(),
        telegramChatId: chatId,
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        telegramSubscribedAt: new Date(),
      },
    });
    const participantUser = await prisma.user.create({
      data: {
        emailNormalized: participantEmail,
        displayName: lead.name,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const accessibleWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        slug: `participant-accessible-${suffix}`,
        title: 'Доступный вебинар участника',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
      },
    });
    const accessibleSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: accessibleWebinar.id,
        title: 'Доступная сессия участника',
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        timezone: 'Europe/Amsterdam',
      },
    });
    await prisma.webinarSource.createMany({
      data: [
        {
          organizationId: tenantA.organization.id,
          webinarId: accessibleWebinar.id,
          type: 'OFFICIAL_SOURCE',
          title: 'Разрешённый материал',
          url: 'https://example.test/participant-material',
          orderIndex: 0,
        },
        {
          organizationId: tenantA.organization.id,
          webinarId: accessibleWebinar.id,
          type: 'OTHER',
          title: 'Небезопасная внутренняя ссылка',
          url: 'http://127.0.0.1/private-material',
          orderIndex: 1,
        },
      ],
    });
    const accessibleRegistration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: accessibleSession.id,
        organizationId: tenantA.organization.id,
        webinarId: accessibleWebinar.id,
        userId: participantUser.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    const privateWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenantB.organization.id,
        slug: `participant-private-${suffix}`,
        title: 'Чужой закрытый вебинар',
        contentStatus: 'PUBLISHED',
        visibility: 'PRIVATE',
      },
    });
    const privateSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantB.organization.id,
        webinarId: privateWebinar.id,
        title: 'Чужая закрытая сессия',
        scheduledAt: new Date(Date.now() + 30 * 60 * 1000),
        timezone: 'Europe/Moscow',
      },
    });
    const privateRegistration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: privateSession.id,
        organizationId: tenantB.organization.id,
        webinarId: privateWebinar.id,
        userId: participantUser.id,
        accessPolicy: 'PRIVATE_GRANT',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });

    const commands = ['/webinars', '/my', '/status', '/room', '/materials', '/help', '/unsubscribe'];
    for (const [index, text] of commands.entries()) {
      await handleParticipantTelegramUpdate({
        update_id: 10_000 + index,
        message: {
          message_id: 11_000 + index,
          text,
          chat: { id: Number(chatId), type: 'private' },
          from: { id: 12_001, username: 'participant_commands', first_name: 'Participant' },
        },
      });
    }
    await handleParticipantTelegramUpdate({
      update_id: 10_100,
      message: {
        message_id: 11_100,
        text: '/room',
        chat: { id: -77_001, type: 'group' },
      },
    });

    const commandEvents = await prisma.telegramBotEvent.findMany({
      where: { eventType: 'telegram_participant_command' },
      orderBy: { providerMessageId: 'asc' },
    });
    expect(commandEvents).toHaveLength(commands.length);
    expect(commandEvents.map(event => (event.metadataJson as { command?: string })?.command)).toEqual(commands);
    for (const event of commandEvents) {
      expect(event).toMatchObject({
        organizationId: tenantA.organization.id,
        webinarId: accessibleWebinar.id,
        webinarSessionId: accessibleSession.id,
        registrationId: accessibleRegistration.id,
        botIdentity: 'PARTICIPANT',
        direction: 'INBOUND',
        correlationId: expect.any(String),
        providerMessageId: expect.any(String),
      });
      expect(JSON.stringify(event.metadataJson ?? {})).not.toMatch(/chatId|email|phone|token|signedUrl/i);
    }
    await expect(prisma.telegramBotEvent.count({ where: { organizationId: tenantB.organization.id } })).resolves.toBe(
      0,
    );
    const roomTokens = await prisma.registrationToken.findMany({ where: { purpose: 'registration' } });
    expect(roomTokens).toHaveLength(3);
    expect(new Set(roomTokens.map(token => token.registrationId))).toEqual(new Set([accessibleRegistration.id]));
    expect(roomTokens.some(token => token.registrationId === privateRegistration.id)).toBe(false);
    await expect(prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).resolves.toMatchObject({
      marketingTelegramConsent: false,
      marketingTelegramRevokedAt: expect.any(Date),
      telegramChatId: chatId,
    });
    await expect(
      prisma.consentRecord.count({
        where: {
          leadId: lead.id,
          kind: 'marketing_telegram',
          action: 'revoke',
          sourceForm: 'telegram_participant_bot',
        },
      }),
    ).resolves.toBe(1);
  }, 60_000);

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
    const { registration, lead, webinarSession } = await createRegisteredParticipant('live-notify@aspb.ru', startedAt);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { telegramChatId: '900900900', telegramBindingVersion: TELEGRAM_BINDING_VERSION },
    });

    // NOTIFY_MODE=log в тестах → отправка не уходит в сеть, но CAS-claim метки отрабатывает.
    expect((await runTelegramLiveJobOnce(new Date())).sent).toBe(1);
    expect((await runTelegramLiveJobOnce(new Date())).sent).toBe(0);

    const updated = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
    expect(updated.telegramLiveSentAt).not.toBeNull();
    const deliveryEvents = await prisma.telegramBotEvent.findMany({
      where: {
        webinarSessionId: webinarSession.id,
        eventType: 'session_live',
        dedupKey: `participant:${registration.id}:session:${webinarSession.id}:session_live:schedule:${webinarSession.scheduleVersion}`,
      },
    });
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]).toMatchObject({
      organizationId: webinarSession.organizationId,
      webinarId: webinarSession.webinarId,
      webinarSessionId: webinarSession.id,
      registrationId: null,
      botIdentity: 'PARTICIPANT',
      direction: 'OUTBOUND',
      providerMessageId: null,
      dedupKey: `participant:${registration.id}:session:${webinarSession.id}:session_live:schedule:${webinarSession.scheduleVersion}`,
      status: 'logged',
      metadataJson: { scheduleVersion: webinarSession.scheduleVersion, deliveryMode: 'log' },
    });
    expect(JSON.stringify(deliveryEvents[0].metadataJson)).not.toContain(lead.email);
    expect(JSON.stringify(deliveryEvents[0].metadataJson)).not.toContain('900900900');
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
        registrationId: null,
        kind: 'system',
        messageType: 'SYSTEM',
        authorName: 'Система АСПБ',
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
      authorRole: 'Подготовленный вопрос',
      message: expect.any(String),
      isSynthetic: true,
    });
    expect(scriptedQuestion).not.toHaveProperty('agentId');
    expect(scriptedQuestion).not.toHaveProperty('answerStartSeconds');
    expect(scriptedQuestion).not.toHaveProperty('topic');
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
    const webinarA = await prisma.webinar.create({
      data: { organizationId: tenantA.organization.id, slug: 'tenant-a-webinar', title: 'Tenant A webinar' },
    });
    const webinarB = await prisma.webinar.create({
      data: { organizationId: tenantB.organization.id, slug: 'tenant-b-webinar', title: 'Tenant B webinar' },
    });
    const sessionA = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinarA.id,
        title: 'Tenant A webinar',
        scheduledAt: new Date('2030-02-01T10:00:00.000Z'),
      },
    });
    const sessionB = await prisma.webinarSession.create({
      data: {
        organizationId: tenantB.organization.id,
        webinarId: webinarB.id,
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

  it('issues and consumes a hashed one-time platform login token without account enumeration', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    const tenant = await createTenantFixture({
      slug: 'platform-login',
      email: 'platform-owner@example.test',
    });
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);

    const knownResponse = await agent
      .post('/api/v1/auth/passwordless/request')
      .set('x-csrf-token', csrfToken)
      .send({ email: ' PLATFORM-OWNER@example.test ' });
    const unknownResponse = await agent
      .post('/api/v1/auth/passwordless/request')
      .set('x-csrf-token', csrfToken)
      .send({ email: 'unknown-account@example.test' });
    expect(knownResponse.status).toBe(202);
    expect(unknownResponse.status).toBe(202);
    expect(knownResponse.body.message).toBe(unknownResponse.body.message);
    await expect(prisma.userAuthEmailJob.count()).resolves.toBe(1);

    const deliveries: Array<{ loginUrl: string; to: string }> = [];
    const deliveryResult = await runUserAuthEmailOutboxJobOnce(new Date(), {
      sendPasswordlessLoginEmail: async input => {
        deliveries.push({ loginUrl: input.loginUrl, to: input.to });
        return { sent: true, mode: 'send' };
      },
    });
    expect(deliveryResult).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].to).toBe('platform-owner@example.test');
    const rawToken = getExchangeTokenFromUrl(deliveries[0].loginUrl);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const storedToken = await prisma.userAuthToken.findFirstOrThrow({ where: { userId: tenant.user.id } });
    expect(storedToken.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedToken.tokenHash).not.toBe(rawToken);

    const consumeResponse = await agent
      .post('/api/v1/auth/passwordless/consume')
      .set('x-csrf-token', csrfToken)
      .send({ token: rawToken });
    expect(consumeResponse.status).toBe(200);
    expect(consumeResponse.body).toMatchObject({
      ok: true,
      user: { id: tenant.user.id, displayName: 'platform-owner@example.test' },
      activeOrganizationId: tenant.organization.id,
      correlationId: expect.any(String),
    });
    expect(consumeResponse.body.sessionToken).toBeUndefined();
    const sessionCookieHeader = (consumeResponse.headers['set-cookie'] as unknown as string[]).find(value =>
      value.startsWith('aspb_user_session='),
    );
    expect(sessionCookieHeader).toContain('HttpOnly');
    expect(sessionCookieHeader).toContain('SameSite=Lax');
    expect(sessionCookieHeader).toContain('Path=/');

    const sessionResponse = await agent.get('/api/v1/auth/session');
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.body.memberships).toEqual([
      expect.objectContaining({ organizationId: tenant.organization.id, role: 'OWNER' }),
    ]);

    const replayAgent = request.agent(app);
    const replayCsrf = await getCsrfToken(replayAgent);
    const replayResponse = await replayAgent
      .post('/api/v1/auth/passwordless/consume')
      .set('x-csrf-token', replayCsrf)
      .send({ token: rawToken });
    expect(replayResponse.status).toBe(401);
    expect(replayResponse.body).toMatchObject({ code: 'passwordless_token_invalid' });

    const expiredRawToken = createAccessToken();
    await prisma.userAuthToken.create({
      data: {
        userId: tenant.user.id,
        tokenHash: hashToken(expiredRawToken),
        purpose: 'PASSWORDLESS_LOGIN',
        createdAt: new Date(Date.now() - 2 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expiredResponse = await replayAgent
      .post('/api/v1/auth/passwordless/consume')
      .set('x-csrf-token', replayCsrf)
      .send({ token: expiredRawToken });
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.body.code).toBe('passwordless_token_invalid');

    const productionRawToken = createAccessToken();
    await prisma.userAuthToken.create({
      data: {
        userId: tenant.user.id,
        tokenHash: hashToken(productionRawToken),
        purpose: 'PASSWORDLESS_LOGIN',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const productionCookieAgent = request.agent(app);
    const productionCookieCsrf = await getCsrfToken(productionCookieAgent);
    const originalNodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const productionCookieResponse = await productionCookieAgent
        .post('/api/v1/auth/passwordless/consume')
        .set('x-csrf-token', productionCookieCsrf)
        .send({ token: productionRawToken });
      expect(productionCookieResponse.status).toBe(200);
      const productionCookieHeader = (productionCookieResponse.headers['set-cookie'] as unknown as string[]).find(
        value => value.startsWith('aspb_user_session='),
      );
      expect(productionCookieHeader).toContain('HttpOnly');
      expect(productionCookieHeader).toContain('Secure');
      expect(productionCookieHeader).toContain('SameSite=Strict');
      expect(productionCookieHeader).toContain('Partitioned');
    } finally {
      env.NODE_ENV = originalNodeEnv;
    }
    await expect(
      prisma.auditLog.count({
        where: { userId: tenant.user.id, action: 'user_auth.passwordless_consumed' },
      }),
    ).resolves.toBe(2);

    const logoutResponse = await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrfToken).send({});
    expect(logoutResponse.status).toBe(204);
    await expect(agent.get('/api/v1/auth/session')).resolves.toMatchObject({ status: 401 });
  });

  it('derives tenant scope from the platform session and hides foreign organizations and memberships', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    const tenantA = await createTenantFixture({ slug: 'http-tenant-a', email: 'http-owner-a@example.test' });
    const tenantB = await prisma.organization.create({
      data: { name: 'HTTP tenant B', slug: 'http-tenant-b', status: 'ACTIVE' },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: tenantB.id,
        userId: tenantA.user.id,
        role: 'AUTHOR',
        status: 'ACTIVE',
      },
    });
    const foreign = await createTenantFixture({ slug: 'http-tenant-foreign', email: 'foreign-owner@example.test' });
    const memberA = await prisma.user.create({
      data: {
        emailNormalized: 'http-member-a@example.test',
        displayName: 'HTTP member A',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const memberAMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: memberA.id,
        role: 'AUTHOR',
        status: 'ACTIVE',
      },
    });
    const rawToken = createAccessToken();
    await prisma.userAuthToken.create({
      data: {
        userId: tenantA.user.id,
        tokenHash: hashToken(rawToken),
        purpose: 'PASSWORDLESS_LOGIN',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const consumeResponse = await agent
      .post('/api/v1/auth/passwordless/consume')
      .set('x-csrf-token', csrfToken)
      .send({ token: rawToken });
    expect(consumeResponse.status).toBe(200);
    expect(consumeResponse.body.activeOrganizationId).toBeNull();
    expect(
      consumeResponse.body.memberships.map((item: { organizationId: string }) => item.organizationId).sort(),
    ).toEqual([tenantA.organization.id, tenantB.id].sort());
    expect(JSON.stringify(consumeResponse.body)).not.toContain(foreign.organization.id);

    const missingContextWrite = await agent
      .patch(`/api/v1/organization/memberships/${memberAMembership.id}/role`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'MODERATOR' });
    expect(missingContextWrite.status).toBe(401);
    expect(missingContextWrite.body.code).toBe('tenant_context_required');

    const foreignSelection = await agent
      .post('/api/v1/auth/active-organization')
      .set('x-csrf-token', csrfToken)
      .send({ organizationId: foreign.organization.id });
    expect(foreignSelection.status).toBe(404);
    expect(foreignSelection.body.code).toBe('tenant_context_unavailable');

    const validSelection = await agent
      .post('/api/v1/auth/active-organization')
      .set('x-csrf-token', csrfToken)
      .send({ organizationId: tenantA.organization.id });
    expect(validSelection.status).toBe(200);
    expect(validSelection.body.organizationId).toBe(tenantA.organization.id);

    const auditCountBeforeForeignWrite = await prisma.auditLog.count();
    const foreignWrite = await agent
      .patch(`/api/v1/organization/memberships/${foreign.membership.id}/role`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'AUTHOR' });
    expect(foreignWrite.status).toBe(404);
    expect(foreignWrite.body.code).toBe('organization_membership_not_found');
    await expect(prisma.auditLog.count()).resolves.toBe(auditCountBeforeForeignWrite);
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: foreign.membership.id } }),
    ).resolves.toMatchObject({ role: 'OWNER' });

    const validWrite = await agent
      .patch(`/api/v1/organization/memberships/${memberAMembership.id}/role`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'MODERATOR' });
    expect(validWrite.status).toBe(200);
    expect(validWrite.body.membership.role).toBe('MODERATOR');
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: memberAMembership.id, action: 'organization_membership.role_changed' },
      }),
    ).resolves.toMatchObject({
      userId: tenantA.user.id,
      organizationId: tenantA.organization.id,
      correlationId: expect.any(String),
    });

    const lastOwnerResponse = await agent
      .patch(`/api/v1/organization/memberships/${tenantA.membership.id}/role`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'AUTHOR' });
    expect(lastOwnerResponse.status).toBe(409);
    expect(lastOwnerResponse.body.code).toBe('last_organization_owner');
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: tenantA.membership.id } }),
    ).resolves.toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
  });

  it('keeps platform auth disabled by default, rejects client tenant injection, and does not treat AdminUser as User', async () => {
    const adminEmail = 'separate-platform-admin@example.test';
    await prisma.adminUser.create({
      data: {
        name: 'Separate admin',
        email: adminEmail,
        passwordHash: await hashPassword('SeparateAdminPassword123'),
        role: 'admin',
        isActive: true,
      },
    });
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);

    const disabledResponse = await agent
      .post('/api/v1/auth/passwordless/request')
      .set('x-csrf-token', csrfToken)
      .send({ email: adminEmail });
    expect(disabledResponse.status).toBe(404);
    expect(disabledResponse.body.code).toBe('platform_accounts_disabled');

    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    const injectionResponse = await agent
      .post('/api/v1/auth/passwordless/request')
      .set('x-csrf-token', csrfToken)
      .send({ email: adminEmail, organizationId: DEFAULT_ORGANIZATION_ID });
    expect(injectionResponse.status).toBe(400);
    expect(injectionResponse.body.code).toBe('validation_failed');

    const adminOnlyResponse = await agent
      .post('/api/v1/auth/passwordless/request')
      .set('x-csrf-token', csrfToken)
      .send({ email: adminEmail });
    expect(adminOnlyResponse.status).toBe(202);
    await expect(prisma.userAuthEmailJob.count()).resolves.toBe(0);
    await expect(prisma.user.count({ where: { emailNormalized: adminEmail } })).resolves.toBe(0);
  });

  it('creates, delivers and accepts a role-bound one-time organization invitation', async () => {
    const tenant = await createTenantFixture({ slug: 'invite-lifecycle', email: 'invite-owner@example.test' });
    const ownerSession = await loginPlatformUser(tenant.user.id);
    const invitedEmail = 'new-author@example.test';

    const createResponse = await ownerSession.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', ownerSession.csrfToken)
      .send({ email: invitedEmail, role: 'AUTHOR' });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toMatchObject({
      ok: true,
      deliveryStatus: 'queued',
      invitation: { emailNormalized: invitedEmail, role: 'AUTHOR', status: 'PENDING' },
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(createResponse.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    await expect(prisma.organizationInvitationToken.count()).resolves.toBe(0);
    await expect(prisma.organizationInvitationEmailJob.count()).resolves.toBe(1);

    const deliveries: Array<{ to: string; invitationUrl: string; roleLabel: string }> = [];
    const outboxResult = await runOrganizationInvitationEmailOutboxJobOnce(new Date(), {
      sendOrganizationInvitationEmail: async input => {
        deliveries.push({ to: input.to, invitationUrl: input.invitationUrl, roleLabel: input.roleLabel });
        return { sent: true, mode: 'send' };
      },
    });
    expect(outboxResult).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    expect(deliveries).toEqual([expect.objectContaining({ to: invitedEmail, roleLabel: 'автор' })]);
    const invitationToken = getExchangeTokenFromUrl(deliveries[0].invitationUrl);
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const storedToken = await prisma.organizationInvitationToken.findFirstOrThrow();
    expect(storedToken.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedToken.tokenHash).not.toBe(invitationToken);

    const inviteeAgent = request.agent(app);
    const inviteeCsrf = await getCsrfToken(inviteeAgent);
    const acceptResponse = await inviteeAgent
      .post('/api/v1/organization/invitations/accept')
      .set('x-csrf-token', inviteeCsrf)
      .send({ token: invitationToken });
    expect(acceptResponse.status).toBe(200);
    expect(acceptResponse.body).toMatchObject({
      ok: true,
      activeOrganizationId: tenant.organization.id,
      memberships: [expect.objectContaining({ organizationId: tenant.organization.id, role: 'AUTHOR' })],
    });
    expect(getCookieValue(acceptResponse, 'aspb_user_session')).toEqual(expect.any(String));
    const invitedUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: invitedEmail } });
    expect(invitedUser).toMatchObject({ kind: 'HUMAN', status: 'ACTIVE', emailVerifiedAt: expect.any(Date) });
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: tenant.organization.id, userId: invitedUser.id } },
      }),
    ).resolves.toMatchObject({ role: 'AUTHOR', status: 'ACTIVE' });
    await expect(
      prisma.organizationInvitation.findUniqueOrThrow({ where: { id: createResponse.body.invitation.id } }),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      acceptedByUserId: invitedUser.id,
      membershipId: expect.any(String),
      acceptedAt: expect.any(Date),
    });
    await expect(
      prisma.organizationInvitationToken.findUniqueOrThrow({ where: { id: storedToken.id } }),
    ).resolves.toMatchObject({ consumedAt: expect.any(Date), invalidatedAt: null });

    const replayAgent = request.agent(app);
    const replayCsrf = await getCsrfToken(replayAgent);
    const replayResponse = await replayAgent
      .post('/api/v1/organization/invitations/accept')
      .set('x-csrf-token', replayCsrf)
      .send({ token: invitationToken });
    expect(replayResponse.status).toBe(401);
    expect(replayResponse.body.code).toBe('organization_invitation_invalid');

    const duplicateResponse = await ownerSession.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', ownerSession.csrfToken)
      .send({ email: invitedEmail, role: 'MODERATOR' });
    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.code).toBe('organization_membership_already_active');
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenant.organization.id,
          action: {
            in: [
              'organization_invitation.created',
              'organization_invitation.accepted',
              'organization_membership.created_from_invitation',
            ],
          },
          correlationId: { not: null },
        },
      }),
    ).resolves.toBe(3);
  });

  it('reactivates a removed membership and keeps invitation list/revoke tenant-scoped', async () => {
    const tenantA = await createTenantFixture({ slug: 'invite-scope-a', email: 'invite-scope-owner-a@example.test' });
    const tenantB = await createTenantFixture({ slug: 'invite-scope-b', email: 'invite-scope-owner-b@example.test' });
    const returningUser = await prisma.user.create({
      data: {
        emailNormalized: 'returning-member@example.test',
        displayName: 'Returning member',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const removedMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: returningUser.id,
        role: 'AUDITOR',
        status: 'REMOVED',
        removedAt: new Date(),
      },
    });
    const sessionA = await loginPlatformUser(tenantA.user.id);
    const sessionB = await loginPlatformUser(tenantB.user.id);

    const invitationA = await sessionA.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ email: returningUser.emailNormalized, role: 'MODERATOR' });
    const invitationB = await sessionB.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', sessionB.csrfToken)
      .send({ email: 'foreign-invite@example.test', role: 'ANALYST' });
    expect(invitationA.status).toBe(201);
    expect(invitationB.status).toBe(201);

    const listA = await sessionA.agent.get('/api/v1/organization/invitations');
    expect(listA.status).toBe(200);
    expect(listA.body.invitations).toEqual([
      expect.objectContaining({ id: invitationA.body.invitation.id, emailNormalized: returningUser.emailNormalized }),
    ]);
    expect(JSON.stringify(listA.body)).not.toContain(invitationB.body.invitation.id);

    const auditCountBeforeForeignRevoke = await prisma.auditLog.count();
    const foreignRevoke = await sessionA.agent
      .delete(`/api/v1/organization/invitations/${invitationB.body.invitation.id}`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(foreignRevoke.status).toBe(404);
    expect(foreignRevoke.body.code).toBe('organization_invitation_not_found');
    await expect(prisma.auditLog.count()).resolves.toBe(auditCountBeforeForeignRevoke);
    await expect(
      prisma.organizationInvitation.findUniqueOrThrow({ where: { id: invitationB.body.invitation.id } }),
    ).resolves.toMatchObject({ status: 'PENDING' });

    const deliveries: Array<{ to: string; invitationUrl: string }> = [];
    await runOrganizationInvitationEmailOutboxJobOnce(new Date(), {
      sendOrganizationInvitationEmail: async input => {
        deliveries.push({ to: input.to, invitationUrl: input.invitationUrl });
        return { sent: true, mode: 'send' };
      },
    });
    const returningDelivery = deliveries.find(delivery => delivery.to === returningUser.emailNormalized);
    const returningToken = returningDelivery ? getExchangeTokenFromUrl(returningDelivery.invitationUrl) : null;
    expect(returningToken).toEqual(expect.any(String));

    const returningAgent = request.agent(app);
    const returningCsrf = await getCsrfToken(returningAgent);
    const accepted = await returningAgent
      .post('/api/v1/organization/invitations/accept')
      .set('x-csrf-token', returningCsrf)
      .send({ token: returningToken });
    expect(accepted.status).toBe(200);
    await expect(
      prisma.organizationMembership.findUniqueOrThrow({ where: { id: removedMembership.id } }),
    ).resolves.toMatchObject({ role: 'MODERATOR', status: 'ACTIVE', removedAt: null });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: removedMembership.id, action: 'organization_membership.reactivated_from_invitation' },
      }),
    ).resolves.toMatchObject({
      userId: returningUser.id,
      organizationId: tenantA.organization.id,
      correlationId: expect.any(String),
      beforeJson: expect.objectContaining({ role: 'AUDITOR', status: 'REMOVED' }),
      afterJson: expect.objectContaining({ role: 'MODERATOR', status: 'ACTIVE' }),
    });

    const nonOwnerCreate = await returningAgent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', returningCsrf)
      .send({ email: 'must-not-invite@example.test', role: 'AUTHOR' });
    expect(nonOwnerCreate.status).toBe(403);
    expect(nonOwnerCreate.body.code).toBe('tenant_owner_required');

    const revokedInvitation = await sessionA.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ email: 'revoked-invite@example.test', role: 'AUTHOR' });
    const revokedDeliveries: Array<{ invitationUrl: string }> = [];
    await runOrganizationInvitationEmailOutboxJobOnce(new Date(), {
      sendOrganizationInvitationEmail: async input => {
        if (input.to === 'revoked-invite@example.test') revokedDeliveries.push({ invitationUrl: input.invitationUrl });
        return { sent: true, mode: 'send' };
      },
    });
    const revokedToken = getExchangeTokenFromUrl(revokedDeliveries[0].invitationUrl);
    const revokeResponse = await sessionA.agent
      .delete(`/api/v1/organization/invitations/${revokedInvitation.body.invitation.id}`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body.invitation.status).toBe('REVOKED');
    const revokedAgent = request.agent(app);
    const revokedCsrf = await getCsrfToken(revokedAgent);
    const revokedAccept = await revokedAgent
      .post('/api/v1/organization/invitations/accept')
      .set('x-csrf-token', revokedCsrf)
      .send({ token: revokedToken });
    expect(revokedAccept.status).toBe(401);
    expect(revokedAccept.body.code).toBe('organization_invitation_invalid');

    const expiringInvitation = await sessionA.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ email: 'expired-invite@example.test', role: 'AUDITOR' });
    const expiredDeliveries: Array<{ invitationUrl: string }> = [];
    await runOrganizationInvitationEmailOutboxJobOnce(new Date(), {
      sendOrganizationInvitationEmail: async input => {
        if (input.to === 'expired-invite@example.test') expiredDeliveries.push({ invitationUrl: input.invitationUrl });
        return { sent: true, mode: 'send' };
      },
    });
    const expiredToken = getExchangeTokenFromUrl(expiredDeliveries[0].invitationUrl);
    const expiredTokenRow = await prisma.organizationInvitationToken.findFirstOrThrow({
      where: { invitationId: expiringInvitation.body.invitation.id },
    });
    const oldCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldExpiresAt = new Date(Date.now() - 60_000);
    await prisma.organizationInvitation.update({
      where: { id: expiringInvitation.body.invitation.id },
      data: { createdAt: oldCreatedAt, expiresAt: oldExpiresAt },
    });
    await prisma.organizationInvitationToken.update({
      where: { id: expiredTokenRow.id },
      data: { createdAt: oldCreatedAt, expiresAt: oldExpiresAt },
    });
    const expiredAgent = request.agent(app);
    const expiredCsrf = await getCsrfToken(expiredAgent);
    const expiredAccept = await expiredAgent
      .post('/api/v1/organization/invitations/accept')
      .set('x-csrf-token', expiredCsrf)
      .send({ token: expiredToken });
    expect(expiredAccept.status).toBe(401);
    expect(expiredAccept.body.code).toBe('organization_invitation_invalid');
    await sessionA.agent.get('/api/v1/organization/invitations');
    await expect(
      prisma.organizationInvitation.findUniqueOrThrow({ where: { id: expiringInvitation.body.invitation.id } }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('makes owner MFA available and blocks protected tenant access until the session is verified', async () => {
    const tenant = await createTenantFixture({ slug: 'owner-mfa', email: 'owner-mfa@example.test' });
    const primarySession = await loginPlatformUser(tenant.user.id);
    const otherSession = await loginPlatformUser(tenant.user.id);

    const enrollment = await primarySession.agent
      .post('/api/v1/auth/mfa/enrollment/start')
      .set('x-csrf-token', primarySession.csrfToken)
      .send({});
    expect(enrollment.status).toBe(200);
    expect(enrollment.body).toMatchObject({
      secret: expect.stringMatching(/^[A-Z2-7]+$/),
      otpauthUrl: expect.stringMatching(/^otpauth:\/\/totp\//),
      expiresAt: expect.any(String),
      correlationId: expect.any(String),
    });
    const enrollmentSecret = enrollment.body.secret as string;
    const storedEnrollment = await prisma.user.findUniqueOrThrow({ where: { id: tenant.user.id } });
    expect(storedEnrollment.mfaSecretEncrypted).toMatch(/^v1\./);
    expect(storedEnrollment.mfaSecretEncrypted).not.toContain(enrollmentSecret);
    expect(storedEnrollment.mfaEnabledAt).toBeNull();
    expect(storedEnrollment.mfaEnrollmentExpiresAt).toEqual(expect.any(Date));

    const invalidConfirm = await primarySession.agent
      .post('/api/v1/auth/mfa/enrollment/confirm')
      .set('x-csrf-token', primarySession.csrfToken)
      .send({ otp: '000000' });
    expect(invalidConfirm.status).toBe(401);
    expect(invalidConfirm.body.code).toBe('user_mfa_code_invalid');

    const confirm = await primarySession.agent
      .post('/api/v1/auth/mfa/enrollment/confirm')
      .set('x-csrf-token', primarySession.csrfToken)
      .send({ otp: generateTotp(enrollmentSecret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({
      authenticated: true,
      mfaRequired: false,
      mfa: { enabled: true, verified: true },
    });
    await expect(otherSession.agent.get('/api/v1/auth/session')).resolves.toMatchObject({ status: 401 });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: tenant.user.id } })).resolves.toMatchObject({
      mfaEnabledAt: expect.any(Date),
      mfaEnrollmentExpiresAt: null,
    });

    const challengedSession = await loginPlatformUser(tenant.user.id);
    expect(challengedSession.response.body).toMatchObject({
      authenticated: false,
      mfaRequired: true,
    });
    expect(challengedSession.response.body.user).toBeUndefined();
    expect(challengedSession.response.body.memberships).toBeUndefined();
    const challengeSummary = await challengedSession.agent.get('/api/v1/auth/session');
    expect(challengeSummary.status).toBe(200);
    expect(challengeSummary.body).toMatchObject({ authenticated: false, mfaRequired: true });
    expect(challengeSummary.body.memberships).toBeUndefined();

    const protectedBeforeMfa = await challengedSession.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', challengedSession.csrfToken)
      .send({ email: 'blocked-before-mfa@example.test', role: 'AUTHOR' });
    expect(protectedBeforeMfa.status).toBe(401);
    expect(protectedBeforeMfa.body.code).toBe('user_authentication_required');
    await expect(prisma.organizationInvitation.count()).resolves.toBe(0);

    const invalidVerification = await challengedSession.agent
      .post('/api/v1/auth/mfa/verify')
      .set('x-csrf-token', challengedSession.csrfToken)
      .send({ otp: '12345', organizationId: tenant.organization.id });
    expect(invalidVerification.status).toBe(400);
    expect(invalidVerification.body.code).toBe('validation_failed');

    const verification = await challengedSession.agent
      .post('/api/v1/auth/mfa/verify')
      .set('x-csrf-token', challengedSession.csrfToken)
      .send({ otp: generateTotp(enrollmentSecret) });
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({
      authenticated: true,
      mfaRequired: false,
      activeOrganizationId: tenant.organization.id,
      mfa: { enabled: true, verified: true },
    });

    const protectedAfterMfa = await challengedSession.agent
      .post('/api/v1/organization/invitations')
      .set('x-csrf-token', challengedSession.csrfToken)
      .send({ email: 'allowed-after-mfa@example.test', role: 'AUTHOR' });
    expect(protectedAfterMfa.status).toBe(201);

    const disable = await challengedSession.agent
      .post('/api/v1/auth/mfa/disable')
      .set('x-csrf-token', challengedSession.csrfToken)
      .send({ otp: generateTotp(enrollmentSecret) });
    expect(disable.status).toBe(200);
    expect(disable.body.mfa).toEqual({ enabled: false, verified: true });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: tenant.user.id } })).resolves.toMatchObject({
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      mfaEnrollmentExpiresAt: null,
    });
    await expect(
      prisma.auditLog.count({
        where: {
          userId: tenant.user.id,
          organizationId: tenant.organization.id,
          action: { in: ['user_mfa.enrollment_started', 'user_mfa.enabled', 'user_mfa.verified', 'user_mfa.disabled'] },
          correlationId: { not: null },
        },
      }),
    ).resolves.toBe(4);
  });

  it('does not expose owner MFA enrollment to non-owner tenant roles', async () => {
    const tenant = await createTenantFixture({
      slug: 'author-mfa-denied',
      email: 'author-mfa-denied@example.test',
      role: 'AUTHOR',
    });
    const session = await loginPlatformUser(tenant.user.id);
    const response = await session.agent
      .post('/api/v1/auth/mfa/enrollment/start')
      .set('x-csrf-token', session.csrfToken)
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('tenant_owner_required');
    await expect(
      prisma.auditLog.count({ where: { userId: tenant.user.id, action: { startsWith: 'user_mfa.' } } }),
    ).resolves.toBe(0);
  });

  it('saves, reviews and publishes only the safe projection of a tenant-scoped author profile', async () => {
    const tenantA = await createTenantFixture({ slug: 'author-profile-a', email: 'author-profile-a@example.test' });
    const tenantB = await createTenantFixture({ slug: 'author-profile-b', email: 'author-profile-b@example.test' });
    const sessionA = await loginPlatformUser(tenantA.user.id);
    const sessionB = await loginPlatformUser(tenantB.user.id);

    const injectedTenant = await sessionA.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ publicName: 'Анна Юрист', organizationId: tenantB.organization.id });
    expect(injectedTenant.status).toBe(400);
    expect(injectedTenant.body.code).toBe('validation_failed');

    const partialDraft = await sessionA.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ publicName: 'Анна Юрист', region: 'Москва' });
    expect(partialDraft.status).toBe(200);
    expect(partialDraft.body.profile).toMatchObject({
      publicName: 'Анна Юрист',
      region: 'Москва',
      verificationStatus: 'DRAFT',
    });

    const incompleteSubmission = await sessionA.agent
      .post('/api/v1/author-verification')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(incompleteSubmission.status).toBe(400);
    expect(incompleteSubmission.body.code).toBe('validation_failed');
    await expect(prisma.authorVerification.count()).resolves.toBe(0);

    const completeDraft = await sessionA.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({
        bio: 'Практикующий юрист по корпоративному и договорному праву с опытом сопровождения бизнеса.',
        specializations: ['Корпоративное право', 'Договорная работа'],
        professionalOrganization: 'Коллегия юристов «Право»',
        experience: 'Более десяти лет сопровождаю компании и представляю доверителей в арбитражных судах.',
      });
    expect(completeDraft.status).toBe(200);
    const profileId = completeDraft.body.profile.id as string;
    const profileSlug = completeDraft.body.profile.slug as string;

    const mismatchedEvidence = await sessionA.agent
      .post('/api/v1/author-verification/evidence')
      .set('x-csrf-token', sessionA.csrfToken)
      .set('content-type', 'application/pdf')
      .set('x-evidence-kind', 'LICENSE')
      .set('x-evidence-filename', encodeURIComponent('лицензия.pdf'))
      .send(Buffer.from('not-a-pdf'));
    expect(mismatchedEvidence.status).toBe(400);
    expect(mismatchedEvidence.body.code).toBe('author_evidence_content_invalid');

    const oversizedEvidence = await sessionA.agent
      .post('/api/v1/author-verification/evidence')
      .set('x-csrf-token', sessionA.csrfToken)
      .set('content-type', 'application/pdf')
      .set('x-evidence-kind', 'LICENSE')
      .set('x-evidence-filename', 'oversized.pdf')
      .send(Buffer.alloc(5 * 1024 * 1024 + 1, 0x25));
    expect(oversizedEvidence.status).toBe(413);
    expect(oversizedEvidence.body.code).toBe('payload_too_large');

    const pdfContent = Buffer.from('%PDF-1.7\nprivate verification evidence\n%%EOF');
    const upload = await sessionA.agent
      .post('/api/v1/author-verification/evidence')
      .set('x-csrf-token', sessionA.csrfToken)
      .set('content-type', 'application/pdf')
      .set('x-evidence-kind', 'LICENSE')
      .set('x-evidence-filename', encodeURIComponent('../лицензия.pdf'))
      .send(pdfContent);
    expect(upload.status).toBe(201);
    expect(upload.body.evidence).toMatchObject({
      kind: 'LICENSE',
      originalName: 'лицензия.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfContent.length,
      checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      submitted: false,
    });
    expect(JSON.stringify(upload.body)).not.toContain('private verification evidence');
    const evidenceId = upload.body.evidence.id as string;

    const foreignEvidenceRead = await sessionB.agent.get(`/api/v1/author-verification/evidence/${evidenceId}`);
    expect(foreignEvidenceRead.status).toBe(404);
    expect(foreignEvidenceRead.body.code).toBe('author_evidence_not_found');
    const foreignEvidenceDelete = await sessionB.agent
      .delete(`/api/v1/author-verification/evidence/${evidenceId}`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({});
    expect(foreignEvidenceDelete.status).toBe(404);
    expect(foreignEvidenceDelete.body.code).toBe('author_evidence_not_found');

    const submission = await sessionA.agent
      .post('/api/v1/author-verification')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(submission.status).toBe(201);
    expect(submission.body.verification).toMatchObject({ status: 'PENDING', publicComment: null });
    const firstVerificationId = submission.body.verification.id as string;
    await expect(prisma.authorProfile.findUniqueOrThrow({ where: { id: profileId } })).resolves.toMatchObject({
      verificationStatus: 'PENDING',
    });

    const lockedDraft = await sessionA.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ region: 'Санкт-Петербург' });
    expect(lockedDraft.status).toBe(409);
    expect(lockedDraft.body.code).toBe('author_profile_not_editable');
    const privateBeforeVerification = await request(app).get(`/api/v1/catalog/authors/${profileSlug}`);
    expect(privateBeforeVerification.status).toBe(404);

    const platformAdmin = await loginAdmin('admin', 'author-review-admin@example.test');
    const managerAdmin = await loginAdmin('manager', 'author-review-manager@example.test');
    const deniedAdminList = await managerAdmin.agent.get('/api/v1/platform/author-verifications');
    expect(deniedAdminList.status).toBe(403);

    const adminList = await platformAdmin.agent.get('/api/v1/platform/author-verifications?status=PENDING');
    expect(adminList.status).toBe(200);
    expect(adminList.body.items).toEqual([
      expect.objectContaining({
        id: firstVerificationId,
        status: 'PENDING',
        internalReason: null,
        evidence: [expect.objectContaining({ id: evidenceId })],
      }),
    ]);
    expect(JSON.stringify(adminList.body)).not.toContain('private verification evidence');

    const adminEvidence = await platformAdmin.agent.get(`/api/v1/platform/author-verifications/evidence/${evidenceId}`);
    expect(adminEvidence.status).toBe(200);
    expect(adminEvidence.headers['cache-control']).toBe('no-store');
    expect(adminEvidence.headers['x-robots-tag']).toContain('noindex');
    expect(Buffer.from(adminEvidence.body)).toEqual(pdfContent);

    const needsInfo = await platformAdmin.agent
      .patch(`/api/v1/platform/author-verifications/${firstVerificationId}`)
      .set('x-csrf-token', platformAdmin.csrfToken)
      .send({
        status: 'NEEDS_INFO',
        publicComment: 'Добавьте подробности о судебной практике.',
        internalReason: 'Недостаточно описан подтверждённый опыт.',
      });
    expect(needsInfo.status).toBe(200);
    expect(needsInfo.body.verification).toMatchObject({
      status: 'NEEDS_INFO',
      publicComment: 'Добавьте подробности о судебной практике.',
      internalReason: 'Недостаточно описан подтверждённый опыт.',
    });

    const authorAfterNeedsInfo = await sessionA.agent.get('/api/v1/author-profile');
    expect(authorAfterNeedsInfo.status).toBe(200);
    expect(authorAfterNeedsInfo.body.latestVerification).toMatchObject({
      status: 'NEEDS_INFO',
      publicComment: 'Добавьте подробности о судебной практике.',
    });
    expect(JSON.stringify(authorAfterNeedsInfo.body)).not.toContain('Недостаточно описан подтверждённый опыт.');

    const revisedDraft = await sessionA.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({
        experience:
          'Более десяти лет сопровождаю компании; участвовала более чем в пятидесяти арбитражных спорах и веду договорные проекты.',
      });
    expect(revisedDraft.status).toBe(200);
    const resubmission = await sessionA.agent
      .post('/api/v1/author-verification')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(resubmission.status).toBe(201);
    const secondVerificationId = resubmission.body.verification.id as string;

    const verified = await platformAdmin.agent
      .patch(`/api/v1/platform/author-verifications/${secondVerificationId}`)
      .set('x-csrf-token', platformAdmin.csrfToken)
      .send({ status: 'VERIFIED' });
    expect(verified.status).toBe(200);
    expect(verified.body.verification.status).toBe('VERIFIED');

    const publicProfile = await request(app).get(`/api/v1/catalog/authors/${profileSlug}`);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.body.author).toMatchObject({
      slug: profileSlug,
      publicName: 'Анна Юрист',
      verificationStatus: 'VERIFIED',
      organization: { name: tenantA.organization.name, slug: tenantA.organization.slug },
    });
    expect(JSON.stringify(publicProfile.body)).not.toContain(evidenceId);
    expect(JSON.stringify(publicProfile.body)).not.toContain('internalReason');
    expect(JSON.stringify(publicProfile.body)).not.toContain(tenantA.user.emailNormalized);

    const authorContext = await resolveTenantContext(prisma, {
      userId: tenantA.user.id,
      activeOrganizationId: tenantA.organization.id,
      correlationId: 'req_author_publish_policy',
    });
    await expect(assertAuthorCanPublish(prisma, authorContext, profileId)).resolves.toMatchObject({ id: profileId });

    const suspended = await platformAdmin.agent
      .patch(`/api/v1/platform/author-verifications/${secondVerificationId}`)
      .set('x-csrf-token', platformAdmin.csrfToken)
      .send({ status: 'SUSPENDED', internalReason: 'Временная приостановка до повторной проверки.' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.verification.status).toBe('SUSPENDED');
    await expect(assertAuthorCanPublish(prisma, authorContext, profileId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'author_verification_required',
    });
    const publicAfterSuspension = await request(app).get(`/api/v1/catalog/authors/${profileSlug}`);
    expect(publicAfterSuspension.status).toBe(404);

    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: {
            in: [
              'author_profile.draft_saved',
              'author_verification.evidence_uploaded',
              'author_verification.submitted',
              'author_verification.reviewed',
              'author_verification.evidence_accessed_by_admin',
            ],
          },
          correlationId: { not: null },
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(8);
  });

  it('denies author profile mutations to non-author tenant roles', async () => {
    const tenant = await createTenantFixture({
      slug: 'moderator-author-profile-denied',
      email: 'moderator-author-profile-denied@example.test',
      role: 'MODERATOR',
    });
    const session = await loginPlatformUser(tenant.user.id);
    const response = await session.agent
      .patch('/api/v1/author-profile')
      .set('x-csrf-token', session.csrfToken)
      .send({ publicName: 'Недоступный профиль' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('tenant_permission_denied');
    await expect(prisma.authorProfile.count()).resolves.toBe(0);
  });

  it('isolates creator webinar reads, writes, sources, preview and commands by authenticated tenant', async () => {
    const taxonomy = await ensureLegalTaxonomyFixture();
    const tenantA = await createTenantFixture({
      slug: 'creator-isolation-a',
      email: 'creator-isolation-a@example.test',
      role: 'AUTHOR',
    });
    const tenantB = await createTenantFixture({
      slug: 'creator-isolation-b',
      email: 'creator-isolation-b@example.test',
      role: 'AUTHOR',
    });
    const profileA = await prisma.authorProfile.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: tenantA.user.id,
        slug: 'creator-isolation-a',
        publicName: 'Автор организации А',
        verificationStatus: 'VERIFIED',
      },
    });
    const profileB = await prisma.authorProfile.create({
      data: {
        organizationId: tenantB.organization.id,
        userId: tenantB.user.id,
        slug: 'creator-isolation-b',
        publicName: 'Автор организации Б',
        verificationStatus: 'VERIFIED',
      },
    });
    const foreignWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenantB.organization.id,
        authorProfileId: profileB.id,
        slug: 'foreign-private-webinar',
        title: 'Закрытый вебинар организации Б',
      },
    });
    const platformSession = await loginPlatformUser(tenantA.user.id);
    env.CREATOR_DASHBOARD_ENABLED = 'on';

    const createResponse = await platformSession.agent
      .post('/api/v1/creator/webinars')
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        title: 'Практика безопасной публикации',
        slug: 'safe-publication-practice',
        description: 'Подробное описание юридического вебинара для безопасной проверки tenant scope.',
        outcomeDescription: 'Зритель сможет применить проверенный порядок действий.',
        jurisdictionId: taxonomy.jurisdiction.id,
        practiceAreas: [
          { practiceAreaId: taxonomy.root.id, isPrimary: true },
          { practiceAreaId: taxonomy.specialization.id, isPrimary: false },
        ],
        visibility: 'PRIVATE',
        freshnessStatus: 'CURRENT',
        audienceLevel: 'PRACTITIONER',
        targetAudience: 'Практикующие юристы и арбитражные управляющие',
        format: 'PREMIERE',
        durationMinutes: 65,
        language: 'ru',
        currentAsOf: '2026-08-20',
        disclaimer: 'Материал носит информационный характер и не заменяет анализ конкретной ситуации.',
        syntheticDisclosure: 'Подготовленные сообщения будут явно обозначены в комнате.',
      });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.webinar).toMatchObject({
      author: { id: profileA.id },
      contentStatus: 'DRAFT',
      mediaStatus: 'NOT_UPLOADED',
      transcriptStatus: 'NOT_AVAILABLE',
      scenarioStatus: 'NOT_AVAILABLE',
    });
    const webinarId = createResponse.body.webinar.id as string;

    const forgedTenant = await platformSession.agent
      .post('/api/v1/creator/webinars')
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        organizationId: tenantB.organization.id,
        title: 'Подмена организации',
        slug: 'forged-organization',
      });
    expect(forgedTenant.status).toBe(400);
    expect(forgedTenant.body.code).toBe('validation_failed');

    const missingRead = await platformSession.agent.get('/api/v1/creator/webinars/missing-webinar');
    const foreignRead = await platformSession.agent.get(`/api/v1/creator/webinars/${foreignWebinar.id}`);
    expect(foreignRead.status).toBe(404);
    expect(foreignRead.body).toMatchObject({ code: 'webinar_not_found', error: missingRead.body.error });

    const foreignWrite = await platformSession.agent
      .patch(`/api/v1/creator/webinars/${foreignWebinar.id}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ title: 'Попытка изменить чужой вебинар' });
    expect(foreignWrite.status).toBe(404);
    expect(foreignWrite.body.code).toBe('webinar_not_found');

    const foreignSource = await platformSession.agent
      .post(`/api/v1/creator/webinars/${foreignWebinar.id}/sources`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ type: 'OFFICIAL_SOURCE', title: 'Чужой источник', url: 'https://example.test/source' });
    expect(foreignSource.status).toBe(404);
    expect(foreignSource.body.code).toBe('webinar_not_found');

    const foreignPreview = await platformSession.agent.get(`/api/v1/creator/webinars/${foreignWebinar.id}/preview`);
    expect(foreignPreview.status).toBe(404);
    expect(foreignPreview.body.code).toBe('webinar_not_found');

    const foreignPublish = await platformSession.agent
      .post(`/api/v1/creator/webinars/${foreignWebinar.id}/publish`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'foreign-publish-0001')
      .send({});
    expect(foreignPublish.status).toBe(404);
    expect(foreignPublish.body.code).toBe('webinar_not_found');

    const sourceResponse = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarId}/sources`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        type: 'OFFICIAL_SOURCE',
        title: 'Официальный источник',
        url: 'https://example.test/legal-source',
        accessedAt: '2026-08-20',
      });
    expect(sourceResponse.status).toBe(201);

    const countsBeforePreview = await Promise.all([
      prisma.registration.count(),
      prisma.event.count(),
      prisma.emailOutboxJob.count(),
      prisma.lead.count(),
    ]);
    const preview = await platformSession.agent.get(`/api/v1/creator/webinars/${webinarId}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, sideEffectsCreated: false });
    await expect(
      Promise.all([
        prisma.registration.count(),
        prisma.event.count(),
        prisma.emailOutboxJob.count(),
        prisma.lead.count(),
      ]),
    ).resolves.toEqual(countsBeforePreview);

    const rename = await platformSession.agent
      .patch(`/api/v1/creator/webinars/${webinarId}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ slug: 'safe-publication-renamed' });
    expect(rename.status).toBe(200);
    await expect(
      prisma.webinarSlugAlias.findUnique({
        where: {
          organizationId_slug: {
            organizationId: tenantA.organization.id,
            slug: 'safe-publication-practice',
          },
        },
      }),
    ).resolves.toMatchObject({ webinarId });

    const submit = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarId}/submit`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'submit-webinar-0001')
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.webinar.contentStatus).toBe('IN_MODERATION');
    const invalidTransition = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarId}/submit`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'submit-webinar-0002')
      .send({});
    expect(invalidTransition.status).toBe(409);
    expect(invalidTransition.body.code).toBe('webinar_transition_invalid');

    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: foreignWebinar.id } })).resolves.toMatchObject({
      title: 'Закрытый вебинар организации Б',
      contentStatus: 'DRAFT',
    });
    await expect(
      prisma.auditLog.count({ where: { organizationId: tenantB.organization.id, entityId: foreignWebinar.id } }),
    ).resolves.toBe(0);
  });

  it('enforces author verification before publish readiness and makes publish idempotent', async () => {
    const taxonomy = await ensureLegalTaxonomyFixture();
    const tenant = await createTenantFixture({
      slug: 'creator-publication',
      email: 'creator-publication@example.test',
      role: 'AUTHOR',
    });
    const profile = await prisma.authorProfile.create({
      data: {
        organizationId: tenant.organization.id,
        userId: tenant.user.id,
        slug: 'creator-publication',
        publicName: 'Проверяемый автор',
        verificationStatus: 'DRAFT',
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        jurisdictionId: taxonomy.jurisdiction.id,
        slug: 'publication-policy',
        title: 'Проверка политики публикации',
        description: 'Подробное описание для проверки серверной политики публикации вебинара.',
        outcomeDescription: 'Зритель получит проверяемый практический результат.',
        contentStatus: 'READY',
        visibility: 'PUBLIC',
        freshnessStatus: 'CURRENT',
        audienceLevel: 'PRACTITIONER',
        targetAudience: 'Практикующие юристы',
        format: 'ON_DEMAND',
        durationMinutes: 60,
        currentAsOf: new Date('2026-08-20T00:00:00.000Z'),
        disclaimer: 'Материал носит информационный характер и не заменяет анализ конкретной ситуации.',
        syntheticDisclosure: 'Подготовленные сообщения имеют явную текстовую маркировку.',
        mediaStatus: 'READY',
        transcriptStatus: 'PUBLISHED',
        scenarioStatus: 'PUBLISHED',
        practiceAreas: {
          create: [
            { practiceAreaId: taxonomy.root.id, isPrimary: true },
            {
              practiceAreaId: taxonomy.specialization.id,
              isPrimary: false,
            },
          ],
        },
      },
    });
    const platformSession = await loginPlatformUser(tenant.user.id);
    env.CREATOR_DASHBOARD_ENABLED = 'on';

    const unverified = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/publish`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'publish-unverified-001')
      .send({});
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe('author_verification_required');

    await prisma.authorProfile.update({ where: { id: profile.id }, data: { verificationStatus: 'SUSPENDED' } });
    const suspended = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/publish`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'publish-suspended-001')
      .send({});
    expect(suspended.status).toBe(403);
    expect(suspended.body.code).toBe('author_verification_required');

    await prisma.authorProfile.update({ where: { id: profile.id }, data: { verificationStatus: 'VERIFIED' } });
    const published = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/publish`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'publish-verified-0001')
      .send({});
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ replayed: false, webinar: { contentStatus: 'PUBLISHED' } });

    const replayed = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/publish`)
      .set('x-csrf-token', platformSession.csrfToken)
      .set('idempotency-key', 'publish-verified-0001')
      .send({});
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ replayed: true, webinar: { contentStatus: 'PUBLISHED' } });
    await expect(prisma.auditLog.count({ where: { entityId: webinar.id, action: 'webinar.publish' } })).resolves.toBe(
      1,
    );
    await expect(prisma.webinarCommand.count({ where: { webinarId: webinar.id, action: 'publish' } })).resolves.toBe(1);
  });

  it('publishes only eligible catalog projections and hides unlisted, private, draft and archived records', async () => {
    const taxonomy = await ensureLegalTaxonomyFixture();
    const tenant = await createTenantFixture({
      slug: 'catalog-tenant',
      email: 'catalog-author@example.test',
      role: 'AUTHOR',
    });
    const otherTenant = await createTenantFixture({
      slug: 'catalog-other-tenant',
      email: 'catalog-other-author@example.test',
      role: 'AUTHOR',
    });
    const [profile, otherProfile] = await Promise.all([
      prisma.authorProfile.create({
        data: {
          organizationId: tenant.organization.id,
          userId: tenant.user.id,
          slug: 'catalog-author-profile',
          publicName: 'Анна Каталогова',
          bio: 'Проверенный автор каталога.',
          verificationStatus: 'VERIFIED',
        },
      }),
      prisma.authorProfile.create({
        data: {
          organizationId: otherTenant.organization.id,
          userId: otherTenant.user.id,
          slug: 'catalog-other-author-profile',
          publicName: 'Другой проверенный автор',
          verificationStatus: 'VERIFIED',
        },
      }),
    ]);
    const common = {
      jurisdictionId: taxonomy.jurisdiction.id,
      description: 'Подробное описание публичного юридического вебинара для каталога.',
      outcomeDescription: 'Слушатель получит проверяемый практический результат.',
      freshnessStatus: 'CURRENT' as const,
      audienceLevel: 'PRACTITIONER' as const,
      targetAudience: 'Практикующие юристы и руководители',
      format: 'PREMIERE' as const,
      durationMinutes: 60,
      currentAsOf: new Date('2026-08-21T00:00:00.000Z'),
      disclaimer: 'Материал носит информационный характер и не заменяет индивидуальную консультацию.',
      publishedAt: new Date('2026-08-21T10:00:00.000Z'),
    };
    const { freshnessStatus: _currentFreshness, ...commonWithoutFreshness } = common;
    const publicWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-public-webinar',
        title: 'Публичный договорный вебинар',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        ...common,
        practiceAreas: {
          create: [
            { practiceAreaId: taxonomy.root.id, isPrimary: true },
            { practiceAreaId: taxonomy.specialization.id, isPrimary: false },
          ],
        },
        sources: {
          create: {
            type: 'OFFICIAL_SOURCE',
            title: 'Официальный источник каталога',
            url: 'https://example.test/catalog-source',
          },
        },
      },
    });
    const successor = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-current-version',
        title: 'Актуальная версия вебинара',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        ...common,
      },
    });
    const superseded = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-old-version',
        title: 'Предыдущая версия вебинара',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        freshnessStatus: 'SUPERSEDED',
        supersededByWebinarId: successor.id,
        ...commonWithoutFreshness,
        slugAliases: { create: { slug: 'catalog-old-alias' } },
      },
    });
    const unlisted = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-unlisted-webinar',
        title: 'Вебинар только по ссылке',
        contentStatus: 'PUBLISHED',
        visibility: 'UNLISTED',
        ...common,
      },
    });
    const privateWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-private-webinar',
        title: 'Закрытый вебинар',
        contentStatus: 'PUBLISHED',
        visibility: 'PRIVATE',
        ...common,
      },
    });
    const draft = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-draft-webinar',
        title: 'Черновик вебинара',
        contentStatus: 'DRAFT',
        visibility: 'PUBLIC',
      },
    });
    const archived = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'catalog-archived-webinar',
        title: 'Архивный вебинар',
        contentStatus: 'ARCHIVED',
        visibility: 'PUBLIC',
        archivedAt: new Date(),
        ...common,
      },
    });
    await prisma.webinar.create({
      data: {
        organizationId: otherTenant.organization.id,
        authorProfileId: otherProfile.id,
        slug: publicWebinar.slug,
        title: 'Одноимённый вебинар другой организации',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        ...common,
      },
    });
    const scheduledAt = new Date('2032-01-15T16:30:00.000Z');
    const session = await prisma.webinarSession.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: publicWebinar.id,
        title: publicWebinar.title,
        scheduledAt,
        timezone: 'Europe/Moscow',
        durationMinutes: 60,
      },
    });

    const disabled = await request(app).get('/api/v1/catalog/webinars');
    expect(disabled.status).toBe(404);
    expect(disabled.body.code).toBe('public_catalog_disabled');
    env.PUBLIC_CATALOG_ENABLED = 'on';

    const catalog = await request(app).get('/api/v1/catalog/webinars').query({
      q: 'договорный',
      practiceArea: taxonomy.root.slug,
      specialization: taxonomy.specialization.slug,
      jurisdiction: taxonomy.jurisdiction.code,
      level: 'PRACTITIONER',
      format: 'PREMIERE',
      availability: 'UPCOMING',
      sort: 'UPCOMING',
    });
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toEqual([
      expect.objectContaining({
        slug: publicWebinar.slug,
        title: publicWebinar.title,
        visibility: 'PUBLIC',
        author: { slug: profile.slug, publicName: profile.publicName },
        organization: { slug: tenant.organization.slug, name: tenant.organization.name },
        jurisdiction: { code: taxonomy.jurisdiction.code, name: taxonomy.jurisdiction.name },
        practiceArea: { slug: taxonomy.root.slug, name: taxonomy.root.name },
        specialization: { slug: taxonomy.specialization.slug, name: taxonomy.specialization.name },
        nextSession: expect.objectContaining({ scheduledAt: scheduledAt.toISOString(), timezone: 'Europe/Moscow' }),
      }),
    ]);
    const recordingBeforeReady = await request(app).get('/api/v1/catalog/webinars').query({
      q: 'договорный',
      availability: 'RECORDING',
    });
    expect(recordingBeforeReady.body.items).toHaveLength(0);
    await prisma.webinar.update({ where: { id: publicWebinar.id }, data: { mediaStatus: 'READY' } });
    const recordingAfterReady = await request(app).get('/api/v1/catalog/webinars').query({
      q: 'договорный',
      availability: 'RECORDING',
      dateFrom: '2032-01-01',
      dateTo: '2032-01-31',
    });
    expect(recordingAfterReady.body.items).toEqual([expect.objectContaining({ slug: publicWebinar.slug })]);
    const allCatalog = await request(app).get('/api/v1/catalog/webinars').query({ sort: 'UPDATED', pageSize: 24 });
    expect(allCatalog.status).toBe(200);
    const listedPaths = allCatalog.body.items.map((item: { canonicalPath: string }) => item.canonicalPath);
    expect(listedPaths).toContain(
      `/crisis_premium/catalog-webinar.html?organization=${tenant.organization.slug}&webinar=${publicWebinar.slug}`,
    );
    expect(listedPaths).toContain(
      `/crisis_premium/catalog-webinar.html?organization=${otherTenant.organization.slug}&webinar=${publicWebinar.slug}`,
    );
    for (const hiddenSlug of [unlisted.slug, privateWebinar.slug, draft.slug, archived.slug]) {
      expect(allCatalog.body.items).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ slug: hiddenSlug })]),
      );
    }

    const publicDetail = await request(app)
      .get(`/api/v1/catalog/webinars/${publicWebinar.slug}`)
      .query({ organization: tenant.organization.slug });
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.webinar).toMatchObject({
      slug: publicWebinar.slug,
      canonicalSlug: publicWebinar.slug,
      wasAlias: false,
      sources: [{ title: 'Официальный источник каталога', url: 'https://example.test/catalog-source' }],
    });
    const aliasDetail = await request(app)
      .get('/api/v1/catalog/webinars/catalog-old-alias')
      .query({ organization: tenant.organization.slug });
    expect(aliasDetail.status).toBe(200);
    expect(aliasDetail.body.webinar).toMatchObject({
      slug: superseded.slug,
      canonicalSlug: superseded.slug,
      requestedSlug: 'catalog-old-alias',
      wasAlias: true,
      freshnessStatus: 'SUPERSEDED',
      supersededBy: {
        title: successor.title,
        canonicalPath: `/crisis_premium/catalog-webinar.html?organization=${tenant.organization.slug}&webinar=${successor.slug}`,
      },
    });
    const unlistedDetail = await request(app)
      .get(`/api/v1/catalog/webinars/${unlisted.slug}`)
      .query({ organization: tenant.organization.slug });
    expect(unlistedDetail.status).toBe(200);
    expect(unlistedDetail.headers['x-robots-tag']).toContain('noindex');
    const sitemap = await request(app).get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toContain('application/xml');
    expect(sitemap.text).toContain(`organization=${tenant.organization.slug}`);
    expect(sitemap.text).toContain(`webinar=${publicWebinar.slug}`);
    for (const hiddenSlug of [unlisted.slug, privateWebinar.slug, draft.slug, archived.slug, 'catalog-old-alias']) {
      expect(sitemap.text).not.toContain(`webinar=${hiddenSlug}`);
    }

    const unknown = await request(app)
      .get('/api/v1/catalog/webinars/missing-webinar')
      .query({ organization: tenant.organization.slug });
    for (const hidden of [privateWebinar, draft, archived]) {
      const response = await request(app)
        .get(`/api/v1/catalog/webinars/${hidden.slug}`)
        .query({ organization: tenant.organization.slug });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'catalog_webinar_not_found', error: unknown.body.error });
    }

    const lead = await prisma.lead.create({
      data: { name: 'Исторический зритель каталога', phone: '+79990000877', email: 'catalog-history@example.test' },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.event.create({
      data: {
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: session.id,
        eventName: 'catalog_history',
      },
    });
    const historyBeforeArchive = await Promise.all([
      prisma.registration.count({ where: { webinarSessionId: session.id } }),
      prisma.event.count({ where: { webinarSessionId: session.id } }),
    ]);
    await prisma.webinar.update({
      where: { id: publicWebinar.id },
      data: { contentStatus: 'ARCHIVED', archivedAt: new Date() },
    });
    const afterArchive = await request(app)
      .get(`/api/v1/catalog/webinars/${publicWebinar.slug}`)
      .query({ organization: tenant.organization.slug });
    expect(afterArchive.status).toBe(404);
    const sitemapAfterArchive = await request(app).get('/sitemap.xml');
    expect(sitemapAfterArchive.text).not.toContain(
      `organization=${tenant.organization.slug}&amp;webinar=${publicWebinar.slug}`,
    );
    await expect(
      Promise.all([
        prisma.registration.count({ where: { webinarSessionId: session.id } }),
        prisma.event.count({ where: { webinarSessionId: session.id } }),
      ]),
    ).resolves.toEqual(historyBeforeArchive);

    await prisma.organizationMembership.update({
      where: {
        organizationId_userId: { organizationId: otherTenant.organization.id, userId: otherTenant.user.id },
      },
      data: { status: 'SUSPENDED' },
    });
    const afterMembershipSuspension = await request(app).get('/api/v1/catalog/webinars').query({ pageSize: 24 });
    expect(afterMembershipSuspension.body.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organization: expect.objectContaining({ slug: otherTenant.organization.slug }) }),
      ]),
    );
  });

  it('registers the shown tenant session and keeps the viewer account private, scoped and idempotent', async () => {
    env.PUBLIC_CATALOG_ENABLED = 'on';
    const tenant = await createTenantFixture({
      slug: 'viewer-account-tenant',
      email: 'viewer-account-author@example.test',
      role: 'AUTHOR',
    });
    const foreignTenant = await createTenantFixture({
      slug: 'viewer-account-foreign',
      email: 'viewer-account-foreign-author@example.test',
      role: 'AUTHOR',
    });
    const [profile, foreignProfile] = await Promise.all([
      prisma.authorProfile.create({
        data: {
          organizationId: tenant.organization.id,
          userId: tenant.user.id,
          slug: 'viewer-account-author',
          publicName: 'Автор кабинета',
          verificationStatus: 'VERIFIED',
        },
      }),
      prisma.authorProfile.create({
        data: {
          organizationId: foreignTenant.organization.id,
          userId: foreignTenant.user.id,
          slug: 'viewer-account-foreign-author',
          publicName: 'Чужой автор',
          verificationStatus: 'VERIFIED',
        },
      }),
    ]);
    const firstWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'viewer-account-current',
        title: 'Доступная запись',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        freshnessStatus: 'CURRENT',
        publishedAt: new Date(),
      },
    });
    const futureWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'viewer-account-future',
        title: 'Будущий вебинар',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        freshnessStatus: 'CURRENT',
        publishedAt: new Date(),
      },
    });
    const privateWebinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'viewer-account-private',
        title: 'Закрытый материал',
        contentStatus: 'PUBLISHED',
        visibility: 'PRIVATE',
        freshnessStatus: 'CURRENT',
        publishedAt: new Date(),
      },
    });
    const foreignWebinar = await prisma.webinar.create({
      data: {
        organizationId: foreignTenant.organization.id,
        authorProfileId: foreignProfile.id,
        slug: 'viewer-account-foreign',
        title: 'Чужой вебинар',
        contentStatus: 'PUBLISHED',
        visibility: 'PUBLIC',
        freshnessStatus: 'CURRENT',
        publishedAt: new Date(),
      },
    });
    const [firstSession, futureSession, foreignSession] = await Promise.all([
      prisma.webinarSession.create({
        data: {
          organizationId: tenant.organization.id,
          webinarId: firstWebinar.id,
          title: firstWebinar.title,
          scheduledAt: new Date(Date.now() - 5 * 60_000),
          durationMinutes: 60,
          replayAvailableHours: 168,
          timezone: 'Europe/Moscow',
        },
      }),
      prisma.webinarSession.create({
        data: {
          organizationId: tenant.organization.id,
          webinarId: futureWebinar.id,
          title: futureWebinar.title,
          scheduledAt: new Date(Date.now() + 24 * 60 * 60_000),
          durationMinutes: 60,
          timezone: 'Asia/Yekaterinburg',
        },
      }),
      prisma.webinarSession.create({
        data: {
          organizationId: foreignTenant.organization.id,
          webinarId: foreignWebinar.id,
          title: foreignWebinar.title,
          scheduledAt: new Date(Date.now() - 5 * 60_000),
          durationMinutes: 60,
        },
      }),
    ]);

    const viewer = request.agent(app);
    const csrfToken = await getCsrfToken(viewer);
    const registrationBody = {
      sessionId: firstSession.id,
      name: 'Зритель Кабинета',
      phone: '+79990007766',
      email: 'viewer-account@example.test',
      personalDataConsent: true,
      termsAccepted: true,
      marketingEmailConsent: false,
      marketingTelegramConsent: false,
      source: 'catalog_detail',
    };
    const registrationPath = `/api/v1/catalog/webinars/${firstWebinar.slug}/register?organization=${tenant.organization.slug}`;
    const registered = await viewer.post(registrationPath).set('x-csrf-token', csrfToken).send(registrationBody);
    expect(registered.status).toBe(202);
    const repeated = await viewer.post(registrationPath).set('x-csrf-token', csrfToken).send(registrationBody);
    expect(repeated.status).toBe(202);
    const storedRegistration = await prisma.registration.findFirstOrThrow({
      where: { webinarSessionId: firstSession.id },
      include: { participantUser: true },
    });
    expect(storedRegistration).toMatchObject({
      organizationId: tenant.organization.id,
      webinarId: firstWebinar.id,
      webinarSessionId: firstSession.id,
      accessPolicy: 'PUBLIC_CATALOG',
      status: 'pending_verification',
      userId: expect.any(String),
    });
    expect(storedRegistration.participantUser?.emailNormalized).toBe(registrationBody.email);
    await expect(prisma.registration.count({ where: { webinarSessionId: firstSession.id } })).resolves.toBe(1);
    await expect(
      prisma.consentRecord.count({ where: { registrationId: storedRegistration.id, kind: 'personal_data' } }),
    ).resolves.toBe(1);

    const injectedScope = await viewer
      .post(registrationPath)
      .set('x-csrf-token', csrfToken)
      .send({ ...registrationBody, organizationId: foreignTenant.organization.id });
    expect(injectedScope.status).toBe(400);

    const foreignSessionAttempt = await viewer
      .post(registrationPath)
      .set('x-csrf-token', csrfToken)
      .send({ ...registrationBody, sessionId: foreignSession.id });
    const unknownSessionAttempt = await viewer
      .post(registrationPath)
      .set('x-csrf-token', csrfToken)
      .send({ ...registrationBody, sessionId: '00000000-0000-4000-8000-000000000000' });
    expect(foreignSessionAttempt.status).toBe(404);
    expect(foreignSessionAttempt.body).toMatchObject({
      code: 'catalog_webinar_not_found',
      error: unknownSessionAttempt.body.error,
    });
    await expect(prisma.registration.count({ where: { webinarSessionId: foreignSession.id } })).resolves.toBe(0);

    const exchangeToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: storedRegistration.id,
        tokenHash: hashToken(exchangeToken),
        purpose: 'registration',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const exchanged = await viewer
      .post('/api/registration/exchange')
      .set('x-csrf-token', csrfToken)
      .send({ token: exchangeToken });
    expect(exchanged.status).toBe(200);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: storedRegistration.userId! } })).resolves.toMatchObject({
      status: 'ACTIVE',
      emailVerifiedAt: expect.any(Date),
    });

    const futureRegistered = await viewer
      .post(`/api/v1/catalog/webinars/${futureWebinar.slug}/register?organization=${tenant.organization.slug}`)
      .set('x-csrf-token', csrfToken)
      .send({ ...registrationBody, sessionId: futureSession.id });
    expect(futureRegistered.status).toBe(201);
    expect(futureRegistered.body.registration).toMatchObject({
      webinarId: futureWebinar.id,
      webinarSessionId: futureSession.id,
      status: 'registered',
    });

    const dashboard = await viewer.get('/api/v1/viewer/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers['cache-control']).toContain('no-store');
    expect(dashboard.body.sections.recordings).toEqual([
      expect.objectContaining({
        webinarId: firstWebinar.id,
        timezone: 'Europe/Moscow',
        accessState: 'available',
        accessExpiresAt: expect.any(String),
      }),
    ]);
    expect(dashboard.body.sections.upcoming).toEqual([
      expect.objectContaining({ webinarId: futureWebinar.id, timezone: 'Asia/Yekaterinburg' }),
    ]);

    const favoritePath = `/api/v1/viewer/favorites/${firstWebinar.id}`;
    expect((await viewer.put(favoritePath).set('x-csrf-token', csrfToken).send({})).status).toBe(200);
    expect((await viewer.put(favoritePath).set('x-csrf-token', csrfToken).send({})).status).toBe(200);
    await expect(
      prisma.viewerWebinarFavorite.count({
        where: {
          userId: storedRegistration.userId!,
          organizationId: tenant.organization.id,
          webinarId: firstWebinar.id,
        },
      }),
    ).resolves.toBe(1);
    const privateFavorite = await viewer
      .put(`/api/v1/viewer/favorites/${privateWebinar.id}`)
      .set('x-csrf-token', csrfToken)
      .send({});
    const foreignFavorite = await viewer
      .put(`/api/v1/viewer/favorites/${foreignWebinar.id}`)
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(privateFavorite.status).toBe(404);
    expect(foreignFavorite.status).toBe(404);
    expect(privateFavorite.body).toMatchObject({ code: 'viewer_object_not_found', error: foreignFavorite.body.error });
    await expect(prisma.registration.count({ where: { webinarId: privateWebinar.id } })).resolves.toBe(0);
    expect((await viewer.delete(favoritePath).set('x-csrf-token', csrfToken)).status).toBe(200);
    expect((await viewer.delete(favoritePath).set('x-csrf-token', csrfToken)).status).toBe(200);
    const foreignFavoriteDelete = await viewer
      .delete(`/api/v1/viewer/favorites/${foreignWebinar.id}`)
      .set('x-csrf-token', csrfToken);
    const unknownFavoriteDelete = await viewer
      .delete('/api/v1/viewer/favorites/00000000-0000-4000-8000-000000000000')
      .set('x-csrf-token', csrfToken);
    expect(foreignFavoriteDelete.status).toBe(404);
    expect(foreignFavoriteDelete.body).toMatchObject({
      code: 'viewer_object_not_found',
      error: unknownFavoriteDelete.body.error,
    });

    const activated = await viewer
      .post(`/api/v1/viewer/registrations/${storedRegistration.id}/activate`)
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(activated.status).toBe(200);
    const foreignLead = await prisma.lead.create({
      data: { name: 'Чужой зритель', phone: '+79990007767', email: 'viewer-account-foreign-viewer@example.test' },
    });
    const foreignRegistration = await prisma.registration.create({
      data: {
        leadId: foreignLead.id,
        webinarSessionId: foreignSession.id,
        organizationId: foreignTenant.organization.id,
        webinarId: foreignWebinar.id,
        userId: foreignTenant.user.id,
        accessPolicy: 'PUBLIC_CATALOG',
        accessTokenHash: hashToken(createAccessToken()),
        status: 'registered',
        emailVerifiedAt: new Date(),
      },
    });
    const foreignActivation = await viewer
      .post(`/api/v1/viewer/registrations/${foreignRegistration.id}/activate`)
      .set('x-csrf-token', csrfToken)
      .send({});
    const unknownActivation = await viewer
      .post('/api/v1/viewer/registrations/00000000-0000-4000-8000-000000000000/activate')
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(foreignActivation.status).toBe(404);
    expect(foreignActivation.body).toMatchObject({
      code: 'viewer_object_not_found',
      error: unknownActivation.body.error,
    });
    const firstProgress = await viewer
      .put(`/api/v1/viewer/progress/${firstSession.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ positionSeconds: 120, durationSeconds: 3600, eventId: 'viewer-progress-event-0001' });
    expect(firstProgress.status).toBe(200);
    const duplicateProgress = await viewer
      .put(`/api/v1/viewer/progress/${firstSession.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ positionSeconds: 120, durationSeconds: 3600, eventId: 'viewer-progress-event-0001' });
    expect(duplicateProgress.body).toMatchObject({ writeAccepted: true, duplicate: true });
    const throttledProgress = await viewer
      .put(`/api/v1/viewer/progress/${firstSession.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ positionSeconds: 121, durationSeconds: 3600, eventId: 'viewer-progress-event-0002' });
    expect(throttledProgress.status).toBe(202);
    expect(throttledProgress.body).toMatchObject({ writeAccepted: false, duplicate: false });
    await expect(prisma.viewerWebinarProgress.count({ where: { webinarSessionId: firstSession.id } })).resolves.toBe(1);
    const foreignProgress = await viewer
      .put(`/api/v1/viewer/progress/${foreignSession.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ positionSeconds: 10, durationSeconds: 3600, eventId: 'viewer-progress-foreign-0001' });
    expect(foreignProgress.status).toBe(404);
    expect(foreignProgress.body.code).toBe('viewer_object_not_found');
    const foreignProgressRead = await viewer.get(`/api/v1/viewer/progress/${foreignSession.id}`);
    const unknownProgressRead = await viewer.get('/api/v1/viewer/progress/00000000-0000-4000-8000-000000000000');
    expect(foreignProgressRead.status).toBe(404);
    expect(foreignProgressRead.body).toMatchObject({
      code: 'viewer_object_not_found',
      error: unknownProgressRead.body.error,
    });

    const note = await viewer
      .post('/api/v1/viewer/notes')
      .set('x-csrf-token', csrfToken)
      .send({ sessionId: firstSession.id, timestampSeconds: 125, body: 'Личная заметка <script>' });
    expect(note.status).toBe(201);
    const notes = await viewer.get('/api/v1/viewer/notes').query({ sessionId: firstSession.id });
    expect(notes.body.notes).toEqual([
      expect.objectContaining({ timestampSeconds: 125, body: 'Личная заметка <script>' }),
    ]);
    const foreignNotes = await viewer.get('/api/v1/viewer/notes').query({ sessionId: foreignSession.id });
    expect(foreignNotes.status).toBe(404);
    expect(foreignNotes.body).toMatchObject({ code: 'viewer_object_not_found', error: foreignProgress.body.error });
    const foreignNote = await prisma.viewerWebinarNote.create({
      data: {
        organizationId: foreignTenant.organization.id,
        webinarId: foreignWebinar.id,
        webinarSessionId: foreignSession.id,
        userId: foreignTenant.user.id,
        timestampMs: 5_000,
        body: 'Чужая приватная заметка',
      },
    });
    const foreignNoteDelete = await viewer
      .delete(`/api/v1/viewer/notes/${foreignNote.id}`)
      .set('x-csrf-token', csrfToken);
    const unknownNoteDelete = await viewer
      .delete('/api/v1/viewer/notes/00000000-0000-4000-8000-000000000000')
      .set('x-csrf-token', csrfToken);
    expect(foreignNoteDelete.status).toBe(404);
    expect(foreignNoteDelete.body).toMatchObject({
      code: 'viewer_object_not_found',
      error: unknownNoteDelete.body.error,
    });
    await expect(prisma.viewerWebinarNote.findUnique({ where: { id: foreignNote.id } })).resolves.toBeTruthy();

    const serviceOnlyUpdate = await viewer
      .patch('/api/v1/viewer/notifications')
      .set('x-csrf-token', csrfToken)
      .send({ serviceTelegramEnabled: false });
    expect(serviceOnlyUpdate.body.preferences).toMatchObject({
      marketingEmailEnabled: false,
      marketingTelegramEnabled: false,
      serviceEmailEnabled: true,
      serviceTelegramEnabled: false,
    });
    await expect(prisma.lead.findUniqueOrThrow({ where: { id: storedRegistration.leadId } })).resolves.toMatchObject({
      marketingEmailRevokedAt: null,
      marketingTelegramRevokedAt: null,
    });
    await expect(
      prisma.consentRecord.count({
        where: { leadId: storedRegistration.leadId, kind: { in: ['marketing_email', 'marketing_telegram'] } },
      }),
    ).resolves.toBe(0);

    const marketingEnabled = await viewer
      .patch('/api/v1/viewer/notifications')
      .set('x-csrf-token', csrfToken)
      .send({ marketingEmailEnabled: true });
    expect(marketingEnabled.body.preferences).toMatchObject({
      marketingEmailEnabled: true,
      serviceEmailEnabled: true,
      serviceTelegramEnabled: false,
    });
    const marketingDisabled = await viewer
      .patch('/api/v1/viewer/notifications')
      .set('x-csrf-token', csrfToken)
      .send({ marketingEmailEnabled: false });
    expect(marketingDisabled.body.preferences).toMatchObject({
      marketingEmailEnabled: false,
      serviceEmailEnabled: true,
      serviceTelegramEnabled: false,
    });
    await expect(prisma.lead.findUniqueOrThrow({ where: { id: storedRegistration.leadId } })).resolves.toMatchObject({
      consent: true,
      marketingEmailConsent: false,
      personalDataConsentRevokedAt: null,
    });
    await expect(
      prisma.consentRecord.count({
        where: { leadId: storedRegistration.leadId, kind: 'marketing_email', action: { in: ['grant', 'revoke'] } },
      }),
    ).resolves.toBe(2);

    const deletedNote = await viewer.delete(`/api/v1/viewer/notes/${note.body.note.id}`).set('x-csrf-token', csrfToken);
    expect(deletedNote.status).toBe(200);
    await expect(prisma.viewerWebinarNote.count({ where: { id: note.body.note.id } })).resolves.toBe(0);
  });

  it('creates bounded timezone-aware recurrence and hides every foreign session operation', async () => {
    const tenantA = await createTenantFixture({
      slug: 'session-scope-a',
      email: 'session-scope-a@example.test',
      role: 'AUTHOR',
    });
    const tenantB = await createTenantFixture({
      slug: 'session-scope-b',
      email: 'session-scope-b@example.test',
      role: 'AUTHOR',
    });
    const [profileA, profileB] = await Promise.all([
      prisma.authorProfile.create({
        data: {
          organizationId: tenantA.organization.id,
          userId: tenantA.user.id,
          slug: 'session-scope-a',
          publicName: 'Автор сессий А',
          verificationStatus: 'VERIFIED',
        },
      }),
      prisma.authorProfile.create({
        data: {
          organizationId: tenantB.organization.id,
          userId: tenantB.user.id,
          slug: 'session-scope-b',
          publicName: 'Автор сессий Б',
          verificationStatus: 'VERIFIED',
        },
      }),
    ]);
    const [webinarA, webinarB] = await Promise.all([
      prisma.webinar.create({
        data: {
          organizationId: tenantA.organization.id,
          authorProfileId: profileA.id,
          slug: 'session-scope-webinar-a',
          title: 'Расписание организации А',
        },
      }),
      prisma.webinar.create({
        data: {
          organizationId: tenantB.organization.id,
          authorProfileId: profileB.id,
          slug: 'session-scope-webinar-b',
          title: 'Расписание организации Б',
        },
      }),
    ]);
    const scheduleB = await prisma.webinarSchedule.create({
      data: {
        organizationId: tenantB.organization.id,
        webinarId: webinarB.id,
        createdById: tenantB.user.id,
        recurrenceType: 'ONCE',
        timezone: 'Europe/Amsterdam',
        localStartTime: '09:00',
        startsOn: new Date('2026-03-28T00:00:00.000Z'),
        maxFutureInstances: 1,
      },
    });
    const foreignSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantB.organization.id,
        webinarId: webinarB.id,
        scheduleId: scheduleB.id,
        title: webinarB.title,
        scheduledAt: new Date('2026-03-28T08:00:00.000Z'),
        timezone: 'Europe/Amsterdam',
        durationMinutes: 60,
      },
    });
    const platformSession = await loginPlatformUser(tenantA.user.id);
    setTestNow(new Date('2026-03-27T00:00:00.000Z'));
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const scheduleInput = {
      recurrenceType: 'DAILY',
      timezone: 'Europe/Amsterdam',
      localStartTime: '09:00',
      startsOn: '2026-03-28',
      endsOn: '2026-04-30',
      maxFutureInstances: 3,
      durationMinutes: 60,
      roomOpenBeforeMinutes: 20,
      replayAvailableHours: 48,
      replayEnabled: true,
    };

    const missingList = await platformSession.agent.get('/api/v1/creator/webinars/missing-webinar/sessions');
    const foreignList = await platformSession.agent.get(`/api/v1/creator/webinars/${webinarB.id}/sessions`);
    expect(missingList.status).toBe(404);
    expect(foreignList.status).toBe(404);
    expect(foreignList.body).toMatchObject({ code: 'webinar_not_found', error: missingList.body.error });

    const countsBeforeForeignWrites = await Promise.all([
      prisma.webinarSchedule.count(),
      prisma.webinarSession.count(),
      prisma.auditLog.count(),
    ]);
    const foreignCreate = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarB.id}/sessions`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send(scheduleInput);
    const foreignUpdate = await platformSession.agent
      .patch(`/api/v1/creator/sessions/${foreignSession.id}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ scheduledAt: '2026-03-29T07:30:00.000Z' });
    const foreignCancel = await platformSession.agent
      .delete(`/api/v1/creator/sessions/${foreignSession.id}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ reason: 'Тестовая попытка отмены чужой сессии.' });
    for (const response of [foreignCreate, foreignUpdate, foreignCancel]) {
      expect(response.status).toBe(404);
    }
    await expect(
      Promise.all([prisma.webinarSchedule.count(), prisma.webinarSession.count(), prisma.auditLog.count()]),
    ).resolves.toEqual(countsBeforeForeignWrites);

    const forgedTenant = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarA.id}/sessions`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ ...scheduleInput, organizationId: tenantB.organization.id });
    expect(forgedTenant.status).toBe(400);
    expect(forgedTenant.body.code).toBe('validation_failed');

    const created = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinarA.id}/sessions`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send(scheduleInput);
    expect(created.status).toBe(201);
    expect(created.body.schedule).toMatchObject({
      recurrenceType: 'DAILY',
      timezone: 'Europe/Amsterdam',
      maxFutureInstances: 3,
    });
    expect(created.body.sessions.map((session: { scheduledAt: string }) => session.scheduledAt)).toEqual([
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
    expect(
      created.body.sessions.every((session: { lifecycleStatus: string }) => session.lifecycleStatus === 'SCHEDULED'),
    ).toBe(true);
    await expect(
      prisma.auditLog.count({
        where: { organizationId: tenantA.organization.id, action: 'webinar_schedule.created' },
      }),
    ).resolves.toBe(1);
  });

  it('requires confirmed registered changes, versions reminders, audits and notifies without reopening cancellation', async () => {
    setTestNow(new Date('2030-01-01T00:00:00.000Z'));
    const tenant = await createTenantFixture({
      slug: 'session-change-notices',
      email: 'session-change-notices@example.test',
      role: 'AUTHOR',
    });
    const profile = await prisma.authorProfile.create({
      data: {
        organizationId: tenant.organization.id,
        userId: tenant.user.id,
        slug: 'session-change-notices',
        publicName: 'Автор изменений',
        verificationStatus: 'VERIFIED',
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        slug: 'session-change-notices',
        title: 'Вебинар с уведомлениями',
        visibility: 'PUBLIC',
      },
    });
    const platformSession = await loginPlatformUser(tenant.user.id);
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const created = await platformSession.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/sessions`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        recurrenceType: 'ONCE',
        timezone: 'Europe/Amsterdam',
        localStartTime: '09:00',
        startsOn: '2031-01-15',
        maxFutureInstances: 1,
        durationMinutes: 60,
      });
    expect(created.status).toBe(201);
    const sessionId = created.body.sessions[0].id as string;

    const registrations: Array<{
      lead: { id: string; email: string; name: string };
      registration: { id: string };
    }> = [];
    for (const index of [1, 2]) {
      const lead = await prisma.lead.create({
        data: {
          name: `Участник ${index}`,
          phone: `+7999000010${index}`,
          email: `session-change-${index}@example.test`,
          consent: true,
          ...(index === 1
            ? {
                telegramChatId: 'session-change-chat-1',
                telegramBindingVersion: TELEGRAM_BINDING_VERSION,
                telegramSubscribedAt: new Date(),
                marketingTelegramConsent: true,
              }
            : {}),
        },
      });
      const registration = await prisma.registration.create({
        data: {
          leadId: lead.id,
          webinarSessionId: sessionId,
          accessTokenHash: hashToken(createAccessToken()),
          status: 'registered',
          emailVerifiedAt: new Date(),
        },
      });
      registrations.push({ lead, registration });
      await prisma.$transaction(tx =>
        enqueueReminderEmail(tx, {
          kind: '24h',
          registrationId: registration.id,
          webinarSessionId: sessionId,
          toEmail: lead.email,
          toName: lead.name,
          scheduledAt: new Date('2031-01-15T08:00:00.000Z'),
          scheduleVersion: 1,
        }),
      );
    }

    const rejectedSnapshot = await Promise.all([
      prisma.webinarSession.findUniqueOrThrow({ where: { id: sessionId } }),
      prisma.emailOutboxJob.count(),
      prisma.auditLog.count({ where: { entityId: sessionId } }),
    ]);
    const unconfirmed = await platformSession.agent
      .patch(`/api/v1/creator/sessions/${sessionId}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ scheduledAt: '2031-01-16T08:00:00.000Z' });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({ code: 'session_registered_change_confirmation_required' });
    await expect(prisma.webinarSession.findUniqueOrThrow({ where: { id: sessionId } })).resolves.toMatchObject({
      scheduledAt: rejectedSnapshot[0].scheduledAt,
      scheduleVersion: 1,
    });
    await expect(prisma.emailOutboxJob.count()).resolves.toBe(rejectedSnapshot[1]);
    await expect(prisma.auditLog.count({ where: { entityId: sessionId } })).resolves.toBe(rejectedSnapshot[2]);

    const rescheduled = await platformSession.agent
      .patch(`/api/v1/creator/sessions/${sessionId}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        scheduledAt: '2031-01-16T08:00:00.000Z',
        timezone: 'Europe/Amsterdam',
        confirmRegisteredChange: true,
        reason: 'Спикер попросил перенести эфир на следующий день.',
      });
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body).toMatchObject({
      registrationCount: 2,
      notificationsQueued: 2,
      session: { scheduleVersion: 2, lifecycleStatus: 'SCHEDULED', timezone: 'Europe/Amsterdam' },
    });
    await expect(
      prisma.emailOutboxJob.count({ where: { type: EMAIL_JOB_REMINDER, status: 'cancelled' } }),
    ).resolves.toBe(2);
    await expect(
      prisma.emailOutboxJob.count({
        where: { type: EMAIL_JOB_SESSION_RESCHEDULED, sessionScheduleVersion: 2, status: 'pending' },
      }),
    ).resolves.toBe(2);

    const rescheduleDelivery = await deliverPendingEmails();
    expect(rescheduleDelivery.result).toMatchObject({ sent: 2, failed: 0 });
    expect(rescheduleDelivery.deliveries).toHaveLength(2);
    expect(rescheduleDelivery.deliveries.every(item => item.kind === 'session_change')).toBe(true);
    expect(
      rescheduleDelivery.deliveries.every(
        item => item.input.kind === 'rescheduled' && item.input.timezone === 'Europe/Amsterdam',
      ),
    ).toBe(true);

    const roomSessionToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registrations[0].registration.id,
        tokenHash: hashToken(roomSessionToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date('2031-01-20T00:00:00.000Z'),
      },
    });
    await prisma.$transaction(tx =>
      enqueueReminderEmail(tx, {
        kind: '3h',
        registrationId: registrations[0].registration.id,
        webinarSessionId: sessionId,
        toEmail: registrations[0].lead.email,
        toName: registrations[0].lead.name,
        scheduledAt: new Date('2031-01-16T08:00:00.000Z'),
        scheduleVersion: 2,
      }),
    );
    const cancelRejectedCounts = await Promise.all([
      prisma.emailOutboxJob.count(),
      prisma.auditLog.count({ where: { entityId: sessionId, action: 'webinar_session.cancelled' } }),
    ]);
    const unconfirmedCancel = await platformSession.agent
      .delete(`/api/v1/creator/sessions/${sessionId}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({ reason: 'Отмена по запросу спикера без подтверждения.' });
    expect(unconfirmedCancel.status).toBe(409);
    await expect(prisma.emailOutboxJob.count()).resolves.toBe(cancelRejectedCounts[0]);
    await expect(
      prisma.auditLog.count({ where: { entityId: sessionId, action: 'webinar_session.cancelled' } }),
    ).resolves.toBe(cancelRejectedCounts[1]);

    const cancelled = await platformSession.agent
      .delete(`/api/v1/creator/sessions/${sessionId}`)
      .set('x-csrf-token', platformSession.csrfToken)
      .send({
        confirmRegisteredChange: true,
        reason: 'Спикер не сможет провести эфир; сессия отменена окончательно.',
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      registrationCount: 2,
      notificationsQueued: 2,
      session: { lifecycleStatus: 'CANCELLED', scheduleVersion: 3 },
    });
    await expect(
      prisma.emailOutboxJob.findFirstOrThrow({
        where: { type: EMAIL_JOB_REMINDER, reminderKind: '3h', sessionScheduleVersion: 2 },
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      prisma.auditLog.findFirstOrThrow({ where: { entityId: sessionId, action: 'webinar_session.cancelled' } }),
    ).resolves.toMatchObject({ organizationId: tenant.organization.id, userId: tenant.user.id });

    const tokenCountBeforeCancellationDelivery = await prisma.registrationToken.count();
    const cancellationDelivery = await deliverPendingEmails();
    expect(cancellationDelivery.result).toMatchObject({ sent: 2, failed: 0 });
    expect(
      cancellationDelivery.deliveries.every(
        item => item.kind === 'session_change' && item.input.kind === 'cancelled' && item.input.webinarUrl === '',
      ),
    ).toBe(true);
    await expect(prisma.registrationToken.count()).resolves.toBe(tokenCountBeforeCancellationDelivery);
    await expect(
      prisma.emailOutboxJob.count({
        where: { type: EMAIL_JOB_SESSION_CANCELLED, sessionScheduleVersion: 3, status: 'sent' },
      }),
    ).resolves.toBe(2);
    const cancelledOutboxCount = await prisma.emailOutboxJob.count();
    await expect(runReminderJobOnce(new Date('2031-01-15T08:00:00.000Z'))).resolves.toMatchObject({
      checked: 0,
      sent: 0,
    });
    await expect(runTelegramLiveJobOnce(new Date('2031-01-16T08:05:00.000Z'))).resolves.toEqual({ sent: 0 });
    await expect(prisma.emailOutboxJob.count()).resolves.toBe(cancelledOutboxCount);

    const cancelledRoomAccess = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', `aspb_room_token=${roomSessionToken}`);
    expect(cancelledRoomAccess.status).toBe(401);
  });

  it('duplicates only allowed Webinar draft data and replays the command without copying history', async () => {
    const taxonomy = await ensureLegalTaxonomyFixture();
    const tenant = await createTenantFixture({
      slug: 'duplicate-webinar',
      email: 'duplicate-webinar@example.test',
      role: 'AUTHOR',
    });
    const foreignTenant = await createTenantFixture({
      slug: 'duplicate-webinar-foreign',
      email: 'duplicate-webinar-foreign@example.test',
      role: 'AUTHOR',
    });
    const [profile, foreignProfile] = await Promise.all([
      prisma.authorProfile.create({
        data: {
          organizationId: tenant.organization.id,
          userId: tenant.user.id,
          slug: 'duplicate-webinar-author',
          publicName: 'Автор дубликата',
          verificationStatus: 'VERIFIED',
        },
      }),
      prisma.authorProfile.create({
        data: {
          organizationId: foreignTenant.organization.id,
          userId: foreignTenant.user.id,
          slug: 'duplicate-webinar-foreign-author',
          publicName: 'Чужой автор',
          verificationStatus: 'VERIFIED',
        },
      }),
    ]);
    const source = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        authorProfileId: profile.id,
        jurisdictionId: taxonomy.jurisdiction.id,
        slug: 'duplicate-source',
        title: 'Исходный юридический вебинар',
        description: 'Описание, которое должно перейти в новый черновик без истории.',
        outcomeDescription: 'Практический результат исходного материала.',
        contentStatus: 'PUBLISHED',
        visibility: 'UNLISTED',
        freshnessStatus: 'CURRENT',
        audienceLevel: 'PRACTITIONER',
        targetAudience: 'Юристы и руководители',
        format: 'PREMIERE',
        durationMinutes: 70,
        currentAsOf: new Date('2026-08-20T00:00:00.000Z'),
        disclaimer: 'Материал носит информационный характер и не заменяет консультацию.',
        syntheticDisclosure: 'Подготовленные сообщения всегда помечены и не являются сообщениями реальных зрителей.',
        mediaStatus: 'READY',
        transcriptStatus: 'PUBLISHED',
        scenarioStatus: 'PUBLISHED',
        practiceAreas: {
          create: [
            { practiceAreaId: taxonomy.root.id, isPrimary: true },
            {
              practiceAreaId: taxonomy.specialization.id,
              isPrimary: false,
            },
          ],
        },
        sources: {
          create: {
            type: 'OFFICIAL_SOURCE',
            title: 'Исходный официальный источник',
            url: 'https://example.test/duplicate-source',
          },
        },
      },
    });
    const sourceScenario = await prisma.chatScenario.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: source.id,
        version: 1,
        status: 'PUBLISHED',
        createdById: tenant.user.id,
        approvedById: tenant.user.id,
        approvedAt: new Date('2026-08-20T10:00:00.000Z'),
        messages: {
          create: [
            {
              orderIndex: 0,
              offsetSeconds: 90,
              kind: 'PREPARED_QUESTION',
              text: 'Какие документы нужно подготовить до начала процедуры?',
              authorLabel: 'Подготовленный вопрос',
              isSynthetic: true,
            },
            {
              orderIndex: 1,
              offsetSeconds: 180,
              kind: 'MODERATOR_NOTICE',
              text: 'Это подготовленное сообщение, а не реплика реального участника.',
              authorLabel: 'Модератор',
              isSynthetic: true,
            },
          ],
        },
      },
    });
    const sourceSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: source.id,
        title: source.title,
        scheduledAt: new Date('2032-01-01T10:00:00.000Z'),
      },
    });
    const lead = await prisma.lead.create({
      data: { name: 'Исторический зритель', phone: '+79990000901', email: 'duplicate-history@example.test' },
    });
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: sourceSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.event.create({
      data: {
        leadId: lead.id,
        registrationId: registration.id,
        webinarSessionId: sourceSession.id,
        eventName: 'source_history_only',
      },
    });
    const foreignWebinar = await prisma.webinar.create({
      data: {
        organizationId: foreignTenant.organization.id,
        authorProfileId: foreignProfile.id,
        slug: 'foreign-duplicate-source',
        title: 'Чужой исходник',
      },
    });
    const creator = await loginPlatformUser(tenant.user.id);
    env.CREATOR_DASHBOARD_ENABLED = 'on';

    const foreignAttempt = await creator.agent
      .post(`/api/v1/creator/webinars/${foreignWebinar.id}/duplicate`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'duplicate-foreign-001')
      .send({ slug: 'must-not-exist' });
    expect(foreignAttempt.status).toBe(404);
    const forgedTenant = await creator.agent
      .post(`/api/v1/creator/webinars/${source.id}/duplicate`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'duplicate-forged-001')
      .send({ slug: 'forged-duplicate', organizationId: foreignTenant.organization.id });
    expect(forgedTenant.status).toBe(400);

    const duplicated = await creator.agent
      .post(`/api/v1/creator/webinars/${source.id}/duplicate`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'duplicate-source-001')
      .send({ slug: 'duplicate-target', title: 'Новый черновик вебинара' });
    expect(duplicated.status).toBe(201);
    expect(duplicated.body).toMatchObject({
      replayed: false,
      webinar: {
        slug: 'duplicate-target',
        title: 'Новый черновик вебинара',
        contentStatus: 'DRAFT',
        visibility: 'UNLISTED',
        mediaStatus: 'NOT_UPLOADED',
        transcriptStatus: 'NOT_AVAILABLE',
        scenarioStatus: 'DRAFT',
      },
    });
    const duplicateId = duplicated.body.webinar.id as string;
    expect(duplicated.body.webinar.practiceAreas).toHaveLength(2);
    expect(duplicated.body.webinar.sources).toHaveLength(1);
    expect(duplicated.body.webinar.sessions).toHaveLength(0);
    const duplicatedScenario = await prisma.chatScenario.findFirstOrThrow({
      where: { organizationId: tenant.organization.id, webinarId: duplicateId },
      include: { messages: { orderBy: { orderIndex: 'asc' } } },
    });
    expect(duplicatedScenario).toMatchObject({
      version: 1,
      status: 'DRAFT',
      approvedById: null,
      approvedAt: null,
      createdById: tenant.user.id,
    });
    expect(duplicatedScenario.id).not.toBe(sourceScenario.id);
    expect(duplicatedScenario.messages).toEqual([
      expect.objectContaining({
        orderIndex: 0,
        offsetSeconds: 90,
        kind: 'PREPARED_QUESTION',
        text: 'Какие документы нужно подготовить до начала процедуры?',
        authorLabel: 'Подготовленный вопрос',
        isSynthetic: true,
      }),
      expect.objectContaining({
        orderIndex: 1,
        offsetSeconds: 180,
        kind: 'MODERATOR_NOTICE',
        text: 'Это подготовленное сообщение, а не реплика реального участника.',
        authorLabel: 'Подготовленный вопрос',
        isSynthetic: true,
      }),
    ]);
    await expect(prisma.registration.count({ where: { webinarSession: { webinarId: duplicateId } } })).resolves.toBe(0);
    await expect(prisma.event.count({ where: { webinarSession: { webinarId: duplicateId } } })).resolves.toBe(0);

    const foreignCreator = await loginPlatformUser(foreignTenant.user.id);
    const foreignScenarioRead = await foreignCreator.agent.get(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`);
    expect(foreignScenarioRead.status).toBe(404);
    const foreignScenarioWrite = await foreignCreator.agent
      .patch(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`)
      .set('x-csrf-token', foreignCreator.csrfToken)
      .send({ messages: [] });
    expect(foreignScenarioWrite.status).toBe(404);

    const forgedScenarioScope = await creator.agent
      .patch(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`)
      .set('x-csrf-token', creator.csrfToken)
      .send({ organizationId: foreignTenant.organization.id, messages: [] });
    expect(forgedScenarioScope.status).toBe(400);

    const falseSynthetic = await creator.agent
      .patch(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`)
      .set('x-csrf-token', creator.csrfToken)
      .send({
        messages: [
          {
            offsetSeconds: 120,
            kind: 'PREPARED_QUESTION',
            text: 'Не должно сохраниться',
            authorLabel: 'Участник',
            isSynthetic: false,
          },
        ],
      });
    expect(falseSynthetic.status).toBe(400);

    const fabricatedAudience = await creator.agent
      .patch(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`)
      .set('x-csrf-token', creator.csrfToken)
      .send({
        messages: [
          {
            offsetSeconds: 120,
            kind: 'PREPARED_QUESTION',
            status: 'APPROVED',
            text: 'Сейчас онлайн 247 участников',
          },
        ],
      });
    expect(fabricatedAudience.status).toBe(400);

    const savedScenario = await creator.agent
      .patch(`/api/v1/creator/webinars/${duplicateId}/chat-scenario`)
      .set('x-csrf-token', creator.csrfToken)
      .send({
        messages: [
          {
            offsetSeconds: 120,
            kind: 'AUTHOR_PROMPT',
            text: 'Подготовленный переход к следующей теме.',
            authorLabel: 'Автор',
          },
        ],
      });
    expect(savedScenario.status).toBe(200);
    expect(savedScenario.body.scenario).toMatchObject({
      id: duplicatedScenario.id,
      version: 1,
      status: 'DRAFT',
      messages: [
        {
          id: expect.any(String),
          orderIndex: 0,
          offsetSeconds: 120,
          kind: 'AUTHOR_PROMPT',
          text: 'Подготовленный переход к следующей теме.',
          authorLabel: 'Подготовленный вопрос',
          isSynthetic: true,
        },
      ],
    });
    const publishedScenario = await creator.agent
      .post(`/api/v1/creator/webinars/${duplicateId}/chat-scenario/publish`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'publish-duplicate-scenario-001')
      .send({});
    expect(publishedScenario.status).toBe(200);
    expect(publishedScenario.body).toMatchObject({ replayed: false, scenario: { status: 'PUBLISHED' } });
    const replayedScenarioPublish = await creator.agent
      .post(`/api/v1/creator/webinars/${duplicateId}/chat-scenario/publish`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'publish-duplicate-scenario-001')
      .send({});
    expect(replayedScenarioPublish.status).toBe(200);
    expect(replayedScenarioPublish.body).toMatchObject({
      replayed: true,
      scenario: { id: publishedScenario.body.scenario.id, status: 'PUBLISHED' },
    });

    const replay = await creator.agent
      .post(`/api/v1/creator/webinars/${source.id}/duplicate`)
      .set('x-csrf-token', creator.csrfToken)
      .set('idempotency-key', 'duplicate-source-001')
      .send({ slug: 'ignored-on-replay' });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, webinar: { id: duplicateId } });
    await expect(prisma.webinar.count({ where: { organizationId: tenant.organization.id } })).resolves.toBe(2);
    await expect(
      prisma.auditLog.count({ where: { entityId: duplicateId, action: 'webinar.duplicated' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.auditLog.count({
        where: {
          entityId: duplicatedScenario.id,
          action: { in: ['chat_scenario.saved', 'chat_scenario.published'] },
        },
      }),
    ).resolves.toBe(2);
  });

  it('keeps private Webinar grants hash-bound, tenant-isolated, single-use and immediately revocable', async () => {
    const ownerTenant = await createTenantFixture({
      slug: 'private-access-owner',
      email: 'private-access-owner@example.test',
      role: 'OWNER',
    });
    const foreignTenant = await createTenantFixture({
      slug: 'private-access-foreign',
      email: 'private-access-foreign@example.test',
      role: 'OWNER',
    });
    const privateWebinar = await prisma.webinar.create({
      data: {
        organizationId: ownerTenant.organization.id,
        slug: 'private-invited-webinar',
        title: 'Закрытый вебинар',
        visibility: 'PRIVATE',
      },
    });
    const foreignPrivateWebinar = await prisma.webinar.create({
      data: {
        organizationId: foreignTenant.organization.id,
        slug: 'foreign-private-invited-webinar',
        title: 'Чужой закрытый вебинар',
        visibility: 'PRIVATE',
      },
    });
    const owner = await loginPlatformUser(ownerTenant.user.id);
    const foreignOwner = await loginPlatformUser(foreignTenant.user.id);
    const tenantAuthorUser = await prisma.user.create({
      data: {
        emailNormalized: 'private-access-author@example.test',
        displayName: 'Автор без owner-прав',
        emailVerifiedAt: new Date(),
        memberships: {
          create: { organizationId: ownerTenant.organization.id, role: 'AUTHOR', status: 'ACTIVE' },
        },
      },
    });
    const tenantAuthor = await loginPlatformUser(tenantAuthorUser.id);
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const invitedEmail = 'invited-private-viewer@example.test';

    const missingList = await foreignOwner.agent.get('/api/v1/creator/webinars/missing-private/access-grants');
    const foreignList = await foreignOwner.agent.get(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants`);
    expect(missingList.status).toBe(404);
    expect(foreignList.status).toBe(404);
    expect(foreignList.body.error).toBe(missingList.body.error);
    const foreignCreate = await foreignOwner.agent
      .post(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants`)
      .set('x-csrf-token', foreignOwner.csrfToken)
      .send({ email: invitedEmail, purpose: 'VIEW', expiresInDays: 7 });
    expect(foreignCreate.status).toBe(404);
    const authorList = await tenantAuthor.agent.get(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants`);
    expect(authorList.status).toBe(403);

    const created = await owner.agent
      .post(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ email: invitedEmail, purpose: 'VIEW', expiresInDays: 7 });
    expect(created.status).toBe(201);
    expect(created.body.grant).toMatchObject({
      purpose: 'VIEW',
      status: 'PENDING',
      recipientType: 'EMAIL',
      delivery: { status: 'PENDING', attempts: 0 },
    });
    expect(JSON.stringify(created.body)).not.toContain(invitedEmail);
    expect(JSON.stringify(created.body)).not.toContain('emailHash');
    const grantId = created.body.grant.id as string;
    const storedGrant = await prisma.webinarAccessGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(storedGrant.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedGrant.emailHash).not.toContain(invitedEmail);

    let invitationUrl = '';
    const delivery = await runWebinarAccessInvitationEmailOutboxJobOnce(new Date(), {
      sendWebinarAccessInvitationEmail: async input => {
        invitationUrl = input.invitationUrl;
        expect(input).toMatchObject({
          to: invitedEmail,
          webinarTitle: privateWebinar.title,
          organizationName: ownerTenant.organization.name,
        });
        return { sent: true, mode: 'send' as const };
      },
    });
    expect(delivery).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    const invitationToken = new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('webinarInvite');
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!invitationToken) throw new Error('Expected private Webinar invitation token');
    const storedToken = await prisma.webinarAccessGrantToken.findFirstOrThrow({ where: { grantId } });
    expect(storedToken.tokenHash).toBe(hashToken(invitationToken));
    expect(JSON.stringify(storedToken)).not.toContain(invitationToken);

    const wrongUser = await prisma.user.create({
      data: {
        emailNormalized: 'wrong-private-viewer@example.test',
        displayName: 'Неверный зритель',
        emailVerifiedAt: new Date(),
        memberships: {
          create: { organizationId: foreignTenant.organization.id, role: 'AUDITOR', status: 'ACTIVE' },
        },
      },
    });
    const wrongSession = await loginPlatformUser(wrongUser.id);
    const wrongAccept = await wrongSession.agent
      .post('/api/v1/webinar-invitations/accept')
      .set('x-csrf-token', wrongSession.csrfToken)
      .send({ token: invitationToken });
    expect(wrongAccept.status).toBe(404);
    await expect(
      prisma.webinarAccessGrantToken.findUniqueOrThrow({ where: { id: storedToken.id } }),
    ).resolves.toMatchObject({
      consumedAt: null,
      invalidatedAt: null,
    });

    const invitedUser = await prisma.user.create({
      data: {
        emailNormalized: invitedEmail,
        displayName: 'Приглашённый зритель',
        emailVerifiedAt: new Date(),
        memberships: {
          create: { organizationId: foreignTenant.organization.id, role: 'AUDITOR', status: 'ACTIVE' },
        },
      },
    });
    const invitedSession = await loginPlatformUser(invitedUser.id);
    const accepted = await invitedSession.agent
      .post('/api/v1/webinar-invitations/accept')
      .set('x-csrf-token', invitedSession.csrfToken)
      .send({ token: invitationToken });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ webinar: { id: privateWebinar.id, visibility: 'PRIVATE' } });
    const replay = await invitedSession.agent
      .post('/api/v1/webinar-invitations/accept')
      .set('x-csrf-token', invitedSession.csrfToken)
      .send({ token: invitationToken });
    expect(replay.status).toBe(404);

    const privateSession = await prisma.webinarSession.create({
      data: {
        organizationId: ownerTenant.organization.id,
        webinarId: privateWebinar.id,
        title: privateWebinar.title,
        scheduledAt: new Date('2032-02-01T10:00:00.000Z'),
      },
    });
    const invitedLead = await prisma.lead.create({
      data: { name: 'Приглашённый Lead', phone: '+79990000911', email: invitedEmail },
    });
    const invitedRegistration = await prisma.registration.create({
      data: {
        leadId: invitedLead.id,
        webinarSessionId: privateSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    const invitedRoomToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: invitedRegistration.id,
        tokenHash: hashToken(invitedRoomToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date('2032-02-02T10:00:00.000Z'),
      },
    });
    const allowedRoom = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', `aspb_room_token=${invitedRoomToken}`);
    expect(allowedRoom.status).toBe(200);

    const outsiderLead = await prisma.lead.create({
      data: { name: 'Зритель без grant', phone: '+79990000912', email: 'private-outsider@example.test' },
    });
    const outsiderRegistration = await prisma.registration.create({
      data: {
        leadId: outsiderLead.id,
        webinarSessionId: privateSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    const outsiderRoomToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: outsiderRegistration.id,
        tokenHash: hashToken(outsiderRoomToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date('2032-02-02T10:00:00.000Z'),
      },
    });
    const deniedRoom = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', `aspb_room_token=${outsiderRoomToken}`);
    expect(deniedRoom.status).toBe(401);

    const foreignRevokeCounts = await Promise.all([
      prisma.webinarAccessGrant.count(),
      prisma.auditLog.count({ where: { entityId: grantId } }),
    ]);
    const foreignRevoke = await foreignOwner.agent
      .delete(`/api/v1/creator/webinars/${foreignPrivateWebinar.id}/access-grants/${grantId}`)
      .set('x-csrf-token', foreignOwner.csrfToken)
      .send({});
    expect(foreignRevoke.status).toBe(404);
    await expect(
      Promise.all([prisma.webinarAccessGrant.count(), prisma.auditLog.count({ where: { entityId: grantId } })]),
    ).resolves.toEqual(foreignRevokeCounts);

    const revoked = await owner.agent
      .delete(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants/${grantId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.grant.status).toBe('REVOKED');
    const revokedRoom = await request(app)
      .get('/api/participant/access/current')
      .set('Cookie', `aspb_room_token=${invitedRoomToken}`);
    expect(revokedRoom.status).toBe(401);
    await expect(
      prisma.auditLog.count({
        where: {
          entityId: grantId,
          action: {
            in: ['webinar_access_grant.created', 'webinar_access_grant.accepted', 'webinar_access_grant.revoked'],
          },
        },
      }),
    ).resolves.toBe(3);

    const ownerList = await owner.agent.get(`/api/v1/creator/webinars/${privateWebinar.id}/access-grants`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.grants).toEqual([expect.objectContaining({ id: grantId, status: 'REVOKED' })]);
    expect(JSON.stringify(ownerList.body)).not.toContain(invitedEmail);
    expect(JSON.stringify(ownerList.body)).not.toContain(storedGrant.emailHash);

    const retentionNow = new Date('2032-06-01T00:00:00.000Z');
    const expiredGrant = await prisma.webinarAccessGrant.create({
      data: {
        organizationId: ownerTenant.organization.id,
        webinarId: privateWebinar.id,
        emailHash: hashWebinarAccessEmail('expired-private-viewer@example.test'),
        purpose: 'VIEW',
        createdAt: new Date('2032-05-01T00:00:00.000Z'),
        expiresAt: new Date('2032-05-20T00:00:00.000Z'),
        invitedByUserId: ownerTenant.user.id,
        tokens: {
          create: {
            tokenHash: hashToken(createAccessToken()),
            createdAt: new Date('2032-05-01T00:00:00.000Z'),
            expiresAt: new Date('2032-05-20T00:00:00.000Z'),
          },
        },
        emailJob: {
          create: {
            toEmail: 'expired-private-viewer@example.test',
            status: 'CANCELLED',
            createdAt: new Date('2032-01-01T00:00:00.000Z'),
            updatedAt: new Date('2032-01-01T00:00:00.000Z'),
          },
        },
      },
    });
    await expect(cleanupExpiredWebinarAccessGrants(prisma, retentionNow)).resolves.toBe(1);
    await expect(prisma.webinarAccessGrant.findUnique({ where: { id: expiredGrant.id } })).resolves.not.toBeNull();
    await expect(prisma.webinarAccessGrantToken.count({ where: { grantId: expiredGrant.id } })).resolves.toBe(0);
    await expect(prisma.webinarAccessInvitationEmailJob.count({ where: { grantId: expiredGrant.id } })).resolves.toBe(
      0,
    );
  });

  it('allows the same start time for different webinars and keeps session edits isolated', async () => {
    const tenant = await createTenantFixture({
      slug: 'multi-session-webinars',
      email: 'multi-session-webinars@example.test',
      role: 'AUTHOR',
    });
    const firstWebinar = await prisma.webinar.create({
      data: { organizationId: tenant.organization.id, slug: 'first-webinar', title: 'Первый вебинар' },
    });
    const secondWebinar = await prisma.webinar.create({
      data: { organizationId: tenant.organization.id, slug: 'second-webinar', title: 'Второй вебинар' },
    });
    const scheduledAt = new Date('2031-01-15T10:00:00.000Z');
    const [firstSession, secondSession] = await Promise.all([
      prisma.webinarSession.create({
        data: {
          organizationId: tenant.organization.id,
          webinarId: firstWebinar.id,
          title: 'Сессия первого вебинара',
          scheduledAt,
        },
      }),
      prisma.webinarSession.create({
        data: {
          organizationId: tenant.organization.id,
          webinarId: secondWebinar.id,
          title: 'Сессия второго вебинара',
          scheduledAt,
        },
      }),
    ]);
    await prisma.webinarSession.update({ where: { id: firstSession.id }, data: { title: 'Изменённая первая сессия' } });
    await expect(prisma.webinarSession.findUniqueOrThrow({ where: { id: secondSession.id } })).resolves.toMatchObject({
      title: 'Сессия второго вебинара',
    });
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: secondWebinar.id } })).resolves.toMatchObject({
      title: 'Второй вебинар',
    });
  });

  it('streams self-hosted multipart bytes only after tenant, author, CSRF and size checks', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    env.MEDIA_STORAGE_PROVIDER = 'local_fs';
    const localRoot = await mkdtemp(join(tmpdir(), 'aspb-integration-media-'));
    env.MEDIA_LOCAL_ROOT = localRoot;
    try {
      const tenantA = await createTenantFixture({
        slug: 'local-media-a',
        email: 'local-media-a@example.test',
        role: 'OWNER',
      });
      const tenantB = await createTenantFixture({
        slug: 'local-media-b',
        email: 'local-media-b@example.test',
        role: 'OWNER',
      });
      const webinar = await prisma.webinar.create({
        data: { organizationId: tenantA.organization.id, slug: 'local-media', title: 'Локальное видео' },
      });
      const unrelatedAuthor = await prisma.user.create({
        data: {
          emailNormalized: 'local-media-author@example.test',
          displayName: 'Другой автор',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
      await prisma.organizationMembership.create({
        data: { organizationId: tenantA.organization.id, userId: unrelatedAuthor.id, role: 'AUTHOR', status: 'ACTIVE' },
      });
      const owner = await loginPlatformUser(tenantA.user.id);
      const foreignOwner = await loginPlatformUser(tenantB.user.id);
      const unrelated = await loginPlatformUser(unrelatedAuthor.id);
      const created = await owner.agent
        .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
        .set('x-csrf-token', owner.csrfToken)
        .send({ fileName: 'local.mp4', mimeType: 'video/mp4', sizeBytes: '10' });
      expect(created.status).toBe(201);
      expect(created.body.parts).toEqual([
        expect.objectContaining({
          partNumber: 1,
          url: `/api/v1/creator/uploads/${created.body.uploadId}/parts/1/content`,
        }),
      ]);
      expect(JSON.stringify(created.body)).not.toContain(localRoot);
      expect(JSON.stringify(created.body)).not.toContain('organizations/');
      const uploadId = created.body.uploadId as string;
      const partPath = `/api/v1/creator/uploads/${uploadId}/parts/1/content`;

      const missingCsrf = await owner.agent
        .put(partPath)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('0123456789'));
      expect(missingCsrf.status).toBe(403);
      expect(missingCsrf.body).toMatchObject({ code: 'csrf_invalid' });
      const foreign = await foreignOwner.agent
        .put(partPath)
        .set('x-csrf-token', foreignOwner.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('0123456789'));
      const unrelatedAuthorAttempt = await unrelated.agent
        .put(partPath)
        .set('x-csrf-token', unrelated.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('0123456789'));
      expect(foreign.status).toBe(404);
      expect(unrelatedAuthorAttempt.status).toBe(404);
      expect(foreign.body.code).toBe(unrelatedAuthorAttempt.body.code);

      const wrongMime = await owner.agent
        .put(partPath)
        .set('x-csrf-token', owner.csrfToken)
        .set('Content-Type', 'video/webm')
        .send(Buffer.from('0123456789'));
      expect(wrongMime.status).toBe(400);
      expect(wrongMime.body).toMatchObject({ code: 'media_upload_part_mime_mismatch' });
      const wrongSize = await owner.agent
        .put(partPath)
        .set('x-csrf-token', owner.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('short'));
      expect(wrongSize.status).toBe(400);
      expect(wrongSize.body).toMatchObject({ code: 'media_upload_part_size_mismatch' });

      const uploaded = await owner.agent
        .put(partPath)
        .set('x-csrf-token', owner.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('0123456789'));
      expect(uploaded.status).toBe(200);
      expect(uploaded.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(uploaded.body).toMatchObject({
        checkpointed: true,
        completedParts: [{ partNumber: 1, etag: expect.stringMatching(/^[0-9a-f]{64}$/) }],
      });
      expect(JSON.stringify(uploaded.body)).not.toContain(localRoot);

      const repeated = await owner.agent
        .put(partPath)
        .set('x-csrf-token', owner.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('0123456789'));
      expect(repeated.status).toBe(200);
      expect(repeated.body.idempotent).toBe(true);
      const conflict = await owner.agent
        .put(partPath)
        .set('x-csrf-token', owner.csrfToken)
        .set('Content-Type', 'video/mp4')
        .send(Buffer.from('abcdefghij'));
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ code: 'media_upload_part_conflict' });

      const resumed = await owner.agent
        .post(`/api/v1/creator/uploads/${uploadId}/resume`)
        .set('x-csrf-token', owner.csrfToken)
        .send({});
      expect(resumed.status).toBe(200);
      expect(resumed.body.parts).toEqual([]);
      expect(resumed.body.completedParts).toEqual(uploaded.body.completedParts);
      const crossComplete = await foreignOwner.agent
        .post(`/api/v1/creator/uploads/${uploadId}/complete`)
        .set('x-csrf-token', foreignOwner.csrfToken)
        .send({ parts: uploaded.body.completedParts });
      expect(crossComplete.status).toBe(404);
      const completed = await owner.agent
        .post(`/api/v1/creator/uploads/${uploadId}/complete`)
        .set('x-csrf-token', owner.csrfToken)
        .send({ parts: uploaded.body.completedParts });
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ idempotent: false, asset: { status: 'VALIDATING' } });
      const completedAgain = await owner.agent
        .post(`/api/v1/creator/uploads/${uploadId}/complete`)
        .set('x-csrf-token', owner.csrfToken)
        .send({ parts: uploaded.body.completedParts });
      expect(completedAgain.status).toBe(200);
      expect(completedAgain.body.idempotent).toBe(true);
      await expect(prisma.mediaJob.count({ where: { assetId: created.body.asset.id } })).resolves.toBe(1);

      const expiring = await owner.agent
        .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
        .set('x-csrf-token', owner.csrfToken)
        .send({ fileName: 'expired.mp4', mimeType: 'video/mp4', sizeBytes: '10' });
      expect(expiring.status).toBe(201);
      const expiringUpload = await prisma.mediaUpload.findUniqueOrThrow({
        where: { id: expiring.body.uploadId as string },
      });
      const providerUploadDirectory = join(localRoot, 'multipart', expiringUpload.providerUploadKey);
      await expect(access(providerUploadDirectory)).resolves.toBeUndefined();
      await prisma.mediaUpload.update({
        where: { id: expiringUpload.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await expect(cleanupExpiredMediaUploads(prisma)).resolves.toEqual({ checked: 1, cancelled: 1, failed: 0 });
      await expect(access(providerUploadDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(prisma.mediaUpload.findUniqueOrThrow({ where: { id: expiringUpload.id } })).resolves.toMatchObject({
        status: 'CANCELLED',
        abortAttemptedAt: expect.any(Date),
      });
      await expect(
        prisma.auditLog.count({
          where: {
            organizationId: tenantA.organization.id,
            action: 'media.upload.expired_cleanup',
            entityId: expiringUpload.id,
          },
        }),
      ).resolves.toBe(1);

      const mediaMetrics = await request(app).get('/metrics');
      expect(mediaMetrics.status).toBe(200);
      expect(mediaMetrics.text).toContain('aspb_media_storage_probe_success{provider="local_fs"} 1');
      expect(mediaMetrics.text).toContain('aspb_media_storage_bytes{provider="local_fs",state="available"} ');
      expect(mediaMetrics.text).toContain('aspb_media_storage_inodes{provider="local_fs",state="available"} ');
      expect(mediaMetrics.text).not.toContain(localRoot);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
      env.MEDIA_LOCAL_ROOT = undefined;
    }
  });

  it('keeps resumable media uploads tenant-scoped, idempotent and version-switched only after READY', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    env.MEDIA_STORAGE_PROVIDER = 'test_fake';
    const tenantA = await createTenantFixture({ slug: 'media-a', email: 'media-a@example.test', role: 'OWNER' });
    const tenantB = await createTenantFixture({ slug: 'media-b', email: 'media-b@example.test', role: 'OWNER' });
    const webinar = await prisma.webinar.create({
      data: { organizationId: tenantA.organization.id, slug: 'media-pipeline', title: 'Медиапайплайн' },
    });
    const sessionA = await loginPlatformUser(tenantA.user.id);
    const sessionB = await loginPlatformUser(tenantB.user.id);
    const unrelatedAuthor = await prisma.user.create({
      data: {
        emailNormalized: 'media-unrelated-author@example.test',
        displayName: 'Другой автор организации',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: tenantA.organization.id, userId: unrelatedAuthor.id, role: 'AUTHOR', status: 'ACTIVE' },
    });
    const unrelatedAuthorSession = await loginPlatformUser(unrelatedAuthor.id);

    const forged = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({
        fileName: 'legal.mp4',
        mimeType: 'video/mp4',
        sizeBytes: '16777216',
        organizationId: tenantB.organization.id,
      });
    expect(forged.status).toBe(400);

    const created = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ fileName: 'legal.mp4', mimeType: 'video/mp4', sizeBytes: '16777216' });
    expect(created.status).toBe(201);
    expect(created.body.asset).toMatchObject({ version: 1, status: 'UPLOADING', mimeType: 'video/mp4' });
    expect(created.body.parts).toHaveLength(2);
    expect(JSON.stringify(created.body)).not.toContain('organizations/');
    const assetId = created.body.asset.id as string;
    const uploadId = created.body.uploadId as string;

    const crossRead = await sessionB.agent.get(`/api/v1/creator/media/${assetId}/status`);
    const recordedPart = await sessionA.agent
      .post(`/api/v1/creator/uploads/${uploadId}/parts`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ partNumber: 1, etag: 'a' });
    expect(recordedPart.status).toBe(200);
    expect(recordedPart.body).toMatchObject({ partCount: 2, completedParts: [{ partNumber: 1, etag: 'a' }] });
    const repeatedPart = await sessionA.agent
      .post(`/api/v1/creator/uploads/${uploadId}/parts`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ partNumber: 1, etag: 'a' });
    expect(repeatedPart.body.idempotent).toBe(true);
    const crossResume = await sessionB.agent
      .post(`/api/v1/creator/uploads/${uploadId}/resume`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({});
    const crossRecordPart = await sessionB.agent
      .post(`/api/v1/creator/uploads/${uploadId}/parts`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({ partNumber: 2, etag: 'foreign' });
    expect(crossResume.status).toBe(404);
    expect(crossRecordPart.status).toBe(404);
    const resumed = await sessionA.agent
      .post(`/api/v1/creator/uploads/${uploadId}/resume`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      completedParts: [{ partNumber: 1, etag: 'a' }],
      parts: [{ partNumber: 2 }],
      asset: { id: assetId, originalFileName: 'legal.mp4', sizeBytes: '16777216' },
    });
    expect(JSON.stringify(resumed.body)).not.toContain('organizations/');
    const tenantContext = await resolveTenantContext(prisma, {
      userId: tenantA.user.id,
      activeOrganizationId: tenantA.organization.id,
      correlationId: 'media-provider-reconciliation-test',
    });
    const providerAwareStorage = {
      name: 'test_fake',
      listMultipartUploadParts: async () => [
        { partNumber: 1, etag: 'a' },
        { partNumber: 2, etag: 'provider-b' },
      ],
      signMultipartUploadParts: async () => [],
    } as any;
    await expect(
      recordMediaUploadPart(
        prisma,
        tenantContext,
        uploadId,
        { partNumber: 1, etag: 'tampered-client-etag' },
        providerAwareStorage,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'media_upload_part_unconfirmed' });
    await expect(resumeMediaUpload(prisma, tenantContext, uploadId, providerAwareStorage)).resolves.toMatchObject({
      completedParts: [
        { partNumber: 1, etag: 'a' },
        { partNumber: 2, etag: 'provider-b' },
      ],
      parts: [],
    });
    await expect(prisma.mediaUpload.findUniqueOrThrow({ where: { id: uploadId } })).resolves.toMatchObject({
      uploadedPartsJson: [
        { partNumber: 1, etag: 'a' },
        { partNumber: 2, etag: 'provider-b' },
      ],
      lastReconciledAt: expect.any(Date),
    });
    const crossComplete = await sessionB.agent
      .post(`/api/v1/creator/uploads/${uploadId}/complete`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 2, etag: 'b' },
        ],
      });
    expect(crossRead.status).toBe(404);
    expect(crossComplete.status).toBe(404);
    const sameTenantAuthorRead = await unrelatedAuthorSession.agent.get(`/api/v1/creator/media/${assetId}/status`);
    const sameTenantAuthorComplete = await unrelatedAuthorSession.agent
      .post(`/api/v1/creator/uploads/${uploadId}/complete`)
      .set('x-csrf-token', unrelatedAuthorSession.csrfToken)
      .send({
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 2, etag: 'b' },
        ],
      });
    expect(sameTenantAuthorRead.status).toBe(404);
    expect(sameTenantAuthorComplete.status).toBe(404);

    const completeBody = { parts: [{ partNumber: 2, etag: 'b' }] };
    const completed = await sessionA.agent
      .post(`/api/v1/creator/uploads/${uploadId}/complete`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send(completeBody);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ idempotent: false, asset: { status: 'VALIDATING' } });
    const completedAgain = await sessionA.agent
      .post(`/api/v1/creator/uploads/${uploadId}/complete`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send(completeBody);
    expect(completedAgain.status).toBe(200);
    expect(completedAgain.body.idempotent).toBe(true);
    await expect(prisma.mediaAsset.count({ where: { webinarId: webinar.id } })).resolves.toBe(1);
    await expect(prisma.mediaJob.count({ where: { assetId } })).resolves.toBe(1);

    await expect(runMediaJobOnce(prisma)).resolves.toEqual({ checked: 1, ready: 1, failed: 0 });
    const ready = await sessionA.agent.get(`/api/v1/creator/media/${assetId}/status`);
    expect(ready.status).toBe(200);
    expect(ready.body.asset).toMatchObject({ status: 'READY', progressPercent: 100, durationSeconds: 3600 });
    expect(JSON.stringify(ready.body)).not.toContain('storageKey');
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      currentMediaAssetId: null,
    });

    const activated = await sessionA.agent
      .post(`/api/v1/creator/media/${assetId}/activate`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(activated.status).toBe(200);
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      currentMediaAssetId: assetId,
      mediaStatus: 'READY',
    });
    await prisma.webinar.update({ where: { id: webinar.id }, data: { visibility: 'UNLISTED' } });

    const playbackSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'Защищённая выдача',
        scheduledAt: new Date(Date.now() - 2 * 60_000),
        durationMinutes: 60,
        videoDurationSeconds: 3_600,
        replayAvailableHours: 168,
      },
    });
    const viewerLead = await prisma.lead.create({
      data: { name: 'Media Viewer', phone: '+79990003111', email: 'media-viewer@example.test', consent: true },
    });
    const viewerRegistration = await prisma.registration.create({
      data: {
        leadId: viewerLead.id,
        webinarSessionId: playbackSession.id,
        accessTokenHash: hashToken(createAccessToken()),
        emailVerifiedAt: new Date(),
      },
    });
    const viewerToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: viewerRegistration.id,
        tokenHash: hashToken(viewerToken),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000),
      },
    });
    const viewerCookie = `aspb_room_token=${viewerToken}`;
    const draftTranscript = await prisma.transcript.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        mediaAssetId: assetId,
        createdByUserId: tenantA.user.id,
        version: 1,
        status: 'DRAFT',
        segments: {
          create: {
            orderIndex: 0,
            startMs: 0,
            endMs: 4_000,
            speaker: 'Черновик',
            text: 'СЕКРЕТНЫЙ ЧЕРНОВИК НЕ ДЛЯ ЗРИТЕЛЯ',
          },
        },
      },
    });
    const publishedTranscript = await prisma.transcript.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        mediaAssetId: assetId,
        createdByUserId: tenantA.user.id,
        reviewedByUserId: tenantA.user.id,
        version: 2,
        revision: 3,
        status: 'PUBLISHED',
        reviewedAt: new Date(),
        publishedAt: new Date(),
        segments: {
          create: [
            {
              orderIndex: 0,
              startMs: 5_000,
              endMs: 12_000,
              speaker: 'Эксперт <АСПБ>',
              text: 'Проверенный фрагмент <script>alert(1)</script>\nWEBVTT --> безопасно',
            },
            {
              orderIndex: 1,
              startMs: 12_000,
              endMs: 24_000,
              speaker: 'Эксперт',
              text: 'Субсидиарная ответственность: основные признаки.',
            },
          ],
        },
      },
    });
    await prisma.webinarChapter.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        transcriptId: publishedTranscript.id,
        startMs: 12_000,
        title: 'Основные признаки',
        description: 'Проверенная глава опубликованной версии',
        orderIndex: 0,
      },
    });
    await prisma.webinarSource.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        type: 'OFFICIAL_SOURCE',
        title: 'Официальный источник',
        url: 'https://example.test/legal-source',
        accessedAt: new Date('2026-08-21T00:00:00.000Z'),
        note: 'Проверено автором вебинара',
        orderIndex: 0,
      },
    });

    const timeline = await request(app).get('/api/webinar/timeline/session/current').set('Cookie', viewerCookie);
    expect(timeline.status).toBe(200);
    expect(timeline.body.video).toMatchObject({
      state: 'ready',
      src: null,
      hlsSrc: `/api/media/webinar/${playbackSession.id}/manifest`,
      poster: `/api/media/webinar/${playbackSession.id}/poster`,
      provider: 'versioned_private',
    });

    const roomContent = await request(app).get('/api/webinar/content/session/current').set('Cookie', viewerCookie);
    expect(roomContent.status).toBe(200);
    expect(roomContent.headers['cache-control']).toContain('no-store');
    expect(roomContent.body).toMatchObject({
      mediaState: 'ready',
      consistencyKey: `${publishedTranscript.id}:v2`,
      transcript: {
        id: publishedTranscript.id,
        version: 2,
        captionsUrl: `/api/media/webinar/${playbackSession.id}/captions/${publishedTranscript.id}`,
      },
      chapters: [{ startMs: 12_000, title: 'Основные признаки' }],
      materials: [{ title: 'Официальный источник', type: 'OFFICIAL_SOURCE' }],
    });
    expect(JSON.stringify(roomContent.body)).toContain('Проверенный фрагмент');
    expect(JSON.stringify(roomContent.body)).not.toContain('СЕКРЕТНЫЙ ЧЕРНОВИК');
    expect(JSON.stringify(roomContent.body)).not.toContain('organizations/');

    const captionsPath = `/api/media/webinar/${playbackSession.id}/captions/${publishedTranscript.id}`;
    const anonymousCaptions = await request(app).get(captionsPath);
    expect(anonymousCaptions.status).toBe(404);
    expect(anonymousCaptions.body).toMatchObject({ code: 'media_not_found' });
    const captions = await request(app).get(captionsPath).set('Cookie', viewerCookie);
    expect(captions.status).toBe(200);
    expect(captions.headers['cache-control']).toContain('no-store');
    expect(captions.headers['content-type']).toContain('text/vtt');
    expect(captions.headers['x-aspb-transcript-version']).toBe('2');
    expect(captions.text).toContain('WEBVTT\n\n1\n00:00:05.000 --> 00:00:12.000');
    expect(captions.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; WEBVTT --&gt; безопасно');
    expect(captions.text).not.toContain('<script>');
    expect(captions.text).not.toContain('СЕКРЕТНЫЙ ЧЕРНОВИК');
    const draftCaptions = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/captions/${draftTranscript.id}`)
      .set('Cookie', viewerCookie);
    expect(draftCaptions.status).toBe(404);
    expect(draftCaptions.body).toMatchObject({ code: 'media_not_found' });

    const transientCurrentAsset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenantA.user.id,
        version: 2,
        status: 'READY',
        originalFileName: 'new-current.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1_024n,
        storageKey: `test/${tenantA.organization.id}/new-current-source`,
        manifestStorageKey: `test/${tenantA.organization.id}/new-current-manifest`,
        posterStorageKey: `test/${tenantA.organization.id}/new-current-poster`,
        checksumSha256: 'a'.repeat(64),
        durationSeconds: 3_600,
        readyAt: new Date(),
      },
    });
    await prisma.webinar.update({
      where: { id: webinar.id },
      data: { currentMediaAssetId: transientCurrentAsset.id },
    });
    const staleTranscriptSnapshot = await request(app)
      .get('/api/webinar/content/session/current')
      .set('Cookie', viewerCookie);
    expect(staleTranscriptSnapshot.status).toBe(200);
    expect(staleTranscriptSnapshot.body).toMatchObject({
      consistencyKey: null,
      transcript: null,
      chapters: [],
    });
    const stalePublishedCaptions = await request(app).get(captionsPath).set('Cookie', viewerCookie);
    expect(stalePublishedCaptions.status).toBe(404);
    expect(stalePublishedCaptions.body).toMatchObject({ code: 'media_not_found' });
    await prisma.webinar.update({ where: { id: webinar.id }, data: { currentMediaAssetId: assetId } });
    await prisma.mediaAsset.delete({ where: { id: transientCurrentAsset.id } });

    const anonymousManifest = await request(app).get(`/api/media/webinar/${playbackSession.id}/manifest`);
    expect(anonymousManifest.status).toBe(404);
    expect(anonymousManifest.body.code).toBe('media_not_found');
    const manifest = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['cache-control']).toContain('no-store');
    expect(manifest.text).toContain(`/api/media/webinar/${playbackSession.id}/segment/`);
    expect(manifest.text).not.toContain('organizations/');
    expect(manifest.text).not.toContain('private-storage');
    const protectedSegmentPath = manifest.text.split('\n').find(line => line.startsWith('/api/media/'));
    expect(protectedSegmentPath).toBeTruthy();
    if (!protectedSegmentPath) throw new Error('Expected protected HLS segment');
    const segment = await request(app).get(protectedSegmentPath).set('Cookie', viewerCookie);
    expect(segment.status).toBe(200);
    expect(segment.headers['content-type']).toContain('video/mp2t');
    const rangedSegment = await request(app)
      .get(protectedSegmentPath)
      .set('Cookie', viewerCookie)
      .set('Range', 'bytes=0-3');
    expect(rangedSegment.status).toBe(206);
    expect(rangedSegment.headers['content-range']).toBe('bytes 0-3/16');
    const poster = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/poster`)
      .set('Cookie', viewerCookie);
    expect(poster.status).toBe(200);
    expect(poster.headers['content-type']).toContain('image/jpeg');

    const unrelatedSameTenantSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        title: 'Другая сессия того же вебинара',
        scheduledAt: new Date(Date.now() - 2 * 60_000),
        durationMinutes: 60,
        replayAvailableHours: 168,
      },
    });
    const sameTenantWrongSessionManifest = await request(app)
      .get(`/api/media/webinar/${unrelatedSameTenantSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(sameTenantWrongSessionManifest.status).toBe(404);
    expect(sameTenantWrongSessionManifest.body).toMatchObject({ code: 'media_not_found' });
    const sameTenantWrongSessionCaptions = await request(app)
      .get(`/api/media/webinar/${unrelatedSameTenantSession.id}/captions/${publishedTranscript.id}`)
      .set('Cookie', viewerCookie);
    expect(sameTenantWrongSessionCaptions.status).toBe(404);
    expect(sameTenantWrongSessionCaptions.body).toMatchObject({ code: 'media_not_found' });

    const foreignPlaybackSession = await prisma.webinarSession.create({
      data: {
        organizationId: tenantB.organization.id,
        webinarId: (
          await prisma.webinar.create({
            data: { organizationId: tenantB.organization.id, slug: 'foreign-media', title: 'Foreign media' },
          })
        ).id,
        title: 'Foreign media',
        scheduledAt: new Date(Date.now() - 2 * 60_000),
      },
    });
    const crossTenantManifest = await request(app)
      .get(`/api/media/webinar/${foreignPlaybackSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(crossTenantManifest.status).toBe(404);
    expect(crossTenantManifest.body).toMatchObject({ code: 'media_not_found' });
    const crossTenantCaptions = await request(app)
      .get(`/api/media/webinar/${foreignPlaybackSession.id}/captions/${publishedTranscript.id}`)
      .set('Cookie', viewerCookie);
    expect(crossTenantCaptions.status).toBe(404);
    expect(crossTenantCaptions.body).toMatchObject({ code: 'media_not_found' });

    await prisma.webinarSession.update({
      where: { id: playbackSession.id },
      data: { scheduledAt: new Date(Date.now() - 3 * 60 * 60_000), durationMinutes: 1, replayAvailableHours: 1 },
    });
    const expiredManifest = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(expiredManifest.status).toBe(404);
    expect(expiredManifest.body).toMatchObject({ code: 'media_not_found' });
    const expiredCaptions = await request(app).get(captionsPath).set('Cookie', viewerCookie);
    expect(expiredCaptions.status).toBe(404);
    expect(expiredCaptions.body).toMatchObject({ code: 'media_not_found' });
    const expiredRoomContent = await request(app)
      .get('/api/webinar/content/session/current')
      .set('Cookie', viewerCookie);
    expect(expiredRoomContent.status).toBe(404);
    await prisma.webinarSession.update({
      where: { id: playbackSession.id },
      data: { scheduledAt: new Date(Date.now() - 2 * 60_000), durationMinutes: 60, replayAvailableHours: 168 },
    });

    await prisma.webinar.update({ where: { id: webinar.id }, data: { visibility: 'PRIVATE' } });
    const privateGrant = await prisma.webinarAccessGrant.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        emailHash: hashWebinarAccessEmail(viewerLead.email),
        invitedByUserId: tenantA.user.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const grantedManifest = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(grantedManifest.status).toBe(200);
    await prisma.webinarAccessGrant.update({ where: { id: privateGrant.id }, data: { revokedAt: new Date() } });
    const revokedManifest = await request(app)
      .get(`/api/media/webinar/${playbackSession.id}/manifest`)
      .set('Cookie', viewerCookie);
    expect(revokedManifest.status).toBe(404);
    expect(revokedManifest.body).toMatchObject({ code: 'media_not_found' });
    const revokedCaptions = await request(app).get(captionsPath).set('Cookie', viewerCookie);
    expect(revokedCaptions.status).toBe(404);
    expect(revokedCaptions.body).toMatchObject({ code: 'media_not_found' });
    const revokedRoomContent = await request(app)
      .get('/api/webinar/content/session/current')
      .set('Cookie', viewerCookie);
    expect(revokedRoomContent.status).toBe(404);
    await prisma.webinar.update({ where: { id: webinar.id }, data: { visibility: 'UNLISTED' } });

    const replacement = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ fileName: 'replacement.webm', mimeType: 'video/webm', sizeBytes: '5242880' });
    expect(replacement.body.asset.version).toBe(2);
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      currentMediaAssetId: assetId,
    });
    const cancelled = await sessionA.agent
      .post(`/api/v1/creator/media/${replacement.body.asset.id}/cancel`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: {
            in: [
              'media.upload.created',
              'media.upload.completed',
              'media.processing.cancelled',
              'media.asset.activated',
            ],
          },
        },
      }),
    ).resolves.toBe(5);

    const failingAsset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenantA.user.id,
        version: 3,
        status: 'VALIDATING',
        originalFileName: 'broken.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5_242_880n,
        storageKey: `test/${tenantA.organization.id}/broken`,
      },
    });
    const failingJob = await prisma.mediaJob.create({
      data: {
        organizationId: tenantA.organization.id,
        assetId: failingAsset.id,
        type: 'PROCESS_VIDEO',
        dedupKey: `media_process:${failingAsset.id}:v1`,
        nextAttemptAt: new Date(0),
      },
    });
    const failingStorage = {
      name: 'failing_test',
      createMultipartUpload: async () => {
        throw new Error('unused');
      },
      signMultipartUploadParts: async () => {
        throw new Error('unused');
      },
      completeMultipartUpload: async () => {
        throw new Error('unused');
      },
      processVideo: async () => {
        throw new Error('transcoder unavailable');
      },
      abortMultipartUpload: async () => undefined,
    };
    await expect(runMediaJobOnce(prisma, failingStorage)).resolves.toEqual({ checked: 1, ready: 0, failed: 1 });
    const retried = await sessionA.agent
      .post(`/api/v1/creator/media/${failingAsset.id}/retry`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(retried.status).toBe(200);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await prisma.mediaJob.update({ where: { id: failingJob.id }, data: { nextAttemptAt: new Date(0) } });
      await runMediaJobOnce(prisma, failingStorage);
    }
    await expect(prisma.mediaJob.findUniqueOrThrow({ where: { id: failingJob.id } })).resolves.toMatchObject({
      status: 'DEAD_LETTER',
      attempts: 5,
      lastErrorCode: 'media_processing_failed',
    });
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: 'media.processing.retried',
          entityId: failingAsset.id,
        },
      }),
    ).resolves.toBe(1);

    const leasedAsset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenantA.user.id,
        version: 50,
        status: 'TRANSCODING',
        originalFileName: 'worker-restart.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5_242_880n,
        storageKey: `test/${tenantA.organization.id}/worker-restart`,
      },
    });
    const leasedJob = await prisma.mediaJob.create({
      data: {
        organizationId: tenantA.organization.id,
        assetId: leasedAsset.id,
        type: 'PROCESS_VIDEO',
        status: 'RUNNING',
        attempts: 1,
        dedupKey: `media_process:${leasedAsset.id}:v1`,
        claimedAt: new Date(Date.now() - 3 * 60 * 60_000),
        claimExpiresAt: new Date(Date.now() - 60_000),
        claimToken: 'abandoned-worker-claim',
      },
    });
    await expect(runMediaJobOnce(prisma)).resolves.toEqual({ checked: 1, ready: 1, failed: 0 });
    await expect(prisma.mediaJob.findUniqueOrThrow({ where: { id: leasedJob.id } })).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      claimToken: null,
      claimExpiresAt: null,
    });
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: 'media.provider.lease_recovered',
          entityId: leasedJob.id,
        },
      }),
    ).resolves.toBe(1);

    const expiredAsset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenantA.user.id,
        version: 4,
        status: 'UPLOADING',
        originalFileName: 'expired.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5_242_880n,
        storageKey: `test/${tenantA.organization.id}/expired`,
      },
    });
    const expiredUpload = await prisma.mediaUpload.create({
      data: {
        organizationId: tenantA.organization.id,
        assetId: expiredAsset.id,
        provider: 'cleanup_test',
        providerUploadKey: `cleanup-${expiredAsset.id}`,
        status: 'UPLOADING',
        partSizeBytes: 5_242_880,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const abortExpired = vi.fn().mockResolvedValue(undefined);
    await expect(
      cleanupExpiredMediaUploads(prisma, {
        name: 'cleanup_test',
        abortMultipartUpload: abortExpired,
      } as any),
    ).resolves.toEqual({ checked: 1, cancelled: 1, failed: 0 });
    expect(abortExpired).toHaveBeenCalledWith({
      providerUploadKey: expiredUpload.providerUploadKey,
      storageKey: expiredAsset.storageKey,
    });
    await expect(prisma.mediaUpload.findUniqueOrThrow({ where: { id: expiredUpload.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      abortAttemptedAt: expect.any(Date),
    });

    const maximumAllowed = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ fileName: 'maximum.mp4', mimeType: 'video/mp4', sizeBytes: String(env.MEDIA_MAX_UPLOAD_BYTES) });
    expect(maximumAllowed.status).toBe(201);
    expect(maximumAllowed.body.parts).toHaveLength(Math.ceil(env.MEDIA_MAX_UPLOAD_BYTES / env.MEDIA_PART_SIZE_BYTES));
    const overMaximum = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/uploads`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({
        fileName: 'too-large.mp4',
        mimeType: 'video/mp4',
        sizeBytes: String(BigInt(env.MEDIA_MAX_UPLOAD_BYTES) + 1n),
      });
    expect(overMaximum.status).toBe(400);
    expect(overMaximum.body).toMatchObject({ code: 'media_size_limit_exceeded' });
  });

  it('recovers an S3 completion committed before the application transaction', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    const tenant = await createTenantFixture({
      slug: 'media-complete-recovery',
      email: 'media-complete-recovery@example.test',
      role: 'OWNER',
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenant.organization.id,
        slug: 'media-complete-recovery',
        title: 'Idempotent provider completion',
      },
    });
    const sizeBytes = 5_242_880n;
    const asset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenant.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenant.user.id,
        version: 1,
        status: 'UPLOADING',
        progressPercent: 15,
        originalFileName: 'recovered.mp4',
        mimeType: 'video/mp4',
        sizeBytes,
        storageKey: `organizations/${tenant.organization.id}/webinars/${webinar.id}/assets/recovered/source`,
      },
    });
    const upload = await prisma.mediaUpload.create({
      data: {
        organizationId: tenant.organization.id,
        assetId: asset.id,
        provider: 's3',
        providerUploadKey: 'provider-already-committed',
        status: 'UPLOADING',
        partSizeBytes: Number(sizeBytes),
        uploadedPartsJson: [{ partNumber: 1, etag: 'trusted-etag' }],
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const context = await resolveTenantContext(prisma, {
      userId: tenant.user.id,
      activeOrganizationId: tenant.organization.id,
      correlationId: 'media-complete-recovery',
    });
    const completeMultipartUpload = vi.fn(async () => ({ mimeType: 'video/mp4', sizeBytes }));
    const signMultipartUploadParts = vi.fn(async () => []);
    const storage = {
      name: 's3',
      listMultipartUploadParts: async () => {
        throw new SafeMediaProviderError('media_upload_already_completed');
      },
      signMultipartUploadParts,
      completeMultipartUpload,
    } as any;

    await expect(resumeMediaUpload(prisma, context, upload.id, storage)).resolves.toMatchObject({
      completedParts: [{ partNumber: 1, etag: 'trusted-etag' }],
      parts: [],
    });
    expect(signMultipartUploadParts).toHaveBeenCalledWith(expect.objectContaining({ partNumbers: [] }));
    await expect(
      completeMediaUpload(prisma, context, upload.id, [{ partNumber: 1, etag: 'trusted-etag' }], storage),
    ).resolves.toMatchObject({ idempotent: false, asset: { status: 'VALIDATING' } });
    expect(completeMultipartUpload).toHaveBeenCalledTimes(1);
    await expect(prisma.mediaUpload.findUniqueOrThrow({ where: { id: upload.id } })).resolves.toMatchObject({
      status: 'COMPLETED',
      completedAt: expect.any(Date),
    });
    await expect(prisma.mediaJob.count({ where: { assetId: asset.id } })).resolves.toBe(1);
    await expect(
      completeMediaUpload(prisma, context, upload.id, [{ partNumber: 1, etag: 'trusted-etag' }], storage),
    ).resolves.toMatchObject({ idempotent: true });
    expect(completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it('generates, reviews, versions and publishes transcripts without cross-tenant disclosure', async () => {
    env.PLATFORM_ACCOUNTS_ENABLED = 'on';
    env.CREATOR_DASHBOARD_ENABLED = 'on';
    env.STT_PROVIDER = 'test_fake';
    env.AI_ENRICHMENT_PROVIDER = 'test_fake';
    const tenantA = await createTenantFixture({
      slug: 'transcript-a',
      email: 'transcript-a@example.test',
      role: 'OWNER',
    });
    const tenantB = await createTenantFixture({
      slug: 'transcript-b',
      email: 'transcript-b@example.test',
      role: 'OWNER',
    });
    const authorProfile = await prisma.authorProfile.create({
      data: {
        organizationId: tenantA.organization.id,
        userId: tenantA.user.id,
        slug: `author-${'c'.repeat(24)}`,
        publicName: 'Автор расшифровки',
        verificationStatus: 'VERIFIED',
      },
    });
    const webinar = await prisma.webinar.create({
      data: {
        organizationId: tenantA.organization.id,
        authorProfileId: authorProfile.id,
        slug: 'transcript-pipeline',
        title: 'Расшифровка вебинара',
        contentStatus: 'DRAFT',
        freshnessStatus: 'CURRENT',
      },
    });
    const asset = await prisma.mediaAsset.create({
      data: {
        organizationId: tenantA.organization.id,
        webinarId: webinar.id,
        createdByUserId: tenantA.user.id,
        version: 1,
        status: 'READY',
        progressPercent: 100,
        originalFileName: 'ready.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5_242_880n,
        checksumSha256: 'a'.repeat(64),
        storageKey: `organizations/${tenantA.organization.id}/webinars/${webinar.id}/source`,
        manifestStorageKey: `organizations/${tenantA.organization.id}/webinars/${webinar.id}/manifest`,
        posterStorageKey: `organizations/${tenantA.organization.id}/webinars/${webinar.id}/poster`,
        audioStorageKey: `organizations/${tenantA.organization.id}/webinars/${webinar.id}/speech.ogg`,
        durationSeconds: 90,
        readyAt: new Date(),
      },
    });
    await prisma.webinar.update({
      where: { id: webinar.id },
      data: { currentMediaAssetId: asset.id, mediaStatus: 'READY' },
    });
    const sessionA = await loginPlatformUser(tenantA.user.id);
    const sessionB = await loginPlatformUser(tenantB.user.id);

    const createdTerm = await sessionA.agent
      .post('/api/v1/creator/term-dictionary')
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ term: 'АСПБ', expansion: 'Ассоциация содействия правовой безопасности' });
    expect(createdTerm.status).toBe(201);
    const termId = createdTerm.body.term.id as string;
    const tenantBTerms = await sessionB.agent.get('/api/v1/creator/term-dictionary');
    expect(tenantBTerms.body.terms).toEqual([]);
    const crossTermUpdate = await sessionB.agent
      .patch(`/api/v1/creator/term-dictionary/${termId}`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({ term: 'Чужой термин' });
    expect(crossTermUpdate.status).toBe(404);

    const crossGenerate = await sessionB.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({});
    const crossRead = await sessionB.agent.get(`/api/v1/creator/webinars/${webinar.id}/transcript`);
    expect(crossGenerate.status).toBe(404);
    expect(crossRead.status).toBe(404);

    const enqueued = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(enqueued.status).toBe(202);
    expect(enqueued.body).toMatchObject({ idempotent: false, job: { type: 'TRANSCRIBE', status: 'PENDING' } });
    expect(JSON.stringify(enqueued.body)).not.toContain('storageKey');
    const jobId = enqueued.body.job.id as string;
    const crossJob = await sessionB.agent.get(`/api/v1/creator/content-jobs/${jobId}/status`);
    expect(crossJob.status).toBe(404);
    await expect(prisma.transcript.count({ where: { webinarId: webinar.id } })).resolves.toBe(0);
    await expect(runContentJobOnce(prisma)).resolves.toEqual({ checked: 1, succeeded: 1, failed: 0 });
    const jobStatus = await sessionA.agent.get(`/api/v1/creator/content-jobs/${jobId}/status`);
    expect(jobStatus.body.job).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    const generated = await sessionA.agent.get(`/api/v1/creator/webinars/${webinar.id}/transcript`);
    expect(generated.body).toMatchObject({
      transcript: {
        version: 1,
        revision: 1,
        status: 'DRAFT',
        provenance: [
          {
            operationType: 'speech_to_text',
            providerId: 'test_fake',
            modelId: 'deterministic-stt-v1',
            templateVersion: 'transcript-v1',
            status: 'succeeded',
            reviewStatus: 'pending',
            inputRefs: { dictionaryEntries: 1 },
          },
        ],
      },
    });
    expect(generated.body.transcript.segments).toHaveLength(3);
    expect(generated.body.transcript.segments[0]).toMatchObject({ startMs: 0, speaker: 'Спикер' });
    expect(JSON.stringify(generated.body)).not.toContain('storageKey');
    expect(JSON.stringify(generated.body)).not.toContain('/source');
    const transcriptId = generated.body.transcript.id as string;
    const originalSegments = generated.body.transcript.segments.map((segment: any) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker: segment.speaker ?? undefined,
      text: segment.text,
    }));
    expect(await getPublishedTranscript(prisma, tenantA.organization.id, webinar.id)).toBeNull();

    const injectedTenant = await sessionA.agent
      .patch(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({
        transcriptId,
        expectedRevision: 1,
        status: 'REVIEWED',
        segments: originalSegments,
        organizationId: tenantB.organization.id,
      });
    expect(injectedTenant.status).toBe(400);

    const reviewedSegments = originalSegments.map((segment: any, index: number) => ({
      ...segment,
      text: index === 0 ? 'Проверенное введение в тему.' : segment.text,
    }));
    const reviewed = await sessionA.agent
      .patch(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ transcriptId, expectedRevision: 1, status: 'REVIEWED', segments: reviewedSegments });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.transcript).toMatchObject({ id: transcriptId, revision: 2, status: 'REVIEWED' });

    const stale = await sessionA.agent
      .patch(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ transcriptId, expectedRevision: 1, status: 'DRAFT', segments: originalSegments });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('transcript_revision_conflict');
    await expect(
      prisma.transcriptSegment.findFirstOrThrow({
        where: { transcriptId, orderIndex: 0 },
      }),
    ).resolves.toMatchObject({ text: 'Проверенное введение в тему.' });

    const crossPublish = await sessionB.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/transcript/publish`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({ transcriptId, expectedRevision: 2 });
    expect(crossPublish.status).toBe(404);
    const published = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/transcript/publish`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ transcriptId, expectedRevision: 2 });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      idempotent: false,
      transcript: { id: transcriptId, version: 1, revision: 3, status: 'PUBLISHED' },
    });
    const repeatedPublish = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/transcript/publish`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ transcriptId, expectedRevision: 3 });
    expect(repeatedPublish.body.idempotent).toBe(true);
    const publicTranscript = await getPublishedTranscript(prisma, tenantA.organization.id, webinar.id);
    expect(publicTranscript).toMatchObject({ id: transcriptId, version: 1 });
    expect(publicTranscript?.segments[0]?.text).toBe('Проверенное введение в тему.');

    const aiEnqueued = await sessionA.agent
      .post(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({});
    expect(aiEnqueued.status).toBe(202);
    expect(aiEnqueued.body.job).toMatchObject({ type: 'AI_ENRICH', status: 'PENDING' });
    await expect(runContentJobOnce(prisma)).resolves.toEqual({ checked: 1, succeeded: 1, failed: 0 });
    const aiJob = await sessionA.agent.get(`/api/v1/creator/content-jobs/${aiEnqueued.body.job.id}/status`);
    expect(aiJob.body.job).toMatchObject({ type: 'AI_ENRICH', status: 'SUCCEEDED', attempts: 1 });
    const suggestionsResponse = await sessionA.agent.get(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions`);
    expect(suggestionsResponse.status).toBe(200);
    const suggestions = suggestionsResponse.body.suggestions as Array<any>;
    expect(suggestions).toHaveLength(7);
    expect([...new Set(suggestions.map(item => item.type))].sort()).toEqual([
      'CHAPTER',
      'DESCRIPTION',
      'PREPARED_QUESTION',
      'TAG',
      'TITLE',
    ]);
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      title: 'Расшифровка вебинара',
      freshnessStatus: 'CURRENT',
      contentStatus: 'DRAFT',
      transcriptStatus: 'PUBLISHED',
    });
    await expect(prisma.webinarChapter.count({ where: { webinarId: webinar.id } })).resolves.toBe(0);
    await expect(prisma.webinarTag.count({ where: { webinarId: webinar.id } })).resolves.toBe(0);
    await expect(
      prisma.chatScenarioMessage.count({ where: { organizationId: tenantA.organization.id } }),
    ).resolves.toBe(0);
    const crossSuggestions = await sessionB.agent.get(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions`);
    expect(crossSuggestions.status).toBe(404);

    for (const suggestion of suggestions) {
      const action = suggestion.type === 'DESCRIPTION' ? 'REJECT' : 'ACCEPT';
      const body =
        action === 'ACCEPT'
          ? {
              action,
              expectedRevision: suggestion.revision,
              content:
                suggestion.type === 'TITLE'
                  ? { text: 'Принятое человеком название' }
                  : suggestion.type === 'TAG' && suggestion.orderIndex === 0
                    ? { name: 'метка-комплаенс' }
                    : suggestion.content,
            }
          : { action, expectedRevision: suggestion.revision };
      const reviewedSuggestion = await sessionA.agent
        .patch(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions/${suggestion.id}`)
        .set('x-csrf-token', sessionA.csrfToken)
        .send(body);
      expect(reviewedSuggestion.status).toBe(200);
      expect(reviewedSuggestion.body.suggestion.status).toBe(action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED');
    }
    const crossSuggestionWrite = await sessionB.agent
      .patch(`/api/v1/creator/webinars/${webinar.id}/ai-suggestions/${suggestions[0].id}`)
      .set('x-csrf-token', sessionB.csrfToken)
      .send({ action: 'REJECT', expectedRevision: 1 });
    expect(crossSuggestionWrite.status).toBe(404);
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      title: 'Принятое человеком название',
      description: null,
      freshnessStatus: 'CURRENT',
      contentStatus: 'DRAFT',
      transcriptStatus: 'PUBLISHED',
      scenarioStatus: 'DRAFT',
    });
    await expect(prisma.webinarChapter.count({ where: { webinarId: webinar.id } })).resolves.toBe(2);
    await expect(prisma.webinarTag.count({ where: { webinarId: webinar.id } })).resolves.toBe(2);
    await expect(
      prisma.chatScenarioMessage.findFirstOrThrow({
        where: { organizationId: tenantA.organization.id },
      }),
    ).resolves.toMatchObject({
      kind: 'PREPARED_QUESTION',
      authorLabel: 'Подготовленный вопрос',
      isSynthetic: true,
    });
    await expect(
      prisma.aiOperationProvenance.findFirstOrThrow({
        where: { organizationId: tenantA.organization.id, operationType: 'content_enrichment', status: 'succeeded' },
      }),
    ).resolves.toMatchObject({
      providerId: 'test_fake',
      modelId: 'deterministic-enrichment-v1',
      templateVersion: 'legal-enrichment-v1',
      reviewStatus: 'accepted',
      inputRefsJson: expect.objectContaining({ dictionaryEntries: 1, transcriptId }),
    });

    const txtExport = await sessionA.agent.get(`/api/v1/creator/webinars/${webinar.id}/transcript/export?format=txt`);
    expect(txtExport.status).toBe(200);
    expect(txtExport.headers['content-type']).toContain('text/plain');
    expect(txtExport.text).toContain('[00:00:00,000] Спикер: Проверенное введение');
    const vttExport = await sessionA.agent.get(`/api/v1/creator/webinars/${webinar.id}/transcript/export?format=vtt`);
    expect(vttExport.status).toBe(200);
    expect(vttExport.text).toContain('WEBVTT\n\n1\n00:00:00.000 --> 00:00:30.000');
    const crossExport = await sessionB.agent.get(`/api/v1/creator/webinars/${webinar.id}/transcript/export?format=txt`);
    expect(crossExport.status).toBe(404);

    const newDraft = await sessionA.agent
      .patch(`/api/v1/creator/webinars/${webinar.id}/transcript`)
      .set('x-csrf-token', sessionA.csrfToken)
      .send({ transcriptId, expectedRevision: 3, status: 'DRAFT', segments: reviewedSegments });
    expect(newDraft.status).toBe(200);
    expect(newDraft.body.transcript).toMatchObject({ version: 2, revision: 1, status: 'DRAFT' });
    expect(newDraft.body.transcript.id).not.toBe(transcriptId);
    await expect(getPublishedTranscript(prisma, tenantA.organization.id, webinar.id)).resolves.toMatchObject({
      id: transcriptId,
    });
    await expect(prisma.webinar.findUniqueOrThrow({ where: { id: webinar.id } })).resolves.toMatchObject({
      transcriptStatus: 'PUBLISHED',
      freshnessStatus: 'CURRENT',
      contentStatus: 'DRAFT',
    });
    const draftTranscriptId = newDraft.body.transcript.id as string;
    await prisma.transcriptSegment.updateMany({
      where: { transcriptId: draftTranscriptId, orderIndex: 0 },
      data: { text: 'Закрытыйчерновик виден только автору.' },
    });
    await prisma.webinar.update({
      where: { id: webinar.id },
      data: { contentStatus: 'PUBLISHED', visibility: 'PUBLIC', publishedAt: new Date() },
    });
    env.PUBLIC_CATALOG_ENABLED = 'on';
    const transcriptSearch = await request(app).get('/api/v1/catalog/search').query({
      q: 'Проверенное',
      sort: 'RELEVANCE',
      pageSize: 12,
    });
    expect(transcriptSearch.status).toBe(200);
    expect(transcriptSearch.body.items).toHaveLength(1);
    expect(transcriptSearch.body.items[0]).toMatchObject({
      slug: webinar.slug,
      transcriptMatch: { startMs: 0, endMs: 30_000, snippet: expect.stringContaining('Проверенное') },
    });
    const tagSearch = await request(app).get('/api/v1/catalog/search').query({ q: 'метка-комплаенс', pageSize: 12 });
    expect(tagSearch.body.items.map((item: any) => item.slug)).toContain(webinar.slug);
    const draftOnlySearch = await request(app)
      .get('/api/v1/catalog/search')
      .query({ q: 'Закрытыйчерновик', pageSize: 12 });
    expect(draftOnlySearch.body.items).toEqual([]);
    await expect(
      prisma.auditLog.count({
        where: {
          organizationId: tenantA.organization.id,
          action: { in: ['transcript.generated', 'transcript.reviewed', 'transcript.published', 'transcript.updated'] },
        },
      }),
    ).resolves.toBe(4);
  });
});
