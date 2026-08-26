-- ANA-006 read-only preflight. The duplicate count is deliberately a heuristic
-- for legacy rows: same logical actor/scope/name/payload inside one second.
WITH event_scope AS (
  SELECT
    event."id",
    event."event_name",
    event."source",
    event."metadata_json"::jsonb AS metadata_json,
    event."registration_id",
    event."webinar_session_id",
    event."visitor_id",
    event."page",
    event."created_at",
    session."organization_id"
  FROM "events" event
  LEFT JOIN "webinar_sessions" session ON session."id" = event."webinar_session_id"
), potential_duplicate_groups AS (
  SELECT count(*) - 1 AS duplicate_rows
  FROM event_scope
  GROUP BY
    coalesce("organization_id", '__platform_or_legacy__'),
    "event_name",
    coalesce("registration_id", "visitor_id", '__anonymous__'),
    coalesce("webinar_session_id", ''),
    coalesce("page", ''),
    coalesce("metadata_json"::text, ''),
    date_trunc('second', "created_at")
  HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM event_scope) AS total_existing_events,
  (SELECT count(*) FROM event_scope WHERE "organization_id" IS NULL) AS events_without_tenant_scope,
  (SELECT count(*) FROM event_scope WHERE "webinar_session_id" IS NULL) AS events_without_session_scope,
  (SELECT count(*) FROM event_scope WHERE "registration_id" IS NULL) AS events_without_registration_scope,
  coalesce((SELECT sum(duplicate_rows) FROM potential_duplicate_groups), 0) AS potential_duplicate_rows;

SELECT
  "event_name",
  count(*) AS unknown_event_type_rows
FROM "events"
WHERE "event_name" NOT IN (
  'page_view',
  'registration_click', 'registration_form_open', 'registration_submit', 'registration_success',
  'telegram_click', 'telegram_subscribe',
  'webinar_room_open', 'webinar_room_waiting', 'viewer_heartbeat',
  'video_start', 'video_progress_25', 'video_progress_50', 'video_progress_75', 'video_finish',
  'recordings_open', 'recording_open', 'recording_play',
  'recording_progress_25', 'recording_progress_50', 'recording_progress_75', 'recording_finish',
  'recording_cta_click', 'chapter_open', 'transcript_search',
  'question_submit', 'question_submit_attempt', 'question_submitted', 'question_submit_error',
  'partner_application_submit', 'partner_application_submitted', 'partner_application_error',
  'partner_form_opened', 'partner_request_click', 'participant_login_request',
  'admin_manual_telegram_reminder', 'telegram_broadcast', 'telegram_news_broadcast',
  'telegram_broadcast_completed', 'telegram_repeat_start', 'telegram_start_without_registration',
  'telegram_participant_command', 'telegram_consultant_start',
  'telegram_consultant_contact_request', 'telegram_consultant_message'
)
GROUP BY "event_name"
ORDER BY unknown_event_type_rows DESC, "event_name";

WITH RECURSIVE metadata_nodes AS (
  SELECT event."id" AS event_id, NULL::text AS key, event."metadata_json"::jsonb AS value
  FROM "events" event
  WHERE event."metadata_json" IS NOT NULL
  UNION ALL
  SELECT node.event_id, child.key, child.value
  FROM metadata_nodes node
  CROSS JOIN LATERAL (
    SELECT object_item.key, object_item.value
    FROM jsonb_each(CASE WHEN jsonb_typeof(node.value) = 'object' THEN node.value ELSE '{}'::jsonb END) object_item
    UNION ALL
    SELECT NULL::text, array_item.value
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(node.value) = 'array' THEN node.value ELSE '[]'::jsonb END) array_item
  ) child
), forbidden AS (
  SELECT DISTINCT event_id
  FROM metadata_nodes
  WHERE key IS NOT NULL
    AND (
      regexp_replace(lower(key), '[^a-z0-9]', '', 'g') ~ '(email|phone|telephone|chatid|bottoken|accesstoken|refreshtoken|authorization|cookie|signedurl|storagekey|providersecret|password|requestbody|ipaddress)'
      OR regexp_replace(lower(key), '[^a-z0-9]', '', 'g') IN ('token', 'secret', 'ip', 'proto', 'prototype', 'constructor', 'clientsproblem', 'questiontext', 'message', 'text')
    )
)
SELECT count(*) AS events_with_forbidden_metadata_keys FROM forbidden;

SELECT coalesce("source", '__null__') AS source, count(*) AS event_count
FROM "events"
GROUP BY coalesce("source", '__null__')
ORDER BY event_count DESC, source;
