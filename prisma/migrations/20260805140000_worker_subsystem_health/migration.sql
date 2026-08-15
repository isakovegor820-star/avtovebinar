CREATE TABLE "worker_subsystem_health" (
    "subsystem" TEXT NOT NULL,
    "last_progress_at" TIMESTAMP(3) NOT NULL,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_subsystem_health_pkey" PRIMARY KEY ("subsystem")
);

CREATE INDEX "worker_subsystem_health_deadline_at_idx" ON "worker_subsystem_health"("deadline_at");
