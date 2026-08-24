import { describe, expect, it } from 'vitest';
import { evaluateTenantRollout, requireTenantRolloutBootstrap } from '../src/lib/tenancy/rolloutPolicy.js';

describe('tenant rollout policy', () => {
  it('fails closed when the policy row is missing', async () => {
    const result = evaluateTenantRollout(true, null, 'org-a');
    expect(result).toEqual({ enabled: false, reason: 'policy_unavailable' });
  });

  it('allows only non-authorizing bootstrap in allowlist mode', async () => {
    const db = {
      platformFeatureFlag: { findUnique: async () => ({ enabled: true }) },
      tenantRolloutPolicy: { findUnique: async () => ({ mode: 'ALLOWLIST' }) },
    };
    await expect(requireTenantRolloutBootstrap(db as never, 'PROVIDER_JOBS')).resolves.toEqual({
      enabled: true,
      reason: 'bootstrap_only',
    });
  });

  it('requires an enabled tenant entry in allowlist mode', async () => {
    const result = evaluateTenantRollout(true, 'ALLOWLIST', 'org-b', false);
    expect(result).toEqual({ enabled: false, reason: 'not_allowlisted' });
  });

  it('never lets an allowlist entry bypass the master kill switch', () => {
    expect(evaluateTenantRollout(false, 'ALLOWLIST', 'org-a', true)).toEqual({
      enabled: false,
      reason: 'master_disabled',
    });
  });
});
