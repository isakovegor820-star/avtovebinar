process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV = 'test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { app } from '../src/app.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import {
  ANALYTICS_ACTIVE_WINDOW_SECONDS,
  getTenantAnalyticsOverview,
  getTenantContentAnalytics,
  getTenantLiveAnalytics,
  getTenantRetention,
} from '../src/lib/tenancy/analytics.js';
import {
  applyModerationAction,
  createPublicContentReport,
  isModerationTransitionAllowed,
  requestWebinarCorrection,
  reviewWebinarCorrection,
  submitWebinarCorrection,
  transitionModerationReport,
} from '../src/lib/moderationCases.js';
import {
  rollbackPlatformChange,
  updatePlatformFeatureFlag,
  updatePlatformOrganization,
} from '../src/lib/platformGovernance.js';
import { hashPassword } from '../src/lib/passwords.js';
import { encryptMfaSecret, generateTotp } from '../src/lib/mfa.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEFAULT_SYSTEM_OWNER_EMAIL,
  DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
  DEFAULT_SYSTEM_OWNER_USER_ID,
} from '../src/lib/tenancy/constants.js';
import { TENANT_ROLLOUT_FEATURES } from '../src/lib/tenancy/rolloutPolicy.js';

const now = new Date('2026-08-23T12:00:00.000Z');
const analyticsReferenceTime = new Date();
const analyticsPeriod = {
  from: new Date(analyticsReferenceTime.getTime() - 86_400_000).toISOString().slice(0, 10),
  to: new Date(analyticsReferenceTime.getTime() + 86_400_000).toISOString().slice(0, 10),
};

async function reset() {
  Object.assign(env, {
    PLATFORM_ACCOUNTS_ENABLED: 'on',
    CREATOR_DASHBOARD_ENABLED: 'on',
    PUBLIC_CATALOG_ENABLED: 'on',
    TENANT_CRM_ENABLED: 'on',
  });
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, organizations, admin_users, legal_practice_areas, jurisdictions, platform_feature_flags, platform_config_changes CASCADE',
  );
  await prisma.platformFeatureFlag.createMany({
    data: [
      { key: 'analytics_dashboard', enabled: true, description: 'Analytics test flag' },
      { key: 'public_reporting', enabled: true, description: 'Reporting test flag' },
      { key: 'moderation_actions', enabled: true, description: 'Moderation test flag' },
      { key: 'provider_jobs', enabled: false, description: 'Provider jobs test flag' },
    ],
  });
  await prisma.tenantRolloutPolicy.createMany({
    data: TENANT_ROLLOUT_FEATURES.map(feature => ({ feature, mode: 'ENABLED', revision: 1 })),
  });
  await prisma.organization.create({
    data: { id: DEFAULT_ORGANIZATION_ID, name: 'АСПБ', slug: DEFAULT_ORGANIZATION_SLUG, status: 'ACTIVE' },
  });
  await prisma.user.create({
    data: {
      id: DEFAULT_SYSTEM_OWNER_USER_ID,
      emailNormalized: DEFAULT_SYSTEM_OWNER_EMAIL,
      displayName: 'Системный владелец АСПБ',
      kind: 'SYSTEM',
      status: 'ACTIVE',
    },
  });
  await prisma.organizationMembership.create({
    data: {
      id: DEFAULT_SYSTEM_OWNER_MEMBERSHIP_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      userId: DEFAULT_SYSTEM_OWNER_USER_ID,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });
}

async function csrf(agent: ReturnType<typeof request.agent>) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  return response.body.csrfToken as string;
}

async function loginAdmin(role: 'owner' | 'admin' | 'viewer') {
  const email = `${role}-${crypto.randomUUID()}@example.test`;
  const password = `Secure${role}Password123`;
  const secret = 'JBSWY3DPEHPK3PXP';
  const admin = await prisma.adminUser.create({
    data: {
      name: role,
      email,
      passwordHash: await hashPassword(password),
      role,
      isActive: true,
      mfaSecretEncrypted: encryptMfaSecret(secret),
      mfaEnabledAt: now,
    },
  });
  const agent = request.agent(app);
  const csrfToken = await csrf(agent);
  const response = await agent
    .post('/api/admin/login')
    .set('x-csrf-token', csrfToken)
    .send({ login: email, password, otp: generateTotp(secret) });
  expect(response.status).toBe(200);
  return { admin, agent, csrfToken };
}

