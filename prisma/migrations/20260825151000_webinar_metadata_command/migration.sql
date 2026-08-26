-- Creator autosave now records the same durable idempotency evidence as other
-- commands. Keep the database allowlist synchronized with that API action.
ALTER TABLE "webinar_commands"
  DROP CONSTRAINT "webinar_commands_action_check",
  ADD CONSTRAINT "webinar_commands_action_check"
    CHECK (
      "action" IN (
        'submit',
        'publish',
        'archive',
        'duplicate',
        'publish_scenario',
        'metadata_update'
      )
    );
