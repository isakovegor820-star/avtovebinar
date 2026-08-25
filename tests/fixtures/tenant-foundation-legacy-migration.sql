\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS "tenant_migration_test" CASCADE;
CREATE SCHEMA "tenant_migration_test";
SET search_path TO "tenant_migration_test";

-- Linked, non-empty legacy surface. The fixture intentionally models every
-- pre-foundation contour whose history must survive the expand migration.
CREATE TABLE "admin_users" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE
);

CREATE TABLE "webinar_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scheduled_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "webinar_sessions_scheduled_at_key" ON "webinar_sessions"("scheduled_at");

CREATE TABLE "webinar_recordings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "webinar_session_id" TEXT NOT NULL REFERENCES "webinar_sessions"("id") ON DELETE CASCADE,
  "video_url" TEXT,
  "published_at" TIMESTAMP(3)
);

CREATE TABLE "leads" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "telegram_chat_id" TEXT,
  "telegram_subscribed_at" TIMESTAMP(3)
);

CREATE TABLE "registrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "webinar_session_id" TEXT NOT NULL REFERENCES "webinar_sessions"("id") ON DELETE CASCADE,
  "access_token_hash" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL,
  "crm_status" TEXT NOT NULL,
  "assigned_manager_id" TEXT REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "next_contact_at" TIMESTAMP(3),
  "email_sent_at" TIMESTAMP(3),
  "reminder_sent_at" TIMESTAMP(3),
  "telegram_live_sent_at" TIMESTAMP(3),
  "telegram_followup_sent_at" TIMESTAMP(3)
);

CREATE TABLE "registration_tokens" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "registration_id" TEXT NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "purpose" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3)
);

CREATE TABLE "questions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "registration_id" TEXT NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
  "webinar_session_id" TEXT NOT NULL REFERENCES "webinar_sessions"("id") ON DELETE CASCADE,
  "text" TEXT NOT NULL
);

CREATE TABLE "webinar_chat_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "webinar_session_id" TEXT NOT NULL REFERENCES "webinar_sessions"("id") ON DELETE CASCADE,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "question_id" TEXT UNIQUE REFERENCES "questions"("id") ON DELETE SET NULL,
  "message" TEXT NOT NULL
);

CREATE TABLE "events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT REFERENCES "leads"("id") ON DELETE SET NULL,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "webinar_session_id" TEXT REFERENCES "webinar_sessions"("id") ON DELETE SET NULL,
  "event_name" TEXT NOT NULL
);

CREATE TABLE "email_outbox_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "webinar_session_id" TEXT REFERENCES "webinar_sessions"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3)
);

CREATE TABLE "telegram_broadcast_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "initiated_by_id" TEXT REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL,
  "recipient_snapshot" JSONB,
  "completed_at" TIMESTAMP(3)
);

CREATE TABLE "telegram_broadcast_recipients" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "job_id" TEXT NOT NULL REFERENCES "telegram_broadcast_jobs"("id") ON DELETE CASCADE,
  "lead_id" TEXT REFERENCES "leads"("id") ON DELETE SET NULL,
  "chat_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3)
);

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "admin_user_id" TEXT REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "admin_users" ("id", "email")
VALUES ('legacy-platform-admin', 'operator@example.test');

INSERT INTO "webinar_sessions" ("id", "scheduled_at") VALUES
  ('legacy-session-1', '2026-08-20T10:00:00.000Z'),
  ('legacy-session-2', '2026-08-21T10:00:00.000Z');

INSERT INTO "webinar_recordings" ("id", "webinar_session_id", "video_url", "published_at")
VALUES ('legacy-recording-1', 'legacy-session-1', 'https://media.example.test/legacy.mp4', '2026-08-20T12:00:00.000Z');

INSERT INTO "leads" ("id", "email", "telegram_chat_id", "telegram_subscribed_at")
VALUES ('legacy-lead-1', 'legacy-participant@example.test', 'tg-chat-legacy-1', '2026-08-19T09:00:00.000Z');

INSERT INTO "registrations" (
  "id", "lead_id", "webinar_session_id", "access_token_hash", "status", "crm_status",
  "assigned_manager_id", "next_contact_at", "email_sent_at", "reminder_sent_at",
  "telegram_live_sent_at", "telegram_followup_sent_at"
) VALUES (
  'legacy-registration-1', 'legacy-lead-1', 'legacy-session-1',
  'legacy-access-token-hash-unchanged', 'registered', 'qualified',
  'legacy-platform-admin', '2026-08-22T09:30:00.000Z', '2026-08-19T10:00:00.000Z',
  '2026-08-20T08:00:00.000Z', '2026-08-20T09:55:00.000Z', '2026-08-20T12:15:00.000Z'
);

INSERT INTO "registration_tokens" ("id", "registration_id", "token_hash", "purpose", "expires_at")
VALUES (
  'legacy-session-token-1', 'legacy-registration-1', 'legacy-room-token-hash-unchanged',
  'room_session', '2026-08-27T10:00:00.000Z'
);

