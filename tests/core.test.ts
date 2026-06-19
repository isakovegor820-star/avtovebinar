import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => {
  return {
    prisma: {
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
    },
  };
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
  WEBINAR_DURATION_MINUTES,
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
import { checkTelegramConnectivity } from '../src/lib/telegram.js';

describe('webinar time logic', () => {
  it('schedules webinar at 19:00 Moscow on the same Moscow day when the slot has not started', () => {
    const firstSeen = new Date('2026-05-21T09:15:00.000Z');
    const scheduledAt = getNextWebinarDate(firstSeen);
    expect(WEBINAR_START_HOUR_MSK).toBe(19);
    expect(scheduledAt.toISOString()).toBe('2026-05-21T16:00:00.000Z');
  });

  it('schedules the next daily 19:00 Moscow slot after today slot has started', () => {
    const firstSeen = new Date('2026-05-21T16:15:00.000Z');
    const scheduledAt = getNextWebinarDate(firstSeen);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:00:00.000Z');
  });

  it('schedules across the end of a month', () => {
    const scheduledAt = getNextWebinarDate(new Date('2026-05-31T16:15:00.000Z'));
    expect(scheduledAt.toISOString()).toBe('2026-06-01T16:00:00.000Z');
  });

  it('keeps the current daily slot during the scheduled webinar window', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-21T16:30:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-21T16:00:00.000Z');
  });

  it('switches the room schedule to tomorrow after the daily webinar ends', () => {
    const scheduledAt = getCurrentOrNextWebinarDate(new Date('2026-05-21T18:01:00.000Z'), 120);
    expect(scheduledAt.toISOString()).toBe('2026-05-22T16:00:00.000Z');
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

  it('keeps firstSeen while the assigned webinar replay is still open', () => {
    const firstSeen = '2026-05-21T09:15:00.000Z';
    const assignedWebinar = getNextWebinarDate(new Date(firstSeen));
    const beforeReplayExpiry = new Date(
      getReplayExpiresAt(assignedWebinar, WEBINAR_DURATION_MINUTES).getTime() - 60 * 1000,
    );
    const resolved = resolveFirstSeenAt(firstSeen, beforeReplayExpiry);
    expect(resolved.toISOString()).toBe(firstSeen);
  });

  it('resets firstSeen after the assigned webinar replay expires', () => {
    const firstSeen = '2026-05-21T09:15:00.000Z';
    const assignedWebinar = getNextWebinarDate(new Date(firstSeen));
    const now = new Date(getReplayExpiresAt(assignedWebinar, WEBINAR_DURATION_MINUTES).getTime() + 1);
    const resolved = resolveFirstSeenAt(firstSeen, now);
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
      TELEGRAM_ADMIN_BOT_POLLING: 'off',
      TELEGRAM_NOTIFY_MODE: 'send',
      TELEGRAM_BOT_POLLING: 'off',
      TELEGRAM_PARTICIPANT_BOT_TOKEN: 'participant-bot-token',
      TELEGRAM_PARTICIPANT_BOT_USERNAME: 'aspb_participant_bot',
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

  it('allows EMAIL_MODE=log without SMTP in production (Telegram-only channel)', () => {
    expect(() =>
      validateProductionSecurity(
        secureProductionConfig({
          EMAIL_MODE: 'log',
          SMTP_HOST: '',
          SMTP_USER: '',
          SMTP_PASS: '',
        }),
      ),
    ).not.toThrow();
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

  it('allows production Telegram log mode without bot settings', () => {
    expect(
      validateProductionSecurity(
        secureProductionConfig({
          TELEGRAM_NOTIFY_MODE: 'log',
          TELEGRAM_ADMIN_BOT_TOKEN: '',
          TELEGRAM_ADMIN_CHAT_ID: '',
          TELEGRAM_PARTICIPANT_BOT_TOKEN: '',
          TELEGRAM_PARTICIPANT_BOT_USERNAME: '',
        }),
      ).TELEGRAM_NOTIFY_MODE,
    ).toBe('log');
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
    consent: true,
  };

  it('validates correct registration data and sets default marketingConsent to false', () => {
    const parsed = registerSchema.parse(validData);
    expect(parsed.name).toBe('Иван');
    expect(parsed.consent).toBe(true);
    expect(parsed.marketingConsent).toBe(false);
  });

  it('accepts explicit marketingConsent', () => {
    const parsed = registerSchema.parse({ ...validData, marketingConsent: true });
    expect(parsed.marketingConsent).toBe(true);
  });

  it('rejects registration without mandatory consent', () => {
    expect(() => registerSchema.parse({ ...validData, consent: false })).toThrow();
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
});