async function fixture() {
  const organization = await prisma.organization.create({
    data: { name: 'Analytics tenant', slug: `analytics-${crypto.randomUUID()}` },
  });
  const analyst = await prisma.user.create({
    data: { emailNormalized: `analyst-${crypto.randomUUID()}@example.test`, status: 'ACTIVE', emailVerifiedAt: now },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: analyst.id, role: 'ANALYST' },
  });
  const author = await prisma.user.create({
    data: { emailNormalized: `author-${crypto.randomUUID()}@example.test`, status: 'ACTIVE', emailVerifiedAt: now },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: author.id, role: 'AUTHOR' },
  });
  const authorProfile = await prisma.authorProfile.create({
    data: {
      organizationId: organization.id,
      userId: author.id,
      slug: `author-${crypto.randomUUID()}`,
      publicName: 'Проверенный автор',
      verificationStatus: 'VERIFIED',
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      authorProfileId: authorProfile.id,
      slug: `webinar-${crypto.randomUUID()}`,
      title: 'Измеримый вебинар',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    },
  });
  const session = await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: webinar.title,
      scheduledAt: new Date('2026-08-23T10:00:00Z'),
      videoDurationSeconds: 1000,
    },
  });
  return {
    organization,
    analyst,
    membership,
    author,
    authorProfile,
    webinar,
    session,
    context: {
      userId: analyst.id,
      organizationId: organization.id,
      membershipId: membership.id,
      role: membership.role,
      permissions: null,
      correlationId: 'test_analytics_context',
    } as const,
  };
}

async function participant(scope: Awaited<ReturnType<typeof fixture>>, index: number) {
  const user = await prisma.user.create({
    data: {
      emailNormalized: `viewer-${index}-${crypto.randomUUID()}@example.test`,
      status: 'ACTIVE',
      emailVerifiedAt: now,
    },
  });
  const lead = await prisma.lead.create({
    data: {
      name: `Viewer ${index}`,
      phone: `+79990000${String(index).padStart(3, '0')}`,
      email: user.emailNormalized,
      professionalStatus: 'Юрист',
      consent: true,
    },
  });
  const registration = await prisma.registration.create({
    data: {
      organizationId: scope.organization.id,
      webinarId: scope.webinar.id,
      userId: user.id,
      leadId: lead.id,
      webinarSessionId: scope.session.id,
      accessPolicy: 'PUBLIC_CATALOG',
      accessTokenHash: crypto.randomBytes(32).toString('hex'),
      registeredAt: analyticsReferenceTime,
      emailVerifiedAt: analyticsReferenceTime,
    },
  });
  return { user, lead, registration };
}

async function event(
  scope: Awaited<ReturnType<typeof fixture>>,
  actor: Awaited<ReturnType<typeof participant>>,
  eventName: string,
  source: string,
  attributes: Record<string, unknown>,
  suffix: string,
) {
  return prisma.event.create({
    data: {
      schemaVersion: 1,
      scopeKind: 'tenant',
      eventName,
      source,
      organizationId: scope.organization.id,
      webinarId: scope.webinar.id,
      webinarSessionId: scope.session.id,
      registrationId: actor.registration.id,
      leadId: actor.lead.id,
      userId: actor.user.id,
      correlationId: `test_event_${suffix}`,
      dedupKey: `test:event:${suffix}:${crypto.randomUUID()}`,
      payloadHash: crypto.createHash('sha256').update(suffix).digest('hex'),
      metadataJson: attributes as Prisma.InputJsonValue,
    },
  });
}

beforeEach(reset);

