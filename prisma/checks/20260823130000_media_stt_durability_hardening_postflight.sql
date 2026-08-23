-- All violation counts must be zero for rows created by the hardened image.
SELECT COUNT(*) AS duplicate_upload_idempotency_bindings
FROM (
  SELECT "organization_id", "idempotency_key"
  FROM "media_uploads"
  WHERE "idempotency_key" IS NOT NULL
  GROUP BY "organization_id", "idempotency_key"
  HAVING COUNT(*) > 1
) duplicates;

SELECT COUNT(*) AS duplicate_stt_provider_bindings
FROM (
  SELECT "provider_id", "provider_job_id"
  FROM "content_jobs"
  WHERE "provider_id" IS NOT NULL AND "provider_job_id" IS NOT NULL
  GROUP BY "provider_id", "provider_job_id"
  HAVING COUNT(*) > 1
) duplicates;

SELECT COUNT(*) AS terminal_content_jobs_with_live_claim
FROM "content_jobs"
WHERE "status" IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
  AND ("claim_token" IS NOT NULL OR "claim_expires_at" IS NOT NULL);

SELECT COUNT(*) AS invalid_media_cleanup_state
FROM "media_uploads"
WHERE "abort_attempts" < 0
   OR ("abort_dead_lettered_at" IS NOT NULL AND "abort_last_error_code" IS NULL);
