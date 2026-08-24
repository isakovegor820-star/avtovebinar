-- TEN-004 expand migration. All new relations are empty at creation time, so
-- ordinary index creation does not scan or lock legacy application tables.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "UserAuthTokenPurpose" AS ENUM ('passwordless_login');
CREATE TYPE "UserAuthEmailJobStatus" AS ENUM (
  'pending',
  'sending',
  'sent',
  'failed',
  'dead_letter',
  'cancelled'
);

CREATE TABLE "user_auth_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose" "UserAuthTokenPurpose" NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_auth_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_auth_tokens_token_hash_format_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "user_auth_tokens_expiry_check"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "user_auth_tokens_consumed_check"
    CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at")
);

CREATE TABLE "user_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "session_version" INTEGER NOT NULL,
  "active_organization_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_hash" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_sessions_token_hash_format_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "user_sessions_version_check" CHECK ("session_version" > 0),
  CONSTRAINT "user_sessions_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "user_sessions_revoked_check"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE TABLE "user_auth_email_jobs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" "UserAuthEmailJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_auth_email_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_auth_email_jobs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "user_auth_email_jobs_claim_check"
    CHECK (("claimed_at" IS NULL) = ("claim_token" IS NULL)),
  CONSTRAINT "user_auth_email_jobs_sent_check"
    CHECK ("sent_at" IS NULL OR "sent_at" >= "created_at")
);

CREATE UNIQUE INDEX "user_auth_tokens_token_hash_key"
  ON "user_auth_tokens"("token_hash");
CREATE INDEX "user_auth_tokens_user_id_purpose_expires_at_idx"
  ON "user_auth_tokens"("user_id", "purpose", "expires_at");
CREATE INDEX "user_auth_tokens_expires_at_idx"
  ON "user_auth_tokens"("expires_at");

CREATE UNIQUE INDEX "user_sessions_token_hash_key"
  ON "user_sessions"("token_hash");
CREATE INDEX "user_sessions_user_id_revoked_at_expires_at_idx"
  ON "user_sessions"("user_id", "revoked_at", "expires_at");
CREATE INDEX "user_sessions_active_organization_id_idx"
  ON "user_sessions"("active_organization_id");
CREATE INDEX "user_sessions_expires_at_idx"
  ON "user_sessions"("expires_at");

CREATE INDEX "user_auth_email_jobs_status_next_attempt_at_idx"
  ON "user_auth_email_jobs"("status", "next_attempt_at");
CREATE INDEX "user_auth_email_jobs_user_id_status_idx"
  ON "user_auth_email_jobs"("user_id", "status");

ALTER TABLE "user_auth_tokens"
  ADD CONSTRAINT "user_auth_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_active_organization_id_fkey"
  FOREIGN KEY ("active_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_auth_email_jobs"
  ADD CONSTRAINT "user_auth_email_jobs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
