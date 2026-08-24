SELECT COUNT(*) AS organizations_without_one_active_default_pipeline
FROM (
  SELECT organization."id"
  FROM organizations organization
  LEFT JOIN crm_pipelines pipeline
    ON pipeline.organization_id = organization.id
   AND pipeline.is_default = true
   AND pipeline.status = 'active'
  GROUP BY organization.id
  HAVING COUNT(pipeline.id) <> 1
) invalid;

SELECT COUNT(*) AS registrations_without_scoped_crm_contact
FROM registrations registration
LEFT JOIN crm_contacts contact
  ON contact.id = registration.crm_contact_id
 AND contact.organization_id = registration.organization_id
WHERE registration.organization_id IS NOT NULL
  AND contact.id IS NULL;

SELECT COUNT(*) AS registration_contact_lead_mismatches
FROM registrations registration
JOIN crm_contacts contact
  ON contact.id = registration.crm_contact_id
 AND contact.organization_id = registration.organization_id
WHERE contact.legacy_lead_id IS DISTINCT FROM registration.lead_id;

SELECT COUNT(*) AS duplicate_contact_email_within_tenant
FROM (
  SELECT organization_id, email_normalized
  FROM crm_contacts
  WHERE email_normalized IS NOT NULL
  GROUP BY organization_id, email_normalized
  HAVING COUNT(*) > 1
) duplicate_email;

SELECT COUNT(*) AS contact_stage_scope_mismatches
FROM crm_contacts contact
LEFT JOIN crm_stages stage
  ON stage.id = contact.stage_id
 AND stage.pipeline_id = contact.pipeline_id
 AND stage.organization_id = contact.organization_id
WHERE stage.id IS NULL;

SELECT COUNT(*) AS event_contact_scope_mismatches
FROM crm_contact_events event
LEFT JOIN crm_contacts contact
  ON contact.id = event.contact_id
 AND contact.organization_id = event.organization_id
WHERE contact.id IS NULL;

SELECT COUNT(*) AS transition_scope_mismatches
FROM crm_stage_transitions transition
LEFT JOIN crm_contacts contact
  ON contact.id = transition.contact_id
 AND contact.organization_id = transition.organization_id
LEFT JOIN crm_stages target
  ON target.id = transition.to_stage_id
 AND target.pipeline_id = transition.pipeline_id
 AND target.organization_id = transition.organization_id
WHERE contact.id IS NULL OR target.id IS NULL;

SELECT COUNT(*) AS lost_transitions_without_reason
FROM crm_stage_transitions transition
JOIN crm_stages stage
  ON stage.id = transition.to_stage_id
 AND stage.pipeline_id = transition.pipeline_id
 AND stage.organization_id = transition.organization_id
WHERE stage.semantic_category = 'lost'
  AND NULLIF(btrim(transition.reason), '') IS NULL;

SELECT COUNT(*) AS legacy_registration_stage_snapshots_missing
FROM registrations registration
LEFT JOIN crm_stage_transitions transition
  ON transition.organization_id = registration.organization_id
 AND transition.legacy_registration_id = registration.id
LEFT JOIN crm_stages stage ON stage.id = transition.to_stage_id
WHERE registration.organization_id IS NOT NULL
  AND (transition.id IS NULL OR stage.code <> registration.crm_status);

WITH ranked AS (
  SELECT
    registration.*,
    row_number() OVER (
      PARTITION BY registration.organization_id, registration.lead_id
      ORDER BY registration.updated_at DESC, registration.registered_at DESC, registration.id DESC
    ) AS rank
  FROM registrations registration
  WHERE registration.organization_id IS NOT NULL
)
SELECT COUNT(*) AS latest_legacy_projection_mismatches
FROM ranked latest
JOIN crm_contacts contact
  ON contact.organization_id = latest.organization_id
 AND contact.legacy_lead_id = latest.lead_id
JOIN crm_stages stage ON stage.id = contact.stage_id
WHERE latest.rank = 1
  AND (
    stage.code <> latest.crm_status
    OR contact.legacy_assigned_manager_id IS DISTINCT FROM latest.assigned_manager_id
    OR contact.next_contact_at IS DISTINCT FROM latest.next_contact_at
  );

SELECT COUNT(*) AS missing_aspb_legacy_stage_codes
FROM (
  VALUES
    ('consultation'),
    ('transferred_to_aspb'),
    ('contract_pending'),
    ('contract_signed'),
    ('payout_due'),
    ('paid')
) required(code)
LEFT JOIN crm_pipelines pipeline
  ON pipeline.organization_id = 'org_aspb' AND pipeline.is_default = true
LEFT JOIN crm_stages stage
  ON stage.pipeline_id = pipeline.id AND stage.code = required.code
WHERE stage.id IS NULL;

SELECT COUNT(*) AS invalid_protected_stage_state
FROM crm_stages
WHERE is_protected = true AND status <> 'active';
