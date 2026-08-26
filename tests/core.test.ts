import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    adminUser: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    auditLog: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  return { prisma };
});

import { createAccessToken, createAdminSession, hashToken, verifyAdminSession } from '../src/lib/tokens.js';
import { adminRouter } from '../src/routes/admin.js';
import { prisma } from '../src/lib/prisma.js';

function getRouteHandler(router: any, path: string, method: string) {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) return null;
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
import { registerSchema } from '../src/routes/public.js';
import { resolveFirstSeenAt } from '../src/routes/public/helpers.js';
import {
  getCountdown,
  getCurrentOrNextWebinarDate,
  getNextWebinarDate,
  getReplayExpiresAt,
  getSessionStatus,
  getWebinarAccess,
  WEBINAR_REPLAY_HOURS,
  WEBINAR_START_HOUR_MSK,
} from '../src/lib/time.js';
import { getClientIp } from '../src/lib/http.js';
import { CRM_STATUSES, isCrmStatus } from '../src/lib/crm.js';
import {
  formatWebinarRelativeDate,
  getDueReminderKind,
  getDueTelegramReminderKind,
  getPostWebinarFollowupDueAt,
} from '../src/lib/reminders.js';
import { getDueNewsSlot } from '../src/lib/telegramNews.js';
import { env, validateProductionSecurity } from '../src/lib/env.js';
import { PUBLIC_ANALYTICS_EVENTS } from '../src/lib/events.js';
import { hashPassword, verifyPassword } from '../src/lib/passwords.js';
import { eventSchema } from '../src/routes/public/events.js';
import { getWebinarVideoConfig } from '../src/lib/webinarVideo.js';
import { getParticipantSessionExpiresAt, PARTICIPANT_SESSION_TTL_DAYS } from '../src/lib/roomLinks.js';
import { parseVisitorId } from '../src/lib/visitor.js';
import { checkTelegramConnectivity, sendOperationalTelegramAlert } from '../src/lib/telegram.js';

describe('webinar time logic', () => {
  it('schedules webinar at 19:30 Moscow on the same Moscow day when the slot has not started', () => {
    const firstSeen = new Date('2026-05-21T09:15:00.000Z');
    const scheduledAt = getNextWebinarDate(firstSeen);
    expect(WEBINAR_START_HOUR_MSK).toBe(19);
    expect(scheduledAt.toISOString()).toBe('2026-05-21T16:30:00.000Z');
  });

  it('schedules the next daily 19:30 Moscow slot after today slot has started', () => {
    const firstSeen = new Date('2026-05-21T19:00:00.000Z');
    const scheduledAt = getNextWebinarDate(firstSeen);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:30:00.000Z');
  });

  it('schedules across the end of a month', () => {
    const scheduledAt = getNextWebinarDate(new Date('2026-05-31T19:00:00.000Z'));
    expect(scheduledAt.toISOString()).toBe('2026-06-01T16:30:00.000Z');
  });

  it('keeps the current daily slot during the scheduled webinar window', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-21T17:00:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-21T16:30:00.000Z');
  });

  it('selects tomorrow for acquisition after todays webinar has finished', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-21T20:31:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:30:00.000Z');
  });

  it('selects todays acquisition slot on the next morning, never yesterdays replay', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-22T07:00:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:30:00.000Z');
  });

  it('keeps todays acquisition slot through the exact configured end boundary', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-22T18:30:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:30:00.000Z');
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
    expect(getWebinarAccess(new Date('2026-05-29T10:00:01.000Z'), scheduledAt, 120).accessStatus).toBe('closed');
  });

  it('expires replay access 7 days after the webinar ends', () => {
    const scheduledAt = new Date('2026-05-22T08:00:00.000Z');
    expect(WEBINAR_REPLAY_HOURS).toBe(168);
    expect(getReplayExpiresAt(scheduledAt, 120).toISOString()).toBe('2026-05-29T10:00:00.000Z');
  });

  it('keeps a valid firstSeen value for attribution only', () => {
    const firstSeen = '2026-05-21T09:15:00.000Z';
    const resolved = resolveFirstSeenAt(firstSeen, new Date('2026-06-01T09:15:00.000Z'));
    expect(resolved.toISOString()).toBe(firstSeen);
  });

  it('uses the current time when firstSeen is invalid', () => {
    const now = new Date('2026-06-01T09:15:00.000Z');
    const resolved = resolveFirstSeenAt('invalid', now);
    expect(resolved).toBe(now);
  });
});

describe('client IP extraction', () => {
  it('uses Express req.ip instead of trusting x-forwarded-for directly', () => {
    const req = {
      ip: '10.0.0.42',
      headers: {
        'x-forwarded-for': '203.0.113.99',
      },
      socket: {
        remoteAddress: '10.0.0.42',
      },
    };

    expect(getClientIp(req as any)).toBe('10.0.0.42');
  });
});

