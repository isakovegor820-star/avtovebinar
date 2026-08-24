CREATE TABLE "tenant_rollout_policies" (
  "feature" TEXT PRIMARY KEY,
  "mode" TEXT NOT NULL DEFAULT 'DISABLED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_admin_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_rollout_policies_mode_check" CHECK ("mode" IN ('DISABLED', 'ALLOWLIST', 'ENABLED')),
  CONSTRAINT "tenant_rollout_policies_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "tenant_rollout_policies_admin_fkey" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "tenant_rollout_entries" (
  "id" TEXT PRIMARY KEY,
  "feature" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_admin_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_rollout_entries_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "tenant_rollout_entries_policy_fkey" FOREIGN KEY ("feature") REFERENCES "tenant_rollout_policies"("feature") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tenant_rollout_entries_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tenant_rollout_entries_admin_fkey" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tenant_rollout_entries_feature_org_key" UNIQUE ("feature", "organization_id")
);
CREATE INDEX "tenant_rollout_policies_mode_updated_idx" ON "tenant_rollout_policies"("mode", "updated_at");
CREATE INDEX "tenant_rollout_entries_org_feature_enabled_idx" ON "tenant_rollout_entries"("organization_id", "feature", "enabled");

-- ENABLED preserves behavior behind the existing master flags. Operators can move
-- a feature to ALLOWLIST with one revisioned control-plane action.
INSERT INTO "tenant_rollout_policies" ("feature", "mode", "revision") VALUES
  ('PLATFORM_ACCOUNTS_ONBOARDING', 'ENABLED', 1),
  ('CREATOR_DASHBOARD', 'ENABLED', 1),
  ('PUBLIC_CATALOG', 'ENABLED', 1),
  ('TENANT_CRM', 'ENABLED', 1),
  ('TENANT_TELEGRAM', 'ENABLED', 1),
  ('PROVIDER_JOBS', 'DISABLED', 1),
  ('ANALYTICS_MODERATION', 'DISABLED', 1);
