-- Read-only inventory of legacy synthetic identities before normalization.
SELECT message_type, author_name, author_role, COUNT(*) AS message_count
FROM webinar_chat_messages
WHERE is_synthetic = true
GROUP BY message_type, author_name, author_role
ORDER BY message_type, message_count DESC;

SELECT kind, author_label, COUNT(*) AS message_count
FROM chat_scenario_messages
GROUP BY kind, author_label
ORDER BY kind, message_count DESC;
