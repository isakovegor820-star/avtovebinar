-- Read-only verification after 20260820120000_tenant_foundation.
-- Compare all legacy counts with the saved preflight result before enabling any flag.
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

SELECT
  COUNT(*) AS webinar_sessions_total,
  COUNT(*) FILTER (WHERE "organization_id" = 'org_aspb') AS webinar_sessions_scoped_to_aspb,
  COUNT(*) FILTER (WHERE "organization_id" IS NULL) AS webinar_sessions_without_scope
FROM "webinar_sessions";

SELECT
  (SELECT COUNT(*) FROM "organizations" WHERE "id" = 'org_aspb') AS aspb_organizations,
  (SELECT COUNT(*) FROM "users"
   WHERE "id" = 'user_aspb_system_owner'
     AND "kind" = 'system'
     AND "status" = 'active') AS bootstrap_system_users,
  (SELECT COUNT(*) FROM "organization_memberships"
   WHERE "id" = 'membership_aspb_system_owner'
     AND "organization_id" = 'org_aspb'
     AND "user_id" = 'user_aspb_system_owner'
     AND "role" = 'owner'
     AND "status" = 'active') AS bootstrap_memberships;

SELECT
  (SELECT COUNT(*) FROM "users" tenant_user
   JOIN "admin_users" admin_user ON admin_user."id" = tenant_user."id") AS admin_ids_copied_to_users,
  (SELECT COUNT(*) FROM "organization_memberships" membership
   JOIN "admin_users" admin_user ON admin_user."id" = membership."user_id") AS admins_given_tenant_membership;

SELECT constraint_name, validated
FROM (
  SELECT conname AS constraint_name, convalidated AS validated
  FROM pg_constraint
  WHERE conname IN (
    'webinar_sessions_organization_id_fkey',
    'audit_logs_user_id_fkey',
    'audit_logs_organization_id_fkey'
  )
) constraints
ORDER BY constraint_name;

SELECT indexrelid::regclass::text AS index_name, indisvalid, indisready
FROM pg_index
WHERE indexrelid::regclass::text LIKE '%organization_id%'
   OR indexrelid::regclass::text LIKE '%audit_logs_user_id_idx%'
   OR indexrelid::regclass::text LIKE '%audit_logs_correlation_id_idx%'
ORDER BY index_name;

SELECT
  COUNT(*) FILTER (WHERE "access_token_hash" IS NULL OR "access_token_hash" = '') AS invalid_registration_tokens,
  COUNT(DISTINCT "access_token_hash") AS distinct_registration_tokens
FROM "registrations";

SELECT
  COUNT(*) FILTER (WHERE "token_hash" IS NULL OR "token_hash" = '') AS invalid_session_tokens,
  COUNT(DISTINCT "token_hash") AS distinct_session_tokens
FROM "registration_tokens";
