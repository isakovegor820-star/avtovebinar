CREATE TABLE IF NOT EXISTS "telegram_broadcast_dead_letters" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "payload_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_broadcast_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_broadcast_dead_letters_job_id_key"
  ON "telegram_broadcast_dead_letters"("job_id");

CREATE INDEX IF NOT EXISTS "telegram_broadcast_dead_letters_created_at_idx"
  ON "telegram_broadcast_dead_letters"("created_at");

CREATE INDEX IF NOT EXISTS "registration_tokens_token_hash_idx"
  ON "registration_tokens"("token_hash");

CREATE INDEX IF NOT EXISTS "webinar_sessions_id_status_idx"
  ON "webinar_sessions"("id", "status");

CREATE INDEX IF NOT EXISTS "events_metadata_json_gin_idx"
  ON "events" USING GIN ("metadata_json");
