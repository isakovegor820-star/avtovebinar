SELECT COUNT(*) AS crm_delivery_target_scope_mismatches
FROM "crm_deliveries" delivery
LEFT JOIN "registrations" registration
  ON registration."id" = delivery."registration_id"
 AND registration."organization_id" = delivery."organization_id"
 AND registration."crm_contact_id" = delivery."contact_id"
 AND registration."webinar_id" = delivery."webinar_id"
 AND registration."webinar_session_id" = delivery."webinar_session_id"
WHERE registration."id" IS NULL;

SELECT COUNT(*) AS crm_delivery_requester_scope_mismatches
FROM "crm_deliveries" delivery
LEFT JOIN "organization_memberships" membership
  ON membership."id" = delivery."requested_by_membership_id"
 AND membership."organization_id" = delivery."organization_id"
WHERE membership."id" IS NULL;

SELECT COUNT(*) AS crm_delivery_consent_scope_mismatches
FROM "crm_deliveries" delivery
JOIN "registrations" target_registration ON target_registration."id" = delivery."registration_id"
LEFT JOIN "consent_records" consent
  ON consent."id" = delivery."consent_record_id"
 AND consent."lead_id" = target_registration."lead_id"
 AND consent."action" = 'grant'
 AND consent."kind" = CASE delivery."channel"
   WHEN 'email' THEN 'marketing_email'
   ELSE 'marketing_telegram'
 END
LEFT JOIN "registrations" evidence_registration
  ON evidence_registration."id" = consent."registration_id"
 AND evidence_registration."organization_id" = delivery."organization_id"
 AND evidence_registration."crm_contact_id" = delivery."contact_id"
WHERE consent."id" IS NULL OR evidence_registration."id" IS NULL;

SELECT COUNT(*) AS crm_delivery_lifecycle_mismatches
FROM "crm_deliveries"
WHERE NOT (
  ("status" IN ('pending', 'retry_scheduled')
    AND "claim_token" IS NULL AND "next_attempt_at" IS NOT NULL
    AND "sent_at" IS NULL AND "completed_at" IS NULL)
  OR ("status" = 'sending'
    AND "claim_token" IS NOT NULL AND "next_attempt_at" IS NULL
    AND "sent_at" IS NULL AND "completed_at" IS NULL)
  OR ("status" = 'sent'
    AND "claim_token" IS NULL AND "next_attempt_at" IS NULL
    AND "sent_at" IS NOT NULL AND "completed_at" IS NOT NULL
    AND "last_error_code" IS NULL)
  OR ("status" IN ('blocked', 'dead_letter', 'cancelled')
    AND "claim_token" IS NULL AND "next_attempt_at" IS NULL
    AND "sent_at" IS NULL AND "completed_at" IS NOT NULL
    AND "last_error_code" IS NOT NULL)
);

SELECT COUNT(*) AS crm_delivery_message_shape_mismatches
FROM "crm_deliveries"
WHERE char_length(btrim("body")) NOT BETWEEN 1 AND 3500
   OR ("channel" = 'email' AND char_length(btrim(COALESCE("subject", ''))) NOT BETWEEN 1 AND 160)
   OR ("channel" = 'telegram' AND "subject" IS NOT NULL);

SELECT COUNT(*) AS crm_delivery_duplicate_idempotency_keys
FROM (
  SELECT "organization_id", "idempotency_key", COUNT(*) AS duplicates
  FROM "crm_deliveries"
  GROUP BY "organization_id", "idempotency_key"
  HAVING COUNT(*) > 1
) duplicate;

SELECT COUNT(*) AS crm_delivery_unvalidated_constraints
FROM pg_constraint
WHERE conrelid = 'crm_deliveries'::regclass
  AND NOT convalidated;

SELECT 1 - COUNT(*) AS crm_delivery_missing_scope_trigger
FROM pg_trigger
WHERE tgrelid = 'crm_deliveries'::regclass
  AND tgname = 'crm_deliveries_scope_guard'
  AND NOT tgisinternal;
