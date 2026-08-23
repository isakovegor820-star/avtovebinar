CREATE TYPE "crm_task_priority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "crm_task_status" AS ENUM ('open', 'completed', 'cancelled');

ALTER TABLE "crm_pipelines"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD CONSTRAINT "crm_pipelines_timezone_not_blank_check"
    CHECK (char_length(btrim("timezone")) BETWEEN 1 AND 120);

CREATE TABLE "crm_tasks" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "assignee_membership_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "priority" "crm_task_priority" NOT NULL DEFAULT 'normal',
  "status" "crm_task_status" NOT NULL DEFAULT 'open',
  "due_at" TIMESTAMP(3) NOT NULL,
  "reminder_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_tasks_title_not_blank_check"
    CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "crm_tasks_description_length_check"
    CHECK ("description" IS NULL OR char_length("description") <= 4000),
  CONSTRAINT "crm_tasks_reminder_before_due_check"
    CHECK ("reminder_at" <= "due_at"),
  CONSTRAINT "crm_tasks_status_timestamps_check" CHECK (
    ("status" = 'open' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'completed' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'cancelled' AND "completed_at" IS NULL AND "cancelled_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "crm_tasks_id_organization_id_key"
  ON "crm_tasks"("id", "organization_id");
CREATE INDEX "crm_tasks_organization_id_status_due_at_idx"
  ON "crm_tasks"("organization_id", "status", "due_at");
CREATE INDEX "crm_tasks_organization_id_assignee_status_due_at_idx"
  ON "crm_tasks"("organization_id", "assignee_membership_id", "status", "due_at");
CREATE INDEX "crm_tasks_organization_id_status_reminder_at_idx"
  ON "crm_tasks"("organization_id", "status", "reminder_at");
CREATE INDEX "crm_tasks_contact_id_status_due_at_idx"
  ON "crm_tasks"("contact_id", "status", "due_at");

ALTER TABLE "crm_tasks"
  ADD CONSTRAINT "crm_tasks_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_tasks_contact_scope_fkey"
    FOREIGN KEY ("contact_id", "organization_id")
    REFERENCES "crm_contacts"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_tasks_assignee_scope_fkey"
    FOREIGN KEY ("assignee_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_tasks_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "aspb_validate_crm_task_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
  ) THEN
    RAISE EXCEPTION 'CRM task identity scope is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_tasks_identity_scope_immutable';
  END IF;

  IF TG_OP = 'INSERT'
    OR NEW."assignee_membership_id" IS DISTINCT FROM OLD."assignee_membership_id" THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "organization_memberships" membership
      WHERE membership."id" = NEW."assignee_membership_id"
        AND membership."organization_id" = NEW."organization_id"
        AND membership."status" = 'active'
        AND membership."role" IN ('owner', 'crm_manager')
    ) THEN
      RAISE EXCEPTION 'CRM task assignee is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'crm_tasks_active_assignee_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_tasks_validate_scope_trigger"
BEFORE INSERT OR UPDATE ON "crm_tasks"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_task_scope"();

CREATE OR REPLACE FUNCTION "aspb_refresh_crm_contact_next_contact_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id TEXT;
  target_contact_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_organization_id := OLD."organization_id";
    target_contact_id := OLD."contact_id";
  ELSE
    target_organization_id := NEW."organization_id";
    target_contact_id := NEW."contact_id";
  END IF;

  UPDATE "crm_contacts" contact
  SET "next_contact_at" = (
    SELECT MIN(task."due_at")
    FROM "crm_tasks" task
    WHERE task."organization_id" = target_organization_id
      AND task."contact_id" = target_contact_id
      AND task."status" = 'open'
  )
  WHERE contact."organization_id" = target_organization_id
    AND contact."id" = target_contact_id;

  IF TG_OP = 'UPDATE' AND (
    OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
    OR OLD."contact_id" IS DISTINCT FROM NEW."contact_id"
  ) THEN
    UPDATE "crm_contacts" contact
    SET "next_contact_at" = (
      SELECT MIN(task."due_at")
      FROM "crm_tasks" task
      WHERE task."organization_id" = OLD."organization_id"
        AND task."contact_id" = OLD."contact_id"
        AND task."status" = 'open'
    )
    WHERE contact."organization_id" = OLD."organization_id"
      AND contact."id" = OLD."contact_id";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_tasks_refresh_next_contact_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "crm_tasks"
FOR EACH ROW EXECUTE FUNCTION "aspb_refresh_crm_contact_next_contact_at"();

CREATE OR REPLACE FUNCTION "aspb_prevent_crm_task_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRM tasks are retained; cancel the task instead'
    USING ERRCODE = '23514', CONSTRAINT = 'crm_tasks_delete_forbidden';
END;
$$;

CREATE TRIGGER "crm_tasks_prevent_delete_trigger"
BEFORE DELETE ON "crm_tasks"
FOR EACH ROW EXECUTE FUNCTION "aspb_prevent_crm_task_delete"();
