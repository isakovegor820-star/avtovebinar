ALTER TABLE "webinar_chapters"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "origin" TEXT,
  ADD COLUMN "created_by_user_id" TEXT;

UPDATE "webinar_chapters" SET "origin" = 'LEGACY_UNKNOWN' WHERE "origin" IS NULL;

ALTER TABLE "webinar_chapters"
  ALTER COLUMN "origin" SET DEFAULT 'MANUAL',
  ALTER COLUMN "origin" SET NOT NULL;

ALTER TABLE "webinar_chapters"
  ADD CONSTRAINT "webinar_chapters_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "webinar_chapters_origin_check" CHECK ("origin" IN ('MANUAL', 'AI_REVIEWED', 'LEGACY_UNKNOWN')),
  ADD CONSTRAINT "webinar_chapters_start_ms_check" CHECK ("start_ms" >= 0),
  ADD CONSTRAINT "webinar_chapters_order_index_check" CHECK ("order_index" >= 0);

CREATE INDEX "webinar_chapters_transcript_order_index_idx"
  ON "webinar_chapters"("transcript_id", "order_index");

ALTER TABLE "webinar_chapters"
  ADD CONSTRAINT "webinar_chapters_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
