-- CRM-007/CRM-012: durable tenant-scoped bulk previews/results. CSV export is
-- streamed on the authenticated request and therefore creates no retained file.

CREATE TYPE "crm_bulk_action_type" AS ENUM (
  'assign_manager',
  'create_task',
  'change_stage',
  'add_tag'
);

CREATE TYPE "crm_bulk_action_status" AS ENUM (
  'previewed',
  'running',
  'completed',
  'partial',
  'failed',
  'expired'
);

CREATE TABLE "crm_bulk_actions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "requested_by_membership_id" TEXT NOT NULL,
  "action_type" "crm_bulk_action_type" NOT NULL,
  "action_json" JSONB NOT NULL,
  "filters_json" JSONB NOT NULL,
  "contact_ids_json" JSONB NOT NULL,
  "request_hash" TEXT NOT NULL,
  "expected_count" INTEGER NOT NULL,
  "status" "crm_bulk_action_status" NOT NULL DEFAULT 'previewed',
  "idempotency_key" TEXT NOT NULL,
  "results_json" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "executed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_bulk_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_bulk_actions_expected_count_check"
    CHECK ("expected_count" BETWEEN 0 AND 1000 AND jsonb_typeof("contact_ids_json") = 'array'
      AND jsonb_array_length("contact_ids_json") = "expected_count"),
  CONSTRAINT "crm_bulk_actions_payload_shape_check"
    CHECK (jsonb_typeof("action_json") = 'object' AND jsonb_typeof("filters_json") = 'object'),
  CONSTRAINT "crm_bulk_actions_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "crm_bulk_actions_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "crm_bulk_actions_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "crm_bulk_actions_terminal_result_check" CHECK (
    ("status" IN ('completed', 'partial', 'failed') AND "results_json" IS NOT NULL AND "executed_at" IS NOT NULL)
    OR ("status" IN ('previewed', 'running', 'expired') AND "results_json" IS NULL AND "executed_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "crm_bulk_actions_id_organization_id_key"
  ON "crm_bulk_actions"("id", "organization_id");
CREATE UNIQUE INDEX "crm_bulk_actions_organization_id_idempotency_key_key"
  ON "crm_bulk_actions"("organization_id", "idempotency_key");
CREATE INDEX "crm_bulk_actions_organization_id_status_expires_at_idx"
  ON "crm_bulk_actions"("organization_id", "status", "expires_at");

ALTER TABLE "crm_bulk_actions"
  ADD CONSTRAINT "crm_bulk_actions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_bulk_actions"
  ADD CONSTRAINT "crm_bulk_actions_requested_by_membership_id_organization_id_fkey"
  FOREIGN KEY ("requested_by_membership_id", "organization_id")
  REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_tasks" ADD COLUMN "bulk_action_id" TEXT;
CREATE UNIQUE INDEX "crm_tasks_bulk_action_id_contact_id_key"
  ON "crm_tasks"("bulk_action_id", "contact_id");
ALTER TABLE "crm_tasks"
  ADD CONSTRAINT "crm_tasks_bulk_action_id_organization_id_fkey"
  FOREIGN KEY ("bulk_action_id", "organization_id")
  REFERENCES "crm_bulk_actions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "aspb_guard_crm_bulk_action_scope"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."requested_by_membership_id" IS DISTINCT FROM OLD."requested_by_membership_id"
    OR NEW."action_type" IS DISTINCT FROM OLD."action_type"
    OR NEW."action_json" IS DISTINCT FROM OLD."action_json"
    OR NEW."filters_json" IS DISTINCT FROM OLD."filters_json"
    OR NEW."contact_ids_json" IS DISTINCT FROM OLD."contact_ids_json"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."expected_count" IS DISTINCT FROM OLD."expected_count"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'CRM bulk preview identity and snapshot are immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('completed', 'partial', 'failed', 'expired') AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."results_json" IS DISTINCT FROM OLD."results_json"
    OR NEW."executed_at" IS DISTINCT FROM OLD."executed_at"
  ) THEN
    RAISE EXCEPTION 'Terminal CRM bulk result is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "crm_bulk_actions_scope_guard"
BEFORE UPDATE ON "crm_bulk_actions"
FOR EACH ROW EXECUTE FUNCTION "aspb_guard_crm_bulk_action_scope"();

CREATE OR REPLACE FUNCTION "aspb_guard_crm_task_bulk_scope"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."bulk_action_id" IS DISTINCT FROM OLD."bulk_action_id" THEN
    RAISE EXCEPTION 'CRM task bulk action identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "crm_tasks_bulk_scope_guard"
BEFORE UPDATE ON "crm_tasks"
FOR EACH ROW EXECUTE FUNCTION "aspb_guard_crm_task_bulk_scope"();
