-- Read-only inventory. Retain this output with the deploy evidence.
SELECT COUNT(*) AS existing_media_uploads FROM "media_uploads";
SELECT COUNT(*) AS active_media_uploads
FROM "media_uploads" WHERE "status" IN ('created', 'uploading');
SELECT COUNT(*) AS running_content_jobs
FROM "content_jobs" WHERE "status" = 'running';
SELECT COUNT(*) AS existing_transcribe_jobs
FROM "content_jobs" WHERE "type" = 'TRANSCRIBE';
SELECT COUNT(*) AS ready_assets_without_speech_rendition
FROM "media_assets"
WHERE "status" = 'ready' AND "audio_storage_key" IS NULL;
