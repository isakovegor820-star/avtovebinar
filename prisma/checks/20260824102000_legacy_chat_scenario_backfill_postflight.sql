\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_scenarios_import_provenance_check' AND convalidated
  ) THEN
    RAISE EXCEPTION 'ChatScenario import provenance constraint is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM chat_scenarios s
    LEFT JOIN chat_scenario_messages m ON m.scenario_id = s.id AND m.organization_id = s.organization_id
    WHERE s.source_kind = 'LEGACY_FILE'
    GROUP BY s.id
    HAVING s.organization_id <> 'org_aspb'
       OR s.webinar_id <> 'webinar_aspb_legacy'
       OR s.runtime_enabled IS DISTINCT FROM false
       OR s.status <> 'draft'
       OR bool_or(m.is_synthetic IS DISTINCT FROM true)
       OR bool_or(m.kind <> 'prepared_question')
  ) THEN
    RAISE EXCEPTION 'legacy ChatScenario shadow invariant failed';
  END IF;
END $$;

SELECT s.source_fingerprint, COUNT(m.id) AS imported_message_count,
       MIN(m.order_index) AS first_order_index, MAX(m.order_index) AS last_order_index
FROM chat_scenarios s
LEFT JOIN chat_scenario_messages m ON m.scenario_id = s.id AND m.organization_id = s.organization_id
WHERE s.source_kind = 'LEGACY_FILE'
GROUP BY s.id, s.source_fingerprint;