describe('participant and analytics identity', () => {
  it('keeps participant cookie lifetime aligned with the seven-day privacy policy', () => {
    const now = new Date('2026-07-29T10:00:00.000Z');
    expect(PARTICIPANT_SESSION_TTL_DAYS).toBe(7);
    expect(getParticipantSessionExpiresAt(now).toISOString()).toBe('2026-08-05T10:00:00.000Z');
  });

  it('accepts generated visitor IDs and rejects malformed cookie values', () => {
    expect(parseVisitorId('FyVj0Lw2cL8Jf0O2XsSGyxbejlV3nL5M')).toBe('FyVj0Lw2cL8Jf0O2XsSGyxbejlV3nL5M');
    expect(parseVisitorId('../admin')).toBeNull();
    expect(parseVisitorId('short')).toBeNull();
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

describe('password hashing', () => {
  it('uses async scrypt hashes and verifies with timing-safe comparison', async () => {
    const stored = await hashPassword('StrongPassword123');
    expect(stored.startsWith('scrypt:')).toBe(true);
    await expect(verifyPassword('StrongPassword123', stored)).resolves.toBe(true);
    await expect(verifyPassword('WrongPassword123', stored)).resolves.toBe(false);
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
      ...overrides,
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
      getDueReminderKind(
        candidate({ reminder30mSentAt: new Date('2026-05-22T07:31:00.000Z') }),
        new Date('2026-05-22T07:45:00.000Z'),
      ),
    ).toBeNull();
  });

  it('uses separate fields for Telegram reminders', () => {
    expect(getDueTelegramReminderKind(candidate(), new Date('2026-05-21T09:00:00.000Z'))).toBe('24h');
    expect(
      getDueTelegramReminderKind(
        candidate({ telegramReminder24hSentAt: new Date('2026-05-21T09:01:00.000Z') }),
        new Date('2026-05-21T09:10:00.000Z'),
      ),
    ).toBeNull();
  });

  it('schedules post-webinar follow-up after the webinar is over', () => {
    expect(getPostWebinarFollowupDueAt(new Date('2026-05-22T08:00:00.000Z'), 120).toISOString()).toBe(
      '2026-05-22T10:10:00.000Z',
    );
  });

  it('formats Telegram reminder day relative to Moscow date', () => {
    expect(formatWebinarRelativeDate(new Date('2026-06-08T16:00:00.000Z'), new Date('2026-06-08T11:00:00.000Z'))).toBe(
      'сегодня',
    );
    expect(formatWebinarRelativeDate(new Date('2026-06-09T16:00:00.000Z'), new Date('2026-06-08T20:00:00.000Z'))).toBe(
      'завтра',
    );
  });
});

describe('security configuration', () => {
  function secureProductionConfig(overrides = {}) {
    return {
      NODE_ENV: 'production',
      PORT: 5174,
      PUBLIC_SITE_URL: 'https://aspb.example.com',
      DATABASE_URL: 'postgresql://example',
      ADMIN_LOGIN: 'owner@aspb.example.com',
      ADMIN_PASSWORD: 'StrongPassword123',
      ADMIN_DEV_BYPASS: 'false',
      ADMIN_COOKIE_SECRET: 'unit-test-admin-cookie-secret-with-32-chars',
      IP_HASH_SECRET: 'unit-test-ip-hash-secret-with-32-chars',
      METRICS_TOKEN: 'unit-test-metrics-token-with-32-chars',
      EMAIL_MODE: 'send',
      E2E_EMAIL_OUTBOX_ENABLED: 'off',
      MEDIA_STORAGE_PROVIDER: 'unconfigured',
      MEDIA_WORK_ROOT: '/var/lib/aspb/media-work',
      STT_PROVIDER: 'unconfigured',
      AI_ENRICHMENT_PROVIDER: 'unconfigured',
      MEDIA_MAX_UPLOAD_BYTES: 4_294_967_296,
      MEDIA_MAX_DURATION_SECONDS: 10_800,
      MEDIA_PART_SIZE_BYTES: 8_388_608,
      MEDIA_UPLOAD_CSP_ORIGINS: '',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_USER: 'smtp-user',
      SMTP_PASS: 'smtp-pass',
      EMAIL_FROM: 'АСПБ <no-reply@example.com>',
      TELEGRAM_GROUP_URL: 'https://t.me/example',
      TELEGRAM_ADMIN_BOT_TOKEN: 'admin-bot-token',
      TELEGRAM_ADMIN_BOT_USERNAME: 'aspb_admin_bot',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_USERNAME: '',
      TELEGRAM_ADMIN_CHAT_ID: '123456',
      TELEGRAM_OPERATIONAL_CHAT_ID: '654321',
      TELEGRAM_ADMIN_BOT_POLLING: 'off',
      TELEGRAM_NOTIFY_MODE: 'send',
      TELEGRAM_BOT_POLLING: 'off',
      TELEGRAM_PARTICIPANT_BOT_TOKEN: 'participant-bot-token',
      TELEGRAM_PARTICIPANT_BOT_USERNAME: 'jwjefgwreqfe_bot',
      TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: 'jwjefgwreqfe_bot',
      TELEGRAM_PARTICIPANT_BOT_POLLING: 'off',
      TELEGRAM_CONSULTANT_BOT_TOKEN: '',
      TELEGRAM_CONSULTANT_BOT_USERNAME: '',
      TELEGRAM_CONSULTANT_BOT_POLLING: 'off',
      TELEGRAM_NEWS_BROADCAST: 'off',
      TELEGRAM_NEWS_TIMES: '09:00',
      TELEGRAM_NEWS_RSS_URLS: '',
      WEBINAR_VIDEO_PROVIDER: 'hls',
      WEBINAR_VIDEO_HLS_URL: 'https://cdn.example.com/webinar/master.m3u8',
      WEBINAR_VIDEO_URL: '',
      WEBINAR_POSTER_URL: 'https://cdn.example.com/webinar/poster.jpg',
      WEBINAR_MEDIA_ORIGIN_TOKEN: 'unit-test-private-media-origin-token-123456',
      WEBINAR_VIDEO_DURATION_SECONDS: 568,
      WEBINAR_TEST_ROOM_MODE: 'off',
      WEBINAR_PREVIEW_MODE: 'off',
      CORS_ORIGIN: 'https://aspb.example.com',
      TRUST_PROXY: 'false',
      MODERATOR_NAME: 'Юлия, модератор АСПБ',
      MODERATOR_ROLE: 'модератор эфира',
      ...overrides,
    } as const;
  }

  it('rejects default production admin secrets', () => {
    expect(() =>
      validateProductionSecurity({
        NODE_ENV: 'production',
        PORT: 5174,
        PUBLIC_SITE_URL: 'https://example.com',
        DATABASE_URL: 'postgresql://example',
        ADMIN_LOGIN: 'admin',
        ADMIN_PASSWORD: 'weak-pass',
        ADMIN_DEV_BYPASS: 'false',
        ADMIN_COOKIE_SECRET: 'short-admin-cookie-secret',
        IP_HASH_SECRET: 'short-ip-hash-secret',
        EMAIL_MODE: 'log',
        E2E_EMAIL_OUTBOX_ENABLED: 'off',
        MEDIA_STORAGE_PROVIDER: 'unconfigured',
        STT_PROVIDER: 'unconfigured',
        AI_ENRICHMENT_PROVIDER: 'unconfigured',
        MEDIA_MAX_UPLOAD_BYTES: 4_294_967_296,
        MEDIA_MAX_DURATION_SECONDS: 10_800,
        MEDIA_PART_SIZE_BYTES: 8_388_608,
        MEDIA_UPLOAD_CSP_ORIGINS: '',
        SMTP_HOST: '',
        SMTP_PORT: 587,
        SMTP_USER: '',
        SMTP_PASS: '',
        EMAIL_FROM: 'АСПБ <no-reply@example.com>',
        TELEGRAM_GROUP_URL: 'https://t.me/example',
        TELEGRAM_ADMIN_BOT_TOKEN: '',
        TELEGRAM_ADMIN_BOT_USERNAME: '',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_BOT_USERNAME: '',
        TELEGRAM_ADMIN_CHAT_ID: '',
        TELEGRAM_ADMIN_BOT_POLLING: 'off',
        TELEGRAM_NOTIFY_MODE: 'log',
        TELEGRAM_BOT_POLLING: 'off',
        TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
        TELEGRAM_PARTICIPANT_BOT_USERNAME: '',
        TELEGRAM_PARTICIPANT_BOT_POLLING: 'off',
        TELEGRAM_CONSULTANT_BOT_TOKEN: '',
        TELEGRAM_CONSULTANT_BOT_USERNAME: '',
        TELEGRAM_CONSULTANT_BOT_POLLING: 'off',
        TELEGRAM_NEWS_BROADCAST: 'off',
        TELEGRAM_NEWS_TIMES: '09:00',
        TELEGRAM_NEWS_RSS_URLS: '',
        WEBINAR_VIDEO_PROVIDER: 'local',
        WEBINAR_VIDEO_HLS_URL: '',
        WEBINAR_VIDEO_URL: '',
        WEBINAR_POSTER_URL: '',
        WEBINAR_VIDEO_DURATION_SECONDS: 568,
        WEBINAR_TEST_ROOM_MODE: 'off',
        WEBINAR_PREVIEW_MODE: 'off',
        CORS_ORIGIN: 'https://example.com',
        TRUST_PROXY: 'false',
        MODERATOR_NAME: 'Юлия, модератор АСПБ',
        MODERATOR_ROLE: 'модератор эфира',
      }),
    ).toThrow(/Production security configuration/);
  });

  it('rejects local dev webinar test mode in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          WEBINAR_TEST_ROOM_MODE: 'on',
        }),
      ),
    ).toThrow(/WEBINAR_TEST_ROOM_MODE/);
  });

  it('rejects webinar preview mode in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          WEBINAR_PREVIEW_MODE: 'on',
        }),
      ),
    ).toThrow(/WEBINAR_PREVIEW_MODE/);
  });

  it('rejects EMAIL_MODE=send when SMTP credentials are missing', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          EMAIL_MODE: 'send',
          SMTP_HOST: '',
          SMTP_USER: '',
          SMTP_PASS: '',
        }),
      ),
    ).toThrow(/SMTP_HOST.*SMTP_USER.*SMTP_PASS/);
  });

  it('rejects the fake E2E email outbox switch in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          E2E_EMAIL_OUTBOX_ENABLED: 'on',
        }),
      ),
    ).toThrow(/E2E_EMAIL_OUTBOX_ENABLED/);
  });

  it('rejects the fake media storage adapter in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'test_fake',
        }),
      ),
    ).toThrow(/MEDIA_STORAGE_PROVIDER/);
  });

  it('rejects the fake speech-to-text adapter in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          STT_PROVIDER: 'test_fake',
        }),
      ),
    ).toThrow(/STT_PROVIDER/);
  });

  it('rejects the fake AI enrichment adapter in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          AI_ENRICHMENT_PROVIDER: 'test_fake',
        }),
      ),
    ).toThrow(/AI_ENRICHMENT_PROVIDER/);
  });

  it('requires complete S3 storage configuration and allows the versioned pipeline to replace legacy media URLs', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 's3',
          MEDIA_S3_ENDPOINT: 'https://storage.example.com',
          MEDIA_S3_BUCKET: undefined,
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: '',
          WEBINAR_POSTER_URL: '',
        }),
      ),
    ).toThrow(/MEDIA_S3_BUCKET/);

    expect(
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 's3',
          MEDIA_S3_ENDPOINT: 'https://storage.example.com',
          MEDIA_S3_BUCKET: 'aspb-private-media',
          MEDIA_S3_ACCESS_KEY_ID: 'access-key',
          MEDIA_S3_SECRET_ACCESS_KEY: 'secret-access-key-value',
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: '',
          WEBINAR_POSTER_URL: '',
          WEBINAR_MEDIA_ORIGIN_TOKEN: '',
        }),
      ).MEDIA_STORAGE_PROVIDER,
    ).toBe('s3');
  });

  it('requires a private absolute root for self-hosted versioned media', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'local_fs',
          MEDIA_LOCAL_ROOT: '/var/lib/aspb/media',
          MEDIA_WORK_ROOT: undefined,
        }),
      ),
    ).toThrow(/MEDIA_WORK_ROOT/);
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'local_fs',
          MEDIA_LOCAL_ROOT: '/var/lib/aspb/media',
          MEDIA_WORK_ROOT: `${process.cwd()}/crisis_premium/media-work`,
        }),
      ),
    ).toThrow(/MEDIA_WORK_ROOT/);
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'local_fs',
          MEDIA_LOCAL_ROOT: 'relative/media',
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: '',
          WEBINAR_POSTER_URL: '',
        }),
      ),
    ).toThrow(/MEDIA_LOCAL_ROOT/);
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'local_fs',
          MEDIA_LOCAL_ROOT: `${process.cwd()}/crisis_premium/private-media`,
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: '',
          WEBINAR_POSTER_URL: '',
        }),
      ),
    ).toThrow(/MEDIA_LOCAL_ROOT/);
    expect(
      validateProductionSecurity(
        secureProductionConfig({
          MEDIA_STORAGE_PROVIDER: 'local_fs',
          MEDIA_LOCAL_ROOT: '/var/lib/aspb/media',
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: '',
          WEBINAR_POSTER_URL: '',
          WEBINAR_MEDIA_ORIGIN_TOKEN: '',
        }),
      ).MEDIA_STORAGE_PROVIDER,
    ).toBe('local_fs');
  });

  it('requires provider-specific credentials when real STT or AI adapters are selected', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          STT_PROVIDER: 'yandex_speechkit',
        }),
      ),
    ).toThrow(/STT_YANDEX_API_KEY.*STT_YANDEX_FOLDER_ID.*STT_YANDEX_AUDIO_URI_PREFIX/);
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          AI_ENRICHMENT_PROVIDER: 'yandex_foundation_models',
        }),
      ),
    ).toThrow(/AI_YANDEX_API_KEY.*AI_YANDEX_FOLDER_ID.*AI_YANDEX_MODEL_URI/);

    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          STT_PROVIDER: 'yandex_speechkit',
          STT_YANDEX_API_KEY: 'speechkit-api-key-value',
          STT_YANDEX_FOLDER_ID: 'folder-id',
          STT_YANDEX_AUDIO_URI_PREFIX: 'http://localhost/private-audio',
          STT_YANDEX_ENDPOINT: 'https://stt.example.com/recognize',
          STT_YANDEX_OPERATION_ENDPOINT: 'https://stt.example.com/operations',
          STT_YANDEX_RESULT_ENDPOINT: 'https://stt.example.com/result',
          STT_YANDEX_DELETE_ENDPOINT: 'https://stt.example.com/delete',
        }),
      ),
    ).toThrow(/STT_YANDEX_AUDIO_URI_PREFIX must use non-local HTTPS/);

    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          AI_ENRICHMENT_PROVIDER: 'yandex_foundation_models',
          AI_YANDEX_API_KEY: 'foundation-models-api-key',
          AI_YANDEX_FOLDER_ID: 'folder-id',
          AI_YANDEX_MODEL_URI: 'gpt://folder-id/model/latest',
          AI_YANDEX_ENDPOINT: 'http://localhost/completion',
        }),
      ),
    ).toThrow(/AI_YANDEX_ENDPOINT must use non-local HTTPS/);
  });

  it('requires the expected participant bot username in production', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: undefined,
        }),
      ),
    ).toThrow(/TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME is required/);
  });

  it('rejects a participant bot username that differs from the deployment pin', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_PARTICIPANT_BOT_USERNAME: 'actual_participant_bot',
          TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: 'different_participant_bot',
        }),
      ),
    ).toThrow(/TELEGRAM_PARTICIPANT_BOT_USERNAME must be different_participant_bot/);
  });

  it('requires a production metrics token', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          METRICS_TOKEN: '',
        }),
      ),
    ).toThrow(/METRICS_TOKEN/);
  });

  it('requires the participant access bot in production even when Telegram delivery is in log mode', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_NOTIFY_MODE: 'log',
          TELEGRAM_ADMIN_BOT_TOKEN: '',
          TELEGRAM_ADMIN_CHAT_ID: '',
          TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
          TELEGRAM_PARTICIPANT_BOT_USERNAME: '',
        }),
      ),
    ).toThrow(/participant bot username|TELEGRAM_PARTICIPANT_BOT_TOKEN/i);
  });

  it('rejects missing bot settings when production Telegram send mode is enabled', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_NOTIFY_MODE: 'send',
          TELEGRAM_ADMIN_BOT_TOKEN: '',
          TELEGRAM_ADMIN_CHAT_ID: '',
          TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
          TELEGRAM_PARTICIPANT_BOT_USERNAME: '',
        }),
      ),
    ).toThrow(/TELEGRAM_ADMIN_BOT_TOKEN.*TELEGRAM_PARTICIPANT_BOT_TOKEN/s);
  });

  it('requires a separate PII-free operational Telegram chat in send mode', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_OPERATIONAL_CHAT_ID: '',
        }),
      ),
    ).toThrow(/TELEGRAM_OPERATIONAL_CHAT_ID/);
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_OPERATIONAL_CHAT_ID: '123456',
        }),
      ),
    ).toThrow(/must differ from TELEGRAM_ADMIN_CHAT_ID/);
  });

  it('rejects localhost production origins and video URLs', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          PUBLIC_SITE_URL: 'https://localhost',
          CORS_ORIGIN: 'https://localhost',
          WEBINAR_VIDEO_HLS_URL: 'https://localhost/video/master.m3u8',
          WEBINAR_POSTER_URL: 'https://127.0.0.1/poster.jpg',
        }),
      ),
    ).toThrow(/PUBLIC_SITE_URL.*CORS_ORIGIN.*WEBINAR_VIDEO_HLS_URL.*WEBINAR_POSTER_URL/s);
  });

  it('accepts a hardened production configuration', () => {
    expect(validateProductionSecurity(secureProductionConfig()).NODE_ENV).toBe('production');
  });

  it('rejects a degraded production email mode because participant access depends on delivery', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          EMAIL_MODE: 'log',
          SMTP_HOST: '',
          SMTP_USER: '',
          SMTP_PASS: '',
        }),
      ),
    ).toThrow(/EMAIL_MODE must be "send"/);
  });

  it('allows same-origin media mounted behind the authenticated media endpoint without an origin token', () => {
    const config = validateProductionSecurity(
      secureProductionConfig({
        PUBLIC_SITE_URL: 'https://aspb.example.com',
        WEBINAR_VIDEO_HLS_URL: 'https://aspb.example.com/crisis_premium/assets/media/webinar/hls/master.m3u8',
        WEBINAR_VIDEO_URL: 'https://aspb.example.com/crisis_premium/assets/media/webinar/video.mp4',
        WEBINAR_MEDIA_ORIGIN_TOKEN: '',
      }),
    );
    expect(config.WEBINAR_MEDIA_ORIGIN_TOKEN).toBe('');
  });

  it('requires an origin token for cross-origin media', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          WEBINAR_MEDIA_ORIGIN_TOKEN: '',
        }),
      ),
    ).toThrow(/WEBINAR_MEDIA_ORIGIN_TOKEN/);
  });

  it('allows production CDN MP4 without HLS when provider is cdn', () => {
    expect(
      validateProductionSecurity(
        secureProductionConfig({
          WEBINAR_VIDEO_PROVIDER: 'cdn',
          WEBINAR_VIDEO_HLS_URL: '',
          WEBINAR_VIDEO_URL: 'https://cdn.example.com/webinar/webinar.mp4',
        }),
      ).WEBINAR_VIDEO_URL,
    ).toBe('https://cdn.example.com/webinar/webinar.mp4');
  });

  it('keeps public analytics events on a fixed allowlist', () => {
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('page_view');
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('video_finish');
    expect(PUBLIC_ANALYTICS_EVENTS).not.toContain('made_up_event');
  });

  it('keeps historical server-side submit events distinguishable from client form lifecycle events', () => {
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('question_submit');
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('question_submitted');
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('partner_application_submit');
    expect(PUBLIC_ANALYTICS_EVENTS).toContain('partner_application_submitted');
  });

  it('limits public event metadata shape and size', () => {
    expect(() =>
      eventSchema.parse({
        eventName: 'question_submit_error',
        metadata: { error: 'Network error' },
      }),
    ).not.toThrow();

    expect(() =>
      eventSchema.parse({
        eventName: 'question_submit_error',
        metadata: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, index])),
      }),
    ).toThrow(/metadata must contain at most/);

    expect(() =>
      eventSchema.parse({
        eventName: 'question_submit_error',
        metadata: { error: 'x'.repeat(4097) },
      }),
    ).toThrow(/metadata must be at most/);
  });
});

