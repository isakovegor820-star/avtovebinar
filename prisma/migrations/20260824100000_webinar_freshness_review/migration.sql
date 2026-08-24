ALTER TABLE "webinars" ADD COLUMN "review_due_at" DATE;
CREATE INDEX "webinars_freshness_review_due_idx"
  ON "webinars"("freshness_status", "review_due_at", "content_status")
  WHERE "review_due_at" IS NOT NULL AND "archived_at" IS NULL;

CREATE TABLE "author_review_tasks" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "author_profile_id" TEXT NOT NULL,
  "due_at" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dedup_key" TEXT NOT NULL UNIQUE,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "author_review_tasks_webinar_due_key" UNIQUE ("webinar_id", "due_at"),
  CONSTRAINT "author_review_tasks_status_check" CHECK ("status" IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT "author_review_tasks_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_review_tasks_webinar_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "author_review_tasks_profile_fkey" FOREIGN KEY ("author_profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "author_review_tasks_org_status_due_idx" ON "author_review_tasks"("organization_id", "status", "due_at");
CREATE INDEX "author_review_tasks_profile_status_due_idx" ON "author_review_tasks"("author_profile_id", "status", "due_at");

CREATE TABLE "author_service_notifications" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL UNIQUE,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dedup_key" TEXT NOT NULL UNIQUE,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "claim_token" TEXT UNIQUE,
  "sent_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "author_service_notifications_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER', 'CANCELLED')),
  CONSTRAINT "author_service_notifications_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "author_service_notifications_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_service_notifications_webinar_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "author_service_notifications_task_fkey" FOREIGN KEY ("task_id") REFERENCES "author_review_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "author_service_notifications_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "author_service_notifications_status_next_idx" ON "author_service_notifications"("status", "next_attempt_at", "created_at");
CREATE INDEX "author_service_notifications_org_user_status_idx" ON "author_service_notifications"("organization_id", "user_id", "status");
