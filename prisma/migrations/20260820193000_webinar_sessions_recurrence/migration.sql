-- SES-001/SES-002/SES-004/SES-005/SES-006 additive schedule foundation.
-- Existing session timestamps and legacy status fields are preserved.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE TYPE "webinar_recurrence_type" AS ENUM ('once', 'daily', 'weekly');

CREATE TABLE "webinar_schedules" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "recurrence_type" "webinar_recurrence_type" NOT NULL,
  "timezone" TEXT NOT NULL,
  "local_start_time" TEXT NOT NULL,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "max_future_instances" INTEGER NOT NULL DEFAULT 30,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_schedules_webinar_scope_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_schedules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_schedules_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_schedules_timezone_length_check" CHECK (char_length("timezone") BETWEEN 1 AND 100),
  CONSTRAINT "webinar_schedules_local_time_check" CHECK ("local_start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "webinar_schedules_period_check" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
  CONSTRAINT "webinar_schedules_max_instances_check" CHECK ("max_future_instances" BETWEEN 1 AND 366),
  CONSTRAINT "webinar_schedules_once_limit_check" CHECK ("recurrence_type" <> 'once' OR "max_future_instances" = 1)
);
CREATE UNIQUE INDEX "webinar_schedules_webinar_id_key" ON "webinar_schedules"("webinar_id");
CREATE UNIQUE INDEX "webinar_schedules_id_organization_id_key" ON "webinar_schedules"("id", "organization_id");
CREATE INDEX "webinar_schedules_organization_id_active_starts_on_idx"
  ON "webinar_schedules"("organization_id", "active", "starts_on");
CREATE INDEX "webinar_schedules_created_by_id_created_at_idx"
  ON "webinar_schedules"("created_by_id", "created_at");

ALTER TABLE "webinar_sessions"
  ADD COLUMN "schedule_id" TEXT,
  ADD COLUMN "schedule_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancellation_reason" TEXT,
  ADD COLUMN "rescheduled_at" TIMESTAMP(3);

ALTER TABLE "email_outbox_jobs"
  ADD COLUMN "session_schedule_version" INTEGER;

UPDATE "email_outbox_jobs" job
SET "session_schedule_version" = session."schedule_version"
FROM "webinar_sessions" session
WHERE job."webinar_session_id" = session."id"
  AND job."type" = 'webinar_reminder';

DROP INDEX "email_outbox_jobs_registration_id_type_reminder_kind_key";
CREATE UNIQUE INDEX "email_outbox_jobs_registration_id_type_reminder_kind_session_schedule_version_key"
  ON "email_outbox_jobs"("registration_id", "type", "reminder_kind", "session_schedule_version");

ALTER TABLE "webinar_sessions"
  ADD CONSTRAINT "webinar_sessions_schedule_scope_fkey"
  FOREIGN KEY ("schedule_id", "organization_id") REFERENCES "webinar_schedules"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "webinar_sessions" VALIDATE CONSTRAINT "webinar_sessions_schedule_scope_fkey";

ALTER TABLE "webinar_sessions"
  ADD CONSTRAINT "webinar_sessions_schedule_version_check" CHECK ("schedule_version" > 0),
  ADD CONSTRAINT "webinar_sessions_cancellation_reason_check"
    CHECK ("cancellation_reason" IS NULL OR char_length("cancellation_reason") BETWEEN 10 AND 2000),
  ADD CONSTRAINT "webinar_sessions_cancelled_state_check"
    CHECK (
      ("lifecycle_status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
      OR ("lifecycle_status" <> 'cancelled' AND "cancelled_at" IS NULL)
    );

CREATE INDEX "webinar_sessions_schedule_id_scheduled_at_idx" ON "webinar_sessions"("schedule_id", "scheduled_at");

RESET statement_timeout;
RESET lock_timeout;
