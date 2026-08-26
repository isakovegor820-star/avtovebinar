-- WEB-007 minimal tenant-scoped ChatScenario domain required for safe Webinar duplication.
-- New tables are empty; legacy file-backed scripted chat and participant messages are unchanged.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "chat_scenario_message_kind" AS ENUM (
  'prepared_question',
  'moderator_notice',
  'author_prompt'
);

ALTER TABLE "webinar_commands"
  DROP CONSTRAINT "webinar_commands_action_check",
  ADD CONSTRAINT "webinar_commands_action_check"
    CHECK ("action" IN ('submit', 'publish', 'archive', 'duplicate', 'publish_scenario'));

CREATE TABLE "chat_scenarios" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "webinar_scenario_status" NOT NULL DEFAULT 'draft',
  "created_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_scenarios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_scenarios_version_check" CHECK ("version" > 0),
  CONSTRAINT "chat_scenarios_status_check" CHECK ("status" <> 'not_available'),
  CONSTRAINT "chat_scenarios_approval_check" CHECK (
    ("status" = 'published' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL)
    OR
    ("status" = 'draft' AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
  ),
  CONSTRAINT "chat_scenarios_webinar_scope_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_scenarios_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chat_scenarios_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chat_scenarios_approved_by_id_fkey"
    FOREIGN KEY ("approved_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- The composite unique index must exist before the message table declares its
-- tenant-scoped foreign key.
CREATE UNIQUE INDEX "chat_scenarios_webinar_id_version_key"
  ON "chat_scenarios"("webinar_id", "version");
CREATE UNIQUE INDEX "chat_scenarios_id_organization_id_key"
  ON "chat_scenarios"("id", "organization_id");

CREATE TABLE "chat_scenario_messages" (
  "id" TEXT NOT NULL,
  "scenario_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "order_index" INTEGER NOT NULL,
  "offset_seconds" INTEGER NOT NULL,
  "kind" "chat_scenario_message_kind" NOT NULL,
  "text" TEXT NOT NULL,
  "author_label" TEXT NOT NULL,
  "is_synthetic" BOOLEAN NOT NULL DEFAULT true,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_scenario_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_scenario_messages_order_check" CHECK ("order_index" BETWEEN 0 AND 10000),
  CONSTRAINT "chat_scenario_messages_offset_check" CHECK ("offset_seconds" BETWEEN 0 AND 10800),
  CONSTRAINT "chat_scenario_messages_text_check" CHECK (char_length("text") BETWEEN 1 AND 1000),
  CONSTRAINT "chat_scenario_messages_author_label_check" CHECK (char_length("author_label") BETWEEN 2 AND 120),
  CONSTRAINT "chat_scenario_messages_synthetic_check" CHECK ("is_synthetic" = true),
  CONSTRAINT "chat_scenario_messages_scenario_scope_fkey"
    FOREIGN KEY ("scenario_id", "organization_id") REFERENCES "chat_scenarios"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_scenario_messages_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "chat_scenarios_organization_id_webinar_id_status_version_idx"
  ON "chat_scenarios"("organization_id", "webinar_id", "status", "version");
CREATE INDEX "chat_scenarios_created_by_id_created_at_idx"
  ON "chat_scenarios"("created_by_id", "created_at");
CREATE INDEX "chat_scenarios_approved_by_id_approved_at_idx"
  ON "chat_scenarios"("approved_by_id", "approved_at");
CREATE UNIQUE INDEX "chat_scenario_messages_scenario_id_order_index_key"
  ON "chat_scenario_messages"("scenario_id", "order_index");
CREATE INDEX "chat_scenario_messages_organization_id_scenario_id_offset_seconds_idx"
  ON "chat_scenario_messages"("organization_id", "scenario_id", "offset_seconds");

RESET statement_timeout;
RESET lock_timeout;
