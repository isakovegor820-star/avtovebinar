ALTER TABLE "events" ADD COLUMN "visitor_id" TEXT;

CREATE INDEX "events_visitor_id_created_at_idx" ON "events"("visitor_id", "created_at");
CREATE INDEX "events_visitor_id_event_name_created_at_idx" ON "events"("visitor_id", "event_name", "created_at");
