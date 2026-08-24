-- BOT-004/BOT-005/BOT-012/BOT-013: platform-owned manager bot identity,
-- owner-confirmed tenant chat bindings and signed, expiring scoped callbacks.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "telegram_manager_chat_binding_status" AS ENUM (
  'pending_chat',
  'pending_owner',
  'active',
  'revoked',
  'expired'
);

CREATE TYPE "telegram_manager_callback_action" AS ENUM (
  'accept_contact',
  'change_stage',
  'mark_hot',
  'create_task'
);

CREATE TYPE "telegram_manager_callback_status" AS ENUM (
  'pending',
  'completed',
  'rejected',
  'expired'
);

CREATE TYPE "telegram_bot_identity" AS ENUM (
  'participant',
  'manager',
  'consultant',
  'operational'
);

CREATE TYPE "telegram_bot_event_direction" AS ENUM (
  'inbound',
  'outbound',
  'internal'
);

CREATE TABLE "telegram_manager_chat_bindings" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "membership_id" TEXT NOT NULL,
  "status" "telegram_manager_chat_binding_status" NOT NULL DEFAULT 'pending_chat',
  "chat_id" TEXT,
  "chat_id_hash" TEXT,
  "requested_by_user_id" TEXT NOT NULL,
  "confirmed_by_user_id" TEXT,
  "revoked_by_user_id" TEXT,
  "claimed_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_manager_chat_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_manager_chat_bindings_chat_hash_check" CHECK (
    "chat_id_hash" IS NULL OR length("chat_id_hash") = 64
  ),
  CONSTRAINT "telegram_manager_chat_bindings_state_check" CHECK (
    ("status" = 'pending_chat' AND "chat_id" IS NULL AND "chat_id_hash" IS NULL AND "claimed_at" IS NULL AND "confirmed_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'pending_owner' AND "chat_id" IS NOT NULL AND "chat_id_hash" IS NOT NULL AND "claimed_at" IS NOT NULL AND "confirmed_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'active' AND "chat_id" IS NOT NULL AND "chat_id_hash" IS NOT NULL AND "claimed_at" IS NOT NULL AND "confirmed_at" IS NOT NULL AND "confirmed_by_user_id" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL)
    OR ("status" = 'expired' AND "chat_id" IS NULL AND "chat_id_hash" IS NULL AND "claimed_at" IS NULL AND "confirmed_at" IS NULL AND "revoked_at" IS NULL)
  ),
  CONSTRAINT "telegram_manager_chat_bindings_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_chat_bindings_membership_scope_fkey" FOREIGN KEY ("membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_chat_bindings_requester_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_chat_bindings_confirmer_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_chat_bindings_revoker_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_manager_chat_bindings_id_organization_id_key"
  ON "telegram_manager_chat_bindings"("id", "organization_id");
CREATE UNIQUE INDEX "telegram_manager_chat_bindings_active_membership_key"
  ON "telegram_manager_chat_bindings"("organization_id", "membership_id")
  WHERE "status" IN ('pending_chat', 'pending_owner', 'active');
CREATE UNIQUE INDEX "telegram_manager_chat_bindings_active_chat_key"
  ON "telegram_manager_chat_bindings"("organization_id", "chat_id_hash")
  WHERE "status" IN ('pending_owner', 'active');
CREATE INDEX "telegram_manager_chat_bindings_org_status_created_idx"
  ON "telegram_manager_chat_bindings"("organization_id", "status", "created_at");
CREATE INDEX "telegram_manager_chat_bindings_org_membership_status_idx"
  ON "telegram_manager_chat_bindings"("organization_id", "membership_id", "status");
CREATE INDEX "telegram_manager_chat_bindings_org_chat_status_idx"
  ON "telegram_manager_chat_bindings"("organization_id", "chat_id_hash", "status");

CREATE TABLE "telegram_manager_chat_binding_tokens" (
  "id" TEXT NOT NULL,
  "binding_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "invalidated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_manager_chat_binding_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_manager_chat_binding_tokens_hash_check" CHECK (length("token_hash") = 64),
  CONSTRAINT "telegram_manager_chat_binding_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "telegram_manager_chat_binding_tokens_terminal_check" CHECK ("consumed_at" IS NULL OR "invalidated_at" IS NULL),
  CONSTRAINT "telegram_manager_chat_binding_tokens_binding_fkey" FOREIGN KEY ("binding_id") REFERENCES "telegram_manager_chat_bindings"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "telegram_manager_chat_binding_tokens_token_hash_key"
  ON "telegram_manager_chat_binding_tokens"("token_hash");
CREATE INDEX "telegram_manager_chat_binding_tokens_binding_expiry_idx"
  ON "telegram_manager_chat_binding_tokens"("binding_id", "expires_at");
CREATE INDEX "telegram_manager_chat_binding_tokens_expiry_terminal_idx"
  ON "telegram_manager_chat_binding_tokens"("expires_at", "consumed_at", "invalidated_at");

CREATE TABLE "telegram_manager_callbacks" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "binding_id" TEXT NOT NULL,
  "membership_id" TEXT NOT NULL,
  "crm_contact_id" TEXT NOT NULL,
  "registration_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "action" "telegram_manager_callback_action" NOT NULL,
  "payload_json" JSONB,
  "status" "telegram_manager_callback_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "provider_callback_id" TEXT,
  "result_code" TEXT,
  "correlation_id" TEXT NOT NULL,
  "created_task_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_manager_callbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_manager_callbacks_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "telegram_manager_callbacks_idempotency_check" CHECK (length(btrim("idempotency_key")) BETWEEN 8 AND 128),
  CONSTRAINT "telegram_manager_callbacks_correlation_check" CHECK (length(btrim("correlation_id")) BETWEEN 8 AND 128),
  CONSTRAINT "telegram_manager_callbacks_result_check" CHECK (
    ("status" = 'pending' AND "consumed_at" IS NULL AND "provider_callback_id" IS NULL AND "result_code" IS NULL)
    OR ("status" IN ('completed', 'rejected', 'expired') AND "consumed_at" IS NOT NULL AND "result_code" IS NOT NULL)
  ),
  CONSTRAINT "telegram_manager_callbacks_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_binding_scope_fkey" FOREIGN KEY ("binding_id", "organization_id") REFERENCES "telegram_manager_chat_bindings"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_membership_scope_fkey" FOREIGN KEY ("membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_contact_scope_fkey" FOREIGN KEY ("crm_contact_id", "organization_id") REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_manager_callbacks_created_task_fkey" FOREIGN KEY ("created_task_id") REFERENCES "crm_tasks"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_manager_callbacks_id_organization_id_key"
  ON "telegram_manager_callbacks"("id", "organization_id");
CREATE UNIQUE INDEX "telegram_manager_callbacks_org_idempotency_key"
  ON "telegram_manager_callbacks"("organization_id", "idempotency_key");
CREATE UNIQUE INDEX "telegram_manager_callbacks_provider_callback_id_key"
  ON "telegram_manager_callbacks"("provider_callback_id");
CREATE UNIQUE INDEX "telegram_manager_callbacks_created_task_id_key"
  ON "telegram_manager_callbacks"("created_task_id");
CREATE INDEX "telegram_manager_callbacks_org_status_expiry_idx"
  ON "telegram_manager_callbacks"("organization_id", "status", "expires_at");
CREATE INDEX "telegram_manager_callbacks_binding_status_created_idx"
  ON "telegram_manager_callbacks"("binding_id", "status", "created_at");
CREATE INDEX "telegram_manager_callbacks_contact_created_idx"
  ON "telegram_manager_callbacks"("crm_contact_id", "created_at");
CREATE INDEX "telegram_manager_callbacks_registration_created_idx"
  ON "telegram_manager_callbacks"("registration_id", "created_at");

CREATE TABLE "telegram_bot_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT,
  "webinar_id" TEXT,
  "webinar_session_id" TEXT,
  "registration_id" TEXT,
  "crm_contact_id" TEXT,
  "membership_id" TEXT,
  "manager_binding_id" TEXT,
  "manager_callback_id" TEXT,
  "bot_identity" "telegram_bot_identity" NOT NULL,
  "direction" "telegram_bot_event_direction" NOT NULL,
  "event_type" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "dedup_key" TEXT,
  "status" TEXT NOT NULL,
  "metadata_json" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_bot_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_bot_events_text_check" CHECK (
    length(btrim("event_type")) BETWEEN 1 AND 80
    AND length(btrim("correlation_id")) BETWEEN 8 AND 128
    AND length(btrim("status")) BETWEEN 1 AND 80
  ),
  CONSTRAINT "telegram_bot_events_tenant_scope_check" CHECK (
    "organization_id" IS NOT NULL
    OR ("webinar_id" IS NULL AND "webinar_session_id" IS NULL AND "registration_id" IS NULL AND "crm_contact_id" IS NULL AND "membership_id" IS NULL AND "manager_binding_id" IS NULL AND "manager_callback_id" IS NULL)
  ),
  CONSTRAINT "telegram_bot_events_webinar_scope_check" CHECK (
    ("webinar_id" IS NULL AND "webinar_session_id" IS NULL)
    OR ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL)
  ),
  CONSTRAINT "telegram_bot_events_sensitive_metadata_check" CHECK (
    "metadata_json" IS NULL
    OR NOT ("metadata_json" ?| ARRAY['token', 'rawToken', 'signedUrl', 'chatId', 'email', 'phone', 'telegramUserId', 'telegramUsername'])
  ),
  CONSTRAINT "telegram_bot_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_contact_scope_fkey" FOREIGN KEY ("crm_contact_id", "organization_id") REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_membership_scope_fkey" FOREIGN KEY ("membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_binding_scope_fkey" FOREIGN KEY ("manager_binding_id", "organization_id") REFERENCES "telegram_manager_chat_bindings"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_bot_events_callback_scope_fkey" FOREIGN KEY ("manager_callback_id", "organization_id") REFERENCES "telegram_manager_callbacks"("id", "organization_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_bot_events_dedup_key_key" ON "telegram_bot_events"("dedup_key");
CREATE INDEX "telegram_bot_events_org_occurred_idx" ON "telegram_bot_events"("organization_id", "occurred_at");
CREATE INDEX "telegram_bot_events_org_webinar_session_occurred_idx" ON "telegram_bot_events"("organization_id", "webinar_id", "webinar_session_id", "occurred_at");
CREATE INDEX "telegram_bot_events_registration_occurred_idx" ON "telegram_bot_events"("registration_id", "occurred_at");
CREATE INDEX "telegram_bot_events_correlation_idx" ON "telegram_bot_events"("correlation_id");
CREATE INDEX "telegram_bot_events_provider_message_idx" ON "telegram_bot_events"("provider_message_id");

CREATE OR REPLACE FUNCTION "aspb_enforce_telegram_manager_callback_scope"()
RETURNS trigger AS $$
DECLARE
  scoped_binding "telegram_manager_chat_bindings"%ROWTYPE;
  scoped_registration "registrations"%ROWTYPE;
  scoped_contact "crm_contacts"%ROWTYPE;
BEGIN
  SELECT * INTO scoped_binding
  FROM "telegram_manager_chat_bindings"
  WHERE "id" = NEW."binding_id";

  SELECT * INTO scoped_registration
  FROM "registrations"
  WHERE "id" = NEW."registration_id";

  SELECT * INTO scoped_contact
  FROM "crm_contacts"
  WHERE "id" = NEW."crm_contact_id";

  IF scoped_binding."id" IS NULL
    OR scoped_registration."id" IS NULL
    OR scoped_contact."id" IS NULL
    OR scoped_binding."organization_id" <> NEW."organization_id"
    OR scoped_binding."membership_id" <> NEW."membership_id"
    OR scoped_contact."organization_id" <> NEW."organization_id"
    OR scoped_registration."organization_id" IS DISTINCT FROM NEW."organization_id"
    OR scoped_registration."webinar_id" IS DISTINCT FROM NEW."webinar_id"
    OR scoped_registration."webinar_session_id" <> NEW."webinar_session_id"
    OR scoped_registration."crm_contact_id" IS DISTINCT FROM NEW."crm_contact_id"
  THEN
    RAISE EXCEPTION 'Telegram manager callback scope is invalid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_manager_callbacks_enforce_scope"
BEFORE INSERT OR UPDATE OF "organization_id", "binding_id", "membership_id", "crm_contact_id", "registration_id", "webinar_id", "webinar_session_id"
ON "telegram_manager_callbacks"
FOR EACH ROW EXECUTE FUNCTION "aspb_enforce_telegram_manager_callback_scope"();

CREATE OR REPLACE FUNCTION "aspb_enforce_telegram_bot_event_scope"()
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
      OR (NEW."webinar_id" IS NOT NULL AND scoped_registration."webinar_id" IS DISTINCT FROM NEW."webinar_id")
      OR (NEW."webinar_session_id" IS NOT NULL AND scoped_registration."webinar_session_id" <> NEW."webinar_session_id")
      OR (NEW."crm_contact_id" IS NOT NULL AND scoped_registration."crm_contact_id" IS DISTINCT FROM NEW."crm_contact_id")
    THEN
      RAISE EXCEPTION 'Telegram bot event registration scope is invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_bot_events_enforce_scope"
BEFORE INSERT ON "telegram_bot_events"
FOR EACH ROW EXECUTE FUNCTION "aspb_enforce_telegram_bot_event_scope"();

CREATE OR REPLACE FUNCTION "aspb_protect_telegram_bot_history"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Telegram bot history cannot be physically deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_manager_chat_bindings_no_delete"
BEFORE DELETE ON "telegram_manager_chat_bindings"
FOR EACH ROW EXECUTE FUNCTION "aspb_protect_telegram_bot_history"();
CREATE TRIGGER "telegram_manager_callbacks_no_delete"
BEFORE DELETE ON "telegram_manager_callbacks"
FOR EACH ROW EXECUTE FUNCTION "aspb_protect_telegram_bot_history"();
CREATE TRIGGER "telegram_bot_events_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "telegram_bot_events"
FOR EACH ROW EXECUTE FUNCTION "aspb_protect_telegram_bot_history"();

RESET statement_timeout;
RESET lock_timeout;
