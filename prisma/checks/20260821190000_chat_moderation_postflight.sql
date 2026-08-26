-- Every returned count must be zero after the expand migration.
SELECT COUNT(*) AS chat_message_scope_violations
FROM webinar_chat_messages message
JOIN webinar_sessions session ON session.id = message.webinar_session_id
WHERE message.organization_id <> session.organization_id
   OR message.webinar_id <> session.webinar_id;

SELECT COUNT(*) AS chat_message_registration_scope_violations
FROM webinar_chat_messages message
JOIN registrations registration ON registration.id = message.registration_id
WHERE registration.webinar_session_id <> message.webinar_session_id;

SELECT COUNT(*) AS chat_message_type_violations
FROM webinar_chat_messages
WHERE message_type IS NULL
   OR (is_synthetic = true AND message_type NOT IN ('prepared_question', 'ai_moderator'))
   OR (is_synthetic = false AND message_type NOT IN ('participant', 'moderator', 'system'));

SELECT COUNT(*) AS chat_message_hidden_state_violations
FROM webinar_chat_messages
WHERE (hidden_at IS NULL AND (hidden_reason IS NOT NULL OR hidden_by_membership_id IS NOT NULL))
   OR (hidden_at IS NOT NULL AND (
     hidden_by_membership_id IS NULL
     OR char_length(btrim(COALESCE(hidden_reason, ''))) NOT BETWEEN 3 AND 500
   ));

SELECT COUNT(*) AS chat_ban_state_violations
FROM registrations
WHERE chat_banned_at IS NULL
  AND (chat_banned_reason IS NOT NULL OR chat_banned_by_membership_id IS NOT NULL);

SELECT COUNT(*) AS published_scenario_draft_message_violations
FROM chat_scenario_messages message
JOIN chat_scenarios scenario ON scenario.id = message.scenario_id
WHERE scenario.status = 'published' AND message.status = 'draft';
