\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "webinar_sessions"
    WHERE "schedule_version" IS NULL OR "schedule_version" < 1
  ) THEN
    RAISE EXCEPTION 'webinar session schedule version backfill is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "webinar_sessions" session
    LEFT JOIN "webinar_schedules" schedule
      ON schedule."id" = session."schedule_id"
     AND schedule."organization_id" = session."organization_id"
    WHERE session."schedule_id" IS NOT NULL AND schedule."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'webinar session contains a cross-tenant or missing schedule reference';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "webinar_schedules" schedule
    LEFT JOIN "webinars" webinar
      ON webinar."id" = schedule."webinar_id"
     AND webinar."organization_id" = schedule."organization_id"
    WHERE webinar."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'webinar schedule contains a cross-tenant or missing webinar reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "webinar_sessions"
    WHERE ("lifecycle_status" = 'cancelled' AND ("cancelled_at" IS NULL OR "cancellation_reason" IS NULL))
       OR ("lifecycle_status" <> 'cancelled' AND "cancelled_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'webinar cancellation state is inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "email_outbox_jobs"
    WHERE "type" = 'webinar_reminder' AND "session_schedule_version" IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy reminder jobs were not assigned a session schedule version';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    WHERE index_class.relname = 'email_outbox_jobs_registration_id_type_reminder_kind_session_schedule_version_key'
      AND index_class.relnamespace = to_regnamespace(current_schema())
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indisunique
  ) THEN
    RAISE EXCEPTION 'schedule-versioned reminder uniqueness index is missing or invalid';
  END IF;
END $$;

SELECT 'webinar_sessions' AS table_name, COUNT(*) AS row_count FROM "webinar_sessions"
UNION ALL SELECT 'webinar_schedules', COUNT(*) FROM "webinar_schedules"
UNION ALL SELECT 'registrations', COUNT(*) FROM "registrations"
UNION ALL SELECT 'registration_tokens', COUNT(*) FROM "registration_tokens"
UNION ALL SELECT 'email_outbox_jobs', COUNT(*) FROM "email_outbox_jobs"
UNION ALL SELECT 'events', COUNT(*) FROM "events"
UNION ALL SELECT 'questions', COUNT(*) FROM "questions"
ORDER BY table_name;

SELECT MIN("scheduled_at") AS earliest_session, MAX("scheduled_at") AS latest_session
FROM "webinar_sessions";
