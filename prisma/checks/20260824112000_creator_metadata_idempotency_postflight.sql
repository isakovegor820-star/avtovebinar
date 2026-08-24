-- Read-only postflight. Every returned count must be zero.
SELECT 'orphan_creator_metadata_idempotency_record' AS check_name, COUNT(*) AS violations
FROM "creator_metadata_idempotency_records" record
LEFT JOIN "users" app_user ON app_user."id" = record."user_id"
LEFT JOIN "organizations" organization ON organization."id" = record."organization_id"
LEFT JOIN "webinars" webinar
  ON webinar."id" = record."webinar_id"
 AND webinar."organization_id" = record."organization_id"
WHERE app_user."id" IS NULL OR organization."id" IS NULL OR webinar."id" IS NULL;

SELECT 'invalid_creator_metadata_idempotency_record' AS check_name, COUNT(*) AS violations
FROM "creator_metadata_idempotency_records"
WHERE char_length("idempotency_key") NOT BETWEEN 8 AND 128
   OR "request_hash" !~ '^[a-f0-9]{64}$';
