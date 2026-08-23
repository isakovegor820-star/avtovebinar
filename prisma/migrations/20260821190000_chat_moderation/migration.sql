-- CHT-001..CHT-007: exact message types, approved scenario messages and
-- tenant-scoped reversible chat moderation. Legacy columns remain available
-- for expand/rollback compatibility.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TYPE "chat_scenario_message_kind" ADD VALUE IF NOT EXISTS 'ai_moderator';
ALTER TYPE "chat_scenario_message_kind" ADD VALUE IF NOT EXISTS 'system';

CREATE TYPE "chat_scenario_message_status" AS ENUM ('draft', 'approved', 'rejected');
CREATE TYPE "webinar_chat_message_type" AS ENUM (
  'participant',
  'moderator',
  'prepared_question',
  'ai_moderator',
  'system'
);

ALTER TABLE "chat_scenario_messages"
  ADD COLUMN "status" "chat_scenario_message_status" NOT NULL DEFAULT 'draft';

-- Published legacy scenario versions were human-approved as a whole.
UPDATE "chat_scenario_messages" message
SET "status" = 'approved'
FROM "chat_scenarios" scenario
WHERE scenario."id" = message."scenario_id"
  AND scenario."status" = 'published';

-- Keeps an old application image rollback-compatible: its publish command
-- does not know the per-message status yet, so draft rows are approved when
-- the whole scenario crosses the existing human publication boundary.
CREATE OR REPLACE FUNCTION "aspb_approve_legacy_scenario_messages"()
RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'published' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    UPDATE "chat_scenario_messages"
    SET "status" = 'approved'
    WHERE "scenario_id" = NEW."id" AND "status" = 'draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_scenarios_legacy_message_approval"
AFTER UPDATE OF "status" ON "chat_scenarios"
FOR EACH ROW EXECUTE FUNCTION "aspb_approve_legacy_scenario_messages"();

ALTER TABLE "registrations"
  ADD COLUMN "chat_banned_reason" TEXT,
  ADD COLUMN "chat_banned_by_membership_id" TEXT;

ALTER TABLE "webinar_chat_messages"
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "message_type" "webinar_chat_message_type",
  ADD COLUMN "hidden_at" TIMESTAMP(3),
  ADD COLUMN "hidden_reason" TEXT,
  ADD COLUMN "hidden_by_membership_id" TEXT,
  ADD COLUMN "moderation_revision" INTEGER NOT NULL DEFAULT 0;

UPDATE "webinar_chat_messages" message
SET
  "organization_id" = session."organization_id",
  "webinar_id" = session."webinar_id",
  "message_type" = CASE message."kind"
    WHEN 'user' THEN 'participant'::"webinar_chat_message_type"
    WHEN 'participant' THEN 'participant'::"webinar_chat_message_type"
    WHEN 'moderator' THEN 'moderator'::"webinar_chat_message_type"
    WHEN 'prepared_question' THEN 'prepared_question'::"webinar_chat_message_type"
    WHEN 'agent_question' THEN 'prepared_question'::"webinar_chat_message_type"
    WHEN 'scripted_user' THEN 'prepared_question'::"webinar_chat_message_type"
    WHEN 'ai_manager' THEN 'ai_moderator'::"webinar_chat_message_type"
    WHEN 'ai_moderator' THEN 'ai_moderator'::"webinar_chat_message_type"
    ELSE 'system'::"webinar_chat_message_type"
  END
FROM "webinar_sessions" session
WHERE session."id" = message."webinar_session_id";

ALTER TABLE "webinar_chat_messages"
  ALTER COLUMN "organization_id" SET NOT NULL,
  ALTER COLUMN "webinar_id" SET NOT NULL,
  ALTER COLUMN "message_type" SET NOT NULL;

ALTER TABLE "webinar_chat_messages"
  ADD CONSTRAINT "webinar_chat_messages_moderation_revision_check"
    CHECK ("moderation_revision" >= 0),
  ADD CONSTRAINT "webinar_chat_messages_hidden_state_check" CHECK (
    ("hidden_at" IS NULL AND "hidden_reason" IS NULL AND "hidden_by_membership_id" IS NULL)
    OR
    ("hidden_at" IS NOT NULL
      AND char_length(btrim("hidden_reason")) BETWEEN 3 AND 500
      AND "hidden_by_membership_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "webinar_chat_messages_synthetic_type_check" CHECK (
    ("is_synthetic" = true AND "message_type" IN ('prepared_question', 'ai_moderator'))
    OR
    ("is_synthetic" = false AND "message_type" IN ('participant', 'moderator', 'system'))
  );

ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_chat_ban_state_check" CHECK (
    ("chat_banned_at" IS NULL
      AND "chat_banned_reason" IS NULL
      AND "chat_banned_by_membership_id" IS NULL)
    OR
    ("chat_banned_at" IS NOT NULL
      AND (
        ("chat_banned_by_membership_id" IS NULL AND "chat_banned_reason" IS NULL)
        OR
        ("chat_banned_by_membership_id" IS NOT NULL
          AND char_length(btrim("chat_banned_reason")) BETWEEN 3 AND 500)
      ))
  );

