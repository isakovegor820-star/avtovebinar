-- Raw bearer URLs must never be durable outbox payload. New workers generate a
-- one-time token immediately before SMTP delivery and persist only its hash.
-- Existing active jobs remain deliverable because their non-secret metadata is
-- sufficient to mint a fresh link; terminal history is permanently redacted.
WITH "legacy_email_registrations" AS (
  SELECT DISTINCT "registration_id"
  FROM "email_outbox_jobs"
  WHERE "registration_id" IS NOT NULL
    AND (
      "webinar_url" LIKE '%token=%'
      OR COALESCE("partner_url", '') LIKE '%token=%'
    )
)
DELETE FROM "registration_tokens"
WHERE "registration_id" IN (SELECT "registration_id" FROM "legacy_email_registrations")
  AND "purpose" IN ('registration', 'participant_login');

UPDATE "email_outbox_jobs"
SET
  "webinar_url" = CASE
    WHEN "status" IN ('pending', 'failed', 'sending') AND "sent_at" IS NULL
      THEN 'generated-at-delivery://email-link'
    ELSE 'redacted://email-link'
  END,
  "partner_url" = NULL;
