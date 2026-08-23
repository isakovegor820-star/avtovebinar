-- CRM-007 hardening: make terminal per-contact results and task linkage
-- structurally verifiable at the database boundary.

CREATE OR REPLACE FUNCTION "aspb_crm_bulk_result_is_valid"(
  p_status "crm_bulk_action_status",
  p_results JSONB,
  p_contact_ids JSONB,
  p_expected_count INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
  success_count INTEGER;
  failure_count INTEGER;
  snapshot_count INTEGER;
  snapshot_distinct_count INTEGER;
  result_count INTEGER;
  result_distinct_count INTEGER;
BEGIN
  IF p_status IN ('previewed', 'running', 'expired') THEN
    RETURN p_results IS NULL;
  END IF;

  IF jsonb_typeof(p_results) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_results -> 'successes') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_results -> 'failures') IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;

  success_count := jsonb_array_length(p_results -> 'successes');
  failure_count := jsonb_array_length(p_results -> 'failures');
  IF success_count + failure_count <> p_expected_count THEN
    RETURN FALSE;
  END IF;
  IF (p_status = 'completed' AND failure_count <> 0)
     OR (p_status = 'failed' AND success_count <> 0)
     OR (p_status = 'partial' AND (success_count = 0 OR failure_count = 0)) THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_contact_ids) AS snapshot(item)
    WHERE jsonb_typeof(snapshot.item) <> 'string'
       OR length(snapshot.item #>> '{}') = 0
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT COUNT(*), COUNT(DISTINCT snapshot.item #>> '{}')
  INTO snapshot_count, snapshot_distinct_count
  FROM jsonb_array_elements(p_contact_ids) AS snapshot(item);
  IF snapshot_count <> p_expected_count OR snapshot_distinct_count <> p_expected_count THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_results -> 'successes') AS success(item)
    WHERE jsonb_typeof(success.item) <> 'object'
       OR COALESCE(success.item ->> 'contactId', '') = ''
       OR NOT (p_contact_ids ? (success.item ->> 'contactId'))
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_results -> 'failures') AS failure(item)
    WHERE jsonb_typeof(failure.item) <> 'object'
       OR COALESCE(failure.item ->> 'contactId', '') = ''
       OR NOT (p_contact_ids ? (failure.item ->> 'contactId'))
       OR COALESCE(failure.item ->> 'code', '') !~ '^[a-z0-9_]{3,80}$'
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT result_item.contact_id)
  INTO result_count, result_distinct_count
  FROM (
    SELECT success.item ->> 'contactId' AS contact_id
    FROM jsonb_array_elements(p_results -> 'successes') AS success(item)
    UNION ALL
    SELECT failure.item ->> 'contactId' AS contact_id
    FROM jsonb_array_elements(p_results -> 'failures') AS failure(item)
  ) result_item;
  RETURN result_count = p_expected_count AND result_distinct_count = p_expected_count;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "crm_bulk_actions"
  ADD CONSTRAINT "crm_bulk_actions_action_discriminator_check" CHECK (
    ("action_type" = 'assign_manager' AND ("action_json" ->> 'type') IS NOT DISTINCT FROM 'ASSIGN_MANAGER')
    OR ("action_type" = 'create_task' AND ("action_json" ->> 'type') IS NOT DISTINCT FROM 'CREATE_TASK')
    OR ("action_type" = 'change_stage' AND ("action_json" ->> 'type') IS NOT DISTINCT FROM 'CHANGE_STAGE')
    OR ("action_type" = 'add_tag' AND ("action_json" ->> 'type') IS NOT DISTINCT FROM 'ADD_TAG')
  ) NOT VALID;
ALTER TABLE "crm_bulk_actions" VALIDATE CONSTRAINT "crm_bulk_actions_action_discriminator_check";

ALTER TABLE "crm_bulk_actions"
  ADD CONSTRAINT "crm_bulk_actions_result_integrity_check" CHECK (
    "aspb_crm_bulk_result_is_valid"("status", "results_json", "contact_ids_json", "expected_count")
  ) NOT VALID;
ALTER TABLE "crm_bulk_actions" VALIDATE CONSTRAINT "crm_bulk_actions_result_integrity_check";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "crm_tasks" task
    JOIN "crm_bulk_actions" action
      ON action."id" = task."bulk_action_id"
     AND action."organization_id" = task."organization_id"
    WHERE task."bulk_action_id" IS NOT NULL
      AND action."action_type" <> 'create_task'
  ) THEN
    RAISE EXCEPTION 'CRM bulk task is linked to a non-task action';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "aspb_guard_crm_task_bulk_scope"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."bulk_action_id" IS DISTINCT FROM OLD."bulk_action_id" THEN
    RAISE EXCEPTION 'CRM task bulk action identity is immutable';
  END IF;
  IF NEW."bulk_action_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "crm_bulk_actions" action
    WHERE action."id" = NEW."bulk_action_id"
      AND action."organization_id" = NEW."organization_id"
      AND action."action_type" = 'create_task'
  ) THEN
    RAISE EXCEPTION 'CRM task requires a same-tenant create-task bulk action';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "crm_tasks_bulk_scope_guard" ON "crm_tasks";
CREATE TRIGGER "crm_tasks_bulk_scope_guard"
BEFORE INSERT OR UPDATE ON "crm_tasks"
FOR EACH ROW EXECUTE FUNCTION "aspb_guard_crm_task_bulk_scope"();
