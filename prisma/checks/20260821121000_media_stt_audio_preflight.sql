SELECT COUNT(*) AS ready_assets_before_speech_rendition
FROM "media_assets"
WHERE "status" = 'ready';

SELECT COUNT(*) AS active_processing_assets_before_speech_rendition
FROM "media_assets"
WHERE "status" IN ('validating', 'transcoding', 'transcribing', 'enriching');
