-- Private, normalized speech input produced by the media worker. It remains an
-- opaque server-side storage key and is never exposed in public API payloads.
ALTER TABLE "media_assets"
  ADD COLUMN "audio_storage_key" TEXT;

CREATE UNIQUE INDEX "media_assets_audio_storage_key_key"
  ON "media_assets"("audio_storage_key");
