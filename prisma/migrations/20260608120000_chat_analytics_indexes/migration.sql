CREATE INDEX IF NOT EXISTS "questions_lead_id_idx" ON "questions"("lead_id");
CREATE INDEX IF NOT EXISTS "questions_registration_id_idx" ON "questions"("registration_id");
CREATE INDEX IF NOT EXISTS "questions_webinar_session_id_idx" ON "questions"("webinar_session_id");

CREATE INDEX IF NOT EXISTS "events_lead_id_idx" ON "events"("lead_id");
CREATE INDEX IF NOT EXISTS "events_webinar_session_id_idx" ON "events"("webinar_session_id");
CREATE INDEX IF NOT EXISTS "events_source_idx" ON "events"("source");
CREATE INDEX IF NOT EXISTS "events_utm_source_idx" ON "events"("utm_source");
CREATE INDEX IF NOT EXISTS "events_utm_medium_idx" ON "events"("utm_medium");
CREATE INDEX IF NOT EXISTS "events_utm_campaign_idx" ON "events"("utm_campaign");
