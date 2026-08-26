import { describe, expect, it } from 'vitest';
import {
  adaptLegacyAnalyticsAttributes,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_REGISTRY,
  ANALYTICS_SOURCES,
  CURRENT_ANALYTICS_SCHEMA_VERSION,
  legacyAnalyticsEventSchema,
  parseAnalyticsV1Request,
  validateAnalyticsAttributes,
} from '../src/lib/analyticsEvents.js';

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CURRENT_ANALYTICS_SCHEMA_VERSION,
    eventName: 'page_view',
    source: 'web',
    dedupKey: 'web:page_view:operation-0001',
    page: '/crisis_premium/index.html',
    attributes: {},
    ...overrides,
  };
}

describe('ANA-006 analytics schema registry', () => {
  it('declares one explicit current version, controlled taxonomy and source allowlist', () => {
    expect(CURRENT_ANALYTICS_SCHEMA_VERSION).toBe(1);
    expect(ANALYTICS_EVENT_NAMES).toContain('viewer_heartbeat');
    expect(ANALYTICS_EVENT_REGISTRY.registration_success.scope).toBe('tenant');
    expect(ANALYTICS_EVENT_REGISTRY.registration_form_error.sources).toEqual(['registration']);
    expect(ANALYTICS_EVENT_REGISTRY.sound_on.sources).toEqual(['room']);
    expect(ANALYTICS_EVENT_REGISTRY.cta_appear.sources).toEqual(['room']);
    expect(ANALYTICS_EVENT_REGISTRY.cta_click.sources).toEqual(['room']);
    expect(ANALYTICS_EVENT_REGISTRY.user_exit.sources).toEqual(['web', 'registration', 'room', 'replay']);
    expect(ANALYTICS_SOURCES).toEqual(
      expect.arrayContaining(['web', 'room', 'replay', 'registration', 'crm', 'email', 'telegram', 'worker', 'system']),
    );
  });

  it('parses a valid current-version event', () => {
    expect(parseAnalyticsV1Request(validPayload())).toMatchObject({
      schemaVersion: 1,
      eventName: 'page_view',
      source: 'web',
      attributes: {},
    });
  });

  it('returns stable machine codes for unknown versions, event types and sources', () => {
    for (const [payload, code] of [
      [validPayload({ schemaVersion: 99 }), 'analytics_schema_version_unsupported'],
      [validPayload({ eventName: 'invented_conversion' }), 'analytics_event_type_unknown'],
      [validPayload({ source: 'browser_extension' }), 'analytics_source_unknown'],
    ] as const) {
      try {
        parseAnalyticsV1Request(payload);
        throw new Error('expected parser to reject payload');
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
  });

  it('requires a bounded idempotency key and validates client diagnostic time', () => {
    expect(() => parseAnalyticsV1Request(validPayload({ dedupKey: '' }))).toThrow();
    expect(() => parseAnalyticsV1Request(validPayload({ dedupKey: `web:${'x'.repeat(130)}` }))).toThrow();
    expect(() =>
      parseAnalyticsV1Request(
        validPayload({ clientOccurredAt: '2020-01-01T00:00:00.000Z' }),
        new Date('2026-08-23T10:00:00.000Z'),
      ),
    ).toThrow(/within 24 hours/);
  });

  it('rejects PII, secrets, signed URLs, storage keys and prototype-pollution keys', () => {
    const unsafe = [
      { Email: 'person@example.test' },
      { phone_number: '+79990000000' },
      { authorization: 'Bearer secret-value' },
      { signedUrl: 'https://cdn.example.test/file?X-Amz-Signature=secret' },
      { storage_key: 'tenant/private/object' },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ];
    for (const attributes of unsafe) {
      expect(() => validateAnalyticsAttributes('viewer_heartbeat', attributes)).toThrow(/analytics attribute/i);
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects oversized, deeply nested and non-allowlisted attributes', () => {
    expect(() =>
      validateAnalyticsAttributes('viewer_heartbeat', { intervalNumber: 1, playbackState: 'x'.repeat(5_000) }),
    ).toThrow();
    expect(() =>
      validateAnalyticsAttributes('viewer_heartbeat', { intervalNumber: 1, nested: { a: { b: { c: { d: 1 } } } } }),
    ).toThrow();
    expect(() => validateAnalyticsAttributes('page_view', { arbitrary: true })).toThrow();
  });

  it('accepts only privacy-safe bounded content analytics attributes', () => {
    expect(validateAnalyticsAttributes('chapter_open', { chapterId: 'chapter-trusted-1' })).toEqual({
      chapterId: 'chapter-trusted-1',
    });
    expect(validateAnalyticsAttributes('transcript_search', { query: 'договорный риск' })).toEqual({
      query: 'договорный риск',
    });
    for (const query of [
      'person@example.test',
      '+7 999 000 00 00',
      'https://private.example.test/query?token=secret',
    ]) {
      expect(() => validateAnalyticsAttributes('transcript_search', { query })).toThrow(/analytics attribute/i);
    }
  });

  it('accepts bounded conversion attributes and rejects PII in canonical funnel events', () => {
    expect(validateAnalyticsAttributes('registration_form_error', { failureCode: 'invalid_phone' })).toEqual({
      failureCode: 'invalid_phone',
    });
    expect(validateAnalyticsAttributes('cta_appear', { ctaKey: 'partner-final', positionSeconds: 3859 })).toEqual({
      ctaKey: 'partner-final',
      positionSeconds: 3859,
    });
    expect(validateAnalyticsAttributes('user_exit', { playbackPosition: 125.5 })).toEqual({
      playbackPosition: 125.5,
    });
    expect(() =>
      validateAnalyticsAttributes('cta_click', { ctaKey: 'partner', email: 'private@example.test' }),
    ).toThrow(/analytics attribute/i);
  });

  it('keeps the legacy adapter strict and drops raw client error details', () => {
    const parsed = legacyAnalyticsEventSchema.parse({
      eventName: 'question_submit_error',
      metadata: { error: 'Network provider detail' },
    });
    expect(adaptLegacyAnalyticsAttributes('question_submit_error', parsed.metadata)).toEqual({
      failureCode: 'legacy_client_error',
    });
    expect(() => legacyAnalyticsEventSchema.parse({ eventName: 'made_up_event' })).toThrow();
    expect(() => legacyAnalyticsEventSchema.parse({ eventName: 'page_view', organizationId: 'forged' })).toThrow();
  });
});
