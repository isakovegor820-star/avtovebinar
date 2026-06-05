CREATE TABLE "email_outbox_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "registration_id" TEXT,
    "webinar_session_id" TEXT,
    "to_email" TEXT NOT NULL,
    "to_name" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "webinar_url" TEXT NOT NULL,
    "partner_url" TEXT,
    "reminder_kind" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_outbox_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_outbox_jobs_status_next_attempt_at_created_at_idx" ON "email_outbox_jobs"("status", "next_attempt_at", "created_at");
CREATE INDEX "email_outbox_jobs_registration_id_idx" ON "email_outbox_jobs"("registration_id");
CREATE INDEX "email_outbox_jobs_webinar_session_id_idx" ON "email_outbox_jobs"("webinar_session_id");
CREATE INDEX "email_outbox_jobs_type_idx" ON "email_outbox_jobs"("type");

ALTER TABLE "email_outbox_jobs" ADD CONSTRAINT "email_outbox_jobs_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "email_outbox_jobs" ADD CONSTRAINT "email_outbox_jobs_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
