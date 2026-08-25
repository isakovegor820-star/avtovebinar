-- Allow the already implemented idempotent wizard autosave command to be
-- persisted by databases built only from committed migrations.
--
-- Safety plan:
-- * no table or column is removed or renamed;
-- * the accepted value set only expands, so all existing rows remain valid;
-- * lock and statement timeouts prevent an unbounded deployment wait;
-- * the constraint replacement is one atomic ALTER TABLE statement.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "webinar_commands"
  DROP CONSTRAINT "webinar_commands_action_check",
  ADD CONSTRAINT "webinar_commands_action_check"
    CHECK ("action" IN ('submit', 'publish', 'archive', 'duplicate', 'publish_scenario', 'metadata_update'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'webinar_commands_action_check'
      AND conrelid = 'webinar_commands'::regclass
      AND pg_get_constraintdef(oid) LIKE '%metadata_update%'
  ) THEN
    RAISE EXCEPTION 'webinar_commands_action_check was not expanded for metadata_update';
  END IF;
END $$;
