export const PUBLIC_ANALYTICS_EVENTS = [
  'page_view',
  'registration_click',
  'registration_form_open',
  'partner_request_click'
] as const;

export type PublicAnalyticsEvent = (typeof PUBLIC_ANALYTICS_EVENTS)[number];
