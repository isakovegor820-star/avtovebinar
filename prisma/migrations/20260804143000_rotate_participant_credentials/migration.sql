-- Bindings made with the pre-remediation Telegram start token are not trusted.
-- Existing values remain only for incident investigation; application queries
-- require the current version and a fresh email-authenticated rebind.
ALTER TABLE "leads"
  ADD COLUMN "telegram_binding_version" TEXT;
