-- WEB-007 ChatScenario structural and tenant-scope verification.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('chat_scenarios') IS NULL OR to_regclass('chat_scenario_messages') IS NULL THEN
    RAISE EXCEPTION 'ChatScenario tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_scenarios_webinar_scope_fkey' AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_scenario_messages_scenario_scope_fkey' AND convalidated
  ) THEN
    RAISE EXCEPTION 'ChatScenario tenant-scope foreign keys are missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_scenario_messages_synthetic_check' AND convalidated
  ) THEN
    RAISE EXCEPTION 'Synthetic message invariant is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'webinar_commands_action_check'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%publish_scenario%'
  ) THEN
    RAISE EXCEPTION 'Scenario publish idempotency action is not allowed';
  END IF;
END $$;

SELECT COUNT(*) AS scenario_tenant_orphans
FROM chat_scenarios s
LEFT JOIN webinars w ON w.id = s.webinar_id AND w.organization_id = s.organization_id
WHERE w.id IS NULL;

SELECT COUNT(*) AS message_tenant_orphans
FROM chat_scenario_messages m
LEFT JOIN chat_scenarios s ON s.id = m.scenario_id AND s.organization_id = m.organization_id
WHERE s.id IS NULL;

SELECT COUNT(*) AS non_synthetic_scenario_messages
FROM chat_scenario_messages
WHERE is_synthetic IS DISTINCT FROM true;

SELECT COUNT(*) AS invalid_published_scenarios
FROM chat_scenarios
WHERE status = 'published' AND (approved_by_id IS NULL OR approved_at IS NULL);
