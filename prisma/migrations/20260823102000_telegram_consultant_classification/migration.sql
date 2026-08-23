-- BOT-006/BOT-007/BOT-012: navigation-only consultant assistant, durable
-- classification/correction history and pseudonymized chat identity.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "telegram_consultant_message_status" AS ENUM (
  'new',
  'handed_to_human',
  'resolved'
);

CREATE TABLE "telegram_consultant_messages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT,
  "webinar_id" TEXT,
  "webinar_session_id" TEXT,
  "registration_id" TEXT,
  "crm_contact_id" TEXT,
  "chat_id_hash" TEXT NOT NULL,
  "provider_message_id" TEXT NOT NULL,
  "provider_message_key" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "urgency" TEXT NOT NULL,
  "classification_model" TEXT NOT NULL,
  "classification_version" TEXT NOT NULL,
  "status" "telegram_consultant_message_status" NOT NULL DEFAULT 'new',
  "handed_off_at" TIMESTAMP(3),
  "corrected_topic" TEXT,
  "corrected_intent" TEXT,
  "corrected_urgency" TEXT,
  "correction_reason" TEXT,
  "handled_by_membership_id" TEXT,
  "corrected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_consultant_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_consultant_messages_text_check" CHECK (char_length(btrim("text")) BETWEEN 1 AND 4000),
  CONSTRAINT "telegram_consultant_messages_chat_hash_check" CHECK (length("chat_id_hash") = 64),
  CONSTRAINT "telegram_consultant_messages_provider_key_check" CHECK (length("provider_message_key") = 64),
  CONSTRAINT "telegram_consultant_messages_correlation_check" CHECK (length(btrim("correlation_id")) BETWEEN 8 AND 128),
  CONSTRAINT "telegram_consultant_messages_topic_check" CHECK ("topic" IN ('bankruptcy', 'tax', 'debt', 'partnership', 'webinar_access', 'other')),
  CONSTRAINT "telegram_consultant_messages_intent_check" CHECK ("intent" IN ('navigation', 'legal_question', 'manager_contact', 'partnership', 'other')),
  CONSTRAINT "telegram_consultant_messages_urgency_check" CHECK ("urgency" IN ('low', 'normal', 'high')),
  CONSTRAINT "telegram_consultant_messages_corrected_topic_check" CHECK ("corrected_topic" IS NULL OR "corrected_topic" IN ('bankruptcy', 'tax', 'debt', 'partnership', 'webinar_access', 'other')),
  CONSTRAINT "telegram_consultant_messages_corrected_intent_check" CHECK ("corrected_intent" IS NULL OR "corrected_intent" IN ('navigation', 'legal_question', 'manager_contact', 'partnership', 'other')),
  CONSTRAINT "telegram_consultant_messages_corrected_urgency_check" CHECK ("corrected_urgency" IS NULL OR "corrected_urgency" IN ('low', 'normal', 'high')),
  CONSTRAINT "telegram_consultant_messages_status_check" CHECK (
    ("status" = 'new' AND "handed_off_at" IS NULL)
    OR ("status" IN ('handed_to_human', 'resolved') AND "handed_off_at" IS NOT NULL)
  ),
  CONSTRAINT "telegram_consultant_messages_correction_check" CHECK (
    ("corrected_topic" IS NULL AND "corrected_intent" IS NULL AND "corrected_urgency" IS NULL AND "correction_reason" IS NULL AND "handled_by_membership_id" IS NULL AND "corrected_at" IS NULL)
    OR (
      ("corrected_topic" IS NOT NULL OR "corrected_intent" IS NOT NULL OR "corrected_urgency" IS NOT NULL)
      AND char_length(btrim("correction_reason")) BETWEEN 3 AND 500
      AND "handled_by_membership_id" IS NOT NULL
      AND "corrected_at" IS NOT NULL
      AND "organization_id" IS NOT NULL
    )
  ),
  CONSTRAINT "telegram_consultant_messages_tenant_scope_check" CHECK (
    "organization_id" IS NOT NULL
    OR ("webinar_id" IS NULL AND "webinar_session_id" IS NULL AND "registration_id" IS NULL AND "crm_contact_id" IS NULL AND "handled_by_membership_id" IS NULL)
  ),
  CONSTRAINT "telegram_consultant_messages_webinar_scope_check" CHECK (
    ("webinar_id" IS NULL AND "webinar_session_id" IS NULL)
    OR ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL AND "webinar_session_id" IS NOT NULL)
  ),
  CONSTRAINT "telegram_consultant_messages_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_consultant_messages_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_consultant_messages_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_consultant_messages_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_consultant_messages_contact_scope_fkey" FOREIGN KEY ("crm_contact_id", "organization_id") REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_consultant_messages_handler_scope_fkey" FOREIGN KEY ("handled_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_consultant_messages_provider_message_key_key"
  ON "telegram_consultant_messages"("provider_message_key");
