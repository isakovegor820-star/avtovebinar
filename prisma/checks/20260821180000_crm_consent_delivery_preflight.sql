-- Read-only evidence before CRM-002/CRM-008/CRM-013 delivery expand.
SELECT COUNT(*) AS crm_contacts_before_delivery_expand FROM "crm_contacts";
SELECT COUNT(*) AS tenant_scoped_crm_registrations_before_delivery_expand
FROM "registrations"
WHERE "organization_id" IS NOT NULL
  AND "webinar_id" IS NOT NULL
  AND "user_id" IS NOT NULL
  AND "crm_contact_id" IS NOT NULL;
SELECT COUNT(*) AS tenant_marketing_email_grants_before_delivery_expand
FROM "consent_records" consent
JOIN "registrations" registration ON registration."id" = consent."registration_id"
WHERE consent."kind" = 'marketing_email'
  AND consent."action" = 'grant'
  AND registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL;
SELECT COUNT(*) AS tenant_marketing_telegram_grants_before_delivery_expand
FROM "consent_records" consent
JOIN "registrations" registration ON registration."id" = consent."registration_id"
WHERE consent."kind" = 'marketing_telegram'
  AND consent."action" = 'grant'
  AND registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL;
SELECT to_regclass('crm_deliveries') AS crm_deliveries_relation_before_expand;
