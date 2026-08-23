-- CHT-008..CHT-010: grounded moderator suggestions, legal-safety routing,
-- durable question queues and participant/CRM status history.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "question_moderation_status" AS ENUM (
  'new',
  'in_review',
  'action_required',
  'resolved',
  'rejected'
);

CREATE TYPE "question_priority" AS ENUM ('normal', 'high');

ALTER TABLE "questions"
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "text_fingerprint" TEXT,
  ADD COLUMN "moderation_status" "question_moderation_status" NOT NULL DEFAULT 'new',
  ADD COLUMN "priority" "question_priority" NOT NULL DEFAULT 'normal',
  ADD COLUMN "moderation_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "handled_by_membership_id" TEXT;

UPDATE "questions" AS question
SET
  "organization_id" = session."organization_id",
  "webinar_id" = session."webinar_id",
  "text_fingerprint" = md5(lower(regexp_replace(btrim(question."text"), '\s+', ' ', 'g'))),
  "moderation_status" = CASE WHEN question."is_answered" THEN 'resolved'::"question_moderation_status" ELSE 'new'::"question_moderation_status" END
FROM "webinar_sessions" AS session
WHERE session."id" = question."webinar_session_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "questions"
    WHERE "organization_id" IS NULL OR "webinar_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Question tenant scope backfill failed';
  END IF;
END;
$$;

ALTER TABLE "questions"
  ALTER COLUMN "organization_id" SET NOT NULL,
  ALTER COLUMN "webinar_id" SET NOT NULL,
  ADD CONSTRAINT "questions_moderation_revision_check" CHECK ("moderation_revision" >= 0),
  ADD CONSTRAINT "questions_answer_status_check" CHECK ("is_answered" = ("moderation_status" = 'resolved')),
  ADD CONSTRAINT "questions_text_fingerprint_check" CHECK ("text_fingerprint" IS NULL OR length("text_fingerprint") = 32),
  ADD CONSTRAINT "questions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "questions_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "questions_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "questions_handler_scope_fkey" FOREIGN KEY ("handled_by_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "questions_id_organization_id_key" ON "questions"("id", "organization_id");
CREATE INDEX "questions_org_webinar_session_status_created_idx" ON "questions"("organization_id", "webinar_id", "webinar_session_id", "moderation_status", "created_at");
CREATE INDEX "questions_org_session_priority_status_created_idx" ON "questions"("organization_id", "webinar_session_id", "priority", "moderation_status", "created_at");
CREATE INDEX "questions_org_session_fingerprint_idx" ON "questions"("organization_id", "webinar_session_id", "text_fingerprint");

CREATE OR REPLACE FUNCTION "aspb_enforce_question_scope"()
RETURNS trigger AS $$
DECLARE
  scoped_session "webinar_sessions"%ROWTYPE;
  scoped_registration "registrations"%ROWTYPE;
BEGIN
  SELECT * INTO scoped_session
  FROM "webinar_sessions"
  WHERE "id" = NEW."webinar_session_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question session scope is invalid';
  END IF;

  SELECT * INTO scoped_registration
  FROM "registrations"
  WHERE "id" = NEW."registration_id";

  IF NOT FOUND
    OR scoped_registration."webinar_session_id" <> scoped_session."id"
    OR scoped_registration."lead_id" <> NEW."lead_id"
    OR scoped_registration."organization_id" IS DISTINCT FROM scoped_session."organization_id"
    OR scoped_registration."webinar_id" IS DISTINCT FROM scoped_session."webinar_id"
  THEN
    RAISE EXCEPTION 'Question registration scope is invalid';
  END IF;

  NEW."organization_id" := scoped_session."organization_id";
  NEW."webinar_id" := scoped_session."webinar_id";
  NEW."text_fingerprint" := md5(lower(regexp_replace(btrim(NEW."text"), '\s+', ' ', 'g')));

  IF TG_OP = 'UPDATE' AND NEW."moderation_status" IS NOT DISTINCT FROM OLD."moderation_status"
    AND NEW."is_answered" IS DISTINCT FROM OLD."is_answered"
  THEN
    NEW."moderation_status" := CASE WHEN NEW."is_answered" THEN 'resolved'::"question_moderation_status" ELSE 'new'::"question_moderation_status" END;
  ELSE
    NEW."is_answered" := NEW."moderation_status" = 'resolved';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "questions_enforce_scope"
BEFORE INSERT OR UPDATE OF "webinar_session_id", "registration_id", "lead_id", "organization_id", "webinar_id", "text", "moderation_status", "is_answered"
ON "questions"
FOR EACH ROW EXECUTE FUNCTION "aspb_enforce_question_scope"();

CREATE TABLE "question_moderation_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "registration_id" TEXT NOT NULL,
  "question_id" TEXT NOT NULL,
  "actor_membership_id" TEXT,
  "from_status" "question_moderation_status",
  "to_status" "question_moderation_status" NOT NULL,
  "from_priority" "question_priority",
  "to_priority" "question_priority" NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "correlation_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "question_moderation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "question_moderation_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "question_moderation_events_source_check" CHECK (length(btrim("source")) BETWEEN 1 AND 80),
  CONSTRAINT "question_moderation_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "question_moderation_events_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "question_moderation_events_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "question_moderation_events_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  CONSTRAINT "question_moderation_events_question_scope_fkey" FOREIGN KEY ("question_id", "organization_id") REFERENCES "questions"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "question_moderation_events_actor_scope_fkey" FOREIGN KEY ("actor_membership_id", "organization_id") REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT
);

CREATE INDEX "question_moderation_events_org_session_status_idx" ON "question_moderation_events"("organization_id", "webinar_session_id", "to_status", "created_at");
CREATE INDEX "question_moderation_events_question_created_idx" ON "question_moderation_events"("question_id", "created_at");
CREATE INDEX "question_moderation_events_registration_created_idx" ON "question_moderation_events"("registration_id", "created_at");

ALTER TABLE "ai_suggestions"
  ALTER COLUMN "transcript_id" DROP NOT NULL,
  ADD COLUMN "webinar_session_id" TEXT,
  ADD COLUMN "registration_id" TEXT,
  ADD COLUMN "question_id" TEXT,
  ADD COLUMN "question_revision" INTEGER,
  ADD COLUMN "published_chat_message_id" TEXT,
  ADD CONSTRAINT "ai_suggestions_transcript_scope_check" CHECK ("type" = 'chat_moderator_reply' OR "transcript_id" IS NOT NULL),
  ADD CONSTRAINT "ai_suggestions_chat_reply_scope_check" CHECK (
    "type" <> 'chat_moderator_reply'
    OR ("webinar_session_id" IS NOT NULL AND "registration_id" IS NOT NULL AND "question_id" IS NOT NULL AND "question_revision" IS NOT NULL AND "question_revision" >= 0)
  ),
  ADD CONSTRAINT "ai_suggestions_session_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_suggestions_registration_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_suggestions_question_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ai_suggestions_published_message_fkey" FOREIGN KEY ("published_chat_message_id") REFERENCES "webinar_chat_messages"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "ai_suggestions_question_revision_type_key" ON "ai_suggestions"("question_id", "question_revision", "type");
CREATE UNIQUE INDEX "ai_suggestions_published_chat_message_id_key" ON "ai_suggestions"("published_chat_message_id");
CREATE INDEX "ai_suggestions_org_session_question_status_idx" ON "ai_suggestions"("organization_id", "webinar_session_id", "question_id", "status");

RESET statement_timeout;
RESET lock_timeout;
