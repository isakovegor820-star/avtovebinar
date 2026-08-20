-- TEN-001/TEN-002/TEN-003 expand migration.
-- Platform users are deliberately separate from legacy platform operators in admin_users.
-- PostgreSQL 16 lock profile:
--   * CREATE TYPE/TABLE and indexes on the new empty tables do not lock legacy writes.
--   * ADD COLUMN with a constant default uses PostgreSQL's metadata-only fast default,
--     but still needs a brief ACCESS EXCLUSIVE lock on the legacy table.
--   * indexes for legacy tables are deliberately deferred to the mandatory
--     post-deploy concurrent-index script; Prisma executes this file in a transaction.
--   * NOT VALID foreign keys take a brief SHARE ROW EXCLUSIVE lock; VALIDATE uses
--     SHARE UPDATE EXCLUSIVE and permits normal reads/writes.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE TYPE "UserKind" AS ENUM ('human', 'system');
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'suspended', 'deactivated');
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'suspended', 'archived');
CREATE TYPE "OrganizationMembershipRole" AS ENUM (
  'owner',
  'author',
  'moderator',
  'crm_manager',
  'analyst',
  'auditor'
);
CREATE TYPE "OrganizationMembershipStatus" AS ENUM ('active', 'suspended', 'removed');

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "email_normalized" TEXT NOT NULL,
  "display_name" TEXT,
  "kind" "UserKind" NOT NULL DEFAULT 'human',
  "status" "UserStatus" NOT NULL DEFAULT 'pending',
  "email_verified_at" TIMESTAMP(3),
  "session_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");
CREATE INDEX "users_status_idx" ON "users"("status");
CREATE INDEX "users_kind_idx" ON "users"("kind");

CREATE TABLE "organizations" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "OrganizationStatus" NOT NULL DEFAULT 'active',
  "settings_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

CREATE TABLE "organization_memberships" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" "OrganizationMembershipRole" NOT NULL,
  "status" "OrganizationMembershipStatus" NOT NULL DEFAULT 'active',
  "permissions_json" JSONB,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key"
  ON "organization_memberships"("organization_id", "user_id");
CREATE INDEX "organization_memberships_user_id_status_idx"
  ON "organization_memberships"("user_id", "status");
CREATE INDEX "organization_memberships_organization_id_status_role_idx"
  ON "organization_memberships"("organization_id", "status", "role");

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Stable compatibility identities are not login credentials. The system user is not an
-- admin_users row and therefore cannot authenticate to the legacy /admin contour.
INSERT INTO "organizations" (
  "id", "name", "slug", "status", "settings_json", "created_at", "updated_at"
) VALUES (
  'org_aspb',
  'АСПБ',
  'aspb',
  'active',
  '{"compatibilityMode":"legacy","scopeVersion":1}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "users" (
  "id", "email_normalized", "display_name", "kind", "status", "email_verified_at",
  "session_version", "created_at", "updated_at"
) VALUES (
  'user_aspb_system_owner',
  'legacy-owner@system.invalid',
  'Системный владелец АСПБ',
  'system',
  'active',
  NULL,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "organization_memberships" (
  "id", "organization_id", "user_id", "role", "status", "permissions_json",
  "joined_at", "created_at", "updated_at"
) VALUES (
  'membership_aspb_system_owner',
  'org_aspb',
  'user_aspb_system_owner',
  'owner',
  'active',
  '{"systemBootstrap":true}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- The DB default is the temporary compatibility layer for every legacy create path. Existing
-- rows are backfilled atomically when this non-null column is added.
ALTER TABLE "webinar_sessions"
  ADD COLUMN "organization_id" TEXT NOT NULL DEFAULT 'org_aspb';

ALTER TABLE "webinar_sessions"
  ADD CONSTRAINT "webinar_sessions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "webinar_sessions"
  VALIDATE CONSTRAINT "webinar_sessions_organization_id_fkey";

-- Extend the existing append-only operational audit instead of creating a competing log.
ALTER TABLE "audit_logs"
  ADD COLUMN "user_id" TEXT,
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "correlation_id" TEXT;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_user_id_fkey";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_organization_id_fkey";

RESET statement_timeout;
RESET lock_timeout;
