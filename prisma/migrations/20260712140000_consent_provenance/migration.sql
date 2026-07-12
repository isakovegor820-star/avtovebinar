-- Доказуемость согласия (152-ФЗ): когда, на какой версии политики и с какого IP дано согласие + отметка отзыва.
-- Все поля nullable — существующие строки не затрагиваются (backfill NULL).
ALTER TABLE "leads" ADD COLUMN "consent_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "marketing_consent_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "consent_policy_version" TEXT;
ALTER TABLE "leads" ADD COLUMN "consent_ip_hash" TEXT;
ALTER TABLE "leads" ADD COLUMN "consent_revoked_at" TIMESTAMP(3);
