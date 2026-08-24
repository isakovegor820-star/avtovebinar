import { describe, expect, it } from 'vitest';
import {
  buildRetentionPlanProjection,
  rejectRetentionApply,
  RETENTION_PLAN_CATEGORIES,
} from '../src/lib/tenancy/retentionPlanning.js';

const counts = Object.fromEntries(RETENTION_PLAN_CATEGORIES.map((category, index) => [category, index + 1])) as Record<
  (typeof RETENTION_PLAN_CATEGORIES)[number],
  number
>;

describe('retention dry-run planning', () => {
  it('is deterministic and exposes only safe counts/reason codes', () => {
    const first = buildRetentionPlanProjection('org-a', counts, [{ categories: ['TENANT_CRM_DATA'] }]);
    const second = buildRetentionPlanProjection('org-a', counts, [{ categories: ['TENANT_CRM_DATA'] }]);
    expect(first).toEqual(second);
    expect(first.destructiveApplyAllowed).toBe(false);
    expect(first.categories.find(item => item.category === 'TENANT_CRM_DATA')).toMatchObject({
      blockedByLegalHoldCount: counts.TENANT_CRM_DATA,
      reasonCode: 'LEGAL_HOLD_ACTIVE',
    });
    expect(JSON.stringify(first)).not.toContain('org-a');
  });

  it('rejects every destructive apply payload server-side', () => {
    expect(() => rejectRetentionApply({ apply: true, production: false })).toThrowError(
      expect.objectContaining({ code: 'retention_apply_blocked' }),
    );
  });
});
