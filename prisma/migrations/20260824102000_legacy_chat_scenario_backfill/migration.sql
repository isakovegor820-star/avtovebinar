ALTER TABLE "chat_scenarios"
  ADD COLUMN "source_kind" TEXT,
  ADD COLUMN "source_version" INTEGER,
  ADD COLUMN "source_fingerprint" TEXT,
  ADD COLUMN "imported_at" TIMESTAMP(3),
  ADD COLUMN "runtime_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "chat_scenarios"
  ADD CONSTRAINT "chat_scenarios_import_provenance_check" CHECK (
    ("source_kind" IS NULL AND "source_version" IS NULL AND "source_fingerprint" IS NULL AND "imported_at" IS NULL)
    OR
    ("source_kind" = 'LEGACY_FILE' AND "source_version" IS NOT NULL AND "source_version" > 0
      AND "source_fingerprint" ~ '^[a-f0-9]{64}$' AND "imported_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "chat_scenarios_webinar_source_fingerprint_key"
  ON "chat_scenarios"("webinar_id", "source_kind", "source_fingerprint");
CREATE INDEX "chat_scenarios_org_source_runtime_idx"
  ON "chat_scenarios"("organization_id", "source_kind", "runtime_enabled");
