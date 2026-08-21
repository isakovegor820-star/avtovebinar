CREATE TYPE "media_asset_status" AS ENUM (
  'created', 'uploading', 'validating', 'transcoding', 'transcribing',
  'enriching', 'ready', 'failed', 'cancelled'
);
CREATE TYPE "media_upload_status" AS ENUM ('created', 'uploading', 'completed', 'cancelled');
CREATE TYPE "media_job_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled');

ALTER TABLE "webinars" ADD COLUMN "current_media_asset_id" TEXT;

CREATE TABLE "media_assets" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "media_asset_status" NOT NULL DEFAULT 'created',
  "progress_percent" INTEGER,
  "original_file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "checksum_sha256" TEXT,
  "storage_key" TEXT NOT NULL,
  "manifest_storage_key" TEXT,
  "poster_storage_key" TEXT,
  "duration_seconds" INTEGER,
  "failure_code" TEXT,
  "ready_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_assets_progress_check" CHECK ("progress_percent" IS NULL OR "progress_percent" BETWEEN 0 AND 100),
  CONSTRAINT "media_assets_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "media_assets_duration_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" > 0),
  CONSTRAINT "media_assets_ready_artifacts_check" CHECK (
    "status" <> 'ready' OR (
      "checksum_sha256" IS NOT NULL AND "duration_seconds" IS NOT NULL AND
      "manifest_storage_key" IS NOT NULL AND "poster_storage_key" IS NOT NULL AND "ready_at" IS NOT NULL
    )
  )
);

CREATE TABLE "media_uploads" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_upload_key" TEXT NOT NULL,
  "status" "media_upload_status" NOT NULL DEFAULT 'created',
  "part_size_bytes" INTEGER NOT NULL,
  "uploaded_parts_json" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_uploads_part_size_check" CHECK ("part_size_bytes" >= 5242880)
);

CREATE TABLE "media_jobs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "media_job_status" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "dedup_key" TEXT NOT NULL,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "last_error_code" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20)
);

CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");
CREATE UNIQUE INDEX "media_assets_manifest_storage_key_key" ON "media_assets"("manifest_storage_key");
CREATE UNIQUE INDEX "media_assets_poster_storage_key_key" ON "media_assets"("poster_storage_key");
CREATE UNIQUE INDEX "media_assets_id_organization_id_key" ON "media_assets"("id", "organization_id");
CREATE UNIQUE INDEX "media_assets_webinar_id_version_key" ON "media_assets"("webinar_id", "version");
CREATE INDEX "media_assets_organization_id_status_updated_at_idx" ON "media_assets"("organization_id", "status", "updated_at");
CREATE INDEX "media_assets_webinar_id_status_version_idx" ON "media_assets"("webinar_id", "status", "version");
CREATE UNIQUE INDEX "media_uploads_provider_upload_key_key" ON "media_uploads"("provider_upload_key");
CREATE INDEX "media_uploads_organization_id_status_expires_at_idx" ON "media_uploads"("organization_id", "status", "expires_at");
CREATE INDEX "media_uploads_asset_id_status_idx" ON "media_uploads"("asset_id", "status");
CREATE UNIQUE INDEX "media_jobs_dedup_key_key" ON "media_jobs"("dedup_key");
CREATE INDEX "media_jobs_organization_id_status_next_attempt_at_idx" ON "media_jobs"("organization_id", "status", "next_attempt_at");
CREATE INDEX "media_jobs_asset_id_status_idx" ON "media_jobs"("asset_id", "status");

ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_asset_scope_fkey" FOREIGN KEY ("asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_asset_scope_fkey" FOREIGN KEY ("asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_current_media_asset_scope_fkey" FOREIGN KEY ("current_media_asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
