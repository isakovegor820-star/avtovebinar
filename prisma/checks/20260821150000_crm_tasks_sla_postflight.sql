SELECT COUNT(*) AS invalid_pipeline_timezones
FROM crm_pipelines
WHERE char_length(btrim(timezone)) NOT BETWEEN 1 AND 120;

SELECT COUNT(*) AS crm_task_scope_mismatches
FROM crm_tasks task
LEFT JOIN crm_contacts contact
  ON contact.id = task.contact_id
 AND contact.organization_id = task.organization_id
WHERE contact.id IS NULL;

SELECT COUNT(*) AS crm_task_assignee_scope_mismatches
FROM crm_tasks task
LEFT JOIN organization_memberships membership
  ON membership.id = task.assignee_membership_id
 AND membership.organization_id = task.organization_id
WHERE membership.id IS NULL;

SELECT COUNT(*) AS crm_task_invalid_assignees
FROM crm_tasks task
JOIN organization_memberships membership
  ON membership.id = task.assignee_membership_id
 AND membership.organization_id = task.organization_id
WHERE membership.role NOT IN ('owner', 'crm_manager')
   OR membership.status <> 'active';

SELECT COUNT(*) AS crm_task_invalid_lifecycle
FROM crm_tasks
WHERE reminder_at > due_at
   OR (status = 'open' AND (completed_at IS NOT NULL OR cancelled_at IS NOT NULL))
   OR (status = 'completed' AND (completed_at IS NULL OR cancelled_at IS NOT NULL))
   OR (status = 'cancelled' AND (completed_at IS NOT NULL OR cancelled_at IS NULL));

SELECT COUNT(*) AS crm_contact_next_task_projection_mismatches
FROM crm_contacts contact
JOIN (
  SELECT organization_id, contact_id
  FROM crm_tasks
  GROUP BY organization_id, contact_id
) task_contacts
  ON task_contacts.organization_id = contact.organization_id
 AND task_contacts.contact_id = contact.id
WHERE contact.next_contact_at IS DISTINCT FROM (
  SELECT MIN(task.due_at)
  FROM crm_tasks task
  WHERE task.organization_id = contact.organization_id
    AND task.contact_id = contact.id
    AND task.status = 'open'
);

SELECT COUNT(*) AS crm_tasks_without_create_event
FROM crm_tasks task
LEFT JOIN crm_contact_events event
  ON event.organization_id = task.organization_id
 AND event.contact_id = task.contact_id
 AND event.source_entity_type = 'crm_task'
 AND event.source_entity_id = task.id
 AND event.type = 'task_created'
WHERE event.id IS NULL;
