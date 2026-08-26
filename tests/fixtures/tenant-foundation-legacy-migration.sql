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
  "title" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "source" TEXT,
  "telegram_chat_id" TEXT,
  "telegram_subscribed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "registrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "webinar_session_id" TEXT NOT NULL REFERENCES "webinar_sessions"("id") ON DELETE CASCADE,
  "access_token_hash" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL,
  "crm_status" TEXT NOT NULL,
  "is_hot" BOOLEAN NOT NULL DEFAULT false,
  "assigned_manager_id" TEXT REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "next_contact_at" TIMESTAMP(3),
  "email_sent_at" TIMESTAMP(3),
  "reminder_sent_at" TIMESTAMP(3),
  "telegram_live_sent_at" TIMESTAMP(3),
  "telegram_followup_sent_at" TIMESTAMP(3),
  "email_verified_at" TIMESTAMP(3),
  "room_entered_at" TIMESTAMP(3),
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "partner_applications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "webinar_session_id" TEXT REFERENCES "webinar_sessions"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  "event_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "email_outbox_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "webinar_session_id" TEXT REFERENCES "webinar_sessions"("id") ON DELETE SET NULL,
  "reminder_kind" TEXT,
  "status" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "email_outbox_jobs_registration_id_type_reminder_kind_key"
  ON "email_outbox_jobs"("registration_id", "type", "reminder_kind");

-- The production legacy contour already has append-only consent evidence from
-- 20260730150000. This focused fixture keeps only the columns read by the later
-- tenant CRM delivery expand while preserving a non-empty CRM registration.
CREATE TABLE "consent_records" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lead_id" TEXT REFERENCES "leads"("id") ON DELETE SET NULL,
  "registration_id" TEXT REFERENCES "registrations"("id") ON DELETE SET NULL,
  "kind" TEXT NOT NULL,
  "action" TEXT NOT NULL
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

INSERT INTO "webinar_sessions" ("id", "title", "scheduled_at", "created_at") VALUES
  ('legacy-session-1', 'Legacy webinar first session', '2026-08-20T10:00:00.000Z', '2026-08-01T10:00:00.000Z'),
  ('legacy-session-2', 'Legacy webinar second session', '2026-08-21T10:00:00.000Z', '2026-08-02T10:00:00.000Z');

INSERT INTO "webinar_recordings" ("id", "webinar_session_id", "video_url", "published_at")
VALUES ('legacy-recording-1', 'legacy-session-1', 'https://media.example.test/legacy.mp4', '2026-08-20T12:00:00.000Z');

INSERT INTO "leads" (
  "id", "name", "phone", "email", "source", "telegram_chat_id",
  "telegram_subscribed_at", "created_at", "updated_at"
)
VALUES (
  'legacy-lead-1', 'Legacy Participant', '+7 (999) 111-22-33',
  'legacy-participant@example.test', 'legacy_partner_funnel',
  'tg-chat-legacy-1', '2026-08-19T09:00:00.000Z',
  '2026-08-01T09:00:00.000Z', '2026-08-19T10:05:00.000Z'
);

