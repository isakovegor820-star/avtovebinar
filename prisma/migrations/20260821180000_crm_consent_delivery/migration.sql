-- CRM-002/CRM-008/CRM-013: tenant-scoped manual marketing delivery with
-- enqueue-time evidence, a durable retry cursor and a final consent fence.

CREATE TYPE "crm_delivery_channel" AS ENUM ('email', 'telegram');
CREATE TYPE "crm_delivery_status" AS ENUM (
  'pending',
  'sending',
  'sent',
  'retry_scheduled',
  'blocked',
  'dead_letter',
  'cancelled'
);

CREATE TABLE "crm_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "registration_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "requested_by_membership_id" TEXT NOT NULL,
  "channel" "crm_delivery_channel" NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'marketing',
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "status" "crm_delivery_status" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consent_record_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "claim_token" TEXT,
  "last_error_code" TEXT,
  "next_attempt_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_deliveries_purpose_check" CHECK ("purpose" = 'marketing'),
  CONSTRAINT "crm_deliveries_message_check" CHECK (
    char_length(btrim("body")) BETWEEN 1 AND 3500
    AND (
      ("channel" = 'email' AND char_length(btrim(COALESCE("subject", ''))) BETWEEN 1 AND 160)
      OR ("channel" = 'telegram' AND "subject" IS NULL)
    )
  ),
  CONSTRAINT "crm_deliveries_attempts_check" CHECK ("attempts" BETWEEN 0 AND 20),
  CONSTRAINT "crm_deliveries_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "crm_deliveries_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "crm_deliveries_error_code_check"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z0-9_]{3,80}$'),
  CONSTRAINT "crm_deliveries_lifecycle_check" CHECK (
    ("status" IN ('pending', 'retry_scheduled')
      AND "claim_token" IS NULL AND "next_attempt_at" IS NOT NULL
      AND "sent_at" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'sending'
      AND "claim_token" IS NOT NULL AND "next_attempt_at" IS NULL
      AND "sent_at" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'sent'
      AND "claim_token" IS NULL AND "next_attempt_at" IS NULL
      AND "sent_at" IS NOT NULL AND "completed_at" IS NOT NULL
      AND "last_error_code" IS NULL)
    OR ("status" IN ('blocked', 'dead_letter', 'cancelled')
      AND "claim_token" IS NULL AND "next_attempt_at" IS NULL
      AND "sent_at" IS NULL AND "completed_at" IS NOT NULL
      AND "last_error_code" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "crm_deliveries_id_organization_id_key"
  ON "crm_deliveries"("id", "organization_id");
CREATE UNIQUE INDEX "crm_deliveries_organization_id_idempotency_key_key"
  ON "crm_deliveries"("organization_id", "idempotency_key");
CREATE UNIQUE INDEX "crm_deliveries_claim_token_key"
  ON "crm_deliveries"("claim_token");
CREATE INDEX "crm_deliveries_organization_id_status_next_attempt_at_created_at_idx"
  ON "crm_deliveries"("organization_id", "status", "next_attempt_at", "created_at");
CREATE INDEX "crm_deliveries_organization_id_contact_id_created_at_idx"
  ON "crm_deliveries"("organization_id", "contact_id", "created_at");
CREATE INDEX "crm_deliveries_registration_id_channel_created_at_idx"
  ON "crm_deliveries"("registration_id", "channel", "created_at");
CREATE INDEX "crm_deliveries_consent_record_id_idx"
  ON "crm_deliveries"("consent_record_id");

ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_contact_id_organization_id_fkey"
  FOREIGN KEY ("contact_id", "organization_id")
  REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_registration_id_fkey"
  FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_webinar_id_organization_id_fkey"
  FOREIGN KEY ("webinar_id", "organization_id")
  REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_webinar_session_id_fkey"
  FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_requested_by_membership_id_organization_id_fkey"
  FOREIGN KEY ("requested_by_membership_id", "organization_id")
  REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_deliveries"
  ADD CONSTRAINT "crm_deliveries_consent_record_id_fkey"
  FOREIGN KEY ("consent_record_id") REFERENCES "consent_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "aspb_guard_crm_delivery_scope"()
RETURNS trigger AS $$
DECLARE
  target_lead_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
    OR NEW."registration_id" IS DISTINCT FROM OLD."registration_id"
    OR NEW."webinar_id" IS DISTINCT FROM OLD."webinar_id"
    OR NEW."webinar_session_id" IS DISTINCT FROM OLD."webinar_session_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."channel" IS DISTINCT FROM OLD."channel"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."subject" IS DISTINCT FROM OLD."subject"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'CRM delivery identity and content are immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'sent' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."attempts" IS DISTINCT FROM OLD."attempts"
    OR NEW."consent_record_id" IS DISTINCT FROM OLD."consent_record_id"
    OR NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
    OR NEW."last_error_code" IS DISTINCT FROM OLD."last_error_code"
    OR NEW."next_attempt_at" IS DISTINCT FROM OLD."next_attempt_at"
    OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
    OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
  ) THEN
    RAISE EXCEPTION 'Sent CRM delivery is immutable';
  END IF;

  SELECT registration."lead_id" INTO target_lead_id
  FROM "registrations" registration
  JOIN "webinar_sessions" session
    ON session."id" = registration."webinar_session_id"
  WHERE registration."id" = NEW."registration_id"
    AND registration."organization_id" = NEW."organization_id"
    AND registration."crm_contact_id" = NEW."contact_id"
    AND registration."webinar_id" = NEW."webinar_id"
    AND registration."webinar_session_id" = NEW."webinar_session_id"
    AND session."organization_id" = NEW."organization_id"
    AND session."webinar_id" = NEW."webinar_id";
  IF target_lead_id IS NULL THEN
    RAISE EXCEPTION 'CRM delivery target must be one exact same-tenant registration';
  END IF;

  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM "organization_memberships" membership
    WHERE membership."id" = NEW."requested_by_membership_id"
      AND membership."organization_id" = NEW."organization_id"
      AND membership."status" = 'active'
      AND membership."role" IN ('owner', 'crm_manager')
  ) THEN
    RAISE EXCEPTION 'CRM delivery requester must be an active tenant CRM writer';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "consent_records" consent
    JOIN "registrations" evidence_registration
      ON evidence_registration."id" = consent."registration_id"
    WHERE consent."id" = NEW."consent_record_id"
      AND consent."lead_id" = target_lead_id
      AND consent."action" = 'grant'
      AND consent."kind" = CASE NEW."channel"
        WHEN 'email' THEN 'marketing_email'
        ELSE 'marketing_telegram'
      END
      AND evidence_registration."organization_id" = NEW."organization_id"
      AND evidence_registration."crm_contact_id" = NEW."contact_id"
  ) THEN
    RAISE EXCEPTION 'CRM delivery requires same-tenant channel consent evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "crm_deliveries_scope_guard"
BEFORE INSERT OR UPDATE ON "crm_deliveries"
FOR EACH ROW EXECUTE FUNCTION "aspb_guard_crm_delivery_scope"();
