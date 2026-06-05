CREATE TABLE "telegram_broadcast_jobs" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "text" TEXT NOT NULL,
  "chat_ids" JSONB NOT NULL,
  "total" INTEGER NOT NULL,
  "sent" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_index" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "telegram_broadcast_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "telegram_broadcast_jobs_status_next_attempt_at_created_at_idx"
  ON "telegram_broadcast_jobs"("status", "next_attempt_at", "created_at");

CREATE INDEX "telegram_broadcast_jobs_created_at_idx"
  ON "telegram_broadcast_jobs"("created_at");
