SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "events"
  ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scope_kind" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "user_id" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "dedup_key" TEXT,
  ADD COLUMN "payload_hash" TEXT,
  ADD COLUMN "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "client_occurred_at" TIMESTAMP(3);

-- Legacy rows keep schema_version=0 and their original semantics. Their
-- authoritative event time is backfilled from the pre-existing server time.
UPDATE "events"
SET "occurred_at" = "created_at"
WHERE "schema_version" = 0;

ALTER TABLE "events"
  ADD CONSTRAINT "events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "events_webinar_scope_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "events_schema_version_check"
    CHECK ("schema_version" IN (0, 1)),
  ADD CONSTRAINT "events_scope_kind_check"
    CHECK ("scope_kind" IN ('legacy', 'platform', 'tenant')),
  ADD CONSTRAINT "events_v1_core_contract_check"
    CHECK (
      "schema_version" = 0
      OR (
        "scope_kind" IN ('platform', 'tenant')
        AND "source" IN ('web', 'room', 'replay', 'registration', 'crm', 'email', 'telegram', 'worker', 'system', 'admin')
        AND "correlation_id" ~ '^[A-Za-z0-9._:-]{8,128}$'
        AND "dedup_key" ~ '^[A-Za-z0-9._:-]{16,128}$'
        AND "payload_hash" ~ '^[0-9a-f]{64}$'
        AND char_length("event_name") BETWEEN 1 AND 120
        AND ("page" IS NULL OR (char_length("page") <= 160 AND "page" !~ '[?#]'))
        AND ("metadata_json" IS NULL OR octet_length("metadata_json"::text) <= 4096)
        AND (
          ("scope_kind" = 'platform'
            AND "organization_id" IS NULL
            AND "webinar_id" IS NULL
            AND "webinar_session_id" IS NULL
            AND "registration_id" IS NULL
            AND "lead_id" IS NULL
            AND "user_id" IS NULL)
          OR
          ("scope_kind" = 'tenant' AND "organization_id" IS NOT NULL)
        )
        AND ("webinar_id" IS NULL OR "organization_id" IS NOT NULL)
        AND ("webinar_session_id" IS NULL OR ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL))
        AND ("registration_id" IS NULL OR "webinar_session_id" IS NOT NULL)
        AND ("lead_id" IS NULL OR "registration_id" IS NOT NULL)
      )
    );

CREATE FUNCTION analytics_metadata_is_safe(value JSONB, depth INTEGER DEFAULT 0)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry RECORD;
  normalized_key TEXT;