CREATE INDEX "telegram_consultant_messages_org_status_created_idx"
  ON "telegram_consultant_messages"("organization_id", "status", "created_at");
CREATE INDEX "telegram_consultant_messages_org_topic_urgency_created_idx"
  ON "telegram_consultant_messages"("organization_id", "topic", "urgency", "created_at");
CREATE INDEX "telegram_consultant_messages_registration_created_idx"
  ON "telegram_consultant_messages"("registration_id", "created_at");
CREATE INDEX "telegram_consultant_messages_contact_created_idx"
  ON "telegram_consultant_messages"("crm_contact_id", "created_at");
CREATE INDEX "telegram_consultant_messages_chat_hash_created_idx"
  ON "telegram_consultant_messages"("chat_id_hash", "created_at");
CREATE INDEX "telegram_consultant_messages_correlation_idx"
  ON "telegram_consultant_messages"("correlation_id");

CREATE OR REPLACE FUNCTION "aspb_enforce_telegram_consultant_scope"()
RETURNS trigger AS $$
DECLARE
  scoped_registration "registrations"%ROWTYPE;
BEGIN
  IF NEW."registration_id" IS NOT NULL THEN
    SELECT * INTO scoped_registration
    FROM "registrations"
    WHERE "id" = NEW."registration_id";

    IF NOT FOUND
      OR scoped_registration."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR scoped_registration."webinar_id" IS DISTINCT FROM NEW."webinar_id"
      OR scoped_registration."webinar_session_id" <> NEW."webinar_session_id"
      OR scoped_registration."crm_contact_id" IS DISTINCT FROM NEW."crm_contact_id"
    THEN
      RAISE EXCEPTION 'Telegram consultant message scope is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_consultant_messages_enforce_scope"
BEFORE INSERT OR UPDATE OF "organization_id", "webinar_id", "webinar_session_id", "registration_id", "crm_contact_id"
ON "telegram_consultant_messages"
FOR EACH ROW EXECUTE FUNCTION "aspb_enforce_telegram_consultant_scope"();

CREATE OR REPLACE FUNCTION "aspb_protect_telegram_consultant_message"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Telegram consultant message cannot be physically deleted';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."webinar_id" IS DISTINCT FROM OLD."webinar_id"
    OR NEW."webinar_session_id" IS DISTINCT FROM OLD."webinar_session_id"
    OR NEW."registration_id" IS DISTINCT FROM OLD."registration_id"
    OR NEW."crm_contact_id" IS DISTINCT FROM OLD."crm_contact_id"
    OR NEW."chat_id_hash" IS DISTINCT FROM OLD."chat_id_hash"
    OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
    OR NEW."provider_message_key" IS DISTINCT FROM OLD."provider_message_key"
    OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
    OR NEW."text" IS DISTINCT FROM OLD."text"
    OR NEW."topic" IS DISTINCT FROM OLD."topic"
    OR NEW."intent" IS DISTINCT FROM OLD."intent"
    OR NEW."urgency" IS DISTINCT FROM OLD."urgency"
    OR NEW."classification_model" IS DISTINCT FROM OLD."classification_model"
    OR NEW."classification_version" IS DISTINCT FROM OLD."classification_version"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'Telegram consultant original message and classification are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_consultant_messages_protect_history"
BEFORE UPDATE OR DELETE ON "telegram_consultant_messages"
FOR EACH ROW EXECUTE FUNCTION "aspb_protect_telegram_consultant_message"();

RESET statement_timeout;
RESET lock_timeout;
