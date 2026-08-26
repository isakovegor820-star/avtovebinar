-- Read-only preflight. Every returned count must be zero.
SELECT 'invalid_webinar_tenant_pair' AS check_name, COUNT(*) AS violations
FROM "webinars" webinar
LEFT JOIN "organizations" organization ON organization."id" = webinar."organization_id"
WHERE organization."id" IS NULL;
