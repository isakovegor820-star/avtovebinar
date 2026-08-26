SELECT COUNT(*) AS terminal_media_jobs_with_live_claim
FROM "media_jobs"
WHERE "status" IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
  AND ("claim_token" IS NOT NULL OR "claim_expires_at" IS NOT NULL);

SELECT COUNT(*) AS pending_media_jobs_with_live_claim
FROM "media_jobs"
WHERE "status" = 'pending'
  AND ("claim_token" IS NOT NULL OR "claim_expires_at" IS NOT NULL);

SELECT COUNT(*) AS running_media_jobs_without_expiry
FROM "media_jobs"
WHERE "status" = 'running'
  AND "claim_expires_at" IS NULL;

SELECT COUNT(*) AS expired_running_media_jobs
FROM "media_jobs"
WHERE "status" = 'running'
  AND "claim_expires_at" <= CURRENT_TIMESTAMP;