-- The trigger derives authoritative scope from WebinarSession and maps old
-- string kinds. Old images can therefore keep writing during expand/rollback.
CREATE OR REPLACE FUNCTION "aspb_guard_webinar_chat_message"()
RETURNS trigger AS $$
DECLARE
  scoped_organization_id TEXT;
  scoped_webinar_id TEXT;
BEGIN
  SELECT session."organization_id", session."webinar_id"
  INTO scoped_organization_id, scoped_webinar_id
  FROM "webinar_sessions" session
  WHERE session."id" = NEW."webinar_session_id";

  IF scoped_organization_id IS NULL OR scoped_webinar_id IS NULL THEN
    RAISE EXCEPTION 'Chat message session is unavailable';
  END IF;
  IF NEW."organization_id" IS NOT NULL AND NEW."organization_id" <> scoped_organization_id THEN
    RAISE EXCEPTION 'Chat message organization scope mismatch';
  END IF;
  IF NEW."webinar_id" IS NOT NULL AND NEW."webinar_id" <> scoped_webinar_id THEN
    RAISE EXCEPTION 'Chat message webinar scope mismatch';
  END IF;

  NEW."organization_id" := scoped_organization_id;
  NEW."webinar_id" := scoped_webinar_id;

  IF NEW."message_type" IS NULL OR (
    TG_OP = 'UPDATE'
    AND NEW."kind" IS DISTINCT FROM OLD."kind"
    AND NEW."message_type" IS NOT DISTINCT FROM OLD."message_type"
  ) THEN
    NEW."message_type" := CASE NEW."kind"
      WHEN 'user' THEN 'participant'::"webinar_chat_message_type"
      WHEN 'participant' THEN 'participant'::"webinar_chat_message_type"
      WHEN 'moderator' THEN 'moderator'::"webinar_chat_message_type"
      WHEN 'prepared_question' THEN 'prepared_question'::"webinar_chat_message_type"
      WHEN 'agent_question' THEN 'prepared_question'::"webinar_chat_message_type"
      WHEN 'scripted_user' THEN 'prepared_question'::"webinar_chat_message_type"
      WHEN 'ai_manager' THEN 'ai_moderator'::"webinar_chat_message_type"
      WHEN 'ai_moderator' THEN 'ai_moderator'::"webinar_chat_message_type"
      ELSE 'system'::"webinar_chat_message_type"
    END;
  END IF;

  IF NEW."registration_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "registrations" registration
    WHERE registration."id" = NEW."registration_id"
      AND registration."webinar_session_id" = NEW."webinar_session_id"
  ) THEN
    RAISE EXCEPTION 'Chat message registration scope mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "webinar_chat_messages_scope_guard"
BEFORE INSERT OR UPDATE OF "webinar_session_id", "organization_id", "webinar_id", "kind", "message_type", "registration_id"
ON "webinar_chat_messages"
FOR EACH ROW EXECUTE FUNCTION "aspb_guard_webinar_chat_message"();

CREATE INDEX "webinar_chat_messages_organization_id_webinar_id_webinar_session_id_hidden_at_visible_at_idx"
  ON "webinar_chat_messages"("organization_id", "webinar_id", "webinar_session_id", "hidden_at", "visible_at");
CREATE INDEX "webinar_chat_messages_message_type_idx"
  ON "webinar_chat_messages"("message_type");
CREATE INDEX "webinar_chat_messages_hidden_by_membership_id_idx"
  ON "webinar_chat_messages"("hidden_by_membership_id");

ALTER TABLE "webinar_chat_messages"
  ADD CONSTRAINT "webinar_chat_messages_session_scope_fkey"
  FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id")
  REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "webinar_chat_messages_webinar_scope_fkey"
  FOREIGN KEY ("webinar_id", "organization_id")
  REFERENCES "webinars"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "webinar_chat_messages_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "webinar_chat_messages_hidden_by_membership_scope_fkey"
  FOREIGN KEY ("hidden_by_membership_id", "organization_id")
  REFERENCES "organization_memberships"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_chat_banned_by_membership_scope_fkey"
  FOREIGN KEY ("chat_banned_by_membership_id", "organization_id")
  REFERENCES "organization_memberships"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

RESET statement_timeout;
RESET lock_timeout;
