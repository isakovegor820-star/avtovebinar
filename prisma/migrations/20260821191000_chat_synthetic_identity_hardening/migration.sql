-- CHT-002/CHT-003 hardening: synthetic chat content cannot retain or regain
-- an invented attendee/moderator identity, including through an old app image.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

UPDATE "chat_scenario_messages"
SET "author_label" = CASE "kind"
  WHEN 'ai_moderator' THEN 'AI-модератор'
  WHEN 'system' THEN 'Система АСПБ'
  ELSE 'Подготовленный вопрос'
END;

UPDATE "webinar_chat_messages"
SET
  "author_name" = CASE "message_type"
    WHEN 'ai_moderator' THEN 'AI-модератор'
    ELSE 'Подготовленный вопрос'
  END,
  "author_role" = CASE "message_type"
    WHEN 'ai_moderator' THEN 'AI-модератор'
    ELSE 'Подготовленный вопрос'
  END
WHERE "is_synthetic" = true;

ALTER TABLE "chat_scenario_messages"
  ADD CONSTRAINT "chat_scenario_messages_safe_identity_check" CHECK (
    ("kind" = 'ai_moderator' AND "author_label" = 'AI-модератор')
    OR ("kind" = 'system' AND "author_label" = 'Система АСПБ')
    OR ("kind" IN ('prepared_question', 'moderator_notice', 'author_prompt')
      AND "author_label" = 'Подготовленный вопрос')
  );

ALTER TABLE "webinar_chat_messages"
  ADD CONSTRAINT "webinar_chat_messages_safe_synthetic_identity_check" CHECK (
    "is_synthetic" = false
    OR ("message_type" = 'prepared_question'
      AND "author_name" = 'Подготовленный вопрос'
      AND "author_role" = 'Подготовленный вопрос')
    OR ("message_type" = 'ai_moderator'
      AND "author_name" = 'AI-модератор'
      AND "author_role" = 'AI-модератор')
  );

CREATE OR REPLACE FUNCTION "aspb_normalize_scenario_message_identity"()
RETURNS trigger AS $$
BEGIN
  NEW."is_synthetic" := true;
  NEW."author_label" := CASE NEW."kind"
    WHEN 'ai_moderator' THEN 'AI-модератор'
    WHEN 'system' THEN 'Система АСПБ'
    ELSE 'Подготовленный вопрос'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_scenario_messages_synthetic_identity"
BEFORE INSERT OR UPDATE OF "kind", "author_label", "is_synthetic"
ON "chat_scenario_messages"
FOR EACH ROW EXECUTE FUNCTION "aspb_normalize_scenario_message_identity"();

CREATE OR REPLACE FUNCTION "aspb_normalize_synthetic_chat_identity"()
RETURNS trigger AS $$
BEGIN
  IF NEW."is_synthetic" = true THEN
    IF NEW."message_type" = 'ai_moderator' THEN
      NEW."author_name" := 'AI-модератор';
      NEW."author_role" := 'AI-модератор';
    ELSE
      NEW."author_name" := 'Подготовленный вопрос';
      NEW."author_role" := 'Подготовленный вопрос';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "webinar_chat_messages_synthetic_identity"
BEFORE INSERT OR UPDATE OF "is_synthetic", "message_type", "kind", "author_name", "author_role"
ON "webinar_chat_messages"
FOR EACH ROW EXECUTE FUNCTION "aspb_normalize_synthetic_chat_identity"();

RESET statement_timeout;
RESET lock_timeout;
