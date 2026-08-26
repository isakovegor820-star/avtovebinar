import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

const landing = source('crisis_premium/index.html');
const utils = source('crisis_premium/js/utils.js');
const registration = source('crisis_premium/js/registration.js');
const analytics = source('crisis_premium/js/analytics.js');
const partner = source('crisis_premium/js/partner.js');

describe('prelaunch funnel frontend remediations', () => {
  it('decorates every landing CTA and preserves separate first/last attribution snapshots', () => {
    expect(landing.match(/href="register\.html"/g)).toHaveLength(8);
    expect(utils).toContain("const firstTouchStorageKey = 'aspb_first_touch_attribution_v1'");
    expect(utils).toContain("const lastTouchStorageKey = 'aspb_last_touch_attribution_v1'");
    expect(utils).toContain("const persistentAttributionAllowed = cookieConsent === 'accepted'");
    expect(utils).toContain('persistentStore?.removeItem(firstTouchStorageKey)');
    expect(utils).toContain('firstSource:');
    expect(utils).toContain('firstLandingUrl:');
    expect(utils).toContain('export function withAttribution(href)');
    expect(registration).toContain("link.setAttribute('href', withAttribution(");
    for (const parameter of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'gclid',
      'yclid',
      'landing_url',
    ]) {
      expect(utils).toContain(parameter);
    }
  });

  it('tracks form start on first edit and renders persistent field-level errors', () => {
    expect(registration.match(/track\('registration_form_open'\)/g)).toHaveLength(1);
    expect(registration).toContain("form.addEventListener('input', trackFormStart, { once: true })");
    expect(registration).toContain("field.setAttribute('aria-invalid', 'true')");
    expect(registration).toContain("field.setAttribute('aria-describedby'");
    expect(registration).toContain('renderServerRegistrationErrors(form, error?.payload?.details)');
    expect(registration).toContain("track('registration_form_error'");
  });

  it('persists and retries analytics without changing its logical dedup key', () => {
    expect(analytics).toContain("const ANALYTICS_QUEUE_KEY = 'aspb_analytics_queue_v1'");
    expect(analytics).toContain('window.sessionStorage.setItem(ANALYTICS_QUEUE_KEY');
    expect(analytics).toContain('keepalive,');
    expect(analytics).toContain("response.status === 429 || response.status >= 500");
    expect(analytics).toContain("response?.headers?.get?.('retry-after')");
    expect(analytics).toContain("window.addEventListener('pagehide'");
    expect(analytics).toContain("track('user_exit')");
    expect(analytics).toContain('pending.set(payload.dedupKey');
  });

  it('keeps partner submission gated and retry-idempotent', () => {
    expect(partner).toContain('setAvailable(false)');
    expect(partner).toContain("document.addEventListener('aspb:room-ready'");
    expect(partner).toContain("accessStatus === 'live' || accessStatus === 'replay'");
    expect(partner).toContain('Форма заявки станет доступна после начала вебинара.');
    expect(partner).toContain("{ 'Idempotency-Key': pendingIdempotencyKey }");
    expect(partner).toContain('pendingPayloadFingerprint !== payloadFingerprint');
    expect(partner).not.toContain("form.removeAttribute('inert')");
  });
});
