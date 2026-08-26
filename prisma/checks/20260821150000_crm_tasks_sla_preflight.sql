-- Read-only preflight for CRM-004/CRM-005. Retain the output with rollout evidence.

SELECT COUNT(*) AS crm_contacts
FROM crm_contacts;

SELECT COUNT(*) AS contacts_with_legacy_next_contact
FROM crm_contacts
WHERE next_contact_at IS NOT NULL;

SELECT COUNT(*) AS contacts_with_tenant_owner_membership
FROM crm_contacts
WHERE owner_membership_id IS NOT NULL;

-- These rows must not be converted to invented CRMTask records: legacy
-- AdminUser is intentionally separate from tenant User/membership.
SELECT COUNT(*) AS legacy_next_contacts_without_tenant_assignee
FROM crm_contacts
WHERE next_contact_at IS NOT NULL
  AND owner_membership_id IS NULL;

SELECT COUNT(*) AS invalid_existing_owner_membership_scope
FROM crm_contacts contact
LEFT JOIN organization_memberships membership
  ON membership.id = contact.owner_membership_id
 AND membership.organization_id = contact.organization_id
WHERE contact.owner_membership_id IS NOT NULL
  AND membership.id IS NULL;
