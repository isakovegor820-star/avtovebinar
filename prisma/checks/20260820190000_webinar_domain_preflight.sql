\set ON_ERROR_STOP on

-- Read-only preflight. Save this output next to the verified backup and compare
-- legacy counts with postflight before enabling any creator feature flag.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_schema() AS schema_name, CURRENT_TIMESTAMP AS captured_at;

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

SELECT "organization_id", COUNT(*) AS session_count
FROM "webinar_sessions"
GROUP BY "organization_id"
ORDER BY "organization_id";

SELECT pg_size_pretty(pg_total_relation_size('webinar_sessions')) AS webinar_sessions_total_size;

SELECT COUNT(*) AS duplicate_scheduled_at_groups
FROM (
  SELECT "scheduled_at"
  FROM "webinar_sessions"
  GROUP BY "scheduled_at"
  HAVING COUNT(*) > 1
) duplicates;

ROLLBACK;
