-- Read-only preflight for CRM-009/CRM-010/CRM-014. Retain this output with rollout evidence.

SELECT COUNT(*) AS crm_contacts
FROM crm_contacts;

SELECT COUNT(*) AS legacy_hot_registrations
FROM registrations
WHERE organization_id IS NOT NULL
  AND crm_contact_id IS NOT NULL
  AND is_hot = TRUE;

SELECT COUNT(DISTINCT (organization_id, crm_contact_id)) AS contacts_with_legacy_hot
FROM registrations
WHERE organization_id IS NOT NULL
  AND crm_contact_id IS NOT NULL
  AND is_hot = TRUE;

SELECT COUNT(*) AS scoped_registration_score_sources
FROM registrations
WHERE organization_id IS NOT NULL
  AND crm_contact_id IS NOT NULL
  AND status = 'registered';

SELECT COUNT(*) AS scoped_room_entry_score_sources
FROM registrations
WHERE organization_id IS NOT NULL
  AND crm_contact_id IS NOT NULL
  AND room_entered_at IS NOT NULL;

SELECT COUNT(*) AS scoped_question_score_sources
FROM questions question
JOIN registrations registration ON registration.id = question.registration_id
WHERE registration.organization_id IS NOT NULL
  AND registration.crm_contact_id IS NOT NULL;

SELECT COUNT(*) AS scoped_cta_score_sources
FROM partner_applications application
JOIN registrations registration ON registration.id = application.registration_id
WHERE registration.organization_id IS NOT NULL
  AND registration.crm_contact_id IS NOT NULL;
