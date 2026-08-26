CREATE TYPE "ai_suggestion_type" AS ENUM ('title', 'description', 'chapter', 'tag', 'prepared_question');
CREATE TYPE "ai_suggestion_status" AS ENUM ('pending', 'accepted', 'rejected');

CREATE TABLE "content_jobs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "media_asset_id" TEXT,
  "transcript_id" TEXT,
  "requested_by_user_id" TEXT NOT NULL,
  "correlation_id" TEXT,
  "type" TEXT NOT NULL,
  "status" "media_job_status" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "dedup_key" TEXT NOT NULL,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT,
  "last_error_code" TEXT,
  "result_ref_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "content_jobs_type_check" CHECK ("type" IN ('TRANSCRIBE', 'AI_ENRICH'))
);

CREATE TABLE "organization_terms" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "normalized_term" TEXT NOT NULL,
  "term" TEXT NOT NULL,
  "expansion" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_terms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_terms_term_check" CHECK (length(btrim("term")) BETWEEN 1 AND 160),
  CONSTRAINT "organization_terms_normalized_check" CHECK (length(btrim("normalized_term")) BETWEEN 1 AND 160),
  CONSTRAINT "organization_terms_expansion_check" CHECK ("expansion" IS NULL OR length(btrim("expansion")) BETWEEN 1 AND 500)
);

CREATE TABLE "ai_suggestions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "transcript_id" TEXT NOT NULL,
  "provenance_id" TEXT NOT NULL,
  "type" "ai_suggestion_type" NOT NULL,
  "status" "ai_suggestion_status" NOT NULL DEFAULT 'pending',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "content_json" JSONB NOT NULL,
  "edited_content_json" JSONB,
  "reviewed_by_user_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "target_entity_type" TEXT,
  "target_entity_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_suggestions_revision_order_check" CHECK ("revision" > 0 AND "order_index" >= 0),
  CONSTRAINT "ai_suggestions_review_check" CHECK (
    ("status" = 'pending' AND "reviewed_by_user_id" IS NULL AND "reviewed_at" IS NULL)
    OR ("status" IN ('accepted', 'rejected') AND "reviewed_by_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  )
);

CREATE TABLE "webinar_chapters" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "transcript_id" TEXT NOT NULL,
  "start_ms" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "order_index" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webinar_chapters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_chapters_timing_order_check" CHECK ("start_ms" >= 0 AND "order_index" >= 0),
  CONSTRAINT "webinar_chapters_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 240)
);

CREATE TABLE "webinar_tags" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_tags_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "webinar_tags_normalized_check" CHECK (length(btrim("normalized_name")) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX "ai_operation_provenance_id_organization_id_key" ON "ai_operation_provenance"("id", "organization_id");
CREATE UNIQUE INDEX "content_jobs_dedup_key_key" ON "content_jobs"("dedup_key");
CREATE INDEX "content_jobs_organization_id_status_next_attempt_at_idx" ON "content_jobs"("organization_id", "status", "next_attempt_at");
CREATE INDEX "content_jobs_webinar_id_type_created_at_idx" ON "content_jobs"("webinar_id", "type", "created_at");
CREATE INDEX "content_jobs_transcript_id_type_created_at_idx" ON "content_jobs"("transcript_id", "type", "created_at");
CREATE UNIQUE INDEX "organization_terms_organization_id_normalized_term_key" ON "organization_terms"("organization_id", "normalized_term");
CREATE INDEX "organization_terms_organization_id_updated_at_idx" ON "organization_terms"("organization_id", "updated_at");
CREATE UNIQUE INDEX "ai_suggestions_provenance_id_type_order_index_key" ON "ai_suggestions"("provenance_id", "type", "order_index");
CREATE INDEX "ai_suggestions_organization_id_webinar_id_status_type_idx" ON "ai_suggestions"("organization_id", "webinar_id", "status", "type");
CREATE INDEX "ai_suggestions_transcript_id_status_idx" ON "ai_suggestions"("transcript_id", "status");
CREATE UNIQUE INDEX "webinar_chapters_webinar_id_transcript_id_order_index_key" ON "webinar_chapters"("webinar_id", "transcript_id", "order_index");
CREATE INDEX "webinar_chapters_organization_id_webinar_id_start_ms_idx" ON "webinar_chapters"("organization_id", "webinar_id", "start_ms");
CREATE UNIQUE INDEX "webinar_tags_webinar_id_normalized_name_key" ON "webinar_tags"("webinar_id", "normalized_name");
CREATE INDEX "webinar_tags_organization_id_normalized_name_idx" ON "webinar_tags"("organization_id", "normalized_name");

ALTER TABLE "transcript_segments" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('russian', "text")) STORED;
CREATE INDEX "transcript_segments_search_vector_idx" ON "transcript_segments" USING GIN ("search_vector");

ALTER TABLE "content_jobs" ADD CONSTRAINT "content_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_jobs" ADD CONSTRAINT "content_jobs_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_jobs" ADD CONSTRAINT "content_jobs_media_asset_scope_fkey" FOREIGN KEY ("media_asset_id", "organization_id") REFERENCES "media_assets"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_jobs" ADD CONSTRAINT "content_jobs_transcript_scope_fkey" FOREIGN KEY ("transcript_id", "organization_id") REFERENCES "transcripts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_jobs" ADD CONSTRAINT "content_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_terms" ADD CONSTRAINT "organization_terms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_terms" ADD CONSTRAINT "organization_terms_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_transcript_scope_fkey" FOREIGN KEY ("transcript_id", "organization_id") REFERENCES "transcripts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_provenance_scope_fkey" FOREIGN KEY ("provenance_id", "organization_id") REFERENCES "ai_operation_provenance"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webinar_chapters" ADD CONSTRAINT "webinar_chapters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webinar_chapters" ADD CONSTRAINT "webinar_chapters_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webinar_chapters" ADD CONSTRAINT "webinar_chapters_transcript_scope_fkey" FOREIGN KEY ("transcript_id", "organization_id") REFERENCES "transcripts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webinar_tags" ADD CONSTRAINT "webinar_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webinar_tags" ADD CONSTRAINT "webinar_tags_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
