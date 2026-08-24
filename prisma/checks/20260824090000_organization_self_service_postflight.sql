-- Read-only postflight. Every returned count must be zero.
SELECT 'invalid_settings_revision' AS check_name, COUNT(*) AS violations
FROM "organizations" WHERE "settings_revision" < 1;

SELECT 'orphan_organization_idempotency_record' AS check_name, COUNT(*) AS violations
FROM "organization_idempotency_records" record
LEFT JOIN "users" app_user ON app_user."id" = record."user_id"
LEFT JOIN "organizations" organization ON organization."id" = record."organization_id"
WHERE app_user."id" IS NULL OR organization."id" IS NULL;

SELECT 'invalid_organization_idempotency_record' AS check_name, COUNT(*) AS violations
FROM "organization_idempotency_records"
WHERE "scope" NOT IN ('organization.create', 'organization.settings.update')
   OR char_length("idempotency_key") NOT BETWEEN 8 AND 128
   OR "request_hash" !~ '^[a-f0-9]{64}$';
