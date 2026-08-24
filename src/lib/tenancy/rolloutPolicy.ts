import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getPlatformFeatureFlags, isManagedPlatformFeatureEnabled } from '../featureFlags.js';
import { AppError } from '../http.js';

export const TENANT_ROLLOUT_FEATURES = [
  'PLATFORM_ACCOUNTS_ONBOARDING',
  'CREATOR_DASHBOARD',
  'PUBLIC_CATALOG',
  'TENANT_CRM',
  'TENANT_TELEGRAM',
  'PROVIDER_JOBS',
  'ANALYTICS_MODERATION',
] as const;
export type TenantRolloutFeature = (typeof TENANT_ROLLOUT_FEATURES)[number];

export function evaluateTenantRollout(
  masterEnabled: boolean,
  mode: string | null | undefined,
  organizationId?: string | null,
  entryEnabled?: boolean,
) {
  if (!masterEnabled) return { enabled: false, reason: 'master_disabled' as const };
  if (!mode || !['DISABLED', 'ALLOWLIST', 'ENABLED'].includes(mode)) {
    return { enabled: false, reason: 'policy_unavailable' as const };
  }
  if (mode === 'DISABLED') return { enabled: false, reason: 'policy_disabled' as const };
  if (mode === 'ENABLED') return { enabled: true, reason: 'global_enabled' as const };
  if (!organizationId) return { enabled: false, reason: 'organization_required' as const };
  return entryEnabled
    ? { enabled: true, reason: 'allowlisted' as const }
    : { enabled: false, reason: 'not_allowlisted' as const };
}

export async function tenantRolloutMasterEnabled(
  db: Pick<PrismaClient, 'platformFeatureFlag'>,
  feature: TenantRolloutFeature,
) {
  const flags = getPlatformFeatureFlags();
  switch (feature) {
    case 'PLATFORM_ACCOUNTS_ONBOARDING':
      return flags.platformAccounts;
    case 'CREATOR_DASHBOARD':
      return flags.platformAccounts && flags.creatorDashboard;
    case 'PUBLIC_CATALOG':
      return flags.publicCatalog;
    case 'TENANT_CRM':
      return flags.platformAccounts && flags.tenantCrm;
    case 'TENANT_TELEGRAM':
      return flags.platformAccounts && flags.tenantCrm && flags.tenantTelegramBots;
    case 'PROVIDER_JOBS':
      return isManagedPlatformFeatureEnabled(db, 'provider_jobs');
    case 'ANALYTICS_MODERATION':
      return (
        flags.platformAccounts &&
        flags.creatorDashboard &&
        ((await isManagedPlatformFeatureEnabled(db, 'analytics_dashboard')) ||
          (await isManagedPlatformFeatureEnabled(db, 'moderation_actions')))
      );
  }
}

export async function getTenantRolloutDecision(
  db: Pick<PrismaClient, 'platformFeatureFlag' | 'tenantRolloutPolicy' | 'tenantRolloutEntry'>,
  feature: TenantRolloutFeature,
  organizationId?: string | null,
) {
  const masterEnabled = await tenantRolloutMasterEnabled(db, feature);
  if (!masterEnabled) return evaluateTenantRollout(false, null, organizationId);
  const policy = await db.tenantRolloutPolicy.findUnique({
    where: { feature },
    select: { mode: true, revision: true },
  });
  const policyDecision = evaluateTenantRollout(masterEnabled, policy?.mode, organizationId);
  if (policyDecision.reason !== 'not_allowlisted') return policyDecision;
  if (!organizationId) return evaluateTenantRollout(masterEnabled, policy?.mode, organizationId);
  const entry = await db.tenantRolloutEntry.findUnique({
    where: { feature_organizationId: { feature, organizationId } },
    select: { enabled: true },
  });
  return evaluateTenantRollout(masterEnabled, policy?.mode, organizationId, entry?.enabled);
}

export async function requireTenantRollout(
  db: Pick<PrismaClient, 'platformFeatureFlag' | 'tenantRolloutPolicy' | 'tenantRolloutEntry'>,
  feature: TenantRolloutFeature,
  organizationId?: string | null,
) {
  const decision = await getTenantRolloutDecision(db, feature, organizationId);
  if (!decision.enabled) {
    throw new AppError(404, 'Функция пока недоступна', undefined, 'tenant_feature_unavailable');
  }
  return decision;
}

