-- WEB-010 additive private Webinar grants and durable invitation delivery.
-- New tables are empty and do not rewrite legacy participant or Webinar data.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "webinar_access_purpose" AS ENUM ('view');

CREATE TABLE "webinar_access_grants" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT,
  "email_hash" TEXT NOT NULL,
  "purpose" "webinar_access_purpose" NOT NULL DEFAULT 'view',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "invited_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webinar_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_access_grants_email_hash_check" CHECK ("email_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "webinar_access_grants_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "webinar_access_grants_acceptance_check"
    CHECK (("accepted_at" IS NULL AND "user_id" IS NULL) OR ("accepted_at" IS NOT NULL AND "user_id" IS NOT NULL)),
  CONSTRAINT "webinar_access_grants_revocation_check"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at"),
  CONSTRAINT "webinar_access_grants_webinar_scope_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_access_grants_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_access_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_access_grants_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "webinar_access_grant_tokens" (
  "id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "invalidated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_access_grant_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_access_grant_tokens_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "webinar_access_grant_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "webinar_access_grant_tokens_terminal_check"
    CHECK (NOT ("consumed_at" IS NOT NULL AND "invalidated_at" IS NOT NULL)),
  CONSTRAINT "webinar_access_grant_tokens_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "webinar_access_grants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "webinar_access_invitation_email_jobs" (
  "id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "to_email" TEXT NOT NULL,
  "status" "UserAuthEmailJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webinar_access_invitation_email_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_access_invitation_email_jobs_email_check"
    CHECK (char_length("to_email") BETWEEN 3 AND 320),
  CONSTRAINT "webinar_access_invitation_email_jobs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "webinar_access_invitation_email_jobs_claim_check"
    CHECK (("claimed_at" IS NULL) = ("claim_token" IS NULL)),
  CONSTRAINT "webinar_access_invitation_email_jobs_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "webinar_access_grants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "webinar_access_grants_id_organization_id_key"
  ON "webinar_access_grants"("id", "organization_id");
CREATE INDEX "webinar_access_grants_organization_id_webinar_id_revoked_at_expires_at_idx"
  ON "webinar_access_grants"("organization_id", "webinar_id", "revoked_at", "expires_at");
CREATE INDEX "webinar_access_grants_email_hash_revoked_at_expires_at_idx"
  ON "webinar_access_grants"("email_hash", "revoked_at", "expires_at");
CREATE INDEX "webinar_access_grants_user_id_revoked_at_expires_at_idx"
  ON "webinar_access_grants"("user_id", "revoked_at", "expires_at");
CREATE INDEX "webinar_access_grants_invited_by_user_id_created_at_idx"
  ON "webinar_access_grants"("invited_by_user_id", "created_at");
CREATE UNIQUE INDEX "webinar_access_grant_tokens_token_hash_key"
  ON "webinar_access_grant_tokens"("token_hash");
CREATE INDEX "webinar_access_grant_tokens_grant_id_expires_at_idx"
  ON "webinar_access_grant_tokens"("grant_id", "expires_at");
CREATE INDEX "webinar_access_grant_tokens_expires_at_idx"
  ON "webinar_access_grant_tokens"("expires_at");
CREATE UNIQUE INDEX "webinar_access_invitation_email_jobs_grant_id_key"
  ON "webinar_access_invitation_email_jobs"("grant_id");
CREATE INDEX "webinar_access_invitation_email_jobs_status_next_attempt_at_idx"
  ON "webinar_access_invitation_email_jobs"("status", "next_attempt_at");

RESET statement_timeout;
RESET lock_timeout;