describe('ANA-001..ANA-005 analytics projection', () => {
  it('computes documented metrics from trusted v1 data and excludes background/retry identities', async () => {
    const scope = await fixture();
    const actors = await Promise.all([0, 1, 2].map(index => participant(scope, index)));
    for (const [index, actor] of actors.entries()) {
      await event(scope, actor, 'webinar_room_open', 'room', {}, `open-${index}`);
      await event(
        scope,
        actor,
        'viewer_heartbeat',
        'room',
        {
          intervalNumber: 1,
          positionSeconds: 500,
          durationSeconds: 1000,
          intervalSeconds: 10,
          playbackState: 'playing',
          visibilityState: 'visible',
        },
        `heartbeat-${index}`,
      );
      await event(
        scope,
        actor,
        'viewer_heartbeat',
        'room',
        {
          intervalNumber: 2,
          positionSeconds: 100,
          durationSeconds: 1000,
          intervalSeconds: 10,
          playbackState: 'playing',
          visibilityState: 'hidden',
        },
        `background-${index}`,
      );
    }
    await event(scope, actors[0], 'video_finish', 'room', {}, 'finish-0');
    await prisma.question.create({
      data: {
        organizationId: scope.organization.id,
        webinarId: scope.webinar.id,
        leadId: actors[0].lead.id,
        registrationId: actors[0].registration.id,
        webinarSessionId: scope.session.id,
        text: 'Тестовый вопрос?',
        textFingerprint: crypto.randomBytes(16).toString('hex'),
      },
    });

    const overview = await getTenantAnalyticsOverview(prisma, scope.context, analyticsPeriod, now);
    expect(overview.metrics).toMatchObject({
      registrations: 3,
      uniqueEntries: 3,
      liveViews: 3,
      replayViews: 0,
      averageWatchSeconds: 10,
      questions: 1,
    });
    expect(overview.metrics.completion).toEqual({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(overview.dataQuality).toMatchObject({
      schemaVersion: 1,
      legacyExcluded: true,
      backgroundHeartbeatsExcluded: true,
    });
  });

  it('keeps live/replay retention separate, suppresses small cohorts and clamps seek/heartbeat identities', async () => {
    const scope = await fixture();
    const actors = await Promise.all([0, 1, 2].map(index => participant(scope, index)));
    for (const [index, actor] of actors.entries()) {
      await event(
        scope,
        actor,
        'viewer_heartbeat',
        'replay',
        {
          intervalNumber: 1,
          positionSeconds: 500,
          durationSeconds: 1000,
          intervalSeconds: 10,
          playbackState: 'playing',
          visibilityState: 'visible',
        },
        `retention-${index}`,
      );
      await event(
        scope,
        actor,
        'viewer_heartbeat',
        'replay',
        {
          intervalNumber: 2,
          positionSeconds: 100,
          durationSeconds: 1000,
          intervalSeconds: 10,
          playbackState: 'playing',
          visibilityState: 'visible',
        },
        `seek-${index}`,
      );
    }
    const replay = await getTenantRetention(prisma, scope.context, analyticsPeriod, 'REPLAY', now);
    const live = await getTenantRetention(prisma, scope.context, analyticsPeriod, 'LIVE', now);
    expect(replay.intervals.find(item => item.fromPercent === 50)).toMatchObject({ viewers: 3, suppressed: false });
    expect(replay.intervals.find(item => item.fromPercent === 60)).toMatchObject({ viewers: null, suppressed: false });
    expect(live.intervals.every(item => item.viewers === null || item.viewers === 0)).toBe(true);
  });

  it('counts only active visible sessions and published transcript aggregates above the privacy threshold', async () => {
    const scope = await fixture();
    const actors = await Promise.all([0, 1, 2].map(index => participant(scope, index)));
    const asset = await prisma.mediaAsset.create({
      data: {
        organizationId: scope.organization.id,
        webinarId: scope.webinar.id,
        createdByUserId: scope.author.id,
        version: 1,
        status: 'CREATED',
        originalFileName: 'fixture.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1000n,
        storageKey: `test/${crypto.randomUUID()}`,
      },
    });
    const transcript = await prisma.transcript.create({
      data: {
        organizationId: scope.organization.id,
        webinarId: scope.webinar.id,
        mediaAssetId: asset.id,
        createdByUserId: scope.author.id,
        reviewedByUserId: scope.author.id,
        version: 1,
        status: 'PUBLISHED',
        reviewedAt: now,
        publishedAt: now,
      },
    });
    const chapter = await prisma.webinarChapter.create({
      data: {
        organizationId: scope.organization.id,
        webinarId: scope.webinar.id,
        transcriptId: transcript.id,
        startMs: 0,
        title: 'Важная глава',
        orderIndex: 0,
      },
    });
    for (const [index, actor] of actors.entries()) {
      await event(
        scope,
        actor,
        'viewer_heartbeat',
        'room',
        {
          intervalNumber: 10,
          positionSeconds: 100,
          durationSeconds: 1000,
          intervalSeconds: 10,
          playbackState: 'playing',
          visibilityState: 'visible',
        },
        `active-${index}`,
      );
      await event(scope, actor, 'chapter_open', 'replay', { chapterId: chapter.id }, `chapter-${index}`);
      await event(scope, actor, 'transcript_search', 'replay', { query: 'договорный риск' }, `search-${index}`);
    }
    const active = await getTenantLiveAnalytics(
      prisma,
      scope.context,
      { webinarId: scope.webinar.id, sessionId: scope.session.id },
      new Date(),
    );
    const content = await getTenantContentAnalytics(prisma, scope.context, analyticsPeriod, now);
    expect(active.activeWindowSeconds).toBe(ANALYTICS_ACTIVE_WINDOW_SECONDS);
    expect(active.syntheticViewersIncluded).toBe(false);
    expect(content.popularChapters).toEqual([{ chapterId: chapter.id, title: 'Важная глава', count: 3 }]);
    expect(content.transcriptSearches).toEqual([{ query: 'договорный риск', count: 3 }]);
  });

  it('returns the same safe 404 for unknown and foreign Webinar filters and ignores organization hints', async () => {
    const scope = await fixture();
    const foreign = await fixture();
    for (const webinarId of ['unknown-webinar', foreign.webinar.id]) {
      await expect(
        getTenantAnalyticsOverview(prisma, scope.context, { webinarId, organizationId: foreign.organization.id }, now),
      ).rejects.toMatchObject({ statusCode: 404, code: 'analytics_scope_not_found' });
    }
    const result = await getTenantAnalyticsOverview(
      prisma,
      scope.context,
      { organizationId: foreign.organization.id },
      now,
    );
    expect(result.metrics.registrations).toBe(0);
  });
});

describe('MOD-001..MOD-005 moderation and governance', () => {
  it('accepts a minimal public report while keeping private/unknown targets indistinguishable', async () => {
    const scope = await fixture();
    const privateWebinar = await prisma.webinar.create({
      data: {
        organizationId: scope.organization.id,
        authorProfileId: scope.authorProfile.id,
        slug: `private-${crypto.randomUUID()}`,
        title: 'Приватная цель',
        contentStatus: 'PUBLISHED',
        visibility: 'PRIVATE',
        publishedAt: now,
      },
    });
    const agent = request.agent(app);
    const csrfToken = await csrf(agent);
    const contact = `reporter-${crypto.randomUUID()}@example.test`;
    const created = await agent.post('/api/v1/reports').set('x-csrf-token', csrfToken).send({
      targetType: 'WEBINAR',
      targetId: scope.webinar.id,
      category: 'RIGHTS',
      description: '  Проверяемое\u0000 описание нарушения исключительных прав.  ',
      reporterContact: contact,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      ok: true,
      report: { category: 'RIGHTS', status: 'NEW' },
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(created.body)).not.toContain(contact);
    const stored = await prisma.contentReport.findUniqueOrThrow({ where: { id: created.body.report.id } });
    expect(stored.description).toBe('Проверяемое описание нарушения исключительных прав.');
    expect(stored.reporterContactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.reporterContactHash).not.toContain(contact);
    expect(stored.createdAt.getTime()).toBeGreaterThan(0);
    for (const targetId of ['unknown-target', privateWebinar.id]) {
      const rejected = await agent.post('/api/v1/reports').set('x-csrf-token', csrfToken).send({
        targetType: 'WEBINAR',
        targetId,
        category: 'CONTENT',
        description: 'Описание жалобы с достаточной проверяемой длиной.',
      });
      expect(rejected.status).toBe(404);
      expect(rejected.body.code).toBe('moderation_item_not_found');
      expect(rejected.body.correlationId).toEqual(expect.any(String));
    }
  });

  it('enforces the exact state machine and creates no history or audit for a rejected mutation', async () => {
    const scope = await fixture();
    const admin = await prisma.adminUser.create({
      data: {
        name: 'Platform owner',
        email: `admin-${crypto.randomUUID()}@example.test`,
        passwordHash: await hashPassword('AdminPassword123'),
        role: 'owner',
        mfaEnabledAt: now,
      },
    });
    const report = await createPublicContentReport(
      prisma,
      {
        targetType: 'WEBINAR',
        targetId: scope.webinar.id,
        category: 'CONTENT',
        description: 'Проверяемое описание нарушения публикации.',
      },
      'report_correlation_1',
    );
    expect(isModerationTransitionAllowed('NEW', 'IN_REVIEW')).toBe(true);
    expect(isModerationTransitionAllowed('NEW', 'RESOLVED')).toBe(false);
    const beforeEvents = await prisma.contentReportEvent.count();
    const beforeAudit = await prisma.auditLog.count();
    await expect(
      transitionModerationReport(
        prisma,
        report.id,
        { status: 'RESOLVED', expectedRevision: 0, reason: 'Недопустимый переход' },
        admin.id,
        'report_correlation_2',
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'moderation_transition_invalid' });
    expect(await prisma.contentReportEvent.count()).toBe(beforeEvents);
    expect(await prisma.auditLog.count()).toBe(beforeAudit);
    const reviewed = await transitionModerationReport(
      prisma,
      report.id,
      { status: 'IN_REVIEW', expectedRevision: 0, reason: 'Начата проверка фактов' },
      admin.id,
      'report_correlation_3',
    );
    expect(reviewed).toMatchObject({ status: 'IN_REVIEW', revision: 1 });
    await expect(
      transitionModerationReport(
        prisma,
        report.id,
        { status: 'REJECTED', expectedRevision: 0, reason: 'Устаревшая форма' },
        admin.id,
        'report_correlation_4',
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'moderation_revision_conflict' });
  });

  it('atomically unpublishes/restores a webinar while preserving data and immutable evidence', async () => {
    const scope = await fixture();
    const admin = await prisma.adminUser.create({
      data: {
        name: 'Platform owner',
        email: `admin-${crypto.randomUUID()}@example.test`,
        passwordHash: 'hash',
        role: 'owner',
        mfaEnabledAt: now,
      },
    });
    const report = await createPublicContentReport(
      prisma,
      {
        targetType: 'WEBINAR',
        targetId: scope.webinar.id,
        category: 'RIGHTS',
        description: 'Есть основания проверить нарушение исключительных прав.',
      },
      'action_correlation_1',
    );
    await applyModerationAction(
      prisma,
      report.id,
      {
        action: 'UNPUBLISH_WEBINAR',
        expectedRevision: 0,
        expectedTargetRevision: 0,
        reason: 'Подтверждён риск нарушения прав',
        confirmation: 'APPLY_MODERATION_ACTION',
      },
      admin.id,
      'action_correlation_2',
    );
    expect(await prisma.webinar.findUnique({ where: { id: scope.webinar.id } })).toMatchObject({
      contentStatus: 'ARCHIVED',
      visibility: 'PRIVATE',
      moderationRevision: 1,
    });
    expect(await prisma.registration.count()).toBe(0);
    const concurrentRestores = await Promise.allSettled(
      ['action_correlation_3', 'action_correlation_4'].map(correlationId =>
        applyModerationAction(
          prisma,
          report.id,
          {
            action: 'RESTORE_WEBINAR',
            expectedRevision: 0,
            expectedTargetRevision: 1,
            reason: 'Основание устранено и проверено',
            confirmation: 'APPLY_MODERATION_ACTION',
          },
          admin.id,
          correlationId,
        ),
      ),
    );
    expect(concurrentRestores.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrentRestores.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(
      (concurrentRestores.find(result => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      statusCode: 409,
    });
    expect(await prisma.webinar.findUnique({ where: { id: scope.webinar.id } })).toMatchObject({
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      moderationRevision: 2,
    });
    expect(await prisma.moderationPlatformAction.count()).toBe(2);
    await expect(prisma.moderationPlatformAction.deleteMany()).rejects.toBeTruthy();
  });

  it('keeps correction revisions private until human review and detects parallel edits', async () => {
    const scope = await fixture();
    const admin = await prisma.adminUser.create({
      data: {
        name: 'Platform owner',
        email: `admin-${crypto.randomUUID()}@example.test`,
        passwordHash: 'hash',
        role: 'owner',
        mfaEnabledAt: now,
      },
    });
    const report = await createPublicContentReport(
      prisma,
      {
        targetType: 'WEBINAR',
        targetId: scope.webinar.id,
        category: 'CONTENT',
        description: 'Нужно исправить проверяемую формулировку вебинара.',
      },
      'correction_correlation_1',
    );
    const correction = await requestWebinarCorrection(
      prisma,
      report.id,
      {
        expectedRevision: 0,
        reason: 'Уточните правовое основание',
        visibilityDecision: 'KEEP_PUBLISHED',
        confirmation: 'REQUEST_CORRECTION',
      },
      admin.id,
      'correction_correlation_2',
    );
    const authorMembership = await prisma.organizationMembership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: scope.organization.id, userId: scope.author.id } },
    });
    const authorContext = {
      userId: scope.author.id,
      organizationId: scope.organization.id,
      membershipId: authorMembership.id,
      role: authorMembership.role,
      permissions: null,
      correlationId: 'author_correlation_1',
    };
    const revision = await submitWebinarCorrection(prisma, authorContext, correction.id, {
      expectedRevision: 0,
      baseContentVersion: 1,
      content: { title: 'Исправленный заголовок', description: 'Исправленное и проверяемое описание вебинара.' },
    });
    expect(revision.status).toBe('SUBMITTED');
    expect((await prisma.webinar.findUniqueOrThrow({ where: { id: scope.webinar.id } })).title).toBe(
      'Измеримый вебинар',
    );
    await expect(
      submitWebinarCorrection(prisma, authorContext, correction.id, {
        expectedRevision: 0,
        baseContentVersion: 1,
        content: { title: 'Параллельная версия', description: 'Параллельное изменение должно быть отклонено.' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'moderation_correction_conflict' });
    const concurrentReviews = await Promise.allSettled(
      ['correction_correlation_3', 'correction_correlation_4'].map(correlationId =>
        reviewWebinarCorrection(
          prisma,
          correction.id,
          {
            decision: 'APPROVE',
            expectedRevision: 1,
            reason: 'Исправление проверено человеком',
            confirmation: 'REVIEW_CORRECTION',
          },
          admin.id,
          correlationId,
        ),
      ),
    );
    expect(concurrentReviews.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrentReviews.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(
      (concurrentReviews.find(result => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      statusCode: 409,
      code: 'moderation_correction_conflict',
    });
    expect(await prisma.webinar.findUnique({ where: { id: scope.webinar.id } })).toMatchObject({
      title: 'Исправленный заголовок',
      contentVersion: 2,
    });
  });

  it('requires confirmation, reason and optimistic concurrency for platform flags and organizations', async () => {
    const scope = await fixture();
    const admin = await prisma.adminUser.create({
      data: {
        name: 'Platform owner',
        email: `admin-${crypto.randomUUID()}@example.test`,
        passwordHash: 'hash',
        role: 'owner',
        mfaEnabledAt: now,
      },
    });
    await expect(
      updatePlatformFeatureFlag(
        prisma,
        'provider_jobs',
        { enabled: true, expectedRevision: 1, reason: 'test' },
        admin.id,
        'governance_correlation_1',
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    const providerSideEffectsBefore = await Promise.all([
      prisma.emailOutboxJob.count(),
      prisma.telegramBroadcastJob.count(),
      prisma.mediaJob.count(),
      prisma.contentJob.count(),
    ]);
    const flag = await updatePlatformFeatureFlag(
      prisma,
      'provider_jobs',
      {
        enabled: true,
        expectedRevision: 1,
        reason: 'Ручное контролируемое включение',
        confirmation: 'CONFIRM_PLATFORM_CHANGE',
      },
      admin.id,
      'governance_correlation_2',
    );
    expect(flag).toMatchObject({ enabled: true, revision: 2 });
    expect(
      await Promise.all([
        prisma.emailOutboxJob.count(),
        prisma.telegramBroadcastJob.count(),
        prisma.mediaJob.count(),
        prisma.contentJob.count(),
      ]),
    ).toEqual(providerSideEffectsBefore);
    await expect(
      updatePlatformFeatureFlag(
        prisma,
        'provider_jobs',
        { enabled: false, expectedRevision: 1, reason: 'Устаревшая версия', confirmation: 'CONFIRM_PLATFORM_CHANGE' },
        admin.id,
        'governance_correlation_3',
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'platform_configuration_conflict' });
    const organization = await updatePlatformOrganization(
      prisma,
      scope.organization.id,
      {
        status: 'SUSPENDED',
        expectedRevision: 1,
        reason: 'Проверяемая административная приостановка',
        confirmation: 'CONFIRM_PLATFORM_CHANGE',
      },
      admin.id,
      'governance_correlation_4',
    );
    expect(organization).toMatchObject({ status: 'SUSPENDED', platformRevision: 2 });
    const organizationChange = await prisma.platformConfigChange.findFirstOrThrow({
      where: { targetType: 'organization', targetId: scope.organization.id },
    });
    const concurrentRollbacks = await Promise.allSettled(
      ['governance_correlation_5', 'governance_correlation_6'].map(correlationId =>
        rollbackPlatformChange(
          prisma,
          organizationChange.id,
          {
            expectedRevision: 2,
            reason: 'Параллельная проверка безопасного отката',
            confirmation: 'CONFIRM_PLATFORM_ROLLBACK',
          },
          admin.id,
          correlationId,
        ),
      ),
    );
    expect(concurrentRollbacks.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrentRollbacks.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(
      (concurrentRollbacks.find(result => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      statusCode: 409,
    });
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: scope.organization.id } })).toMatchObject({
      status: 'ACTIVE',
      platformRevision: 3,
    });
    expect(await prisma.platformConfigChange.count()).toBe(3);
    expect(await prisma.auditLog.count()).toBe(3);
  });

  it('keeps tenant and unauthenticated callers out of platform-admin aggregates', async () => {
    await fixture();
    const response = await request(app).get('/api/admin/analytics/organizations');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ ok: false });
    expect(JSON.stringify(response.body)).not.toMatch(/email|phone|telegram/i);
  });

  it('enforces the AdminUser and tenant role matrix without exposing aggregate PII', async () => {
    const scope = await fixture();
    const [platformOwner, platformAdmin, platformViewer] = await Promise.all([
      loginAdmin('owner'),
      loginAdmin('admin'),
      loginAdmin('viewer'),
    ]);
    for (const authorized of [platformOwner, platformAdmin]) {
      const response = await authorized.agent.get('/api/admin/analytics/organizations');
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body.rows)).not.toMatch(/email|phone|telegram|message|notes|chatId/i);
      expect(response.body.excludedFields).toEqual(
        expect.arrayContaining(['chat', 'notes', 'email', 'phone', 'telegramIdentifiers']),
      );
    }
    expect((await platformViewer.agent.get('/api/admin/analytics/organizations')).status).toBe(403);

    for (const role of ['OWNER', 'ANALYST', 'AUDITOR'] as const) {
      const user = await prisma.user.create({
        data: {
          emailNormalized: `${role.toLowerCase()}-${crypto.randomUUID()}@example.test`,
          status: 'ACTIVE',
          emailVerifiedAt: now,
        },
      });
      await prisma.organizationMembership.create({
        data: { organizationId: scope.organization.id, userId: user.id, role, status: 'ACTIVE' },
      });
      const rawToken = createAccessToken();
      await prisma.userSession.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          activeOrganizationId: scope.organization.id,
          sessionVersion: user.sessionVersion,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const response = await request(app)
        .get('/api/admin/analytics/organizations')
        .set('Cookie', `aspb_user_session=${rawToken}`);
      expect(response.status).toBe(401);
    }
  });
});