INSERT INTO "registrations" (
  "id", "lead_id", "webinar_session_id", "access_token_hash", "status", "crm_status", "is_hot",
  "assigned_manager_id", "next_contact_at", "email_sent_at", "reminder_sent_at",
  "telegram_live_sent_at", "telegram_followup_sent_at", "email_verified_at", "registered_at", "updated_at"
) VALUES (
  'legacy-registration-1', 'legacy-lead-1', 'legacy-session-1',
  'legacy-access-token-hash-unchanged', 'registered', 'qualified', true,
  'legacy-platform-admin', '2026-08-22T09:30:00.000Z', '2026-08-19T10:00:00.000Z',
  '2026-08-20T08:00:00.000Z', '2026-08-20T09:55:00.000Z', '2026-08-20T12:15:00.000Z',
  '2026-08-19T10:05:00.000Z', '2026-08-19T10:05:00.000Z', '2026-08-22T09:00:00.000Z'
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

INSERT INTO "email_outbox_jobs" (
  "id", "type", "registration_id", "webinar_session_id", "reminder_kind", "status", "sent_at"
)
VALUES (
  'legacy-email-job-1', 'webinar_reminder', 'legacy-registration-1', 'legacy-session-1', '24h',
  'sent', '2026-08-19T10:00:00.000Z'
);

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
  ('partner_applications', (SELECT COUNT(*) FROM "partner_applications")),
  ('webinar_chat_messages', (SELECT COUNT(*) FROM "webinar_chat_messages")),
  ('events', (SELECT COUNT(*) FROM "events")),
  ('email_outbox_jobs', (SELECT COUNT(*) FROM "email_outbox_jobs")),
  ('consent_records', (SELECT COUNT(*) FROM "consent_records")),
  ('telegram_broadcast_jobs', (SELECT COUNT(*) FROM "telegram_broadcast_jobs")),
  ('telegram_broadcast_recipients', (SELECT COUNT(*) FROM "telegram_broadcast_recipients")),
  ('audit_logs', (SELECT COUNT(*) FROM "audit_logs"));

\ir ../../prisma/migrations/20260820120000_tenant_foundation/migration.sql
\ir ../../prisma/checks/20260820120000_tenant_foundation_concurrent_indexes.sql
\ir ../../prisma/migrations/20260820143000_user_passwordless_auth/migration.sql
\ir ../../prisma/migrations/20260820160000_organization_invitations/migration.sql
\ir ../../prisma/migrations/20260820170000_user_owner_mfa/migration.sql
\ir ../../prisma/migrations/20260820180000_author_verification/migration.sql
\ir ../../prisma/migrations/20260820190000_webinar_domain/migration.sql
\ir ../../prisma/migrations/20260820193000_webinar_sessions_recurrence/migration.sql
\ir ../../prisma/migrations/20260820200000_private_webinar_access/migration.sql
\ir ../../prisma/migrations/20260820203000_chat_scenario/migration.sql
\ir ../../prisma/migrations/20260821130000_viewer_account_registration/migration.sql
\ir ../../prisma/checks/20260821140000_crm_contact_pipeline_preflight.sql
\ir ../../prisma/migrations/20260821140000_crm_contact_pipeline/migration.sql
\ir ../../prisma/migrations/20260821141000_crm_stage_integrity_hardening/migration.sql
\ir ../../prisma/checks/20260821140000_crm_contact_pipeline_postflight.sql
\ir ../../prisma/checks/20260821150000_crm_tasks_sla_preflight.sql
\ir ../../prisma/migrations/20260821150000_crm_tasks_sla/migration.sql
\ir ../../prisma/checks/20260821150000_crm_tasks_sla_postflight.sql
\ir ../../prisma/checks/20260821160000_crm_scoring_tags_preflight.sql
\ir ../../prisma/migrations/20260821160000_crm_scoring_tags/migration.sql
\ir ../../prisma/migrations/20260821161000_crm_scoring_legacy_room_backfill/migration.sql
\ir ../../prisma/checks/20260821160000_crm_scoring_tags_postflight.sql
\ir ../../prisma/checks/20260821170000_crm_bulk_export_preflight.sql
\ir ../../prisma/migrations/20260821170000_crm_bulk_export/migration.sql
\ir ../../prisma/migrations/20260821171000_crm_bulk_integrity_hardening/migration.sql
\ir ../../prisma/checks/20260821170000_crm_bulk_export_postflight.sql
\ir ../../prisma/checks/20260821180000_crm_consent_delivery_preflight.sql
\ir ../../prisma/migrations/20260821180000_crm_consent_delivery/migration.sql
\ir ../../prisma/checks/20260821180000_crm_consent_delivery_postflight.sql

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

  IF (SELECT COUNT(*) FROM "webinar_sessions"
      WHERE "organization_id" = 'org_aspb'
        AND "webinar_id" = 'webinar_aspb_legacy'
        AND "timezone" = 'Europe/Moscow'
        AND "lifecycle_status" = 'scheduled'
        AND "schedule_version" = 1
        AND "schedule_id" IS NULL
        AND "cancelled_at" IS NULL
        AND "rescheduled_at" IS NULL) <> 2 THEN
    RAISE EXCEPTION 'legacy webinar sessions were not fully scoped to org_aspb';
  END IF;

  IF (SELECT COUNT(*) FROM "webinar_schedules") <> 0 THEN
    RAISE EXCEPTION 'SES expand migration unexpectedly created recurrence data';
  END IF;

  IF (SELECT COUNT(*) FROM "webinar_access_grants") <> 0
    OR (SELECT COUNT(*) FROM "webinar_access_grant_tokens") <> 0
    OR (SELECT COUNT(*) FROM "webinar_access_invitation_email_jobs") <> 0 THEN
    RAISE EXCEPTION 'WEB-010 expand migration unexpectedly created private access data';
  END IF;

  IF (SELECT COUNT(*) FROM "chat_scenarios") <> 0
    OR (SELECT COUNT(*) FROM "chat_scenario_messages") <> 0 THEN
    RAISE EXCEPTION 'WEB-007 expand migration unexpectedly created scenario data';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "registrations" registration
    JOIN "users" participant_user ON participant_user."id" = registration."user_id"
    WHERE registration."id" = 'legacy-registration-1'
      AND registration."organization_id" = 'org_aspb'
      AND registration."webinar_id" = 'webinar_aspb_legacy'
      AND registration."access_policy" = 'legacy'
      AND participant_user."email_normalized" = 'legacy-participant@example.test'
      AND participant_user."kind" = 'human'
      AND participant_user."status" = 'active'
      AND participant_user."email_verified_at" = '2026-08-19T10:05:00.000Z'
  ) THEN
    RAISE EXCEPTION 'viewer registration backfill did not preserve trusted legacy scope';
  END IF;

  IF (SELECT COUNT(*) FROM "viewer_webinar_favorites") <> 0
    OR (SELECT COUNT(*) FROM "viewer_webinar_progress") <> 0
    OR (SELECT COUNT(*) FROM "viewer_webinar_notes") <> 0
    OR (SELECT COUNT(*) FROM "viewer_notification_preferences") <> 0 THEN
    RAISE EXCEPTION 'viewer expand migration unexpectedly created behavioral data';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "crm_contacts" contact
    JOIN "crm_pipelines" pipeline
      ON pipeline."id" = contact."pipeline_id"
     AND pipeline."organization_id" = contact."organization_id"
    JOIN "crm_stages" stage
      ON stage."id" = contact."stage_id"
     AND stage."pipeline_id" = contact."pipeline_id"
     AND stage."organization_id" = contact."organization_id"
    JOIN "registrations" registration
      ON registration."crm_contact_id" = contact."id"
     AND registration."organization_id" = contact."organization_id"
    WHERE contact."organization_id" = 'org_aspb'
      AND contact."legacy_lead_id" = 'legacy-lead-1'
      AND contact."email_normalized" = 'legacy-participant@example.test'
      AND contact."phone_normalized" = '+79991112233'
      AND contact."legacy_assigned_manager_id" = 'legacy-platform-admin'
      AND contact."next_contact_at" = '2026-08-22T09:30:00.000Z'
      AND pipeline."is_default" = true
      AND stage."code" = 'qualified'
      AND registration."id" = 'legacy-registration-1'
  ) THEN
    RAISE EXCEPTION 'CRM contact backfill did not preserve scope, stage, manager, SLA or registration link';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "crm_pipelines"
    WHERE "organization_id" = 'org_aspb'
      AND "is_default" = true
      AND "timezone" = 'Europe/Moscow'
  ) OR (SELECT COUNT(*) FROM "crm_tasks") <> 0 THEN
    RAISE EXCEPTION 'CRM task expand invented a task or changed the default timezone';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM "crm_scoring_rule_sets" ruleset
    WHERE ruleset."organization_id" = 'org_aspb'
      AND ruleset."version" = 1
      AND ruleset."status" = 'active'
      AND ruleset."hot_threshold" = 60
  ) <> 1 OR (
    SELECT COUNT(*)
    FROM "crm_scoring_rules" rule
    JOIN "crm_scoring_rule_sets" ruleset ON ruleset."id" = rule."rule_set_id"
    WHERE ruleset."organization_id" = 'org_aspb'
      AND ruleset."version" = 1
  ) <> 5 THEN
    RAISE EXCEPTION 'CRM scoring expand did not create one complete versioned baseline model';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "crm_contacts" contact
    JOIN "crm_scoring_rule_sets" ruleset
      ON ruleset."id" = contact."score_rule_set_id"
     AND ruleset."organization_id" = contact."organization_id"
    WHERE contact."organization_id" = 'org_aspb'
      AND contact."legacy_lead_id" = 'legacy-lead-1'
      AND contact."score" = 50
      AND contact."manual_hot" = TRUE
      AND contact."manual_hot_source" = 'legacy_backfill'
      AND contact."manual_hot_reason" = 'Перенесено из legacy CRM'
      AND ruleset."version" = 1
      AND (
        SELECT COUNT(*)
        FROM "crm_score_factors" factor
        WHERE factor."organization_id" = contact."organization_id"
          AND factor."contact_id" = contact."id"
      ) = 3
  ) THEN
    RAISE EXCEPTION 'CRM scoring backfill did not preserve registration, legacy room entry and question facts';
  END IF;

  IF (SELECT COUNT(*) FROM "crm_tags") <> 0
    OR (SELECT COUNT(*) FROM "crm_contact_tags") <> 0 THEN
    RAISE EXCEPTION 'CRM tag expand invented tag data';
  END IF;

  IF (SELECT COUNT(*) FROM "crm_bulk_actions") <> 0
    OR EXISTS (SELECT 1 FROM "crm_tasks" WHERE "bulk_action_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'CRM bulk expand invented preview, result, or task data';
  END IF;

  IF (SELECT COUNT(*) FROM "crm_deliveries") <> 0 THEN
    RAISE EXCEPTION 'CRM delivery expand invented a marketing message';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM "crm_stages" stage
    JOIN "crm_pipelines" pipeline ON pipeline."id" = stage."pipeline_id"
    WHERE pipeline."organization_id" = 'org_aspb'
      AND stage."code" IN (
        'consultation', 'transferred_to_aspb', 'contract_pending',
        'contract_signed', 'payout_due', 'paid'
      )
      AND stage."is_protected" = true
  ) <> 6 THEN
    RAISE EXCEPTION 'ASPB legacy CRM stages were not preserved one-to-one as protected stages';
  END IF;

  IF EXISTS (
    SELECT organization."id"
    FROM "organizations" organization
    LEFT JOIN "crm_pipelines" pipeline
      ON pipeline."organization_id" = organization."id"
     AND pipeline."is_default" = true
     AND pipeline."status" = 'active'
    GROUP BY organization."id"
    HAVING COUNT(pipeline."id") <> 1
  ) OR EXISTS (
    SELECT 1
    FROM "registrations" registration
    LEFT JOIN "crm_contacts" contact
      ON contact."id" = registration."crm_contact_id"
     AND contact."organization_id" = registration."organization_id"
    WHERE registration."organization_id" IS NOT NULL
      AND contact."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "registrations" registration
    JOIN "crm_contacts" contact
      ON contact."id" = registration."crm_contact_id"
     AND contact."organization_id" = registration."organization_id"
    WHERE contact."legacy_lead_id" IS DISTINCT FROM registration."lead_id"
  ) OR EXISTS (
    SELECT 1
    FROM "crm_contacts"
    WHERE "email_normalized" IS NOT NULL
    GROUP BY "organization_id", "email_normalized"
    HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM "crm_contacts" contact
    LEFT JOIN "crm_stages" stage
      ON stage."id" = contact."stage_id"
     AND stage."pipeline_id" = contact."pipeline_id"
     AND stage."organization_id" = contact."organization_id"
    WHERE stage."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "crm_contact_events" event
    LEFT JOIN "crm_contacts" contact
      ON contact."id" = event."contact_id"
     AND contact."organization_id" = event."organization_id"
    WHERE contact."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "crm_stage_transitions" transition
    LEFT JOIN "crm_contacts" contact
      ON contact."id" = transition."contact_id"
     AND contact."organization_id" = transition."organization_id"
    LEFT JOIN "crm_stages" target
      ON target."id" = transition."to_stage_id"
     AND target."pipeline_id" = transition."pipeline_id"
     AND target."organization_id" = transition."organization_id"
    WHERE contact."id" IS NULL OR target."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "crm_stage_transitions" transition
    JOIN "crm_stages" stage
      ON stage."id" = transition."to_stage_id"
     AND stage."pipeline_id" = transition."pipeline_id"
     AND stage."organization_id" = transition."organization_id"
    WHERE stage."semantic_category" = 'lost'
      AND NULLIF(btrim(transition."reason"), '') IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "crm_stages"
    WHERE "is_protected" = true AND "status" <> 'active'
  ) THEN
    RAISE EXCEPTION 'CRM postflight scope, projection, or protected-stage invariants failed';
  END IF;

  IF EXISTS (
    SELECT registration."id"
    FROM "registrations" registration
    LEFT JOIN "crm_stage_transitions" transition
      ON transition."organization_id" = registration."organization_id"
     AND transition."legacy_registration_id" = registration."id"
    LEFT JOIN "crm_stages" stage ON stage."id" = transition."to_stage_id"
    WHERE registration."organization_id" IS NOT NULL
    GROUP BY registration."id", registration."crm_status"
    HAVING COUNT(transition."id") = 0
       OR bool_or(stage."code" <> registration."crm_status")
  ) THEN
    RAISE EXCEPTION 'CRM legacy stage snapshot postflight failed';
  END IF;

  IF EXISTS (
    WITH ranked AS (
      SELECT
        registration.*,
        row_number() OVER (
          PARTITION BY registration."organization_id", registration."lead_id"
          ORDER BY registration."updated_at" DESC,
            registration."registered_at" DESC,
            registration."id" DESC
        ) AS rank
      FROM "registrations" registration
      WHERE registration."organization_id" IS NOT NULL
    )
    SELECT 1
    FROM ranked latest
    JOIN "crm_contacts" contact
      ON contact."organization_id" = latest."organization_id"
     AND contact."legacy_lead_id" = latest."lead_id"
    JOIN "crm_stages" stage ON stage."id" = contact."stage_id"
    WHERE latest.rank = 1
      AND (
        stage."code" <> latest."crm_status"
        OR contact."legacy_assigned_manager_id" IS DISTINCT FROM latest."assigned_manager_id"
        OR contact."next_contact_at" IS DISTINCT FROM latest."next_contact_at"
      )
  ) THEN
    RAISE EXCEPTION 'CRM latest legacy projection postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "crm_stage_transitions" transition
    JOIN "crm_stages" stage ON stage."id" = transition."to_stage_id"
    WHERE transition."legacy_registration_id" = 'legacy-registration-1'
      AND transition."source" = 'legacy_backfill'
      AND transition."occurred_at" = '2026-08-22T09:00:00.000Z'
      AND stage."code" = 'qualified'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "crm_contact_events" event
    WHERE event."registration_id" = 'legacy-registration-1'
      AND event."type" = 'registration'
      AND event."source" = 'legacy_backfill'
      AND event."occurred_at" = '2026-08-19T10:05:00.000Z'
  ) THEN
    RAISE EXCEPTION 'CRM migration did not create auditable legacy transition/event snapshots';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "email_outbox_jobs"
    WHERE "id" = 'legacy-email-job-1'
      AND "session_schedule_version" = 1
      AND "type" = 'webinar_reminder'
      AND "reminder_kind" = '24h'
      AND "sent_at" = '2026-08-19T10:00:00.000Z'
  ) THEN
    RAISE EXCEPTION 'legacy reminder history was not safely versioned';
  END IF;

  IF (SELECT COUNT(*) FROM "webinars"
      WHERE "id" = 'webinar_aspb_legacy'
        AND "organization_id" = 'org_aspb'
        AND "slug" = 'legacy-webinar'
        AND "legacy_compatibility" = true
        AND "content_status" = 'published'
        AND "visibility" = 'unlisted') <> 1 THEN
    RAISE EXCEPTION 'legacy Webinar compatibility container was not created exactly once';
  END IF;

  IF (SELECT COUNT(*) FROM "webinar_sessions" session
      LEFT JOIN "webinars" webinar
        ON webinar."id" = session."webinar_id"
       AND webinar."organization_id" = session."organization_id"
      WHERE webinar."id" IS NULL) <> 0 THEN
    RAISE EXCEPTION 'webinar session scope contains an orphan relationship';
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

  IF (SELECT COUNT(*) FROM "user_auth_tokens") <> 0
    OR (SELECT COUNT(*) FROM "user_sessions") <> 0
    OR (SELECT COUNT(*) FROM "user_auth_email_jobs") <> 0
    OR (SELECT COUNT(*) FROM "organization_invitations") <> 0
    OR (SELECT COUNT(*) FROM "organization_invitation_tokens") <> 0
    OR (SELECT COUNT(*) FROM "organization_invitation_email_jobs") <> 0 THEN
    RAISE EXCEPTION 'TEN-004/TEN-005 expand migrations unexpectedly created identity data';
  END IF;

  IF (SELECT COUNT(*) FROM "author_profiles") <> 0
    OR (SELECT COUNT(*) FROM "author_verifications") <> 0
    OR (SELECT COUNT(*) FROM "author_verification_evidence") <> 0 THEN
    RAISE EXCEPTION 'AUT-001/AUT-002/AUT-005 expand migration unexpectedly created author data';
  END IF;

  IF (SELECT COUNT(*) FROM "legal_practice_areas") <> 0
    OR (SELECT COUNT(*) FROM "jurisdictions") <> 0
    OR (SELECT COUNT(*) FROM "webinar_practice_areas") <> 0
    OR (SELECT COUNT(*) FROM "webinar_sources") <> 0
    OR (SELECT COUNT(*) FROM "webinar_slug_aliases") <> 0
    OR (SELECT COUNT(*) FROM "webinar_commands") <> 0 THEN
    RAISE EXCEPTION 'WEB expand migration unexpectedly created non-compatibility domain data';
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
