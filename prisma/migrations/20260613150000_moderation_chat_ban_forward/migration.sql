-- Модерация чата: бан участника в эфире и пометка пересланного вопроса.
-- Оба поля nullable, без дефолта — безопасно для существующих данных.
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "chat_banned_at" TIMESTAMP(3);
ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "forwarded_at" TIMESTAMP(3);
