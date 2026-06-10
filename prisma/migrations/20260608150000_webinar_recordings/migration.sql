CREATE TABLE IF NOT EXISTS "webinar_recordings" (
  "id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "poster_url" TEXT,
  "video_url" TEXT,
  "hls_url" TEXT,
  "duration_seconds" INTEGER,
  "published_at" TIMESTAMP(3),
  "visible" BOOLEAN NOT NULL DEFAULT false,
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "category" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "webinar_recordings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_recordings_webinar_session_id_fkey"
    FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "webinar_recordings_webinar_session_id_idx"
  ON "webinar_recordings"("webinar_session_id");

CREATE INDEX IF NOT EXISTS "webinar_recordings_visible_published_at_order_index_idx"
  ON "webinar_recordings"("visible", "published_at", "order_index");

CREATE INDEX IF NOT EXISTS "webinar_recordings_category_idx"
  ON "webinar_recordings"("category");
