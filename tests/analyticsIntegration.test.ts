process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV = 'test';
process.env.EMAIL_MODE = 'log';
process.env.TELEGRAM_NOTIFY_MODE = 'log';

import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createAccessToken, hashToken } from '../src/lib/tokens.js';
import { ROOM_SESSION_TOKEN_PURPOSE } from '../src/lib/roomLinks.js';
import { buildServerDedupKey, recordAnalyticsEvent } from '../src/lib/analyticsEvents.js';

beforeAll(() => {
  if (process.env.ASPB_SKIP_TEST_MIGRATION_DEPLOY === 'on') return;
  execSync('node scripts/assert-test-database.mjs', { env: process.env, stdio: 'ignore' });
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore' });
}, 30_000);

async function createParticipantFixture(label: string) {
  const suffix = `${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const organization = await prisma.organization.create({
    data: { name: `Analytics ${suffix}`, slug: `analytics-${suffix}`, status: 'ACTIVE' },
  });
  const user = await prisma.user.create({
    data: {
      emailNormalized: `${suffix}@example.test`,
      displayName: 'Analytics participant',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const webinar = await prisma.webinar.create({
    data: {
      organizationId: organization.id,
      slug: `webinar-${suffix}`,
      title: 'ANA-006 Webinar',
      contentStatus: 'PUBLISHED',
      visibility: 'PUBLIC',
      publishedAt: new Date(Date.now() - 60_000),
    },
  });
  const webinarSession = await prisma.webinarSession.create({
    data: {
      organizationId: organization.id,
      webinarId: webinar.id,
      title: webinar.title,
      scheduledAt: new Date(Date.now() - 60_000),
      durationMinutes: 65,
      status: 'live',
    },
  });
  const lead = await prisma.lead.create({
    data: {
      name: 'Analytics participant',
      phone: `+7999${crypto.randomInt(10_000_000).toString().padStart(7, '0')}`,
      email: `${suffix}@example.test`,
      consent: true,
    },
  });
  const registration = await prisma.registration.create({
    data: {
      leadId: lead.id,
      organizationId: organization.id,
      webinarId: webinar.id,
      webinarSessionId: webinarSession.id,
      userId: user.id,
      accessPolicy: 'PUBLIC_CATALOG',
      accessTokenHash: hashToken(createAccessToken()),
      status: 'registered',
      emailVerifiedAt: new Date(),
    },
  });
  const token = createAccessToken();
  await prisma.registrationToken.create({
    data: {
      registrationId: registration.id,
      tokenHash: hashToken(token),
      purpose: ROOM_SESSION_TOKEN_PURPOSE,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return {
    organization,
    user,
    webinar,
    webinarSession,
    registration,
    cookie: `aspb_room_token=${token}; aspb_cookie_consent=accepted`,
  };
}

function eventPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventName: 'viewer_heartbeat',
    source: 'room',
    dedupKey: `web:heartbeat:${crypto.randomUUID()}`,
    page: '/crisis_premium/webinar.html',
    attributes: { intervalNumber: 1, positionSeconds: 30, playbackState: 'playing' },
    ...overrides,
  };
}

describe('ANA-006 versioned analytics integration', () => {
  it('persists every canonical funnel event added by the pre-launch browser contract', async () => {
    const fixture = await createParticipantFixture('canonical-funnel');
    const cases = [
      {
        eventName: 'registration_form_error',
        source: 'registration',
        attributes: { failureCode: 'invalid_email' },
        cookie: undefined,
      },
      { eventName: 'user_exit', source: 'web', attributes: {}, cookie: undefined },
      { eventName: 'sound_on', source: 'room', attributes: {}, cookie: fixture.cookie },
      {
        eventName: 'cta_appear',
        source: 'room',
        attributes: { ctaKey: 'partner-final', positionSeconds: 3859 },
        cookie: fixture.cookie,
      },
      {
        eventName: 'cta_click',
        source: 'room',
        attributes: { ctaKey: 'partner-final', positionSeconds: 3861 },
        cookie: fixture.cookie,
      },
    ] as const;

    const dedupKeys: string[] = [];
    for (const event of cases) {
      const dedupKey = `web:${event.eventName}:${crypto.randomUUID()}`;
      dedupKeys.push(dedupKey);
      const pending = request(app).post('/api/events').send(
        eventPayload({
          eventName: event.eventName,
          source: event.source,
          dedupKey,
          attributes: event.attributes,
        }),
      );
      if (event.cookie) pending.set('Cookie', event.cookie);
      const response = await pending;
      expect(response.status, `${event.eventName}: ${JSON.stringify(response.body)}`).toBe(201);
    }

    expect(await prisma.event.count({ where: { dedupKey: { in: dedupKeys } } })).toBe(cases.length);
  });

  it('stores trusted tenant scope, safe correlation/source and server-authoritative time', async () => {
    const fixture = await createParticipantFixture('valid');
    const clientOccurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const payload = eventPayload({ clientOccurredAt });
    const before = new Date();
    const response = await request(app)
      .post('/api/events')
      .set('Cookie', fixture.cookie)
      .set('x-correlation-id', 'analytics-valid-correlation-0001')
      .send(payload);
    const after = new Date();
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, accepted: true, replayed: false, schemaVersion: 1 });
    const stored = await prisma.event.findFirstOrThrow({
      where: { dedupKey: payload.dedupKey, organizationId: fixture.organization.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(stored).toMatchObject({
      schemaVersion: 1,
      scopeKind: 'tenant',
      organizationId: fixture.organization.id,
      webinarId: fixture.webinar.id,
      webinarSessionId: fixture.webinarSession.id,
      registrationId: fixture.registration.id,
      userId: fixture.user.id,
      source: 'room',
      correlationId: 'analytics-valid-correlation-0001',
    });
    expect(stored.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 10);
    expect(stored.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime() + 10);
    expect(stored.clientOccurredAt?.toISOString()).toBe(clientOccurredAt);
    expect(stored.occurredAt.toISOString()).not.toBe(clientOccurredAt);

    const aggregatePayload = eventPayload({
      eventName: 'video_start',
      dedupKey: `web:consent:${crypto.randomUUID()}`,
      attributes: {},
      utmSource: 'must-not-persist',
    });
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('Cookie', fixture.cookie.replace('accepted', 'declined'))
          .set('User-Agent', 'private-user-agent')
          .send(aggregatePayload)
      ).status,
    ).toBe(201);
    const aggregate = await prisma.event.findFirstOrThrow({ where: { dedupKey: aggregatePayload.dedupKey } });
    expect(aggregate).toMatchObject({
      scopeKind: 'tenant',
      organizationId: fixture.organization.id,
      webinarId: fixture.webinar.id,
      webinarSessionId: fixture.webinarSession.id,
      registrationId: null,
      leadId: null,
      userId: null,
      visitorId: null,
      userAgent: null,
      ipHash: null,
      utmSource: null,
    });
  });

  it('rejects unknown version/type/source without inserting a row', async () => {
    const before = await prisma.event.count();
    for (const [payload, code] of [
      [eventPayload({ schemaVersion: 2 }), 'analytics_schema_version_unsupported'],
      [eventPayload({ eventName: 'unknown_conversion' }), 'analytics_event_type_unknown'],
      [eventPayload({ source: 'unknown_writer' }), 'analytics_source_unknown'],
    ] as const) {
      const response = await request(app).post('/api/events').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(code);
      expect(response.body.correlationId).toEqual(expect.any(String));
    }
    expect(await prisma.event.count()).toBe(before);
  });

  it('makes unknown and cross-tenant scope hints indistinguishable', async () => {
    const owner = await createParticipantFixture('owner');
    const foreign = await createParticipantFixture('foreign');
    const hints = [
      { organizationId: foreign.organization.id },
      { webinarId: foreign.webinar.id },
      { webinarSessionId: foreign.webinarSession.id },
      { registrationId: foreign.registration.id },
      { userId: foreign.user.id },
      { webinarSessionId: 'missing-session-id' },
    ];
    const responses = [];
    for (const hint of hints) {
      responses.push(
        await request(app)
          .post('/api/events')
          .set('Cookie', owner.cookie)
          .send(eventPayload({ ...hint, dedupKey: `web:scope:${crypto.randomUUID()}` })),
      );
    }
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'analytics_scope_not_found', error: 'Analytics scope not found' });
    }
    expect(await prisma.event.count({ where: { organizationId: owner.organization.id } })).toBe(0);
  });

  it('deduplicates sequential and concurrent delivery atomically and conflicts on another payload/type', async () => {
    const fixture = await createParticipantFixture('dedup');
    const dedupKey = `web:atomic:${crypto.randomUUID()}`;
    const payload = eventPayload({ dedupKey });
    const first = await request(app).post('/api/events').set('Cookie', fixture.cookie).send(payload);
    const retry = await request(app).post('/api/events').set('Cookie', fixture.cookie).send(payload);
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.body.replayed).toBe(true);
    expect(await prisma.event.count({ where: { organizationId: fixture.organization.id, dedupKey } })).toBe(1);

    const conflict = await request(app)
      .post('/api/events')
      .set('Cookie', fixture.cookie)
      .send(eventPayload({ dedupKey, attributes: { intervalNumber: 2 } }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('analytics_idempotency_conflict');
    const typeConflict = await request(app)
      .post('/api/events')
      .set('Cookie', fixture.cookie)
      .send(eventPayload({ dedupKey, eventName: 'video_start', attributes: {} }));
    expect(typeConflict.status).toBe(409);

    const concurrentKey = `web:concurrent:${crypto.randomUUID()}`;
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/api/events')
          .set('Cookie', fixture.cookie)
          .send(eventPayload({ dedupKey: concurrentKey })),
      ),
    );
    expect(concurrent.filter(response => response.status === 201)).toHaveLength(1);
    expect(concurrent.filter(response => response.status === 200)).toHaveLength(7);
    expect(
      await prisma.event.count({ where: { organizationId: fixture.organization.id, dedupKey: concurrentKey } }),
    ).toBe(1);

    const transactionKey = buildServerDedupKey('admin_manual_telegram_reminder', `transaction:${crypto.randomUUID()}`);
    await prisma.$transaction(async tx => {
      const input = {
        eventName: 'admin_manual_telegram_reminder' as const,
        source: 'admin' as const,
        dedupKey: transactionKey,
        correlationId: `analytics-transaction-${crypto.randomUUID()}`,
        scope: { kind: 'trusted' as const, registrationId: fixture.registration.id },
        attributes: {},
      };
      expect((await recordAnalyticsEvent(tx as unknown as typeof prisma, input)).replayed).toBe(false);
      expect((await recordAnalyticsEvent(tx as unknown as typeof prisma, input)).replayed).toBe(true);
    });
    expect(
      await prisma.event.count({ where: { organizationId: fixture.organization.id, dedupKey: transactionKey } }),
    ).toBe(1);
  });

  it('allows the same dedup key in another tenant and keeps heartbeat/conversion retries singular', async () => {
    const firstTenant = await createParticipantFixture('tenant-a');
    const secondTenant = await createParticipantFixture('tenant-b');
    const sharedKey = `web:shared:${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      request(app)
        .post('/api/events')
        .set('Cookie', firstTenant.cookie)
        .send(eventPayload({ dedupKey: sharedKey })),
      request(app)
        .post('/api/events')
        .set('Cookie', secondTenant.cookie)
        .send(eventPayload({ dedupKey: sharedKey })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.event.count({ where: { dedupKey: sharedKey, schemaVersion: 1 } })).toBe(2);

    const conversionKey = `web:conversion:${crypto.randomUUID()}`;
    const conversion = eventPayload({
      eventName: 'registration_success',
      source: 'registration',
      dedupKey: conversionKey,
      attributes: {},
    });
    await request(app).post('/api/events').set('Cookie', firstTenant.cookie).send(conversion);
    await request(app).post('/api/events').set('Cookie', firstTenant.cookie).send(conversion);
    expect(
      await prisma.event.count({ where: { organizationId: firstTenant.organization.id, dedupKey: conversionKey } }),
    ).toBe(1);
    expect(
      await prisma.event.count({
        where: { organizationId: firstTenant.organization.id, eventName: 'viewer_heartbeat' },
      }),
    ).toBe(1);
  });

  it('rejects missing/long keys, sensitive/oversized/deep attributes and prototype pollution without leaks', async () => {
    const fixture = await createParticipantFixture('negative');
    const secret = 'Bearer do-not-log-or-return-this-token';
    const cases = [
      eventPayload({ dedupKey: undefined }),
      eventPayload({ dedupKey: `web:${'x'.repeat(130)}` }),
      eventPayload({ attributes: { intervalNumber: 1, Email: 'person@example.test' } }),
      eventPayload({ attributes: { intervalNumber: 1, authorization: secret } }),
      eventPayload({ attributes: { intervalNumber: 1, signedUrl: 'https://cdn.test/a?X-Amz-Signature=secret' } }),
      eventPayload({ attributes: { intervalNumber: 1, storage_key: 'private/object' } }),
      eventPayload({ attributes: { intervalNumber: 1, nested: { a: { b: { c: { d: true } } } } } }),
      eventPayload({ attributes: { intervalNumber: 1, playbackState: 'x'.repeat(5_000) } }),
      eventPayload({ attributes: JSON.parse('{"intervalNumber":1,"__proto__":{"polluted":true}}') }),
    ];
    const before = await prisma.event.count({ where: { organizationId: fixture.organization.id } });
    for (const payload of cases) {
      const response = await request(app).post('/api/events').set('Cookie', fixture.cookie).send(payload);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    const tooLarge = await request(app)
      .post('/api/events')
      .set('Cookie', fixture.cookie)
      .send(eventPayload({ padding: 'x'.repeat(13_000) }));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('analytics_payload_too_large');
    expect(await prisma.event.count({ where: { organizationId: fixture.organization.id } })).toBe(before);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('replaces an invalid correlation header with a safe generated value', async () => {
    const dedupKey = `web:correlation:${crypto.randomUUID()}`;
    const response = await request(app)
      .post('/api/events')
      .set('x-correlation-id', 'Bearer secret@example.test')
      .send(eventPayload({ eventName: 'page_view', source: 'web', dedupKey, attributes: {} }));
    expect(response.status).toBe(201);
    expect(response.body.correlationId).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(response.headers['x-correlation-id']).toBe(response.body.correlationId);
    const stored = await prisma.event.findFirstOrThrow({ where: { scopeKind: 'platform', dedupKey } });
    expect(stored.correlationId).toBe(response.body.correlationId);
    expect(stored.correlationId).not.toContain('secret');
  });

  it('keeps an unversioned legacy writer on the observable schemaVersion=0 adapter', async () => {
    const response = await request(app)
      .post('/api/events')
      .send({
        eventName: 'page_view',
        page: '/crisis_premium/index.html',
        metadata: { campaign: 'legacy-safe' },
      });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ schemaVersion: 0, legacyCompatibility: true });
    const stored = await prisma.event.findFirstOrThrow({
      where: { schemaVersion: 0, eventName: 'page_view' },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.scopeKind).toBe('legacy');
    expect(stored.metadataJson).toBeNull();
  });
});
