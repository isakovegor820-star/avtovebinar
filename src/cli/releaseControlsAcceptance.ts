import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';

const managedFlags = ['analytics_dashboard', 'moderation_actions', 'provider_jobs'] as const;
const disabledPolicies = ['ANALYTICS_MODERATION', 'PROVIDER_JOBS'] as const;

export async function verifyReleaseControls() {
  const [flags, policies, enabledEntries] = await Promise.all([
    prisma.platformFeatureFlag.findMany({
      where: { key: { in: [...managedFlags] } },
      select: { key: true, enabled: true },
    }),
    prisma.tenantRolloutPolicy.findMany({
      where: { feature: { in: [...disabledPolicies] } },
      select: { feature: true, mode: true },
    }),
    prisma.tenantRolloutEntry.count({
      where: { feature: { in: [...disabledPolicies] }, enabled: true },
    }),
  ]);

  const flagState = new Map(flags.map(flag => [flag.key, flag.enabled]));
  const policyState = new Map(policies.map(policy => [policy.feature, policy.mode]));
  const checks = {
    retentionApplyDisabled: env.RETENTION_APPLY_ENABLED === 'off',
    managedMasterFlagsDisabled: managedFlags.every(flag => flagState.get(flag) === false),
    sensitivePoliciesDisabled: disabledPolicies.every(feature => policyState.get(feature) === 'DISABLED'),
    sensitiveTenantEntriesDisabled: enabledEntries === 0,
  };
  const ok = Object.values(checks).every(Boolean);

  process.stdout.write(
    `${JSON.stringify({
      ok,
      checks,
      providerModes: {
        media: env.MEDIA_STORAGE_PROVIDER,
        speechToText: env.STT_PROVIDER,
        aiEnrichment: env.AI_ENRICHMENT_PROVIDER,
      },
      containsSensitiveData: false,
    })}\n`,
  );

  if (!ok) throw new Error('release_controls_not_fail_closed');
}

verifyReleaseControls()
  .catch(error => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        errorCode: error instanceof Error ? error.message : 'release_controls_acceptance_failed',
        containsSensitiveData: false,
      })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
