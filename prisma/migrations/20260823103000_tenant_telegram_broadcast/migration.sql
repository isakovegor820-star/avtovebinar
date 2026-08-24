-- BOT-008/BOT-009/BOT-011/BOT-012: tenant-scoped templates, expiring
-- preview confirmation and exact durable broadcast recipients.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE "telegram_broadcast_templates" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "variables_json" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "created_by_membership_id" TEXT NOT NULL,
  "published_by_membership_id" TEXT,
  "published_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_broadcast_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_broadcast_templates_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "telegram_broadcast_templates_text_check" CHECK (char_length(btrim("text")) BETWEEN 3 AND 2800),
  CONSTRAINT "telegram_broadcast_templates_version_check" CHECK ("version" > 0),
  CONSTRAINT "telegram_broadcast_templates_variables_check" CHECK (jsonb_typeof("variables_json") = 'array'),
  CONSTRAINT "telegram_broadcast_templates_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
  CONSTRAINT "telegram_broadcast_templates_publication_check" CHECK (
    ("status" = 'draft' AND "published_at" IS NULL AND "published_by_membership_id" IS NULL AND "archived_at" IS NULL)
    OR ("status" = 'published' AND "published_at" IS NOT NULL AND "published_by_membership_id" IS NOT NULL AND "archived_at" IS NULL)
    OR ("status" = 'archived' AND "published_at" IS NOT NULL AND "published_by_membership_id" IS NOT NULL AND "archived_at" IS NOT NULL)
  ),
  CONSTRAINT "telegram_broadcast_templates_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_templates_creator_scope_fkey" FOREIGN KEY ("created_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_templates_publisher_scope_fkey" FOREIGN KEY ("published_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_broadcast_templates_id_org_key"
  ON "telegram_broadcast_templates"("id", "organization_id");
CREATE UNIQUE INDEX "telegram_broadcast_templates_id_org_version_key"
  ON "telegram_broadcast_templates"("id", "organization_id", "version");
CREATE UNIQUE INDEX "telegram_broadcast_templates_org_name_version_key"
  ON "telegram_broadcast_templates"("organization_id", "name", "version");
CREATE INDEX "telegram_broadcast_templates_org_status_updated_idx"
  ON "telegram_broadcast_templates"("organization_id", "status", "updated_at");

CREATE OR REPLACE FUNCTION "aspb_validate_telegram_broadcast_template"()
RETURNS trigger AS $$
DECLARE
  template_variable TEXT;
BEGIN
  IF NEW."text" LIKE '%{{%' OR NEW."text" LIKE '%}}%' THEN
    FOR template_variable IN
      SELECT match[1]
      FROM regexp_matches(NEW."text", '\{\{([a-z_]+)\}\}', 'g') AS match
    LOOP
      IF template_variable NOT IN ('participant_name', 'webinar_title', 'session_datetime', 'room_link') THEN
        RAISE EXCEPTION 'Unknown Telegram template variable';
      END IF;
    END LOOP;
    IF regexp_replace(NEW."text", '\{\{(?:participant_name|webinar_title|session_datetime|room_link)\}\}', '', 'g') LIKE '%{{%'
      OR regexp_replace(NEW."text", '\{\{(?:participant_name|webinar_title|session_datetime|room_link)\}\}', '', 'g') LIKE '%}}%'
    THEN
      RAISE EXCEPTION 'Malformed Telegram template variable';
    END IF;
  END IF;
  IF NEW."status" IN ('published', 'archived') AND position('{{room_link}}' IN NEW."text") = 0 THEN
    RAISE EXCEPTION 'Published Telegram template must contain room_link';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('published', 'archived') AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."text" IS DISTINCT FROM OLD."text"
    OR NEW."variables_json" IS DISTINCT FROM OLD."variables_json"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_by_membership_id" IS DISTINCT FROM OLD."created_by_membership_id"
    OR NEW."published_by_membership_id" IS DISTINCT FROM OLD."published_by_membership_id"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  ) THEN
    RAISE EXCEPTION 'Published Telegram template content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_broadcast_templates_validate"
BEFORE INSERT OR UPDATE ON "telegram_broadcast_templates"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_telegram_broadcast_template"();

CREATE TABLE "telegram_broadcast_previews" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "template_version" INTEGER NOT NULL,
  "segment_key" TEXT NOT NULL,
  "total" INTEGER NOT NULL,
  "snapshot_hash" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_by_membership_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_broadcast_previews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_broadcast_previews_segment_check" CHECK ("segment_key" = 'registered_session'),
  CONSTRAINT "telegram_broadcast_previews_total_check" CHECK ("total" >= 0),
  CONSTRAINT "telegram_broadcast_previews_hash_check" CHECK (length("snapshot_hash") = 64 AND length("token_hash") = 64),
  CONSTRAINT "telegram_broadcast_previews_correlation_check" CHECK (char_length(btrim("correlation_id")) BETWEEN 8 AND 128),
  CONSTRAINT "telegram_broadcast_previews_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "telegram_broadcast_previews_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_previews_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_previews_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_previews_template_scope_fkey" FOREIGN KEY ("template_id", "organization_id", "template_version") REFERENCES "telegram_broadcast_templates"("id", "organization_id", "version") ON DELETE RESTRICT,
  CONSTRAINT "telegram_broadcast_previews_creator_scope_fkey" FOREIGN KEY ("created_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "telegram_broadcast_previews_id_org_key"
  ON "telegram_broadcast_previews"("id", "organization_id");
CREATE UNIQUE INDEX "telegram_broadcast_previews_token_hash_key"
  ON "telegram_broadcast_previews"("token_hash");
CREATE INDEX "telegram_broadcast_previews_org_expiry_idx"
  ON "telegram_broadcast_previews"("organization_id", "expires_at", "consumed_at");
CREATE INDEX "telegram_broadcast_previews_org_session_created_idx"
  ON "telegram_broadcast_previews"("organization_id", "webinar_id", "webinar_session_id", "created_at");

ALTER TABLE "telegram_broadcast_jobs"
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "webinar_session_id" TEXT,
  ADD COLUMN "requester_membership_id" TEXT,
  ADD COLUMN "template_id" TEXT,
  ADD COLUMN "template_version" INTEGER,
  ADD COLUMN "segment_key" TEXT,
  ADD COLUMN "preview_id" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "pause_requested_at" TIMESTAMP(3),
  ADD COLUMN "pause_requested_by_membership_id" TEXT,
  ADD COLUMN "paused_at" TIMESTAMP(3),
  ADD COLUMN "paused_by_membership_id" TEXT,
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_by_membership_id" TEXT,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by_membership_id" TEXT,
  ADD COLUMN "cancel_reason" TEXT;

ALTER TABLE "telegram_broadcast_jobs"
  ADD CONSTRAINT "telegram_broadcast_jobs_tenant_scope_check" CHECK (
    ("organization_id" IS NULL AND "webinar_id" IS NULL AND "webinar_session_id" IS NULL
      AND "requester_membership_id" IS NULL AND "template_id" IS NULL AND "template_version" IS NULL
      AND "segment_key" IS NULL AND "preview_id" IS NULL AND "correlation_id" IS NULL)
    OR
    ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL AND "webinar_session_id" IS NOT NULL
      AND "requester_membership_id" IS NOT NULL AND "template_id" IS NOT NULL AND "template_version" IS NOT NULL
      AND "segment_key" = 'registered_session' AND "preview_id" IS NOT NULL AND "correlation_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "telegram_broadcast_jobs_pause_check" CHECK (
    ("pause_requested_at" IS NULL AND "pause_requested_by_membership_id" IS NULL
      AND "paused_at" IS NULL AND "paused_by_membership_id" IS NULL)
    OR ("organization_id" IS NOT NULL AND "pause_requested_at" IS NOT NULL
      AND "pause_requested_by_membership_id" IS NOT NULL AND "paused_at" IS NULL AND "paused_by_membership_id" IS NULL)
    OR ("organization_id" IS NOT NULL AND "pause_requested_at" IS NOT NULL
      AND "pause_requested_by_membership_id" IS NOT NULL AND "paused_at" IS NOT NULL AND "paused_by_membership_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "telegram_broadcast_jobs_cancel_check" CHECK (
    ("cancel_requested_at" IS NULL AND "cancel_requested_by_membership_id" IS NULL
      AND "cancelled_at" IS NULL AND "cancelled_by_membership_id" IS NULL AND "cancel_reason" IS NULL)
    OR ("organization_id" IS NOT NULL AND "cancel_requested_at" IS NOT NULL
      AND "cancel_requested_by_membership_id" IS NOT NULL AND "cancelled_at" IS NULL
      AND "cancelled_by_membership_id" IS NULL AND char_length(btrim("cancel_reason")) BETWEEN 3 AND 500)
    OR ("organization_id" IS NOT NULL AND "cancel_requested_at" IS NOT NULL
      AND "cancel_requested_by_membership_id" IS NOT NULL AND "cancelled_at" IS NOT NULL
      AND "cancelled_by_membership_id" IS NOT NULL AND char_length(btrim("cancel_reason")) BETWEEN 3 AND 500)
  ),
  ADD CONSTRAINT "telegram_broadcast_jobs_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_requester_scope_fkey" FOREIGN KEY ("requester_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_template_scope_fkey" FOREIGN KEY ("template_id", "organization_id", "template_version") REFERENCES "telegram_broadcast_templates"("id", "organization_id", "version") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_preview_scope_fkey" FOREIGN KEY ("preview_id", "organization_id") REFERENCES "telegram_broadcast_previews"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_paused_by_scope_fkey" FOREIGN KEY ("paused_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_pause_requester_scope_fkey" FOREIGN KEY ("pause_requested_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_jobs_cancelled_by_scope_fkey" FOREIGN KEY ("cancelled_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT;
ALTER TABLE "telegram_broadcast_jobs"
  ADD CONSTRAINT "telegram_broadcast_jobs_cancel_requester_scope_fkey" FOREIGN KEY ("cancel_requested_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "telegram_broadcast_jobs_preview_id_key" ON "telegram_broadcast_jobs"("preview_id");
CREATE INDEX "telegram_broadcast_jobs_org_status_created_idx" ON "telegram_broadcast_jobs"("organization_id", "status", "created_at");
CREATE INDEX "telegram_broadcast_jobs_org_session_created_idx" ON "telegram_broadcast_jobs"("organization_id", "webinar_id", "webinar_session_id", "created_at");
CREATE INDEX "telegram_broadcast_jobs_requester_created_idx" ON "telegram_broadcast_jobs"("requester_membership_id", "created_at");

ALTER TABLE "telegram_broadcast_recipients"
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "webinar_session_id" TEXT,
  ADD COLUMN "registration_id" TEXT,
  ADD COLUMN "crm_contact_id" TEXT,
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

ALTER TABLE "telegram_broadcast_recipients"
  ADD CONSTRAINT "telegram_broadcast_recipients_tenant_scope_check" CHECK (
    ("organization_id" IS NULL AND "webinar_id" IS NULL AND "webinar_session_id" IS NULL
      AND "registration_id" IS NULL AND "crm_contact_id" IS NULL AND "correlation_id" IS NULL)
    OR
    ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL AND "webinar_session_id" IS NOT NULL
      AND "registration_id" IS NOT NULL AND "correlation_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "telegram_broadcast_recipients_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_recipients_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_recipients_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_recipients_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "telegram_broadcast_recipients_contact_scope_fkey" FOREIGN KEY ("crm_contact_id", "organization_id") REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "telegram_broadcast_recipients_job_registration_key"
  ON "telegram_broadcast_recipients"("job_id", "registration_id") WHERE "registration_id" IS NOT NULL;
CREATE INDEX "telegram_broadcast_recipients_org_session_status_idx"
  ON "telegram_broadcast_recipients"("organization_id", "webinar_id", "webinar_session_id", "status");
CREATE INDEX "telegram_broadcast_recipients_registration_created_idx"
  ON "telegram_broadcast_recipients"("registration_id", "created_at");
CREATE INDEX "telegram_broadcast_recipients_correlation_idx"
  ON "telegram_broadcast_recipients"("correlation_id");

CREATE OR REPLACE FUNCTION "aspb_enforce_tenant_telegram_broadcast_recipient"()
RETURNS trigger AS $$
DECLARE
  scoped_job "telegram_broadcast_jobs"%ROWTYPE;
  scoped_registration "registrations"%ROWTYPE;
BEGIN
  SELECT * INTO scoped_job FROM "telegram_broadcast_jobs" WHERE "id" = NEW."job_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Telegram broadcast job is missing';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM scoped_job."organization_id" THEN
    RAISE EXCEPTION 'Telegram broadcast recipient organization is invalid';
  END IF;
  IF NEW."organization_id" IS NOT NULL THEN
    IF NEW."webinar_id" IS DISTINCT FROM scoped_job."webinar_id"
      OR NEW."webinar_session_id" IS DISTINCT FROM scoped_job."webinar_session_id"
    THEN
      RAISE EXCEPTION 'Telegram broadcast recipient session scope is invalid';
    END IF;
    SELECT * INTO scoped_registration FROM "registrations" WHERE "id" = NEW."registration_id";
    IF NOT FOUND
      OR scoped_registration."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR scoped_registration."webinar_id" IS DISTINCT FROM NEW."webinar_id"
      OR scoped_registration."webinar_session_id" <> NEW."webinar_session_id"
      OR scoped_registration."lead_id" <> NEW."lead_id"
      OR scoped_registration."crm_contact_id" IS DISTINCT FROM NEW."crm_contact_id"
    THEN
      RAISE EXCEPTION 'Telegram broadcast recipient registration scope is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_broadcast_recipients_enforce_scope"
BEFORE INSERT OR UPDATE OF "job_id", "lead_id", "organization_id", "webinar_id", "webinar_session_id", "registration_id", "crm_contact_id"
ON "telegram_broadcast_recipients"
FOR EACH ROW EXECUTE FUNCTION "aspb_enforce_tenant_telegram_broadcast_recipient"();

RESET statement_timeout;
RESET lock_timeout;
