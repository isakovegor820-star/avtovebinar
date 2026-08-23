import { env } from './env.js';
import type { PrismaClient } from '@prisma/client';

export type PlatformFeatureFlags = {
  platformAccounts: boolean;
  tenantEnforcement: boolean;
  creatorDashboard: boolean;
  publicCatalog: boolean;
  tenantCrm: boolean;
  tenantTelegramBots: boolean;
};

export function getPlatformFeatureFlags(): PlatformFeatureFlags {
  return {
    platformAccounts: env.PLATFORM_ACCOUNTS_ENABLED === 'on',
    tenantEnforcement: env.PLATFORM_TENANCY_ENFORCEMENT === 'on',
    creatorDashboard: env.CREATOR_DASHBOARD_ENABLED === 'on',
    publicCatalog: env.PUBLIC_CATALOG_ENABLED === 'on',
    tenantCrm: env.TENANT_CRM_ENABLED === 'on',
    tenantTelegramBots: env.TENANT_TELEGRAM_BOTS_ENABLED === 'on',
  };
}

export type ManagedPlatformFeatureFlag =
  | 'analytics_dashboard'
  | 'public_reporting'
  | 'moderation_actions'
  | 'provider_jobs';

export async function isManagedPlatformFeatureEnabled(
  db: Pick<PrismaClient, 'platformFeatureFlag'>,
  key: ManagedPlatformFeatureFlag,
) {
  const flag = await db.platformFeatureFlag.findUnique({ where: { key }, select: { enabled: true } });
  return flag?.enabled === true;
}
