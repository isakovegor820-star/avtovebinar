import { describe, expect, it } from 'vitest';
import {
  createOrganizationSchema,
  normalizeOrganizationSlug,
  parseOrganizationIdempotencyKey,
  updateOrganizationSchema,
} from '../src/lib/tenancy/organizations.js';

describe('organization self-service contracts', () => {
  it('normalizes Russian and Latin organization slugs deterministically', () => {
    expect(normalizeOrganizationSlug('  Юр-команда № 12  ')).toBe('yur-komanda-no-12');
    expect(normalizeOrganizationSlug('Legal   Team')).toBe('legal-team');
    expect(() => normalizeOrganizationSlug('api')).toThrowError(
      expect.objectContaining({ code: 'organization_slug_invalid' }),
    );
  });

  it('requires bounded retry keys and strict settings payloads', () => {
    expect(parseOrganizationIdempotencyKey('org-create-0001')).toBe('org-create-0001');
    expect(() => parseOrganizationIdempotencyKey('short')).toThrowError(
      expect.objectContaining({ code: 'idempotency_key_required' }),
    );
    expect(createOrganizationSchema.parse({ name: 'Юридическая команда' })).toEqual({ name: 'Юридическая команда' });
    expect(() => createOrganizationSchema.parse({ name: 'А', organizationId: 'forged' })).toThrow();
    expect(
      updateOrganizationSchema.parse({
        expectedRevision: 2,
        settings: { defaultTimezone: 'Europe/Amsterdam', locale: 'ru-RU' },
      }),
    ).toMatchObject({ expectedRevision: 2 });
    expect(() =>
      updateOrganizationSchema.parse({ expectedRevision: 2, settings: { defaultTimezone: 'Not/AZone' } }),
    ).toThrow();
  });
});
