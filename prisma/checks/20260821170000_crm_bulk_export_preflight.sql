-- Read-only evidence before CRM-007/CRM-012 expand.
SELECT COUNT(*) AS crm_contacts_before_bulk_expand FROM "crm_contacts";
SELECT COUNT(*) AS crm_tasks_before_bulk_expand FROM "crm_tasks";
SELECT COUNT(*) AS memberships_with_explicit_crm_export_permission
FROM "organization_memberships"
WHERE "status" = 'active'
  AND jsonb_typeof("permissions_json" -> 'crm' -> 'export') = 'boolean'
  AND ("permissions_json" -> 'crm' ->> 'export')::boolean = true;
SELECT to_regclass('crm_bulk_actions') AS crm_bulk_actions_relation_before_expand;
SELECT COUNT(*) AS crm_tasks_with_bulk_action_column_before_expand
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'crm_tasks'
  AND column_name = 'bulk_action_id';
