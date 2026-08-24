\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "webinar_access_grants" grant_row
    LEFT JOIN "webinars" webinar
      ON webinar."id" = grant_row."webinar_id"
     AND webinar."organization_id" = grant_row."organization_id"
    WHERE webinar."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'webinar access grant contains a cross-tenant or missing webinar reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "webinar_access_grants"
    WHERE "email_hash" !~ '^[0-9a-f]{64}$'
       OR "expires_at" <= "created_at"
       OR (("accepted_at" IS NULL) <> ("user_id" IS NULL))
  ) THEN
    RAISE EXCEPTION 'webinar access grant invariants are invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "webinar_access_grant_tokens"
    WHERE "token_hash" !~ '^[0-9a-f]{64}$'
       OR "expires_at" <= "created_at"
       OR ("consumed_at" IS NOT NULL AND "invalidated_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'webinar access invitation token invariants are invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "webinar_access_invitation_email_jobs"
    WHERE ("claimed_at" IS NULL) <> ("claim_token" IS NULL)
       OR "attempts" < 0
  ) THEN
    RAISE EXCEPTION 'webinar access email outbox invariants are invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    WHERE index_class.relname = 'webinar_access_grant_tokens_token_hash_key'
      AND index_class.relnamespace = to_regnamespace(current_schema())
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indisunique
  ) THEN
    RAISE EXCEPTION 'webinar access token uniqueness index is missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index index_state
    JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    WHERE index_class.relname = 'webinar_access_invitation_email_jobs_grant_id_key'
      AND index_class.relnamespace = to_regnamespace(current_schema())
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indisunique
  ) THEN
    RAISE EXCEPTION 'webinar access email job uniqueness index is missing or invalid';
  END IF;
END $$;

SELECT 'webinars' AS table_name, COUNT(*) AS row_count FROM "webinars"
UNION ALL SELECT 'webinar_sessions', COUNT(*) FROM "webinar_sessions"
UNION ALL SELECT 'registrations', COUNT(*) FROM "registrations"
UNION ALL SELECT 'registration_tokens', COUNT(*) FROM "registration_tokens"
UNION ALL SELECT 'email_outbox_jobs', COUNT(*) FROM "email_outbox_jobs"
UNION ALL SELECT 'users', COUNT(*) FROM "users"
UNION ALL SELECT 'organization_memberships', COUNT(*) FROM "organization_memberships"
UNION ALL SELECT 'audit_logs', COUNT(*) FROM "audit_logs"
UNION ALL SELECT 'webinar_access_grants', COUNT(*) FROM "webinar_access_grants"
UNION ALL SELECT 'webinar_access_grant_tokens', COUNT(*) FROM "webinar_access_grant_tokens"
UNION ALL SELECT 'webinar_access_invitation_email_jobs', COUNT(*) FROM "webinar_access_invitation_email_jobs"
ORDER BY table_name;
