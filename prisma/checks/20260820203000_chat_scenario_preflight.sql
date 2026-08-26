-- Read-only snapshot before WEB-007 ChatScenario expand migration.
\set ON_ERROR_STOP on

SELECT COUNT(*) AS organizations_before FROM organizations;
SELECT COUNT(*) AS users_before FROM users;
SELECT COUNT(*) AS webinars_before FROM webinars;
SELECT COUNT(*) AS webinar_sessions_before FROM webinar_sessions;
SELECT COUNT(*) AS webinar_chat_messages_before FROM webinar_chat_messages;
SELECT COUNT(*) AS webinar_commands_before FROM webinar_commands;

SELECT COUNT(*) AS webinar_tenant_orphans_before
FROM webinars w
LEFT JOIN organizations o ON o.id = w.organization_id
WHERE o.id IS NULL;
