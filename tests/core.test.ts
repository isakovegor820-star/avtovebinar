import { describe, expect, it } from 'vitest';
import { createAccessToken, createAdminSession, hashToken, verifyAdminSession } from '../src/lib/tokens.js';
import { getCountdown, getNextWebinarDate, getReplayExpiresAt, getSessionStatus, getWebinarAccess } from '../src/lib/time.js';
import { CRM_STATUSES, isCrmStatus } from '../src/lib/crm.js';
import { getDueReminderKind, getDueTelegramReminderKind, getPostWebinarFollowupDueAt } from '../src/lib/reminders.js';
import { getDueNewsSlot } from '../src/lib/telegramNews.js';
import { validateProductionSecurity } from '../src/lib/env.js';
import { PUBLIC_ANALYTICS_EVENTS } from '../src/lib/events.js';

describe('webinar time logic', () => {
  it('schedules webinar at 11:00 Moscow on the next Moscow day', () => {
    const firstSeen = new Date('2026-05-21T09:15:00.000Z');
    const scheduledAt = getNextWebinarDate(firstSeen);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T08:00:00.000Z');
  });

  it('returns scheduled, live and finished statuses', () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    expect(getSessionStatus(new Date('2026-05-22T07:59:00.000Z'), scheduledAt, 120)).toBe('scheduled');
    expect(getSessionStatus(new Date('2026-05-22T08:30:00.000Z'), scheduledAt, 120)).toBe('live');
    expect(getSessionStatus(new Date('2026-05-22T10:01:00.000Z'), scheduledAt, 120)).toBe('finished');
  });

  it('creates a positive countdown', () => {
    const countdown = getCountdown(new Date('2026-05-22T07:59:30.000Z'), new Date('2026-05-22T08:00:00.000Z'));
    expect(countdown.totalSeconds).toBe(30);
    expect(countdown.seconds).toBe(30);
  });

  it('calculates strict webinar access windows', () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    expect(getWebinarAccess(new Date('2026-05-22T07:40:00.000Z'), scheduledAt, 120).accessStatus).toBe('waiting');
    expect(getWebinarAccess(new Date('2026-05-22T07:59:00.000Z'), scheduledAt, 120).accessStatus).toBe('pre_live');
    expect(getWebinarAccess(new Date('2026-05-22T08:30:00.000Z'), scheduledAt, 120).accessStatus).toBe('live');
    expect(getWebinarAccess(new Date('2026-05-22T10:30:00.000Z'), scheduledAt, 120).accessStatus).toBe('replay');
    expect(getWebinarAccess(new Date('2026-05-24T10:00:01.000Z'), scheduledAt, 120).accessStatus).toBe('closed');
  });

  it('expires replay access 48 hours after the webinar ends', () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    expect(getReplayExpiresAt(scheduledAt, 120).toISOString()).toBe('2026-05-24T10:00:00.000Z');
  });
});

describe('token logic', () => {
  it('generates non-empty access tokens and stable hashes', () => {
    const token = createAccessToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });

  it('creates valid admin sessions', () => {
    const session = createAdminSession();
    expect(verifyAdminSession(session)).toBe(true);
    expect(verifyAdminSession(`${session}x`)).toBe(false);
  });
});

describe('email reminder logic', () => {
  const scheduledAt = new Date('2026-05-22T08:00:00.000Z');

  function candidate(overrides = {}) {
    return {
      id: 'reg_1',
      reminder24hSentAt: null,
      reminder3hSentAt: null,
      reminder30mSentAt: null,
      webinarSession: { scheduledAt },
      ...overrides
    };
  }

  it('selects the 24h reminder when the webinar is within a day', () => {
    expect(getDueReminderKind(candidate(), new Date('2026-05-21T09:00:00.000Z'))).toBe('24h');
  });

  it('selects the urgent reminder window instead of older missed reminders', () => {
    expect(getDueReminderKind(candidate(), new Date('2026-05-22T07:45:00.000Z'))).toBe('30m');
  });

  it('does not send the same reminder twice', () => {
    expect(
      getDueReminderKind(candidate({ reminder30mSentAt: new Date('2026-05-22T07:31:00.000Z') }), new Date('2026-05-22T07:45:00.000Z'))
    ).toBeNull();
  });

  it('uses separate fields for Telegram reminders', () => {
    expect(getDueTelegramReminderKind(candidate(), new Date('2026-05-21T09:00:00.000Z'))).toBe('24h');
    expect(
      getDueTelegramReminderKind(candidate({ telegramReminder24hSentAt: new Date('2026-05-21T09:01:00.000Z') }), new Date('2026-05-21T09:10:00.000Z'))
    ).toBeNull();
  });

  it('schedules post-webinar follow-up after the webinar is over', () => {
    expect(getPostWebinarFollowupDueAt(new Date('2026-05-22T08:00:00.000Z'), 120).toISOString()).toBe('2026-05-22T10:10:00.000Z');
  });
});

describe('security configuration', () => {
  it('rejects default production admin secrets', () => {
    expect(() =>
      validateProductionSecurity({
        NODE_ENV: 'production',
        PORT: 5174,
        PUBLIC_SITE_URL: 'https://example.com',
        DATABASE_URL: 'postgresql://example',
        ADMIN_LOGIN: 'admin',
        ADMIN_PASSWORD: 'admin123',
        ADMIN_COOKIE_SECRET: 'dev-admin-cookie-secret-change-me',
        IP_HASH_SECRET: 'dev-ip-hash-secret-change-me',
        EMAIL_MODE: 'log',
        SMTP_HOST: '',
        SMTP_PORT: 587,
        SMTP_USER: '',
        SMTP_PASS: '',
        EMAIL_FROM: 'АСПБ <no-reply@example.com>',
        TELEGRAM_GROUP_URL: 'https://t.me/example',
        TELEGRAM_ADMIN_BOT_TOKEN: '',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_BOT_USERNAME: '',
        TELEGRAM_ADMIN_CHAT_ID: '',
        TELEGRAM_ADMIN_BOT_POLLING: 'off',
        TELEGRAM_NOTIFY_MODE: 'log',
        TELEGRAM_BOT_POLLING: 'off',
        TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
        TELEGRAM_PARTICIPANT_BOT_USERNAME: '',
        TELEGRAM_PARTICIPANT_BOT_POLLING: 'off',
        TELEGRAM_NEWS_BROADCAST: 'off',
        TELEGRAM_NEWS_TIMES: '09:00',
        TELEGRAM_NEWS_RSS_URLS: '',
        WEBINAR_TEST_ROOM_MODE: 'off',
        CORS_ORIGIN: 'https://example.com'
      })
    ).toThrow(/Production security configuration/);
  });

  it('keeps public analytics events on a fixed allowlist', () => {
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('page_view');
    expect(PUBLIC_ANALYTICS_EVENTS).not.toContain('made_up_event');
  });
});

describe('CRM status logic', () => {
  it('recognizes only supported partner funnel statuses', () => {
    expect(CRM_STATUSES).toContain('contract_pending');
    expect(isCrmStatus('paid')).toBe(true);
    expect(isCrmStatus('unknown')).toBe(false);
  });
});

describe('Telegram news scheduler', () => {
  it('selects the latest due Moscow news slot', () => {
    const slot = getDueNewsSlot(new Date('2026-05-22T11:10:00.000Z'), '09:00,11:30,14:00');
    expect(slot?.slotKey).toBe('2026-05-22:14:00');
  });

  it('waits when no news slot is due yet', () => {
    expect(getDueNewsSlot(new Date('2026-05-22T04:30:00.000Z'), '09:00,11:30')).toBeNull();
  });
});
