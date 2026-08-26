import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_REGISTRY, validateAnalyticsAttributes } from '../src/lib/analyticsEvents.js';
import {
  generateUnsubscribeTokenValue,
  UNSUBSCRIBE_TOKEN_PURPOSE,
} from '../src/lib/unsubscribe.js';
import { registerSchema } from '../src/routes/public.js';
import {
  partnerApplicationIdempotencyKeySchema,
  partnerApplicationSchema,
} from '../src/routes/public/partners.js';
import { canUseLegacyDailyRollover } from '../src/routes/public/helpers.js';
import { resolveRegistrationAttribution } from '../src/routes/public/registration.js';

describe('pre-launch backend remediation contracts', () => {
  it('normalizes valid registration identity fields and rejects non-actionable values', () => {
    const parsed = registerSchema.parse({
      name: '  Анна  Мария  ',
      phone: '+7 (999) 555-44-33',
      email: '  QA+Alias@Example.TEST ',
      personalDataConsent: true,
      termsAccepted: true,
    });
    expect(parsed).toMatchObject({
      name: 'Анна Мария',
      phone: '+79995554433',
      email: 'qa+alias@example.test',
    });

    for (const input of [
      { name: '<>', phone: '+79995554433' },
      { name: '<script>alert(1)</script>', phone: '+79995554433' },
      { name: 'Анна', phone: 'abcdef' },
      { name: 'Анна', phone: 'javascript:alert(1)' },
      { name: 'Анна', phone: '12345' },
    ]) {
      expect(() =>
        registerSchema.parse({
          ...input,
          email: 'qa@example.test',
          personalDataConsent: true,
          termsAccepted: true,
        }),
      ).toThrow();
    }
  });

  it('bounds click attribution and strips query/hash PII from persisted landing URLs', () => {
    const parsed = registerSchema.parse({
      name: 'Анна Мария',
      phone: '+79995554433',
      email: 'qa@example.test',
      personalDataConsent: true,
      termsAccepted: true,
      gclid: 'Google_Click-123',
      yclid: 'Yandex_Click.456',
      landingUrl: 'https://aspb.example/crisis_premium/index.html?email=privacy@example.test&utm_source=ad#token',
    });
    expect(parsed).toMatchObject({
      gclid: 'Google_Click-123',
      yclid: 'Yandex_Click.456',
      landingUrl: 'https://aspb.example/crisis_premium/index.html',
    });
    expect(() =>
      registerSchema.parse({
        name: 'Анна Мария',
        phone: '+79995554433',
        email: 'qa@example.test',
        personalDataConsent: true,
        termsAccepted: true,
        gclid: '<script>',
      }),
    ).toThrow();
  });

  it('keeps campaign A as first touch and campaign B as last touch on first registration', () => {
    const parsed = registerSchema.parse({
      name: 'Анна Мария',
      phone: '+79995554433',
      email: 'qa@example.test',
      personalDataConsent: true,
      termsAccepted: true,
      source: 'campaign-b',
      utmSource: 'b-network',
      gclid: 'click-B',
      landingUrl: 'https://aspb.example/register?utm_source=b-network',
      firstSource: 'campaign-a',
      firstUtmSource: 'a-network',
      firstYclid: 'click-A',
      firstLandingUrl: 'https://aspb.example/landing?utm_source=a-network',
    });
    expect(resolveRegistrationAttribution(parsed)).toEqual({
      first: expect.objectContaining({
        source: 'campaign-a',
        utmSource: 'a-network',
        yclid: 'click-A',
        landingUrl: 'https://aspb.example/landing',
      }),
      last: expect.objectContaining({
        source: 'campaign-b',
        utmSource: 'b-network',
        gclid: 'click-B',
        landingUrl: 'https://aspb.example/register',
      }),
    });
  });

  it('requires actionable partner fields and a stable bounded idempotency key', () => {
    expect(() => partnerApplicationSchema.parse({})).toThrow();
    expect(() => partnerApplicationSchema.parse({ sphere: 'Юрист', city: '' })).toThrow();
    expect(partnerApplicationSchema.parse({ sphere: '  Юрист  ', city: '  Москва ' })).toMatchObject({
      sphere: 'Юрист',
      city: 'Москва',
    });
    expect(partnerApplicationIdempotencyKeySchema.parse('partner-submit-00000001')).toBe('partner-submit-00000001');
    for (const key of ['', 'short', 'contains spaces and is invalid', 'x'.repeat(129)]) {
      expect(() => partnerApplicationIdempotencyKeySchema.parse(key)).toThrow();
    }
  });

  it('never rolls versioned or foreign webinar registrations into the legacy daily room', () => {
    expect(
      canUseLegacyDailyRollover({
        accessPolicy: 'PUBLIC_CATALOG',
        webinarId: 'webinar-versioned',
        webinarSession: { webinarId: 'webinar-versioned' },
      }),
    ).toBe(false);
    expect(
      canUseLegacyDailyRollover({
        accessPolicy: 'LEGACY',
        webinarId: 'webinar-versioned',
        webinarSession: { webinarId: 'webinar-versioned' },
      }),
    ).toBe(false);
    expect(
      canUseLegacyDailyRollover({
        accessPolicy: 'LEGACY',
        webinarId: 'webinar_aspb_legacy',
        webinarSession: { webinarId: 'webinar_aspb_legacy' },
      }),
    ).toBe(true);
  });

  it('uses random opaque unsubscribe capabilities and persists only their hashes', () => {
    const { token, tokenHash } = generateUnsubscribeTokenValue();
    expect(token).not.toContain(Buffer.from('privacy.qa+alias@example.test').toString('base64url'));
    expect(token).not.toContain('privacy.qa');
    expect(token).toHaveLength(43);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(tokenHash).not.toBe(token);
    expect(UNSUBSCRIBE_TOKEN_PURPOSE).toBe('email-marketing-unsubscribe');
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toContain('model UnsubscribeToken');
    expect(schema).toContain('tokenHash String');
    expect(schema).toContain('usedAt');
    expect(schema).toContain('revokedAt');
  });

  it('accepts the canonical funnel events with privacy-safe schemas', () => {
    for (const eventName of [
      'sound_on',
      'cta_appear',
      'cta_click',
      'registration_form_error',
      'registration_success',
      'user_exit',
      'partner_request_click',
      'video_progress_25',
      'video_progress_50',
      'video_progress_75',
    ] as const) {
      expect(ANALYTICS_EVENT_REGISTRY[eventName]).toBeDefined();
    }
    expect(validateAnalyticsAttributes('registration_form_error', { failureCode: 'invalid_phone' })).toEqual({
      failureCode: 'invalid_phone',
    });
    expect(() =>
      validateAnalyticsAttributes('registration_form_error', {
        failureCode: 'invalid_phone',
        email: 'privacy@example.test',
      }),
    ).toThrow(/analytics attribute/i);
  });

  it('keeps dynamic room responses out of browser caches and removes path bearer exchange', () => {
    const registrationSource = readFileSync('src/routes/public/registration.ts', 'utf8');
    const webinarSource = readFileSync('src/routes/public/webinar.ts', 'utf8');
    expect(registrationSource).not.toContain("'/registration/exchange/:token'");
    expect(registrationSource).toContain("res.setHeader('Cache-Control', 'private, no-store')");
    expect(webinarSource).not.toContain("'private, max-age=30'");
    expect(webinarSource).toContain('timezone: access.webinarSession.timezone');
  });

  it('defines an explicit 200 anonymous registration-session contract without weakening room access checks', () => {
    const registrationSource = readFileSync('src/routes/public/registration.ts', 'utf8');
    const sessionState = registrationSource.slice(
      registrationSource.indexOf('async function sendRegistrationState'),
      registrationSource.indexOf('async function getPublishedRecordingsCount'),
    );
    expect(sessionState).toContain("state: 'anonymous'");
    expect(sessionState).toContain('res.status(200).json');
    expect(sessionState).toContain("'Cache-Control', 'private, no-store'");
    expect(registrationSource).toContain("throw new AppError(401, 'Participant session not found')");
  });

  it('adds durable partner idempotency and manager Telegram notification constraints to Prisma', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toContain('idempotencyKey');
    expect(schema).toContain('requestFingerprint');
    expect(schema).toContain('@@unique([registrationId, idempotencyKey])');
    expect(schema).toContain('model ManagerTelegramNotificationJob');
    expect(schema).toContain('dedupKey');
  });
});
