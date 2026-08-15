-- A stale worker must not be able to finalize or mutate a job after a newer
-- worker has reclaimed it. Nullable unique claim tokens provide CAS ownership.
ALTER TABLE "email_outbox_jobs"
  ADD COLUMN "claim_token" TEXT;

ALTER TABLE "telegram_broadcast_jobs"
  ADD COLUMN "claim_token" TEXT;

CREATE UNIQUE INDEX "email_outbox_jobs_claim_token_key"
  ON "email_outbox_jobs"("claim_token");

CREATE UNIQUE INDEX "telegram_broadcast_jobs_claim_token_key"
  ON "telegram_broadcast_jobs"("claim_token");
