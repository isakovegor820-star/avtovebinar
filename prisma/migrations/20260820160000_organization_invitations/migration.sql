-- TEN-005 expand migration. New invitation tables are empty and do not alter
-- legacy registration, webinar, CRM, email, Telegram or platform-admin data.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "OrganizationInvitationStatus" AS ENUM (
  'pending',
  'accepted',
  'revoked',
  'expired'
);

CREATE TABLE "organization_invitations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "email_normalized" TEXT NOT NULL,
  "role" "OrganizationMembershipRole" NOT NULL,
  "status" "OrganizationInvitationStatus" NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "invited_by_user_id" TEXT NOT NULL,
  "accepted_by_user_id" TEXT,
  "membership_id" TEXT,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_invitations_email_check"
    CHECK (
      "email_normalized" = lower(btrim("email_normalized"))
      AND char_length("email_normalized") BETWEEN 3 AND 320
    ),
  CONSTRAINT "organization_invitations_expiry_check"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "organization_invitations_state_check"
    CHECK (
      ("status" = 'pending' AND "accepted_at" IS NULL AND "accepted_by_user_id" IS NULL
        AND "membership_id" IS NULL AND "revoked_at" IS NULL)
      OR
      ("status" = 'accepted' AND "accepted_at" IS NOT NULL AND "accepted_by_user_id" IS NOT NULL
        AND "membership_id" IS NOT NULL AND "revoked_at" IS NULL)
      OR
      ("status" = 'revoked' AND "accepted_at" IS NULL AND "accepted_by_user_id" IS NULL
        AND "membership_id" IS NULL AND "revoked_at" IS NOT NULL)
      OR
      ("status" = 'expired' AND "accepted_at" IS NULL AND "accepted_by_user_id" IS NULL
        AND "membership_id" IS NULL AND "revoked_at" IS NULL)
    )
);

CREATE TABLE "organization_invitation_tokens" (
  "id" TEXT NOT NULL,
  "invitation_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "invalidated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_invitation_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_invitation_tokens_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "organization_invitation_tokens_expiry_check"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "organization_invitation_tokens_terminal_check"
    CHECK (NOT ("consumed_at" IS NOT NULL AND "invalidated_at" IS NOT NULL)),
  CONSTRAINT "organization_invitation_tokens_consumed_check"
    CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at"),
  CONSTRAINT "organization_invitation_tokens_invalidated_check"
    CHECK ("invalidated_at" IS NULL OR "invalidated_at" >= "created_at")
);

CREATE TABLE "organization_invitation_email_jobs" (
  "id" TEXT NOT NULL,
  "invitation_id" TEXT NOT NULL,
  "status" "UserAuthEmailJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_invitation_email_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_invitation_email_jobs_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "organization_invitation_email_jobs_claim_check"
    CHECK (("claimed_at" IS NULL) = ("claim_token" IS NULL)),
  CONSTRAINT "organization_invitation_email_jobs_sent_check"
    CHECK ("sent_at" IS NULL OR "sent_at" >= "created_at")
);

CREATE INDEX "organization_invitations_organization_id_status_expires_at_idx"
  ON "organization_invitations"("organization_id", "status", "expires_at");
CREATE INDEX "organization_invitations_email_normalized_status_idx"
  ON "organization_invitations"("email_normalized", "status");
CREATE INDEX "organization_invitations_invited_by_user_id_idx"
  ON "organization_invitations"("invited_by_user_id");
CREATE INDEX "organization_invitations_accepted_by_user_id_idx"
  ON "organization_invitations"("accepted_by_user_id");
CREATE UNIQUE INDEX "organization_invitations_pending_org_email_key"
  ON "organization_invitations"("organization_id", "email_normalized")
  WHERE "status" = 'pending';

CREATE UNIQUE INDEX "organization_invitation_tokens_token_hash_key"
  ON "organization_invitation_tokens"("token_hash");
CREATE INDEX "organization_invitation_tokens_invitation_id_expires_at_idx"
  ON "organization_invitation_tokens"("invitation_id", "expires_at");
CREATE INDEX "organization_invitation_tokens_expires_at_idx"
  ON "organization_invitation_tokens"("expires_at");

CREATE UNIQUE INDEX "organization_invitation_email_jobs_invitation_id_key"
  ON "organization_invitation_email_jobs"("invitation_id");
CREATE INDEX "organization_invitation_email_jobs_status_next_attempt_at_idx"
  ON "organization_invitation_email_jobs"("status", "next_attempt_at");

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_invited_by_user_id_fkey"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_accepted_by_user_id_fkey"
  FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_membership_id_fkey"
  FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organization_invitation_tokens"
  ADD CONSTRAINT "organization_invitation_tokens_invitation_id_fkey"
  FOREIGN KEY ("invitation_id") REFERENCES "organization_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_invitation_email_jobs"
  ADD CONSTRAINT "organization_invitation_email_jobs_invitation_id_fkey"
  FOREIGN KEY ("invitation_id") REFERENCES "organization_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
