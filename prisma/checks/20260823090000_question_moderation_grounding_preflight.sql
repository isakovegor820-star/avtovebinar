-- Read-only inventory before the additive CHT-008..CHT-010 expand migration.
SELECT COUNT(*) AS questions_without_session
FROM questions question
LEFT JOIN webinar_sessions session ON session.id = question.webinar_session_id
WHERE session.id IS NULL;

SELECT COUNT(*) AS question_registration_session_mismatches
FROM questions question
JOIN registrations registration ON registration.id = question.registration_id
WHERE registration.webinar_session_id <> question.webinar_session_id
   OR registration.lead_id <> question.lead_id;

SELECT COUNT(*) AS question_registration_tenant_scope_gaps
FROM questions question
JOIN registrations registration ON registration.id = question.registration_id
JOIN webinar_sessions session ON session.id = question.webinar_session_id
WHERE registration.organization_id IS DISTINCT FROM session.organization_id
   OR registration.webinar_id IS DISTINCT FROM session.webinar_id;

SELECT is_answered, COUNT(*) AS question_count
FROM questions
GROUP BY is_answered
ORDER BY is_answered;

SELECT COUNT(*) AS existing_ai_moderator_messages
FROM webinar_chat_messages
WHERE message_type = 'ai_moderator';
