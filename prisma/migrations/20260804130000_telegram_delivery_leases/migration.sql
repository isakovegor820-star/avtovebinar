-- A sent timestamp is delivery evidence and must only be written after Telegram accepts
-- the message. Separate expiring leases make a claim recoverable after a worker crash.
ALTER TABLE "registrations"
  ADD COLUMN "telegram_reminder_24h_claimed_until" TIMESTAMP(3),
  ADD COLUMN "telegram_reminder_3h_claimed_until" TIMESTAMP(3),
  ADD COLUMN "telegram_reminder_30m_claimed_until" TIMESTAMP(3),
  ADD COLUMN "telegram_live_claimed_until" TIMESTAMP(3),
  ADD COLUMN "telegram_followup_claimed_until" TIMESTAMP(3);
