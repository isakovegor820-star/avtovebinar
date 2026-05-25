CREATE TABLE "telegram_news_posts" (
  "id" TEXT NOT NULL,
  "post_key" TEXT NOT NULL,
  "slot_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "url" TEXT,
  "source_title" TEXT,
  "recipient_count" INTEGER NOT NULL DEFAULT 0,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "telegram_news_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_news_posts_post_key_key" ON "telegram_news_posts"("post_key");
CREATE INDEX "telegram_news_posts_slot_key_idx" ON "telegram_news_posts"("slot_key");
CREATE INDEX "telegram_news_posts_sent_at_idx" ON "telegram_news_posts"("sent_at");
