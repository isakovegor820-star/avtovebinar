CREATE TABLE "transcripts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "media_asset_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "reviewed_by_user_id" TEXT,
  "version" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "webinar_transcript_status" NOT NULL DEFAULT 'draft',
  "language" TEXT NOT NULL DEFAULT 'ru',
  "reviewed_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcripts_version_revision_check" CHECK ("version" > 0 AND "revision" > 0),
  CONSTRAINT "transcripts_language_check" CHECK (length(btrim("language")) BETWEEN 2 AND 16),
  CONSTRAINT "transcripts_review_state_check" CHECK (
    ("status" = 'draft' AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL AND "published_at" IS NULL)
    OR ("status" = 'reviewed' AND "reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    OR ("status" = 'published' AND "reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "published_at" IS NOT NULL)
  )
);

CREATE TABLE "transcript_segments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "transcript_id" TEXT NOT NULL,
  "order_index" INTEGER NOT NULL,
  "start_ms" INTEGER NOT NULL,
  "end_ms" INTEGER NOT NULL,
  "speaker" TEXT,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcript_segments_order_check" CHECK ("order_index" >= 0),
  CONSTRAINT "transcript_segments_timing_check" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms"),
  CONSTRAINT "transcript_segments_text_check" CHECK (length(btrim("text")) > 0),
  CONSTRAINT "transcript_segments_speaker_check" CHECK ("speaker" IS NULL OR length(btrim("speaker")) BETWEEN 1 AND 120)
);

CREATE TABLE "ai_operation_provenance" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "media_asset_id" TEXT,
  "transcript_id" TEXT,
  "operation_type" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "template_version" TEXT NOT NULL,
  "input_refs_json" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "review_status" TEXT NOT NULL DEFAULT 'pending',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_operation_provenance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_operation_type_check" CHECK (length(btrim("operation_type")) BETWEEN 1 AND 80),
  CONSTRAINT "ai_operation_provider_check" CHECK (length(btrim("provider_id")) BETWEEN 1 AND 120),
  CONSTRAINT "ai_operation_model_check" CHECK (length(btrim("model_id")) BETWEEN 1 AND 120),
  CONSTRAINT "ai_operation_template_check" CHECK (length(btrim("template_version")) BETWEEN 1 AND 80),
  CONSTRAINT "ai_operation_status_check" CHECK ("status" IN ('succeeded', 'failed')),
  CONSTRAINT "ai_operation_review_status_check" CHECK ("review_status" IN ('pending', 'accepted', 'rejected', 'not_applicable'))
);

CREATE UNIQUE INDEX "transcripts_id_organization_id_key" ON "transcripts"("id", "organization_id");
CREATE UNIQUE INDEX "transcripts_webinar_id_version_key" ON "transcripts"("webinar_id", "version");
CREATE UNIQUE INDEX "transcripts_one_published_per_webinar_idx" ON "transcripts"("webinar_id") WHERE "status" = 'published';
CREATE INDEX "transcripts_organization_id_status_updated_at_idx" ON "transcripts"("organization_id", "status", "updated_at");
CREATE INDEX "transcripts_media_asset_id_version_idx" ON "transcripts"("media_asset_id", "version");
CREATE UNIQUE INDEX "transcript_segments_transcript_id_order_index_key" ON "transcript_segments"("transcript_id", "order_index");
CREATE INDEX "transcript_segments_organization_id_transcript_id_start_ms_idx" ON "transcript_segments"("organization_id", "transcript_id", "start_ms");
CREATE INDEX "ai_operation_provenance_organization_id_operation_type_created_at_idx" ON "ai_operation_provenance"("organization_id", "operation_type", "created_at");
CREATE INDEX "ai_operation_provenance_webinar_id_created_at_idx" ON "ai_operation_provenance"("webinar_id", "created_at");
CREATE INDEX "ai_operation_provenance_transcript_id_created_at_idx" ON "ai_operation_provenance"("transcript_id", "created_at");

ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_media_asset_scope_fkey" FOREIGN KEY ("media_asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_scope_fkey" FOREIGN KEY ("transcript_id", "organization_id") REFERENCES "transcripts"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_operation_provenance" ADD CONSTRAINT "ai_operation_provenance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_operation_provenance" ADD CONSTRAINT "ai_operation_provenance_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_operation_provenance" ADD CONSTRAINT "ai_operation_provenance_media_asset_scope_fkey" FOREIGN KEY ("media_asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_operation_provenance" ADD CONSTRAINT "ai_operation_provenance_transcript_scope_fkey" FOREIGN KEY ("transcript_id", "organization_id") REFERENCES "transcripts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
