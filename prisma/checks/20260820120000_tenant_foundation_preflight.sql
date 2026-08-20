-- Read-only snapshot to run before 20260820120000_tenant_foundation on a legacy database.
-- Save the result with the deployment evidence; this script does not modify data.
SHOW server_version;

SELECT "migration_name", "started_at", "finished_at", "rolled_back_at", "logs"
FROM "_prisma_migrations"
WHERE "migration_name" = '20260820120000_tenant_foundation';

SELECT
  (SELECT COUNT(*) FROM "webinar_sessions") AS webinar_sessions,
  (SELECT COUNT(*) FROM "webinar_recordings") AS webinar_recordings,
  (SELECT COUNT(*) FROM "registrations") AS registrations,
  (SELECT COUNT(*) FROM "registration_tokens") AS registration_tokens,
  (SELECT COUNT(*) FROM "leads") AS leads,
  (SELECT COUNT(*) FROM "questions") AS questions,
  (SELECT COUNT(*) FROM "webinar_chat_messages") AS chat_messages,
  (SELECT COUNT(*) FROM "events") AS events,
  (SELECT COUNT(*) FROM "email_outbox_jobs") AS email_jobs,
  (SELECT COUNT(*) FROM "telegram_broadcast_jobs") AS telegram_broadcast_jobs,
  (SELECT COUNT(*) FROM "telegram_broadcast_recipients") AS telegram_broadcast_recipients,
  (SELECT COUNT(*) FROM "admin_users") AS admin_users,
  (SELECT COUNT(*) FROM "audit_logs") AS audit_logs;

SELECT COUNT(*) AS registrations_without_session
FROM "registrations" registration
LEFT JOIN "webinar_sessions" session ON session."id" = registration."webinar_session_id"
WHERE session."id" IS NULL;

SELECT COUNT(*) AS questions_with_mismatched_session
FROM "questions" question
JOIN "registrations" registration ON registration."id" = question."registration_id"
WHERE question."webinar_session_id" <> registration."webinar_session_id";

SELECT
  (SELECT COUNT(*)
   FROM "webinar_recordings" recording
   LEFT JOIN "webinar_sessions" session ON session."id" = recording."webinar_session_id"
   WHERE session."id" IS NULL) AS recordings_without_session,
  (SELECT COUNT(*)
   FROM "webinar_chat_messages" message
   LEFT JOIN "webinar_sessions" session ON session."id" = message."webinar_session_id"
   WHERE session."id" IS NULL) AS chat_messages_without_session,
  (SELECT COUNT(*)
   FROM "email_outbox_jobs" job
   LEFT JOIN "webinar_sessions" session ON session."id" = job."webinar_session_id"
   WHERE job."webinar_session_id" IS NOT NULL AND session."id" IS NULL) AS email_jobs_without_session,
  (SELECT COUNT(*)
   FROM "telegram_broadcast_recipients" recipient
   LEFT JOIN "telegram_broadcast_jobs" job ON job."id" = recipient."job_id"
   WHERE job."id" IS NULL) AS telegram_recipients_without_job;

SELECT
  COUNT(*) FILTER (WHERE "access_token_hash" IS NULL OR "access_token_hash" = '') AS invalid_registration_tokens,
  COUNT(DISTINCT "access_token_hash") AS distinct_registration_tokens
FROM "registrations";

SELECT
  COUNT(*) FILTER (WHERE "token_hash" IS NULL OR "token_hash" = '') AS invalid_session_tokens,
  COUNT(DISTINCT "token_hash") AS distinct_session_tokens
FROM "registration_tokens";