/**
 * Pre-auth bootstrap gate. ALLOWLIST permits the non-enumerating login/session
 * bootstrap only; it never authorizes tenant data or mutations. Those must call
 * requireTenantRollout again with the server-resolved organization id.
 */
export async function requireTenantRolloutBootstrap(
  db: Pick<PrismaClient, 'platformFeatureFlag' | 'tenantRolloutPolicy'>,
  feature: TenantRolloutFeature,
) {
  const masterEnabled = await tenantRolloutMasterEnabled(db, feature);
  if (!masterEnabled) {
    throw new AppError(404, 'Функция пока недоступна', undefined, 'tenant_feature_unavailable');
  }
  const policy = await db.tenantRolloutPolicy.findUnique({ where: { feature }, select: { mode: true } });
  if (!policy || policy.mode === 'DISABLED' || !['ALLOWLIST', 'ENABLED'].includes(policy.mode)) {
    throw new AppError(404, 'Функция пока недоступна', undefined, 'tenant_feature_unavailable');
  }
  return {
    enabled: true,
    reason: policy.mode === 'ALLOWLIST' ? ('bootstrap_only' as const) : ('global_enabled' as const),
  };
}

const policyUpdateSchema = z
  .object({
    mode: z.enum(['DISABLED', 'ALLOWLIST', 'ENABLED']),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(10).max(1_000),
    confirm: z.literal(true),
  })
  .strict();
const entryUpdateSchema = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(10).max(1_000),
    confirm: z.literal(true),
  })
  .strict();

function conflict(): never {
  throw new AppError(409, 'Настройка уже изменена; обновите данные', undefined, 'rollout_revision_conflict');
}

export async function updateTenantRolloutPolicy(
  db: PrismaClient,
  featureInput: unknown,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const feature = z.enum(TENANT_ROLLOUT_FEATURES).parse(featureInput);
  const data = policyUpdateSchema.parse(raw);
  return db.$transaction(async tx => {
    const current = await tx.tenantRolloutPolicy.findUnique({ where: { feature } });
    if (!current || current.revision !== data.expectedRevision) conflict();
    const changed = await tx.tenantRolloutPolicy.updateMany({
      where: { feature, revision: data.expectedRevision },
      data: { mode: data.mode, revision: { increment: 1 }, updatedByAdminUserId: adminUserId },
    });
    if (changed.count !== 1) conflict();
    await tx.auditLog.create({
      data: {
        adminUserId,
        correlationId,
        action: 'tenant_rollout.policy_updated',
        entityType: 'tenant_rollout_policy',
        entityId: feature,
        beforeJson: { mode: current.mode, revision: current.revision },
        afterJson: { mode: data.mode, revision: current.revision + 1, reason: data.reason },
      },
    });
    return { feature, mode: data.mode, revision: current.revision + 1 };
  });
}

export async function updateTenantRolloutEntry(
  db: PrismaClient,
  featureInput: unknown,
  organizationIdInput: unknown,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const feature = z.enum(TENANT_ROLLOUT_FEATURES).parse(featureInput);
  const organizationId = z.string().trim().min(1).max(191).parse(organizationIdInput);
  const data = entryUpdateSchema.parse(raw);
  return db.$transaction(async tx => {
    const [policy, organization, current] = await Promise.all([
      tx.tenantRolloutPolicy.findUnique({ where: { feature } }),
      tx.organization.findFirst({ where: { id: organizationId, status: 'ACTIVE' }, select: { id: true } }),
      tx.tenantRolloutEntry.findUnique({ where: { feature_organizationId: { feature, organizationId } } }),
    ]);
    if (!policy || !organization) {
      throw new AppError(404, 'Объект недоступен', undefined, 'rollout_target_unavailable');
    }
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== data.expectedRevision) conflict();
    const entry = current
      ? await tx.tenantRolloutEntry.update({
          where: { id: current.id },
          data: { enabled: data.enabled, revision: { increment: 1 }, updatedByAdminUserId: adminUserId },
        })
      : await tx.tenantRolloutEntry.create({
          data: { feature, organizationId, enabled: data.enabled, updatedByAdminUserId: adminUserId },
        });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId,
        correlationId,
        action: 'tenant_rollout.entry_updated',
        entityType: 'tenant_rollout_entry',
        entityId: entry.id,
        beforeJson: { enabled: current?.enabled ?? false, revision: currentRevision },
        afterJson: { enabled: entry.enabled, revision: entry.revision, feature, reason: data.reason },
      },
    });
    return { feature, organizationId, enabled: entry.enabled, revision: entry.revision };
  });
}
