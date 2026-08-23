-- Every returned count must be zero after the CHT-008..CHT-010 expand migration.
SELECT COUNT(*) AS question_scope_violations
FROM questions question
JOIN webinar_sessions session ON session.id = question.webinar_session_id
WHERE question.organization_id <> session.organization_id
   OR question.webinar_id <> session.webinar_id;

SELECT COUNT(*) AS question_registration_scope_violations
FROM questions question
JOIN registrations registration ON registration.id = question.registration_id
WHERE registration.webinar_session_id <> question.webinar_session_id
   OR registration.lead_id <> question.lead_id
   OR (registration.organization_id IS NOT NULL AND registration.organization_id <> question.organization_id)
   OR (registration.webinar_id IS NOT NULL AND registration.webinar_id <> question.webinar_id);

SELECT COUNT(*) AS question_state_violations
FROM questions
WHERE organization_id IS NULL
   OR webinar_id IS NULL
   OR text_fingerprint IS NULL
   OR length(text_fingerprint) <> 32
   OR moderation_revision < 0
   OR is_answered <> (moderation_status = 'resolved');

SELECT COUNT(*) AS question_event_scope_violations
FROM question_moderation_events event
JOIN questions question ON question.id = event.question_id
WHERE event.organization_id <> question.organization_id
   OR event.webinar_id <> question.webinar_id
   OR event.webinar_session_id <> question.webinar_session_id
   OR event.registration_id <> question.registration_id
   OR char_length(btrim(event.reason)) NOT BETWEEN 3 AND 500;

SELECT COUNT(*) AS chat_moderator_suggestion_scope_violations
FROM ai_suggestions suggestion
LEFT JOIN questions question ON question.id = suggestion.question_id
LEFT JOIN ai_operation_provenance provenance ON provenance.id = suggestion.provenance_id
WHERE suggestion.type = 'chat_moderator_reply'
  AND (
    question.id IS NULL
    OR suggestion.organization_id <> question.organization_id
    OR suggestion.webinar_id <> question.webinar_id
    OR suggestion.webinar_session_id <> question.webinar_session_id
    OR suggestion.registration_id <> question.registration_id
    OR suggestion.question_revision IS NULL
    OR provenance.operation_type <> 'CHAT_MODERATOR_GROUNDED_REPLY'
    OR provenance.provider_id <> 'local_policy'
    OR suggestion.content_json->>'outcome' NOT IN ('GROUNDED', 'NO_BASIS', 'PERSONALIZED_LEGAL_ADVICE')
  );

SELECT COUNT(*) AS unreviewed_ai_moderator_publication_violations
FROM ai_suggestions suggestion
LEFT JOIN webinar_chat_messages message ON message.id = suggestion.published_chat_message_id
WHERE suggestion.type = 'chat_moderator_reply'
  AND (
    (suggestion.published_chat_message_id IS NOT NULL AND (
      suggestion.status <> 'accepted'
      OR suggestion.reviewed_by_user_id IS NULL
      OR suggestion.reviewed_at IS NULL
      OR message.message_type <> 'ai_moderator'
      OR message.is_synthetic <> true
      OR message.author_name <> 'AI-модератор'
    ))
    OR (suggestion.status <> 'accepted' AND suggestion.published_chat_message_id IS NOT NULL)
  );
