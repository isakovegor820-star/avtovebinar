WITH new_contract_violations AS (
  SELECT event."id"
  FROM "events" event
  LEFT JOIN "webinars" webinar
    ON webinar."id" = event."webinar_id" AND webinar."organization_id" = event."organization_id"
  LEFT JOIN "webinar_sessions" session
    ON session."id" = event."webinar_session_id"
    AND session."webinar_id" = event."webinar_id"
    AND session."organization_id" = event."organization_id"
  LEFT JOIN "registrations" registration
    ON registration."id" = event."registration_id"
    AND registration."webinar_session_id" = event."webinar_session_id"
    AND registration."lead_id" IS NOT DISTINCT FROM event."lead_id"
    AND registration."user_id" IS NOT DISTINCT FROM event."user_id"
  LEFT JOIN "users" user_row
    ON user_row."id" = event."user_id" AND user_row."status" = 'active'
  LEFT JOIN "organization_memberships" membership
    ON membership."user_id" = event."user_id"
    AND membership."organization_id" = event."organization_id"
    AND membership."status" = 'active'
  WHERE event."schema_version" = 1
    AND (
      event."scope_kind" NOT IN ('platform', 'tenant')
      OR event."event_name" NOT IN (
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
      OR event."source" IS NULL OR event."source" NOT IN ('web', 'room', 'replay', 'registration', 'crm', 'email', 'telegram', 'worker', 'system', 'admin')
      OR event."correlation_id" IS NULL OR event."correlation_id" !~ '^[A-Za-z0-9._:-]{8,128}$'
      OR event."dedup_key" IS NULL OR event."dedup_key" !~ '^[A-Za-z0-9._:-]{16,128}$'
      OR event."payload_hash" IS NULL OR event."payload_hash" !~ '^[0-9a-f]{64}$'
      OR event."occurred_at" IS NULL
      OR event."occurred_at" IS DISTINCT FROM event."created_at"
      OR (event."metadata_json" IS NOT NULL AND jsonb_typeof(event."metadata_json"::jsonb) <> 'object')
      OR NOT analytics_metadata_is_safe(event."metadata_json"::jsonb)
      OR (event."scope_kind" = 'tenant' AND event."organization_id" IS NULL)
      OR (event."scope_kind" = 'platform' AND (event."organization_id" IS NOT NULL OR event."webinar_id" IS NOT NULL OR event."webinar_session_id" IS NOT NULL OR event."registration_id" IS NOT NULL OR event."lead_id" IS NOT NULL OR event."user_id" IS NOT NULL))
      OR (event."webinar_id" IS NOT NULL AND webinar."id" IS NULL)
      OR (event."webinar_session_id" IS NOT NULL AND session."id" IS NULL)
      OR (event."registration_id" IS NOT NULL AND registration."id" IS NULL)
      OR (event."user_id" IS NOT NULL AND event."registration_id" IS NULL AND (user_row."id" IS NULL OR membership."id" IS NULL))
    )
), duplicate_keys AS (
  SELECT "organization_id", "scope_kind", "dedup_key"
  FROM "events"
  WHERE "schema_version" = 1
  GROUP BY "organization_id", "scope_kind", "dedup_key"
  HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM "events" WHERE "schema_version" = 0) AS classified_legacy_events,
  (SELECT count(*) FROM "events" WHERE "schema_version" = 1) AS version_1_events,
  (SELECT count(*) FROM new_contract_violations) AS new_contract_violations,
  (SELECT count(*) FROM duplicate_keys) AS duplicate_dedup_scopes;

DO $$
DECLARE
  violation_count BIGINT;
  duplicate_count BIGINT;
BEGIN
  SELECT count(*) INTO violation_count
  FROM "events" event
  LEFT JOIN "webinars" webinar
    ON webinar."id" = event."webinar_id" AND webinar."organization_id" = event."organization_id"
  LEFT JOIN "webinar_sessions" session
    ON session."id" = event."webinar_session_id"
    AND session."webinar_id" = event."webinar_id"
    AND session."organization_id" = event."organization_id"
  LEFT JOIN "registrations" registration
    ON registration."id" = event."registration_id"
    AND registration."webinar_session_id" = event."webinar_session_id"
    AND registration."lead_id" IS NOT DISTINCT FROM event."lead_id"
    AND registration."user_id" IS NOT DISTINCT FROM event."user_id"
  LEFT JOIN "users" user_row
    ON user_row."id" = event."user_id" AND user_row."status" = 'active'
  LEFT JOIN "organization_memberships" membership
    ON membership."user_id" = event."user_id"
    AND membership."organization_id" = event."organization_id"
    AND membership."status" = 'active'
  WHERE event."schema_version" = 1
    AND (
      event."scope_kind" NOT IN ('platform', 'tenant')
      OR event."event_name" NOT IN (
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
      OR event."source" IS NULL OR event."source" NOT IN ('web', 'room', 'replay', 'registration', 'crm', 'email', 'telegram', 'worker', 'system', 'admin')
      OR event."correlation_id" IS NULL OR event."correlation_id" !~ '^[A-Za-z0-9._:-]{8,128}$'
      OR event."dedup_key" IS NULL OR event."dedup_key" !~ '^[A-Za-z0-9._:-]{16,128}$'
      OR event."payload_hash" IS NULL OR event."payload_hash" !~ '^[0-9a-f]{64}$'
      OR event."occurred_at" IS NULL OR event."occurred_at" IS DISTINCT FROM event."created_at"
      OR (event."metadata_json" IS NOT NULL AND jsonb_typeof(event."metadata_json"::jsonb) <> 'object')
      OR NOT analytics_metadata_is_safe(event."metadata_json"::jsonb)
      OR (event."scope_kind" = 'tenant' AND event."organization_id" IS NULL)
      OR (event."scope_kind" = 'platform' AND (event."organization_id" IS NOT NULL OR event."webinar_id" IS NOT NULL OR event."webinar_session_id" IS NOT NULL OR event."registration_id" IS NOT NULL OR event."lead_id" IS NOT NULL OR event."user_id" IS NOT NULL))
      OR (event."webinar_id" IS NOT NULL AND webinar."id" IS NULL)
      OR (event."webinar_session_id" IS NOT NULL AND session."id" IS NULL)
      OR (event."registration_id" IS NOT NULL AND registration."id" IS NULL)
      OR (event."user_id" IS NOT NULL AND event."registration_id" IS NULL AND (user_row."id" IS NULL OR membership."id" IS NULL))
    );

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT 1
    FROM "events"
    WHERE "schema_version" = 1
    GROUP BY "organization_id", "scope_kind", "dedup_key"
    HAVING count(*) > 1
  ) duplicate_scope;

  IF violation_count <> 0 OR duplicate_count <> 0 THEN
    RAISE EXCEPTION 'ANA-006 postflight failed: contract=%, duplicate=%', violation_count, duplicate_count;
  END IF;
END;
$$;
