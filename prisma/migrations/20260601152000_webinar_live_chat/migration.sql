CREATE TABLE "webinar_chat_messages" (
    "id" TEXT NOT NULL,
    "webinar_session_id" TEXT NOT NULL,
    "registration_id" TEXT,
    "question_id" TEXT,
    "kind" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_role" TEXT,
    "message" TEXT NOT NULL,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "visible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webinar_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webinar_chat_messages_question_id_key" ON "webinar_chat_messages"("question_id");
CREATE INDEX "webinar_chat_messages_webinar_session_id_visible_at_idx" ON "webinar_chat_messages"("webinar_session_id", "visible_at");
CREATE INDEX "webinar_chat_messages_registration_id_idx" ON "webinar_chat_messages"("registration_id");
CREATE INDEX "webinar_chat_messages_kind_idx" ON "webinar_chat_messages"("kind");

ALTER TABLE "webinar_chat_messages" ADD CONSTRAINT "webinar_chat_messages_webinar_session_id_fkey" FOREIGN KEY ("webinar_session_id") REFERENCES "webinar_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webinar_chat_messages" ADD CONSTRAINT "webinar_chat_messages_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "webinar_chat_messages" ADD CONSTRAINT "webinar_chat_messages_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
