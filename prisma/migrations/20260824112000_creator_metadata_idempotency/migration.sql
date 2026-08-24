-- GAP-WIZARD-001: additive tenant-scoped creator metadata autosave idempotency.
CREATE TABLE "creator_metadata_idempotency_records" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_metadata_idempotency_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creator_metadata_idempotency_records_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "creator_metadata_idempotency_records_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "creator_metadata_idempotency_records_webinar_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "creator_metadata_idempotency_records_key_check"
    CHECK (char_length("idempotency_key") BETWEEN 8 AND 128),
  CONSTRAINT "creator_metadata_idempotency_records_hash_check"
    CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "creator_metadata_idempotency_records_organization_key_key"
  ON "creator_metadata_idempotency_records"("organization_id", "idempotency_key");
CREATE INDEX "creator_metadata_idempotency_records_user_created_idx"
  ON "creator_metadata_idempotency_records"("user_id", "created_at");
CREATE INDEX "creator_metadata_idempotency_records_webinar_created_idx"
  ON "creator_metadata_idempotency_records"("webinar_id", "created_at");
