-- Read-only inventory. Existing uploads require no backfill because both claim
-- columns are nullable and are populated only by the hardened application.
SELECT COUNT(*) AS existing_media_uploads FROM "media_uploads";
SELECT COUNT(*) AS active_media_uploads
FROM "media_uploads" WHERE "status" IN ('created', 'uploading');
