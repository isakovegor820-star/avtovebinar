\set ON_ERROR_STOP on

-- Read-only snapshot before WEB-010. The migration only adds empty tables and
-- must not rewrite existing Webinar, participant, email or audit history.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name, current_schema() AS schema_name, CURRENT_TIMESTAMP AS captured_at;

SELECT 'webinars' AS table_name, COUNT(*) AS row_count FROM "webinars"
UNION ALL SELECT 'webinar_sessions', COUNT(*) FROM "webinar_sessions"
UNION ALL SELECT 'registrations', COUNT(*) FROM "registrations"
UNION ALL SELECT 'registration_tokens', COUNT(*) FROM "registration_tokens"
UNION ALL SELECT 'email_outbox_jobs', COUNT(*) FROM "email_outbox_jobs"
UNION ALL SELECT 'users', COUNT(*) FROM "users"
UNION ALL SELECT 'organization_memberships', COUNT(*) FROM "organization_memberships"
UNION ALL SELECT 'audit_logs', COUNT(*) FROM "audit_logs"
ORDER BY table_name;

SELECT "visibility", COUNT(*) AS webinar_count
FROM "webinars"
GROUP BY "visibility"
ORDER BY "visibility";

ROLLBACK;
