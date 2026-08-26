SELECT COUNT(*) AS webinars_without_tenant
FROM "webinars"
WHERE "organization_id" IS NULL;

SELECT COUNT(*) AS duplicate_webinar_tenant_keys
FROM (
  SELECT "id", "organization_id"
  FROM "webinars"
  GROUP BY "id", "organization_id"
  HAVING COUNT(*) > 1
) duplicates;
