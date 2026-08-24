-- Recoverable leases keep a crashed transcoder from leaving a media job in
-- RUNNING forever. The application renews the lease while ffmpeg is active and
-- requeues only an expired claim.
ALTER TABLE "media_jobs"
  ADD COLUMN "claim_expires_at" TIMESTAMP(3);

CREATE INDEX "media_jobs_status_claim_expires_at_idx"
  ON "media_jobs"("status", "claim_expires_at");
