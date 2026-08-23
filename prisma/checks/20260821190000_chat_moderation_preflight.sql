-- Read-only inventory before the additive CHT-001..CHT-007 expand migration.
SELECT kind, is_synthetic, COUNT(*) AS message_count
FROM webinar_chat_messages
GROUP BY kind, is_synthetic
ORDER BY kind, is_synthetic;

SELECT COUNT(*) AS chat_messages_without_session
FROM webinar_chat_messages message
LEFT JOIN webinar_sessions session ON session.id = message.webinar_session_id
WHERE session.id IS NULL;

SELECT COUNT(*) AS chat_messages_with_foreign_registration
FROM webinar_chat_messages message
JOIN registrations registration ON registration.id = message.registration_id
WHERE registration.webinar_session_id <> message.webinar_session_id;

SELECT scenario.status, COUNT(*) AS message_count
FROM chat_scenario_messages message
JOIN chat_scenarios scenario ON scenario.id = message.scenario_id
GROUP BY scenario.status
ORDER BY scenario.status;

SELECT COUNT(*) AS active_legacy_chat_bans
FROM registrations
WHERE chat_banned_at IS NOT NULL;