INSERT INTO "questions" ("id", "lead_id", "registration_id", "webinar_session_id", "text")
VALUES ('legacy-question-1', 'legacy-lead-1', 'legacy-registration-1', 'legacy-session-1', 'Legacy question');

INSERT INTO "webinar_chat_messages" (
  "id", "webinar_session_id", "registration_id", "question_id", "message"
) VALUES (
  'legacy-chat-1', 'legacy-session-1', 'legacy-registration-1', 'legacy-question-1', 'Legacy chat message'
);

INSERT INTO "events" ("id", "lead_id", "registration_id", "webinar_session_id", "event_name")
VALUES ('legacy-event-1', 'legacy-lead-1', 'legacy-registration-1', 'legacy-session-1', 'room_entered');

INSERT INTO "email_outbox_jobs" ("id", "registration_id", "webinar_session_id", "status", "sent_at")
VALUES ('legacy-email-job-1', 'legacy-registration-1', 'legacy-session-1', 'sent', '2026-08-19T10:00:00.000Z');

INSERT INTO "telegram_broadcast_jobs" (
  "id", "initiated_by_id", "status", "recipient_snapshot", "completed_at"
) VALUES (
  'legacy-telegram-job-1', 'legacy-platform-admin', 'completed',
  '[{"leadId":"legacy-lead-1","chatId":"tg-chat-legacy-1"}]'::jsonb,
  '2026-08-20T12:16:00.000Z'
);

INSERT INTO "telegram_broadcast_recipients" (
  "id", "job_id", "lead_id", "chat_id", "status", "sent_at"
) VALUES (
  'legacy-telegram-recipient-1', 'legacy-telegram-job-1', 'legacy-lead-1',
  'tg-chat-legacy-1', 'sent', '2026-08-20T12:15:30.000Z'
);

INSERT INTO "audit_logs" ("id", "admin_user_id", "action")
VALUES ('legacy-audit-1', 'legacy-platform-admin', 'legacy.crm.updated');

CREATE TEMP TABLE "legacy_row_counts" (
  "table_name" TEXT PRIMARY KEY,
  "row_count" BIGINT NOT NULL
);

INSERT INTO "legacy_row_counts" ("table_name", "row_count") VALUES
  ('admin_users', (SELECT COUNT(*) FROM "admin_users")),
  ('webinar_sessions', (SELECT COUNT(*) FROM "webinar_sessions")),
  ('webinar_recordings', (SELECT COUNT(*) FROM "webinar_recordings")),
  ('leads', (SELECT COUNT(*) FROM "leads")),
  ('registrations', (SELECT COUNT(*) FROM "registrations")),
  ('registration_tokens', (SELECT COUNT(*) FROM "registration_tokens")),
  ('questions', (SELECT COUNT(*) FROM "questions")),
  ('webinar_chat_messages', (SELECT COUNT(*) FROM "webinar_chat_messages")),
  ('events', (SELECT COUNT(*) FROM "events")),
  ('email_outbox_jobs', (SELECT COUNT(*) FROM "email_outbox_jobs")),
  ('telegram_broadcast_jobs', (SELECT COUNT(*) FROM "telegram_broadcast_jobs")),
  ('telegram_broadcast_recipients', (SELECT COUNT(*) FROM "telegram_broadcast_recipients")),
  ('audit_logs', (SELECT COUNT(*) FROM "audit_logs"));

\ir ../../prisma/migrations/20260820120000_tenant_foundation/migration.sql
\ir ../../prisma/checks/20260820120000_tenant_foundation_concurrent_indexes.sql

DO $$
DECLARE
  snapshot RECORD;
  actual_count BIGINT;
