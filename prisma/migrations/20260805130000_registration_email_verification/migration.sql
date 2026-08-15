-- Existing registrations were created by the legacy flow and already had
-- participant access. Grandfather them as verified while new registrations use
-- an explicit pending_verification -> registered transition.
ALTER TABLE "registrations"
ADD COLUMN "email_verified_at" TIMESTAMP(3);

ALTER TABLE "registrations"
ADD COLUMN "pending_metadata_json" JSONB;

UPDATE "registrations"
SET "email_verified_at" = "registered_at"
WHERE "status" = 'registered'
  AND "email_verified_at" IS NULL;

CREATE INDEX "registrations_status_email_verified_at_idx"
ON "registrations"("status", "email_verified_at");
