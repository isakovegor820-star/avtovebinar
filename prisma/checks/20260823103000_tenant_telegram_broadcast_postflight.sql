-- Every returned count must be zero after BOT-008/BOT-009/BOT-011/BOT-012 expand.
SELECT COUNT(*) AS tenant_broadcast_job_scope_violations
FROM telegram_broadcast_jobs job
LEFT JOIN webinar_sessions session
  ON session.id = job.webinar_session_id
 AND session.webinar_id = job.webinar_id
 AND session.organization_id = job.organization_id
WHERE job.organization_id IS NOT NULL
  AND (session.id IS NULL OR job.requester_membership_id IS NULL OR job.template_id IS NULL
       OR job.preview_id IS NULL OR job.correlation_id IS NULL);

SELECT COUNT(*) AS tenant_broadcast_recipient_scope_violations
FROM telegram_broadcast_recipients recipient
JOIN telegram_broadcast_jobs job ON job.id = recipient.job_id
LEFT JOIN registrations registration ON registration.id = recipient.registration_id
WHERE recipient.organization_id IS NOT NULL
  AND (recipient.organization_id IS DISTINCT FROM job.organization_id
       OR recipient.webinar_id IS DISTINCT FROM job.webinar_id
       OR recipient.webinar_session_id IS DISTINCT FROM job.webinar_session_id
       OR registration.organization_id IS DISTINCT FROM recipient.organization_id
       OR registration.webinar_id IS DISTINCT FROM recipient.webinar_id
       OR registration.webinar_session_id <> recipient.webinar_session_id
       OR registration.lead_id <> recipient.lead_id);

SELECT COUNT(*) AS published_template_violations
FROM telegram_broadcast_templates template
WHERE template.status IN ('published', 'archived')
  AND position('{{room_link}}' IN template.text) = 0;

SELECT COUNT(*) AS consumed_preview_without_job
FROM telegram_broadcast_previews preview
LEFT JOIN telegram_broadcast_jobs job ON job.preview_id = preview.id
WHERE preview.consumed_at IS NOT NULL AND job.id IS NULL;

SELECT COUNT(*) AS tenant_broadcast_sensitive_event_metadata
FROM telegram_bot_events event
WHERE event.event_type LIKE 'tenant_broadcast_%'
  AND event.metadata_json ?| ARRAY['chatId', 'email', 'phone', 'token', 'signedUrl', 'text'];