BEGIN
  FOR snapshot IN SELECT * FROM "legacy_row_counts" LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I', snapshot.table_name) INTO actual_count;
    IF actual_count <> snapshot.row_count THEN
      RAISE EXCEPTION 'legacy row count changed for %: before %, after %',
        snapshot.table_name, snapshot.row_count, actual_count;
    END IF;
  END LOOP;

  IF (SELECT COUNT(*) FROM "webinar_sessions" WHERE "organization_id" = 'org_aspb') <> 2 THEN
    RAISE EXCEPTION 'legacy webinar sessions were not fully scoped to org_aspb';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "webinar_recordings" recording
    JOIN "webinar_sessions" session ON session."id" = recording."webinar_session_id"
    WHERE recording."id" = 'legacy-recording-1' AND session."organization_id" = 'org_aspb'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "registrations" registration
    JOIN "leads" lead ON lead."id" = registration."lead_id"
    JOIN "webinar_sessions" session ON session."id" = registration."webinar_session_id"
    JOIN "admin_users" manager ON manager."id" = registration."assigned_manager_id"
    WHERE registration."id" = 'legacy-registration-1'
      AND lead."id" = 'legacy-lead-1'
      AND session."id" = 'legacy-session-1'
      AND manager."id" = 'legacy-platform-admin'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "questions" question
    JOIN "registrations" registration ON registration."id" = question."registration_id"
    JOIN "webinar_sessions" session ON session."id" = question."webinar_session_id"
    WHERE question."id" = 'legacy-question-1'
      AND registration."id" = 'legacy-registration-1'
      AND session."id" = 'legacy-session-1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "webinar_chat_messages" message
    JOIN "questions" question ON question."id" = message."question_id"
    JOIN "registrations" registration ON registration."id" = message."registration_id"
    WHERE message."id" = 'legacy-chat-1'
      AND question."id" = 'legacy-question-1'
      AND registration."id" = 'legacy-registration-1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "events" event
    JOIN "registrations" registration ON registration."id" = event."registration_id"
    JOIN "webinar_sessions" session ON session."id" = event."webinar_session_id"
    WHERE event."id" = 'legacy-event-1'
      AND registration."id" = 'legacy-registration-1'
      AND session."id" = 'legacy-session-1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "email_outbox_jobs" job
    JOIN "registrations" registration ON registration."id" = job."registration_id"
    JOIN "webinar_sessions" session ON session."id" = job."webinar_session_id"
    WHERE job."id" = 'legacy-email-job-1'
      AND registration."id" = 'legacy-registration-1'
      AND session."id" = 'legacy-session-1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "telegram_broadcast_recipients" recipient
    JOIN "telegram_broadcast_jobs" job ON job."id" = recipient."job_id"
    JOIN "leads" lead ON lead."id" = recipient."lead_id"
    WHERE recipient."id" = 'legacy-telegram-recipient-1'
      AND job."id" = 'legacy-telegram-job-1'
      AND lead."id" = 'legacy-lead-1'
  ) THEN
    RAISE EXCEPTION 'one or more legacy entity relationships changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "registrations"
    WHERE "id" = 'legacy-registration-1'
      AND "access_token_hash" = 'legacy-access-token-hash-unchanged'
      AND "crm_status" = 'qualified'
      AND "assigned_manager_id" = 'legacy-platform-admin'
      AND "next_contact_at" = '2026-08-22T09:30:00.000Z'
      AND "email_sent_at" = '2026-08-19T10:00:00.000Z'
      AND "reminder_sent_at" = '2026-08-20T08:00:00.000Z'
      AND "telegram_live_sent_at" = '2026-08-20T09:55:00.000Z'
      AND "telegram_followup_sent_at" = '2026-08-20T12:15:00.000Z'
  ) OR NOT EXISTS (
    SELECT 1 FROM "registration_tokens"
    WHERE "id" = 'legacy-session-token-1'
      AND "registration_id" = 'legacy-registration-1'
      AND "token_hash" = 'legacy-room-token-hash-unchanged'
      AND "purpose" = 'room_session'
      AND "expires_at" = '2026-08-27T10:00:00.000Z'
  ) OR NOT EXISTS (
    SELECT 1 FROM "telegram_broadcast_jobs"
    WHERE "id" = 'legacy-telegram-job-1'
      AND "status" = 'completed'
      AND "completed_at" = '2026-08-20T12:16:00.000Z'
      AND "recipient_snapshot" = '[{"leadId":"legacy-lead-1","chatId":"tg-chat-legacy-1"}]'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM "telegram_broadcast_recipients"
    WHERE "id" = 'legacy-telegram-recipient-1'
      AND "status" = 'sent'
      AND "sent_at" = '2026-08-20T12:15:30.000Z'
  ) THEN
    RAISE EXCEPTION 'legacy token, CRM, or delivery state changed';
  END IF;

  IF (SELECT COUNT(*) FROM "organizations" WHERE "id" = 'org_aspb') <> 1
    OR (SELECT COUNT(*) FROM "users" WHERE "id" = 'user_aspb_system_owner' AND "kind" = 'system') <> 1
    OR (SELECT COUNT(*) FROM "organization_memberships"
        WHERE "id" = 'membership_aspb_system_owner'
          AND "organization_id" = 'org_aspb'
          AND "user_id" = 'user_aspb_system_owner'
          AND "role" = 'owner'
          AND "status" = 'active') <> 1 THEN
    RAISE EXCEPTION 'ASPB compatibility bootstrap was not created exactly once';
  END IF;

  IF EXISTS (SELECT 1 FROM "users" WHERE "email_normalized" = 'operator@example.test')
    OR EXISTS (SELECT 1 FROM "organization_memberships" WHERE "user_id" = 'legacy-platform-admin') THEN
    RAISE EXCEPTION 'legacy platform admin was incorrectly promoted to a tenant user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "audit_logs"
    WHERE "id" = 'legacy-audit-1'
      AND "admin_user_id" = 'legacy-platform-admin'
      AND "action" = 'legacy.crm.updated'
  ) THEN
    RAISE EXCEPTION 'legacy audit history was changed';
  END IF;
END $$;

SET search_path TO public;
DROP SCHEMA "tenant_migration_test" CASCADE;
