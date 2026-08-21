SELECT COUNT(*) AS invalid_existing_media_checksums
FROM "media_assets"
WHERE "checksum_sha256" IS NOT NULL
  AND "checksum_sha256" !~ '^[0-9a-f]{64}$';

SELECT
  (SELECT COUNT(*) FROM "media_assets") AS media_assets_before,
  (SELECT COUNT(*) FROM "media_uploads") AS media_uploads_before,
  (SELECT COUNT(*) FROM "media_jobs") AS media_jobs_before;
