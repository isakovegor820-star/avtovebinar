-- Read-only CRM expand preflight. Run before applying
-- 20260821140000_crm_contact_pipeline and retain the output with rollout evidence.

SELECT COUNT(*) AS legacy_leads FROM leads;
SELECT COUNT(*) AS legacy_registrations FROM registrations;
SELECT crm_status, COUNT(*) AS registrations
FROM registrations
GROUP BY crm_status
ORDER BY crm_status;

SELECT COUNT(*) AS registrations_with_manager
FROM registrations
WHERE assigned_manager_id IS NOT NULL;

SELECT COUNT(*) AS registrations_with_next_contact
FROM registrations
WHERE next_contact_at IS NOT NULL;

-- A global Lead can currently be reused by registrations in several tenants.
-- The CRM backfill intentionally creates one contact per (organization, Lead)
-- so that no tenant can observe the other tenant's projection.
SELECT COUNT(*) AS leads_used_by_multiple_organizations
FROM (
  SELECT registration.lead_id
  FROM registrations registration
  WHERE registration.organization_id IS NOT NULL
  GROUP BY registration.lead_id
  HAVING COUNT(DISTINCT registration.organization_id) > 1
) scoped_lead;

WITH contact_scope AS (
  SELECT DISTINCT
    COALESCE(registration.organization_id, 'org_aspb') AS organization_id,
    lead.id AS lead_id,
    lower(btrim(lead.email)) AS email_normalized
  FROM leads lead
  LEFT JOIN registrations registration ON registration.lead_id = lead.id
), duplicate_email AS (
  SELECT organization_id, email_normalized
  FROM contact_scope
  GROUP BY organization_id, email_normalized
  HAVING COUNT(*) > 1
)
SELECT COUNT(*) AS duplicate_normalized_emails_within_tenant
FROM duplicate_email;

SELECT COUNT(*) AS invalid_phone_for_crm_normalization
FROM leads
WHERE regexp_replace(phone, '[^0-9]', '', 'g') <> ''
  AND char_length(regexp_replace(phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 18;

SELECT COUNT(*) AS invalid_legacy_crm_stage_codes
FROM registrations
WHERE crm_status !~ '^[a-z][a-z0-9_]{0,62}$';

-- These rows are not blocked: the migration creates a protected stage with
-- the exact legacy code so meaning is retained. The count requires explicit
-- review before rollout because the code has no built-in Russian label.
SELECT crm_status AS unrecognized_legacy_status, COUNT(*) AS registrations
FROM registrations
WHERE crm_status NOT IN (
  'new', 'qualified', 'contacted', 'consultation', 'transferred_to_aspb',
  'contract_pending', 'contract_sent', 'contract_signed', 'payout_due',
  'paid', 'lost', 'consultation_scheduled', 'offer_sent', 'won', 'not_target'
)
GROUP BY crm_status
ORDER BY crm_status;

-- Consolidation picks the latest registration per tenant/contact. Conflicting
-- legacy values remain on every Registration and are represented by import
-- transitions; this count is an acceptance input, not permission to discard.
SELECT COUNT(*) AS tenant_contacts_with_multiple_legacy_statuses
FROM (
  SELECT registration.organization_id, registration.lead_id
  FROM registrations registration
  WHERE registration.organization_id IS NOT NULL
  GROUP BY registration.organization_id, registration.lead_id
  HAVING COUNT(DISTINCT registration.crm_status) > 1
) conflict;
