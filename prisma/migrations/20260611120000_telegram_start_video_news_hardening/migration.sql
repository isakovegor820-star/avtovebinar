ALTER TABLE "telegram_news_posts"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'sent',
  ADD COLUMN "failed_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "completed_at" TIMESTAMP(3);

UPDATE "telegram_news_posts"
SET "completed_at" = "sent_at"
WHERE "completed_at" IS NULL;

ALTER TABLE "telegram_news_posts"
  ALTER COLUMN "status" SET DEFAULT 'sending';

DELETE FROM "telegram_news_posts" newer
USING "telegram_news_posts" older
WHERE newer."slot_key" = older."slot_key"
  AND (
    newer."sent_at" < older."sent_at"
    OR (newer."sent_at" = older."sent_at" AND newer."id" < older."id")
  );

DROP INDEX IF EXISTS "telegram_news_posts_slot_key_idx";
CREATE UNIQUE INDEX "telegram_news_posts_slot_key_key" ON "telegram_news_posts"("slot_key");
