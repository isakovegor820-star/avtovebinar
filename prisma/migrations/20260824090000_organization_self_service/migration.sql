-- GAP-ORG-001: additive organization onboarding/settings idempotency support.
ALTER TABLE "organizations"
  ADD COLUMN "settings_revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "organization_idempotency_records" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_idempotency_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_idempotency_records_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "organization_idempotency_records_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "organization_idempotency_records_scope_check"
    CHECK ("scope" IN ('organization.create', 'organization.settings.update')),
  CONSTRAINT "organization_idempotency_records_key_check"
    CHECK (char_length("idempotency_key") BETWEEN 8 AND 128),
  CONSTRAINT "organization_idempotency_records_hash_check"
    CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "organization_idempotency_records_user_scope_key_key"
  ON "organization_idempotency_records"("user_id", "scope", "idempotency_key");
CREATE INDEX "organization_idempotency_records_organization_created_idx"
  ON "organization_idempotency_records"("organization_id", "created_at");
CREATE INDEX "organization_idempotency_records_created_idx"
  ON "organization_idempotency_records"("created_at");

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_settings_revision_check" CHECK ("settings_revision" > 0);
