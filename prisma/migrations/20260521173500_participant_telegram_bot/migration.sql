ALTER TABLE "leads"
  ADD COLUMN "telegram_chat_id" TEXT,
  ADD COLUMN "telegram_username" TEXT,
  ADD COLUMN "telegram_first_name" TEXT,
  ADD COLUMN "telegram_subscribed_at" TIMESTAMP(3);

CREATE INDEX "leads_telegram_chat_id_idx" ON "leads"("telegram_chat_id");

ALTER TABLE "registrations"
  ADD COLUMN "telegram_reminder_24h_sent_at" TIMESTAMP(3),
  ADD COLUMN "telegram_reminder_3h_sent_at" TIMESTAMP(3),
  ADD COLUMN "telegram_reminder_30m_sent_at" TIMESTAMP(3);
