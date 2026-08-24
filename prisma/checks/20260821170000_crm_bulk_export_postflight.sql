SELECT COUNT(*) AS crm_bulk_requester_scope_mismatches
FROM "crm_bulk_actions" action
LEFT JOIN "organization_memberships" membership
  ON membership."id" = action."requested_by_membership_id"
 AND membership."organization_id" = action."organization_id"
WHERE membership."id" IS NULL;

SELECT COUNT(*) AS crm_bulk_snapshot_count_mismatches
FROM "crm_bulk_actions"
WHERE jsonb_typeof("contact_ids_json") <> 'array'
   OR jsonb_array_length("contact_ids_json") <> "expected_count";

SELECT COUNT(*) AS crm_bulk_terminal_result_mismatches
FROM "crm_bulk_actions"
WHERE ("status" IN ('completed', 'partial', 'failed') AND ("results_json" IS NULL OR "executed_at" IS NULL))
   OR ("status" IN ('previewed', 'running', 'expired') AND ("results_json" IS NOT NULL OR "executed_at" IS NOT NULL));

SELECT COUNT(*) AS crm_bulk_action_discriminator_mismatches
FROM "crm_bulk_actions"
WHERE NOT (
  ("action_type" = 'assign_manager' AND "action_json" ->> 'type' = 'ASSIGN_MANAGER')
  OR ("action_type" = 'create_task' AND "action_json" ->> 'type' = 'CREATE_TASK')
  OR ("action_type" = 'change_stage' AND "action_json" ->> 'type' = 'CHANGE_STAGE')
  OR ("action_type" = 'add_tag' AND "action_json" ->> 'type' = 'ADD_TAG')
);

SELECT COUNT(*) AS crm_bulk_result_integrity_mismatches
FROM "crm_bulk_actions"
WHERE NOT "aspb_crm_bulk_result_is_valid"("status", "results_json", "contact_ids_json", "expected_count");

SELECT COUNT(*) AS crm_bulk_task_scope_mismatches
FROM "crm_tasks" task
JOIN "crm_bulk_actions" action ON action."id" = task."bulk_action_id"
WHERE task."organization_id" <> action."organization_id";

SELECT COUNT(*) AS crm_bulk_task_action_type_mismatches
FROM "crm_tasks" task
JOIN "crm_bulk_actions" action ON action."id" = task."bulk_action_id"
WHERE task."bulk_action_id" IS NOT NULL
  AND action."action_type" <> 'create_task';

SELECT COUNT(*) AS crm_bulk_duplicate_task_targets
FROM (
  SELECT "bulk_action_id", "contact_id", COUNT(*) AS duplicates
  FROM "crm_tasks"
  WHERE "bulk_action_id" IS NOT NULL
  GROUP BY "bulk_action_id", "contact_id"
  HAVING COUNT(*) > 1
) duplicate;

SELECT COUNT(*) AS crm_bulk_unvalidated_integrity_constraints
FROM pg_constraint
WHERE conrelid = 'crm_bulk_actions'::regclass
  AND conname IN ('crm_bulk_actions_action_discriminator_check', 'crm_bulk_actions_result_integrity_check')
  AND NOT convalidated;

SELECT 2 - COUNT(*) AS crm_bulk_missing_integrity_constraints
FROM pg_constraint
WHERE conrelid = 'crm_bulk_actions'::regclass
  AND conname IN ('crm_bulk_actions_action_discriminator_check', 'crm_bulk_actions_result_integrity_check');

SELECT COUNT(*) AS crm_bulk_duplicate_snapshot_contacts
FROM (
  SELECT action."id", value.contact_id, COUNT(*) AS duplicates
  FROM "crm_bulk_actions" action
  CROSS JOIN LATERAL jsonb_array_elements_text(action."contact_ids_json") value(contact_id)
  GROUP BY action."id", value.contact_id
  HAVING COUNT(*) > 1
) duplicate;
