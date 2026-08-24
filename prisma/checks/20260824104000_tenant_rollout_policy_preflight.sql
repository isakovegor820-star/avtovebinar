\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.admin_users') IS NULL THEN
    RAISE EXCEPTION 'tenant rollout prerequisites are missing';
  END IF;
END $$;
SELECT COUNT(*) AS active_organizations_before FROM organizations WHERE status = 'active';
