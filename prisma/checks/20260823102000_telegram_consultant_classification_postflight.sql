-- Every returned count must be zero after BOT-006/BOT-007 expand.
SELECT COUNT(*) AS consultant_scope_violations
FROM telegram_consultant_messages message
LEFT JOIN registrations registration ON registration.id = message.registration_id
WHERE (message.organization_id IS NULL AND (
       message.webinar_id IS NOT NULL OR message.webinar_session_id IS NOT NULL
       OR message.registration_id IS NOT NULL OR message.crm_contact_id IS NOT NULL
     ))
   OR (message.registration_id IS NOT NULL AND (
       registration.id IS NULL
       OR registration.organization_id IS DISTINCT FROM message.organization_id
       OR registration.webinar_id IS DISTINCT FROM message.webinar_id
       OR registration.webinar_session_id <> message.webinar_session_id
       OR registration.crm_contact_id IS DISTINCT FROM message.crm_contact_id
     ));

SELECT COUNT(*) AS consultant_classification_violations
FROM telegram_consultant_messages message
WHERE message.topic NOT IN ('bankruptcy', 'tax', 'debt', 'partnership', 'webinar_access', 'other')
   OR message.intent NOT IN ('navigation', 'legal_question', 'manager_contact', 'partnership', 'other')
   OR message.urgency NOT IN ('low', 'normal', 'high')
   OR char_length(btrim(message.text)) NOT BETWEEN 1 AND 4000
   OR length(message.chat_id_hash) <> 64;

SELECT COUNT(*) AS consultant_correction_violations
FROM telegram_consultant_messages message
LEFT JOIN organization_memberships membership
  ON membership.id = message.handled_by_membership_id
 AND membership.organization_id = message.organization_id
WHERE message.corrected_at IS NOT NULL
  AND (
    message.correction_reason IS NULL
    OR char_length(btrim(message.correction_reason)) NOT BETWEEN 3 AND 500
    OR membership.id IS NULL
  );

SELECT COUNT(*) AS new_consultant_analytics_pii_violations
FROM events
WHERE event_name LIKE 'telegram_consultant_%'
  AND created_at >= TIMESTAMP '2026-08-23 00:00:00'
  AND metadata_json ?| ARRAY['chatId', 'text', 'telegramUserId', 'telegramUsername', 'telegramFirstName', 'email', 'phone'];