describe('webinar video config', () => {
  function withVideoEnv<T>(overrides: Partial<typeof env>, task: () => T) {
    const original = {
      NODE_ENV: env.NODE_ENV,
      WEBINAR_VIDEO_URL: env.WEBINAR_VIDEO_URL,
      WEBINAR_VIDEO_HLS_URL: env.WEBINAR_VIDEO_HLS_URL,
      WEBINAR_VIDEO_PROVIDER: env.WEBINAR_VIDEO_PROVIDER,
    };
    Object.assign(env, overrides);
    try {
      return task();
    } finally {
      Object.assign(env, original);
    }
  }

  it('allows production MP4 URL without HLS when it is explicitly configured', () => {
    withVideoEnv(
      {
        NODE_ENV: 'production',
        WEBINAR_VIDEO_PROVIDER: 'cdn',
        WEBINAR_VIDEO_URL: 'https://cdn.example.com/webinar.mp4',
        WEBINAR_VIDEO_HLS_URL: undefined,
      },
      () => {
        const config = getWebinarVideoConfig();
        expect(config.src).toBe('https://cdn.example.com/webinar.mp4');
        expect(config.hlsSrc).toBeNull();
        expect(config.externalMp4Allowed).toBe(true);
        expect(config.localFallbackAllowed).toBe(false);
        expect(config.fallbackAllowed).toBe(false);
      },
    );
  });

  it('uses the broadcast MP4 fallback while keeping local fallback disabled in production', () => {
    withVideoEnv(
      {
        NODE_ENV: 'production',
        WEBINAR_VIDEO_PROVIDER: 'local',
        WEBINAR_VIDEO_URL: undefined,
        WEBINAR_VIDEO_HLS_URL: undefined,
      },
      () => {
        const config = getWebinarVideoConfig();
        expect(config.src).toBe(
          'https://aspb-partners.ru/crisis_premium/assets/media/vasiliy-artin-2026-06-10/video.mp4',
        );
        expect(config.externalMp4Allowed).toBe(true);
        expect(config.localFallbackAllowed).toBe(false);
      },
    );
  });
});

