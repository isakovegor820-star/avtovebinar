SELECT COUNT(*) AS duplicate_speech_rendition_keys
FROM (
  SELECT "audio_storage_key"
  FROM "media_assets"
  WHERE "audio_storage_key" IS NOT NULL
  GROUP BY "audio_storage_key"
  HAVING COUNT(*) > 1
) duplicates;

SELECT COUNT(*) AS new_integrity_assets_without_speech_rendition
FROM "media_assets"
WHERE "integrity_verified_at" IS NOT NULL
  AND "audio_storage_key" IS NULL;
