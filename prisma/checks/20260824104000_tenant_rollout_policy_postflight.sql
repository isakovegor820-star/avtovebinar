\set ON_ERROR_STOP on
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tenant_rollout_policies) <> 7 THEN
    RAISE EXCEPTION 'expected seven canonical tenant rollout policies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tenant_rollout_entries e
    LEFT JOIN organizations o ON o.id = e.organization_id
    LEFT JOIN tenant_rollout_policies p ON p.feature = e.feature
    WHERE o.id IS NULL OR p.feature IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant rollout entry scope invariant failed';
  END IF;
END $$;
SELECT feature, mode, revision FROM tenant_rollout_policies ORDER BY feature;
