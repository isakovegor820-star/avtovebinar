BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Keep the database allowlist aligned with ANALYTICS_EVENT_REGISTRY. The
-- browser already emits these canonical funnel events; rejecting them here
-- silently loses form-error, sound, CTA and exit analytics.
ALTER TABLE "events"
  DROP CONSTRAINT "events_v1_known_event_type_check";

ALTER TABLE "events"
  ADD CONSTRAINT "events_v1_known_event_type_check" CHECK (
    "schema_version" = 0 OR "event_name" IN (
      'page_view',
      'registration_click', 'registration_form_open', 'registration_form_error',
      'registration_submit', 'registration_success',
      'telegram_click', 'telegram_subscribe',
      'webinar_room_open', 'webinar_room_waiting', 'viewer_heartbeat',
      'sound_on',
      'video_start', 'video_progress_25', 'video_progress_50', 'video_progress_75', 'video_finish',
      'cta_appear', 'cta_click', 'user_exit',
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
  ) NOT VALID;

ALTER TABLE "events"
  VALIDATE CONSTRAINT "events_v1_known_event_type_check";

COMMIT;
