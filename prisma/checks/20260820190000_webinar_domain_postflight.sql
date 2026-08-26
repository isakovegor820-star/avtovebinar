\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "webinar_sessions" session
    LEFT JOIN "webinars" webinar
      ON webinar."id" = session."webinar_id"
     AND webinar."organization_id" = session."organization_id"
    WHERE webinar."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'webinar_sessions contains a cross-tenant or missing Webinar reference';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "webinars"
    WHERE "id" = 'webinar_aspb_legacy'
      AND "organization_id" = 'org_aspb'
      AND "legacy_compatibility" = true
  ) THEN
    RAISE EXCEPTION 'ASPB compatibility Webinar is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "webinar_sessions"
    WHERE "webinar_id" IS NULL OR "timezone" IS NULL OR "lifecycle_status" IS NULL
  ) THEN
    RAISE EXCEPTION 'required WebinarSession domain columns contain NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    WHERE index_class.relname = 'webinar_sessions_webinar_id_scheduled_at_key'
      AND index_class.relnamespace = to_regnamespace(current_schema())
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indisunique
  ) THEN
    RAISE EXCEPTION 'composite WebinarSession uniqueness index is missing or invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'webinar_sessions_scheduled_at_key'
      AND relnamespace = to_regnamespace(current_schema())
      AND relkind = 'i'
  ) THEN
    RAISE EXCEPTION 'legacy global scheduled_at uniqueness index still exists';
  END IF;
END $$;

SELECT 'webinar_sessions' AS table_name, COUNT(*) AS row_count FROM "webinar_sessions"
UNION ALL SELECT 'webinar_recordings', COUNT(*) FROM "webinar_recordings"
UNION ALL SELECT 'registrations', COUNT(*) FROM "registrations"
UNION ALL SELECT 'questions', COUNT(*) FROM "questions"
UNION ALL SELECT 'webinar_chat_messages', COUNT(*) FROM "webinar_chat_messages"
UNION ALL SELECT 'events', COUNT(*) FROM "events"
UNION ALL SELECT 'email_outbox_jobs', COUNT(*) FROM "email_outbox_jobs"
UNION ALL SELECT 'telegram_broadcast_jobs', COUNT(*) FROM "telegram_broadcast_jobs"
UNION ALL SELECT 'telegram_broadcast_recipients', COUNT(*) FROM "telegram_broadcast_recipients"
ORDER BY table_name;

SELECT "organization_id", "webinar_id", COUNT(*) AS session_count
FROM "webinar_sessions"
GROUP BY "organization_id", "webinar_id"
ORDER BY "organization_id", "webinar_id";
