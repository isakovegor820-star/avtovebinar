ALTER TABLE "registrations"
  ADD COLUMN IF NOT EXISTS "telegram_followup_sent_at" TIMESTAMP(3);
