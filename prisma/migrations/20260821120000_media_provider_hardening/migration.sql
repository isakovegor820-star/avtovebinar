-- Additive metadata required to prove source integrity and retain provider
-- reconciliation evidence without changing existing media asset semantics.
ALTER TABLE "media_assets"
  ADD COLUMN "expected_checksum_sha256" TEXT,
  ADD COLUMN "container_format" TEXT,
  ADD COLUMN "video_codec" TEXT,
  ADD COLUMN "audio_codec" TEXT,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "integrity_verified_at" TIMESTAMP(3);

ALTER TABLE "media_uploads"
  ADD COLUMN "last_reconciled_at" TIMESTAMP(3),
  ADD COLUMN "abort_attempted_at" TIMESTAMP(3);

ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_expected_checksum_sha256_format_check"
  CHECK (
    "expected_checksum_sha256" IS NULL OR
    "expected_checksum_sha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "media_assets_checksum_sha256_format_check"
  CHECK (
    "checksum_sha256" IS NULL OR
    "checksum_sha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "media_assets_dimensions_check"
  CHECK (
    ("width" IS NULL AND "height" IS NULL) OR
    ("width" > 0 AND "height" > 0)
  );
