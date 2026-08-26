-- Historical partner applications remain nullable. Every new public API row
-- carries a stable operation key and canonical request fingerprint.
ALTER TABLE "partner_applications"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_fingerprint" TEXT;

CREATE UNIQUE INDEX "partner_applications_registration_id_idempotency_key_key"
  ON "partner_applications"("registration_id", "idempotency_key");

-- Privacy-safe campaign attribution: landing URLs are normalized by the API to
-- origin + pathname, while first and last touches remain independently queryable.
ALTER TABLE "leads"
  ADD COLUMN "gclid" TEXT,
  ADD COLUMN "yclid" TEXT,
  ADD COLUMN "landing_url" TEXT,
  ADD COLUMN "last_source" TEXT,
  ADD COLUMN "last_utm_source" TEXT,
  ADD COLUMN "last_utm_medium" TEXT,
  ADD COLUMN "last_utm_campaign" TEXT,
  ADD COLUMN "last_utm_content" TEXT,
  ADD COLUMN "last_utm_term" TEXT,
  ADD COLUMN "last_gclid" TEXT,
  ADD COLUMN "last_yclid" TEXT,
  ADD COLUMN "last_landing_url" TEXT,
  ADD COLUMN "last_touch_at" TIMESTAMP(3);

CREATE TABLE "unsubscribe_tokens" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "unsubscribe_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unsubscribe_tokens_token_hash_key" ON "unsubscribe_tokens"("token_hash");
CREATE INDEX "unsubscribe_tokens_lead_id_purpose_expires_at_idx"
  ON "unsubscribe_tokens"("lead_id", "purpose", "expires_at");
CREATE INDEX "unsubscribe_tokens_expires_at_used_at_revoked_at_idx"
  ON "unsubscribe_tokens"("expires_at", "used_at", "revoked_at");
ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manager alerts store only entity references, not a second PII snapshot.
CREATE TABLE "manager_telegram_notification_jobs" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "dedup_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "registration_id" TEXT NOT NULL,
  "partner_application_id" TEXT,
  "question_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "claim_token" TEXT,
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "dead_lettered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manager_telegram_notification_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "manager_telegram_notification_jobs_dedup_key_key"
  ON "manager_telegram_notification_jobs"("dedup_key");
CREATE UNIQUE INDEX "manager_telegram_notification_jobs_claim_token_key"
  ON "manager_telegram_notification_jobs"("claim_token");
CREATE INDEX "manager_telegram_notification_jobs_status_next_attempt_at_created_at_idx"
  ON "manager_telegram_notification_jobs"("status", "next_attempt_at", "created_at");
CREATE INDEX "manager_telegram_notification_jobs_registration_id_created_at_idx"
  ON "manager_telegram_notification_jobs"("registration_id", "created_at");
CREATE INDEX "manager_telegram_notification_jobs_partner_application_id_idx"
  ON "manager_telegram_notification_jobs"("partner_application_id");
CREATE INDEX "manager_telegram_notification_jobs_question_id_idx"
  ON "manager_telegram_notification_jobs"("question_id");

ALTER TABLE "manager_telegram_notification_jobs"
  ADD CONSTRAINT "manager_telegram_notification_jobs_registration_id_fkey"
  FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manager_telegram_notification_jobs"
  ADD CONSTRAINT "manager_telegram_notification_jobs_partner_application_id_fkey"
  FOREIGN KEY ("partner_application_id") REFERENCES "partner_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manager_telegram_notification_jobs"
  ADD CONSTRAINT "manager_telegram_notification_jobs_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
