-- Additive media/STT durability fields. Every new column is nullable or has a
-- safe default so the previous application image remains compatible during
-- expand/rollback.
ALTER TABLE "media_assets"
  ADD COLUMN "speech_size_bytes" BIGINT,
  ADD COLUMN "renditions_metadata_json" JSONB;

ALTER TABLE "media_uploads"
  ADD COLUMN "abort_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "abort_next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "abort_last_error_code" TEXT,
  ADD COLUMN "abort_dead_lettered_at" TIMESTAMP(3),
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT;

CREATE UNIQUE INDEX "media_uploads_organization_id_idempotency_key_key"
  ON "media_uploads"("organization_id", "idempotency_key");
CREATE INDEX "media_uploads_status_abort_next_attempt_at_expires_at_idx"
  ON "media_uploads"("status", "abort_next_attempt_at", "expires_at");
ALTER TABLE "content_jobs"
  ADD COLUMN "claim_expires_at" TIMESTAMP(3),
  ADD COLUMN "provider_id" TEXT,
  ADD COLUMN "provider_job_id" TEXT,
  ADD COLUMN "provider_model_id" TEXT,
  ADD COLUMN "provider_model_version" TEXT,
  ADD COLUMN "provider_state" TEXT,
  ADD COLUMN "provider_submitted_at" TIMESTAMP(3),
  ADD COLUMN "provider_deadline_at" TIMESTAMP(3),
  ADD COLUMN "provider_result_stored_at" TIMESTAMP(3),
  ADD COLUMN "provider_deleted_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

CREATE INDEX "content_jobs_status_claim_expires_at_idx"
  ON "content_jobs"("status", "claim_expires_at");
CREATE UNIQUE INDEX "content_jobs_provider_id_provider_job_id_key"
  ON "content_jobs"("provider_id", "provider_job_id");

ALTER TABLE "ai_operation_provenance"
  ADD COLUMN "provider_model_version" TEXT;
