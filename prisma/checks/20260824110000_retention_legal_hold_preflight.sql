\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.retention_runs') IS NULL THEN
    RAISE EXCEPTION 'retention/legal-hold prerequisites are missing';
  END IF;
END $$;
SELECT COUNT(*) AS organizations_before FROM organizations;
