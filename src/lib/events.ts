export const PUBLIC_ANALYTICS_EVENTS = [
  'page_view',
  'registration_click',
  'registration_form_open',
  'registration_submit',
  'registration_success',
  'telegram_click',
  'telegram_subscribe',
  'webinar_room_open',
  'video_start',
  'video_progress_25',
  'video_progress_50',
  'video_progress_75',
  'video_finish',
  'question_submit',
  'partner_application_submit',
  'partner_request_click'
] as const;

export type PublicAnalyticsEvent = (typeof PUBLIC_ANALYTICS_EVENTS)[number];
