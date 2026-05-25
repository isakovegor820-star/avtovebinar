ALTER TABLE "webinar_sessions" ADD COLUMN "video_url" TEXT;
ALTER TABLE "webinar_sessions" ADD COLUMN "poster_url" TEXT;
ALTER TABLE "webinar_sessions" ADD COLUMN "video_duration_seconds" INTEGER NOT NULL DEFAULT 568;
ALTER TABLE "webinar_sessions" ADD COLUMN "room_open_before_minutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "webinar_sessions" ADD COLUMN "replay_available_hours" INTEGER NOT NULL DEFAULT 48;
ALTER TABLE "webinar_sessions" ADD COLUMN "replay_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "webinar_sessions" ADD COLUMN "live_mode" TEXT NOT NULL DEFAULT 'simulated';
