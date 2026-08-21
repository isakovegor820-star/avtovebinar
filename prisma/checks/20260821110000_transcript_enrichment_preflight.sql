SELECT COUNT(*) AS invalid_existing_segments
FROM "transcript_segments"
WHERE "start_ms" < 0 OR "end_ms" <= "start_ms" OR length(btrim("text")) = 0;

SELECT COUNT(*) AS duplicate_provenance_tenant_keys
FROM (
  SELECT "id", "organization_id"
  FROM "ai_operation_provenance"
  GROUP BY "id", "organization_id"
  HAVING COUNT(*) > 1
) duplicates;
