-- Флаг отправки сообщения «эфир начался» в Telegram (идемпотентность через CAS-claim).
ALTER TABLE "registrations" ADD COLUMN "telegram_live_sent_at" TIMESTAMP(3);
