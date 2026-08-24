SELECT COUNT(*) AS running_media_jobs_before_leases
FROM "media_jobs"
WHERE "status" = 'running';

SELECT MIN("claimed_at") AS oldest_running_media_claim
FROM "media_jobs"
WHERE "status" = 'running';
