-- Read-only preflight. Every returned count must be zero.
SELECT 'invalid_existing_organization_slug' AS check_name, COUNT(*) AS violations
FROM "organizations"
WHERE "slug" !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$';

SELECT 'duplicate_existing_organization_slug' AS check_name, COUNT(*) AS violations
FROM (
  SELECT "slug" FROM "organizations" GROUP BY "slug" HAVING COUNT(*) > 1
) duplicate_slug;