describe('Telegram health-check', () => {
  it('fails when the participant token belongs to a different bot username', async () => {
    const original = {
      TELEGRAM_NOTIFY_MODE: env.TELEGRAM_NOTIFY_MODE,
      TELEGRAM_ADMIN_BOT_TOKEN: env.TELEGRAM_ADMIN_BOT_TOKEN,
      TELEGRAM_ADMIN_BOT_USERNAME: env.TELEGRAM_ADMIN_BOT_USERNAME,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: env.TELEGRAM_BOT_USERNAME,
      TELEGRAM_PARTICIPANT_BOT_TOKEN: env.TELEGRAM_PARTICIPANT_BOT_TOKEN,
      TELEGRAM_PARTICIPANT_BOT_USERNAME: env.TELEGRAM_PARTICIPANT_BOT_USERNAME,
      TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: env.TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME,
      TELEGRAM_CONSULTANT_BOT_TOKEN: env.TELEGRAM_CONSULTANT_BOT_TOKEN,
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      const username = value.includes('participant-token') ? 'wrong_participant_bot' : 'aspb_admin_bot';
      return new Response(JSON.stringify({ ok: true, result: { username } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    Object.assign(env, {
      TELEGRAM_NOTIFY_MODE: 'send',
      TELEGRAM_ADMIN_BOT_TOKEN: 'admin-token',
      TELEGRAM_ADMIN_BOT_USERNAME: 'aspb_admin_bot',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_USERNAME: '',
      TELEGRAM_PARTICIPANT_BOT_TOKEN: 'participant-token',
      TELEGRAM_PARTICIPANT_BOT_USERNAME: 'aspb_participant_bot',
      TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: undefined,
      TELEGRAM_CONSULTANT_BOT_TOKEN: '',
    });

    try {
      await expect(checkTelegramConnectivity()).rejects.toThrow(
        /participant bot token returned @wrong_participant_bot, expected @aspb_participant_bot/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(env, original);
      vi.unstubAllGlobals();
    }
  });

  it('sends only a structured PII-free alert to the separate operational chat', async () => {
    const original = {
      TELEGRAM_NOTIFY_MODE: env.TELEGRAM_NOTIFY_MODE,
      TELEGRAM_ADMIN_BOT_TOKEN: env.TELEGRAM_ADMIN_BOT_TOKEN,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_OPERATIONAL_CHAT_ID: env.TELEGRAM_OPERATIONAL_CHAT_ID,
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 314 } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(env, {
      TELEGRAM_NOTIFY_MODE: 'send',
      TELEGRAM_ADMIN_BOT_TOKEN: 'admin-token',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_OPERATIONAL_CHAT_ID: '654321',
    });

    try {
      const result = await sendOperationalTelegramAlert({
        code: 'telegram_broadcast_worker_failed',
        subsystem: 'broadcast',
        severity: 'error',
        correlationId: 'lead@example.test token=raw-secret',
      });
      expect(result).toEqual({ sent: true, mode: 'send', providerMessageId: '314' });
      const request = fetchMock.mock.calls[0];
      const body = JSON.parse(String(request?.[1]?.body));
      expect(body.chat_id).toBe('654321');
      expect(body.text).toContain('Correlation ID: correlation_unavailable');
      expect(body.text).not.toContain('lead@example.test');
      expect(body.text).not.toContain('raw-secret');
      expect(body).not.toHaveProperty('reply_markup');
    } finally {
      Object.assign(env, original);
      vi.unstubAllGlobals();
    }
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

describe('registration validation logic', () => {
  const validData = {
    name: 'Иван',
    phone: '+79000000000',
    email: 'ivan@example.com',
    personalDataConsent: true,
    termsAccepted: true,
  };

  it('validates separate mandatory actions and defaults both marketing channels to false', () => {
    const parsed = registerSchema.parse(validData);
    expect(parsed.name).toBe('Иван');
    expect(parsed.personalDataConsent).toBe(true);
    expect(parsed.termsAccepted).toBe(true);
    expect(parsed.marketingEmailConsent).toBe(false);
    expect(parsed.marketingTelegramConsent).toBe(false);
  });

  it('accepts channel-specific optional marketing consent', () => {
    const parsed = registerSchema.parse({ ...validData, marketingTelegramConsent: true });
    expect(parsed.marketingEmailConsent).toBe(false);
    expect(parsed.marketingTelegramConsent).toBe(true);
  });

  it('parses explicit string booleans without treating "false" as consent', () => {
    const parsed = registerSchema.parse({
      ...validData,
      personalDataConsent: 'true',
      termsAccepted: 'true',
      marketingEmailConsent: 'false',
      marketingTelegramConsent: 'true',
    });
    expect(parsed.marketingEmailConsent).toBe(false);
    expect(parsed.marketingTelegramConsent).toBe(true);
  });

  it('rejects registration without either mandatory separate action', () => {
    expect(() => registerSchema.parse({ ...validData, personalDataConsent: false })).toThrow();
    expect(() => registerSchema.parse({ ...validData, termsAccepted: false })).toThrow();
    expect(() => registerSchema.parse({ ...validData, personalDataConsent: 'false' })).toThrow();
    expect(() => registerSchema.parse({ ...validData, termsAccepted: 'false' })).toThrow();
  });

  it('rejects ambiguous truthy values for every consent field', () => {
    for (const value of ['on', 'yes', '1', 1, {}, []]) {
      expect(() => registerSchema.parse({ ...validData, marketingEmailConsent: value })).toThrow();
    }
  });
});

describe('admin privilege checks', () => {
  const patchHandler = getRouteHandler(adminRouter, '/api/admin/users/:id', 'patch')!;
  const postHandler = getRouteHandler(adminRouter, '/api/admin/users', 'post')!;

  it('allows owner to modify anyone and promote to owner', async () => {
    vi.mocked(prisma.adminUser.findUnique).mockResolvedValue({
      id: 'user_2',
      name: 'Manager',
      email: 'manager@example.com',
      role: 'manager',
      isActive: true,
    } as any);

    vi.mocked(prisma.adminUser.update).mockResolvedValue({
      id: 'user_2',
      name: 'Manager',
      email: 'manager@example.com',
      role: 'owner',
      isActive: true,
    } as any);

    const req = {
      params: { id: 'user_2' },
      body: { role: 'owner' },
      admin: { id: 'owner_1', role: 'owner', email: 'owner@aspb.ru' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    await new Promise<void>(resolve => {
      const wrappedNext = (err: any) => {
        next(err);
        resolve();
      };
      res.json = vi.fn().mockImplementation(() => {
        resolve();
      });
      patchHandler(req as any, res as any, wrappedNext);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });

  it('prevents admin from modifying an owner user', async () => {
    vi.mocked(prisma.adminUser.findUnique).mockResolvedValue({
      id: 'user_owner',
      name: 'Real Owner',
      email: 'owner@example.com',
      role: 'owner',
      isActive: true,
    } as any);

    const req = {
      params: { id: 'user_owner' },
      body: { isActive: false },
      admin: { id: 'admin_1', role: 'admin', email: 'admin@aspb.ru' },
      headers: {},
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    await new Promise<void>(resolve => {
      const wrappedNext = (err: any) => {
        next(err);
        resolve();
      };
      res.json = vi.fn().mockImplementation(() => {
        resolve();
      });
      patchHandler(req as any, res as any, wrappedNext);
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('Недостаточно прав для изменения владельца');
  });

  it('prevents admin from promoting anyone to owner', async () => {
    vi.mocked(prisma.adminUser.findUnique).mockResolvedValue({
      id: 'user_manager',
      name: 'Manager',
      email: 'manager@example.com',
      role: 'manager',
      isActive: true,
    } as any);

    const req = {
      params: { id: 'user_manager' },
      body: { role: 'owner' },
      admin: { id: 'admin_1', role: 'admin', email: 'admin@aspb.ru' },
      headers: {},
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    await new Promise<void>(resolve => {
      const wrappedNext = (err: any) => {
        next(err);
        resolve();
      };
      res.json = vi.fn().mockImplementation(() => {
        resolve();
      });
      patchHandler(req as any, res as any, wrappedNext);
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('Недостаточно прав для назначения роли владельца');
  });

  it('prevents admin from creating an owner', async () => {
    const req = {
      body: {
        name: 'New Owner',
        email: 'newowner@example.com',
        password: 'Password12345!',
        role: 'owner',
      },
      admin: { id: 'admin_1', role: 'admin', email: 'admin@aspb.ru' },
      headers: {},
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    await new Promise<void>(resolve => {
      const wrappedNext = (err: any) => {
        next(err);
        resolve();
      };
      res.json = vi.fn().mockImplementation(() => {
        resolve();
      });
      postHandler(req as any, res as any, wrappedNext);
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('Недостаточно прав для создания владельца');
  });

  it('atomically prevents an owner from disabling the last active owner', async () => {
    vi.mocked(prisma.adminUser.findUnique).mockResolvedValue({
      id: 'owner_1',
      name: 'Only Owner',
      email: 'owner@example.com',
      role: 'owner',
      isActive: true,
    } as any);
    vi.mocked(prisma.adminUser.count).mockResolvedValue(1);

    const req = {
      params: { id: 'owner_1' },
      body: { isActive: false },
      admin: { id: 'owner_1', role: 'owner', email: 'owner@example.com' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    await new Promise<void>(resolve => {
      const wrappedNext = (error: unknown) => {
        next(error);
        resolve();
      };
      res.json.mockImplementation(() => resolve());
      patchHandler(req as any, res as any, wrappedNext);
    });

    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.adminUser.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'owner_1' } }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });
});
