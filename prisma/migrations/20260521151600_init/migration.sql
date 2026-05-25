-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "city" TEXT,
    "professional_status" TEXT,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_sessions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 120,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webinar_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "webinar_session_id" TEXT NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success_viewed_at" TIMESTAMP(3),
    "room_entered_at" TIMESTAMP(3),
    "telegram_clicked_at" TIMESTAMP(3),
    "email_sent_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'registered',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "registration_id" TEXT NOT NULL,
    "webinar_session_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "is_answered" BOOLEAN NOT NULL DEFAULT false,
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "lead_id" TEXT,
    "registration_id" TEXT,
    "webinar_session_id" TEXT,
    "page" TEXT,
    "source" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "user_agent" TEXT,
    "ip_hash" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_email_key" ON "leads"("email");
CREATE INDEX "leads_phone_idx" ON "leads"("phone");
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");
CREATE INDEX "webinar_sessions_status_idx" ON "webinar_sessions"("status");
CREATE UNIQUE INDEX "webinar_sessions_scheduled_at_key" ON "webinar_sessions"("scheduled_at");
CREATE UNIQUE INDEX "registrations_access_token_hash_key" ON "registrations"("access_token_hash");
CREATE INDEX "registrations_lead_id_idx" ON "registrations"("lead_id");
CREATE INDEX "registrations_webinar_session_id_idx" ON "registrations"("webinar_session_id");
CREATE INDEX "registrations_registered_at_idx" ON "registrations"("registered_at");
CREATE INDEX "questions_created_at_idx" ON "questions"("created_at");
CREATE INDEX "questions_is_answered_idx" ON "questions"("is_answered");
CREATE INDEX "events_event_name_idx" ON "events"("event_name");
CREATE INDEX "events_created_at_idx" ON "events"("created_at");
CREATE INDEX "events_registration_id_idx" ON "events"("registration_id");

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
