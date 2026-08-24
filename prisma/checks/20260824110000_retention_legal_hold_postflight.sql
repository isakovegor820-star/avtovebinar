\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.legal_holds') IS NULL THEN
    RAISE EXCEPTION 'legal_holds is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM legal_holds h LEFT JOIN organizations o ON o.id = h.organization_id WHERE o.id IS NULL
  ) THEN
    RAISE EXCEPTION 'legal hold tenant scope invariant failed';
  END IF;
END $$;
SELECT COUNT(*) AS legal_holds_after FROM legal_holds;