BEGIN
  IF value IS NULL THEN
    RETURN TRUE;
  END IF;
  IF depth > 3 THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(value) = 'object' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(value)) > 20 THEN
      RETURN FALSE;
    END IF;
    FOR entry IN SELECT key, val FROM jsonb_each(value) AS item(key, val) LOOP
      normalized_key := regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g');
      IF normalized_key ~ '(email|phone|telephone|chatid|bottoken|accesstoken|refreshtoken|authorization|cookie|signedurl|storagekey|providersecret|password|requestbody|ipaddress)'
         OR normalized_key IN ('token', 'secret', 'ip', 'proto', 'prototype', 'constructor', 'clientsproblem', 'questiontext', 'message', 'text')
         OR NOT analytics_metadata_is_safe(entry.val, depth + 1) THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(value) = 'array' THEN
    IF jsonb_array_length(value) > 20 THEN
      RETURN FALSE;
    END IF;
    FOR entry IN SELECT val FROM jsonb_array_elements(value) AS item(val) LOOP
      IF NOT analytics_metadata_is_safe(entry.val, depth + 1) THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(value) = 'string' THEN
    IF char_length(value #>> '{}') > 500
       OR (value #>> '{}') ~* '(Bearer[[:space:]]+[A-Za-z0-9._~+/-]+|x-amz-signature=|x-goog-signature=|[?&](token|signature|key)=|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$)' THEN
      RETURN FALSE;
    END IF;
  END IF;
  RETURN TRUE;
END;
$$;

ALTER TABLE "events"
  ADD CONSTRAINT "events_v1_metadata_safe_check"
    CHECK (
      "schema_version" = 0 OR (
        ("metadata_json" IS NULL OR jsonb_typeof("metadata_json"::jsonb) = 'object')
        AND analytics_metadata_is_safe("metadata_json"::jsonb)
      )
    ),
  ADD CONSTRAINT "events_v1_known_event_type_check"
    CHECK (
      "schema_version" = 0 OR "event_name" IN (
        'page_view',
        'registration_click', 'registration_form_open', 'registration_submit', 'registration_success',
        'telegram_click', 'telegram_subscribe',
        'webinar_room_open', 'webinar_room_waiting', 'viewer_heartbeat',
        'video_start', 'video_progress_25', 'video_progress_50', 'video_progress_75', 'video_finish',
        'recordings_open', 'recording_open', 'recording_play',
        'recording_progress_25', 'recording_progress_50', 'recording_progress_75', 'recording_finish',
        'recording_cta_click',
        'question_submit', 'question_submit_attempt', 'question_submitted', 'question_submit_error',
        'partner_application_submit', 'partner_application_submitted', 'partner_application_error',
        'partner_form_opened', 'partner_request_click', 'participant_login_request',
        'admin_manual_telegram_reminder', 'telegram_broadcast', 'telegram_news_broadcast',
        'telegram_broadcast_completed', 'telegram_repeat_start', 'telegram_start_without_registration',
        'telegram_participant_command', 'telegram_consultant_start',
        'telegram_consultant_contact_request', 'telegram_consultant_message'
      )
    );

CREATE FUNCTION analytics_validate_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Prisma DateTime uses TIMESTAMP(3) WITHOUT TIME ZONE in this project. Store
  -- the UTC wall-clock explicitly so a database session timezone cannot shift
  -- the authoritative instant when Prisma reads it back.
  server_now TIMESTAMP(3) := timezone('UTC', clock_timestamp());
  session_scope RECORD;
  registration_scope RECORD;
BEGIN
  IF NEW."schema_version" = 0 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."occurred_at" := server_now;
    NEW."created_at" := server_now;
  ELSIF NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" THEN
    RAISE EXCEPTION 'analytics occurred_at is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."scope_kind" = 'tenant' THEN
    PERFORM 1 FROM "organizations" WHERE "id" = NEW."organization_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analytics tenant scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."webinar_id" IS NOT NULL THEN
    PERFORM 1 FROM "webinars"
    WHERE "id" = NEW."webinar_id" AND "organization_id" = NEW."organization_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analytics Webinar scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."webinar_session_id" IS NOT NULL THEN
    SELECT "organization_id", "webinar_id"
    INTO session_scope
    FROM "webinar_sessions"
    WHERE "id" = NEW."webinar_session_id";
    IF NOT FOUND
       OR session_scope."organization_id" IS DISTINCT FROM NEW."organization_id"
       OR session_scope."webinar_id" IS DISTINCT FROM NEW."webinar_id" THEN
      RAISE EXCEPTION 'analytics WebinarSession scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."registration_id" IS NOT NULL THEN
    SELECT "lead_id", "user_id", "webinar_session_id"
    INTO registration_scope
    FROM "registrations"
    WHERE "id" = NEW."registration_id";
    IF NOT FOUND
       OR registration_scope."webinar_session_id" IS DISTINCT FROM NEW."webinar_session_id"
       OR registration_scope."lead_id" IS DISTINCT FROM NEW."lead_id"
       OR registration_scope."user_id" IS DISTINCT FROM NEW."user_id" THEN
      RAISE EXCEPTION 'analytics registration scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."user_id" IS NOT NULL AND NEW."registration_id" IS NULL THEN
    PERFORM 1
    FROM "users" user_row
    JOIN "organization_memberships" membership
      ON membership."user_id" = user_row."id"
     AND membership."organization_id" = NEW."organization_id"
     AND membership."status" = 'active'
    WHERE user_row."id" = NEW."user_id" AND user_row."status" = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analytics User tenant scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "events_validate_v1_scope"
BEFORE INSERT OR UPDATE ON "events"
FOR EACH ROW EXECUTE FUNCTION analytics_validate_event_scope();

-- Atomic idempotency scope: one client key per server-derived tenant, or one
-- key in the explicit platform scope. Event type and payload are compared by
-- the application after a unique conflict; a key cannot be reused for a
-- different event or payload in the same scope.
CREATE UNIQUE INDEX "events_tenant_dedup_key_key"
  ON "events" ("organization_id", "dedup_key")
  WHERE "schema_version" = 1 AND "scope_kind" = 'tenant' AND "dedup_key" IS NOT NULL;
CREATE UNIQUE INDEX "events_platform_dedup_key_key"
  ON "events" ("dedup_key")
  WHERE "schema_version" = 1 AND "scope_kind" = 'platform' AND "dedup_key" IS NOT NULL;

CREATE INDEX "events_organization_occurred_idx" ON "events" ("organization_id", "occurred_at");
CREATE INDEX "events_organization_event_occurred_idx" ON "events" ("organization_id", "event_name", "occurred_at");
CREATE INDEX "events_organization_session_occurred_idx" ON "events" ("organization_id", "webinar_session_id", "occurred_at");
CREATE INDEX "events_session_event_occurred_idx" ON "events" ("webinar_session_id", "event_name", "occurred_at");
CREATE INDEX "events_event_occurred_idx" ON "events" ("event_name", "occurred_at");
CREATE INDEX "events_occurred_at_idx" ON "events" ("occurred_at");
CREATE INDEX "events_correlation_id_idx" ON "events" ("correlation_id");
CREATE INDEX "events_dedup_key_idx" ON "events" ("dedup_key");
