\set ON_ERROR_STOP on

-- Read-only snapshot before the additive SES migration. Persist alongside the
-- backup record and compare these legacy counts/timestamps with postflight.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_schema() AS schema_name, CURRENT_TIMESTAMP AS captured_at;

SELECT 'webinar_sessions' AS table_name, COUNT(*) AS row_count FROM "webinar_sessions"
UNION ALL SELECT 'registrations', COUNT(*) FROM "registrations"
UNION ALL SELECT 'registration_tokens', COUNT(*) FROM "registration_tokens"
UNION ALL SELECT 'email_outbox_jobs', COUNT(*) FROM "email_outbox_jobs"
UNION ALL SELECT 'events', COUNT(*) FROM "events"
UNION ALL SELECT 'questions', COUNT(*) FROM "questions"
ORDER BY table_name;

SELECT MIN("scheduled_at") AS earliest_session, MAX("scheduled_at") AS latest_session
FROM "webinar_sessions";

SELECT COUNT(*) AS existing_reminder_jobs
FROM "email_outbox_jobs"
WHERE "type" = 'webinar_reminder';

ROLLBACK;
