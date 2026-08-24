\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.chat_scenarios') IS NULL OR to_regclass('public.chat_scenario_messages') IS NULL THEN
    RAISE EXCEPTION 'ChatScenario prerequisites are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organizations WHERE id = 'org_aspb' AND status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM webinars
    WHERE id = 'webinar_aspb_legacy' AND organization_id = 'org_aspb' AND legacy_compatibility = true
  ) THEN
    RAISE EXCEPTION 'exact compatibility tenant/webinar target is unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u
    JOIN organization_memberships m ON m.user_id = u.id AND m.organization_id = 'org_aspb'
    WHERE u.id = 'user_aspb_system_owner' AND u.kind = 'system' AND u.status = 'active'
      AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'compatibility system identity is unavailable';
  END IF;
END $$;

SELECT COUNT(*) AS legacy_target_scenarios_before
FROM chat_scenarios
WHERE webinar_id = 'webinar_aspb_legacy' AND organization_id = 'org_aspb';
