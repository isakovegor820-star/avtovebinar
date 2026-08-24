CREATE TYPE "webinar_material_status" AS ENUM ('uploading', 'ready', 'failed', 'deleted');
CREATE TYPE "webinar_material_upload_status" AS ENUM ('uploading', 'completed', 'cancelled');

CREATE TABLE "webinar_materials" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "original_file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "expected_checksum_sha256" TEXT,
  "checksum_sha256" TEXT,
  "storage_key" TEXT NOT NULL UNIQUE,
  "status" "webinar_material_status" NOT NULL DEFAULT 'uploading',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "ready_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_materials_id_organization_key" UNIQUE ("id", "organization_id"),
  CONSTRAINT "webinar_materials_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "webinar_materials_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "webinar_materials_checksum_check" CHECK (
    "expected_checksum_sha256" IS NULL OR "expected_checksum_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "webinar_materials_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_materials_webinar_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webinar_materials_creator_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "webinar_materials_organization_webinar_status_created_idx"
  ON "webinar_materials"("organization_id", "webinar_id", "status", "created_at");

CREATE TABLE "webinar_material_uploads" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "material_id" TEXT NOT NULL UNIQUE,
  "provider" TEXT NOT NULL,
  "provider_upload_key" TEXT NOT NULL UNIQUE,
  "status" "webinar_material_upload_status" NOT NULL DEFAULT 'uploading',
  "part_size_bytes" INTEGER NOT NULL,
  "uploaded_parts_json" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_material_uploads_org_idempotency_key" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "webinar_material_uploads_material_organization_key" UNIQUE ("material_id", "organization_id"),
  CONSTRAINT "webinar_material_uploads_part_size_check" CHECK ("part_size_bytes" >= 5242880),
  CONSTRAINT "webinar_material_uploads_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_material_uploads_material_fkey" FOREIGN KEY ("material_id", "organization_id") REFERENCES "webinar_materials"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "webinar_material_uploads_org_status_expires_idx"
  ON "webinar_material_uploads"("organization_id", "status", "expires_at");
