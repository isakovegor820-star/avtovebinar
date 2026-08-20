import { env } from './env.js';

export type PlatformFeatureFlags = {
  platformAccounts: boolean;
  tenantEnforcement: boolean;
  creatorDashboard: boolean;
};

export function getPlatformFeatureFlags(): PlatformFeatureFlags {
  return {
    platformAccounts: env.PLATFORM_ACCOUNTS_ENABLED === 'on',
    tenantEnforcement: env.PLATFORM_TENANCY_ENFORCEMENT === 'on',
    creatorDashboard: env.CREATOR_DASHBOARD_ENABLED === 'on',
  };
}
