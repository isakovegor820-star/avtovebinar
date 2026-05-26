-- Align replay policy with the production requirement: replay is available for 7 days.
ALTER TABLE "webinar_sessions"
  ALTER COLUMN "replay_available_hours" SET DEFAULT 168;

UPDATE "webinar_sessions"
SET "replay_available_hours" = 168
WHERE "replay_available_hours" = 48;
