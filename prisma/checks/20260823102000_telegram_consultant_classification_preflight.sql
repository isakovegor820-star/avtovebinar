-- Read-only inventory before BOT-006/BOT-007 expand.
SELECT COUNT(*) AS legacy_consultant_events
FROM events
WHERE event_name LIKE 'telegram_consultant_%';

SELECT COUNT(*) AS legacy_consultant_events_with_raw_chat_id
FROM events
WHERE event_name LIKE 'telegram_consultant_%'
  AND metadata_json ? 'chatId';

SELECT COUNT(*) AS existing_consultant_message_table
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name = 'telegram_consultant_messages';
