ALTER TABLE "registrations"
  ADD COLUMN "confirmation_sent_at" TIMESTAMP(3),
  ADD COLUMN "reminder_24h_sent_at" TIMESTAMP(3),
  ADD COLUMN "reminder_3h_sent_at" TIMESTAMP(3),
  ADD COLUMN "reminder_30m_sent_at" TIMESTAMP(3),
  ADD COLUMN "crm_status" TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN "manager_note" TEXT;

CREATE INDEX "registrations_crm_status_idx" ON "registrations"("crm_status");

CREATE TABLE "partner_applications" (
  "id" TEXT NOT NULL,
  "lead_id" TEXT NOT NULL,
  "registration_id" TEXT,
  "webinar_session_id" TEXT,
  "sphere" TEXT,
  "city" TEXT,
  "client_flow" TEXT,
  "experience" TEXT,
  "comment" TEXT,
  "preferred_format" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "partner_applications_lead_id_idx" ON "partner_applications"("lead_id");
CREATE INDEX "partner_applications_registration_id_idx" ON "partner_applications"("registration_id");
CREATE INDEX "partner_applications_status_idx" ON "partner_applications"("status");
CREATE INDEX "partner_applications_created_at_idx" ON "partner_applications"("created_at");

ALTER TABLE "partner_applications"
  ADD CONSTRAINT "partner_applications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "partner_applications"
  ADD CONSTRAINT "partner_applications_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "partner_applications"
  ADD CONSTRAINT "partner_applications_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "webinar_timeline_events" (
  "id" TEXT NOT NULL,
  "webinar_session_id" TEXT,
  "offset_seconds" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'message',
  "cta_label" TEXT,
  "cta_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_timeline_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webinar_timeline_events_webinar_session_id_idx" ON "webinar_timeline_events"("webinar_session_id");
CREATE INDEX "webinar_timeline_events_offset_seconds_idx" ON "webinar_timeline_events"("offset_seconds");

ALTER TABLE "webinar_timeline_events"
  ADD CONSTRAINT "webinar_timeline_events_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "registration_tokens" (
  "id" TEXT NOT NULL,
  "registration_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'access',
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "registration_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registration_tokens_token_hash_key" ON "registration_tokens"("token_hash");
CREATE INDEX "registration_tokens_registration_id_idx" ON "registration_tokens"("registration_id");
CREATE INDEX "registration_tokens_purpose_idx" ON "registration_tokens"("purpose");

ALTER TABLE "registration_tokens"
  ADD CONSTRAINT "registration_tokens_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
