SELECT COUNT(*) AS invalid_media_checksums
FROM "media_assets"
WHERE ("expected_checksum_sha256" IS NOT NULL AND "expected_checksum_sha256" !~ '^[0-9a-f]{64}$')
   OR ("checksum_sha256" IS NOT NULL AND "checksum_sha256" !~ '^[0-9a-f]{64}$');

SELECT COUNT(*) AS incomplete_integrity_evidence
FROM "media_assets"
WHERE "integrity_verified_at" IS NOT NULL
  AND (
    "checksum_sha256" IS NULL OR "container_format" IS NULL OR
    "video_codec" IS NULL OR "width" IS NULL OR "height" IS NULL
  );

SELECT COUNT(*) AS invalid_media_dimensions
FROM "media_assets"
WHERE ("width" IS NULL) <> ("height" IS NULL)
   OR "width" <= 0 OR "height" <= 0;
