-- Additive, recoverable claim preventing concurrent CompleteMultipartUpload
-- calls. Nullable columns keep the previous application image compatible.
ALTER TABLE "media_uploads"
  ADD COLUMN "complete_claim_token" TEXT,
  ADD COLUMN "complete_claim_expires_at" TIMESTAMP(3);

CREATE INDEX "media_uploads_status_complete_claim_expires_at_idx"
  ON "media_uploads"("status", "complete_claim_expires_at");
