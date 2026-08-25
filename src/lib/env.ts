import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const optionalUrl = z.preprocess(value => (value === '' ? undefined : value), z.string().url().optional());
const optionalEmail = z.preprocess(value => (value === '' ? undefined : value), z.string().email().optional());
const optionalTelegramUsername = z.preprocess(
  value => {
    if (value === '') return undefined;
    if (typeof value !== 'string') return value;
    return value.trim().replace(/^@/, '');
  },
  z
    .string()
    .regex(
      /^[a-zA-Z0-9_]{5,32}$/,
      'Telegram username must be 5-32 chars and contain only latin letters, digits, or underscores',
    )
    .optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive(),
  PUBLIC_SITE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  ADMIN_LOGIN: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(12),
  ADMIN_COOKIE_SECRET: z.string().min(32),
  IP_HASH_SECRET: z.string().min(32),
  METRICS_TOKEN: z.string().optional(),
  EMAIL_MODE: z.enum(['send', 'log']),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
  EMAIL_REPLY_TO: optionalEmail,
  TELEGRAM_GROUP_URL: z.string().url(),
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_BOT_USERNAME: optionalTelegramUsername,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: optionalTelegramUsername,
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_NOTIFY_MODE: z.enum(['send', 'log']),
  TELEGRAM_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: z.string().optional(),
  TELEGRAM_PARTICIPANT_BOT_USERNAME: optionalTelegramUsername,
  TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: optionalTelegramUsername,
  TELEGRAM_PARTICIPANT_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_CONSULTANT_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CONSULTANT_BOT_USERNAME: optionalTelegramUsername,
  TELEGRAM_CONSULTANT_BOT_POLLING: z.enum(['on', 'off']),
  // HTTP-прокси ТОЛЬКО для запросов к api.telegram.org (обход блокировки из РФ-ДЦ).
  // Пусто → прямое соединение. На проде указывает на локальный privoxy → WARP.
  TELEGRAM_HTTPS_PROXY: z.string().optional(),
  TELEGRAM_NEWS_BROADCAST: z.enum(['on', 'off']),
  TELEGRAM_MANUAL_BROADCAST: z.enum(['on', 'off']).optional(),
  TELEGRAM_NEWS_TIMES: z.string().min(1),
  TELEGRAM_NEWS_RSS_URLS: z.string().min(1),
  WEBINAR_VIDEO_URL: optionalUrl,
  WEBINAR_VIDEO_HLS_URL: optionalUrl,
  WEBINAR_POSTER_URL: optionalUrl,
  WEBINAR_MEDIA_ORIGIN_TOKEN: z.string().min(32).optional(),
  WEBINAR_VIDEO_PROVIDER: z.enum(['local', 'cdn', 'hls', 'streaming']).default('local'),
  WEBINAR_VIDEO_DURATION_SECONDS: z.coerce.number().int().positive().default(3860),
  WEBINAR_TEST_ROOM_MODE: z.enum(['on', 'off']),
  // Локальное превью комнаты для QA: открывает комнату как «живую» для держателей токена
  // регистрации, не затрагивая публичный лендинг. В production запрещено.
  WEBINAR_PREVIEW_MODE: z.enum(['on', 'off']).default('off'),
  CORS_ORIGIN: z.string().min(1),
  WORKER_ROLE: z.enum(['api', 'webinar', 'all']).optional(),
  TRUST_PROXY: z.enum(['false', 'true', '1', 'loopback']).default('false'),
  ADMIN_DEV_BYPASS: z.enum(['false', 'true']).default('false'),
  // Expand/switch flags for the tenant migration. Both remain off until the
  // passwordless user-session flow is ready; legacy /admin is independent.
  PLATFORM_ACCOUNTS_ENABLED: z.enum(['on', 'off']).default('off'),
  PLATFORM_TENANCY_ENFORCEMENT: z.enum(['on', 'off']).default('off'),
  // Имя и роль модератора эфира: показываются участникам в чате (приветствие +
  // ручные ответы из админки). Настраиваются без правки кода — поменять в .env.
  MODERATOR_NAME: z.string().trim().min(2).max(80).default('Юлия, модератор АСПБ'),
  MODERATOR_ROLE: z.string().trim().min(2).max(80).default('модератор эфира'),
});

type EnvConfig = z.infer<typeof envSchema>;
type ProductionSecurityConfig = Omit<EnvConfig, 'PLATFORM_ACCOUNTS_ENABLED' | 'PLATFORM_TENANCY_ENFORCEMENT'> &
  Partial<Pick<EnvConfig, 'PLATFORM_ACCOUNTS_ENABLED' | 'PLATFORM_TENANCY_ENFORCEMENT'>>;

export const ASPB_PARTICIPANT_BOT_USERNAME = 'jwjefgwreqfe_bot';

export function isStrongPassword(value: string) {
  return value.length >= 12 && /[a-zа-я]/i.test(value) && /\d/.test(value);
}

function parseOrigins(value: string) {
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function isLocalhostUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isLocalMountedMediaUrl(value: string | undefined, publicSiteUrl: string) {
  if (!value) return false;
  try {
    const media = new URL(value, publicSiteUrl);
    const publicOrigin = new URL(publicSiteUrl).origin;
    return media.origin === publicOrigin && media.pathname.startsWith('/crisis_premium/');
  } catch {
    return false;
  }
}

export function validateProductionSecurity<T extends ProductionSecurityConfig>(config: T): T {
  if (config.NODE_ENV !== 'production') {
    return config;
  }

  const errors: string[] = [];
  if (config.ADMIN_LOGIN === 'admin') {
    errors.push('ADMIN_LOGIN must not use the default "admin" in production');
  }
  if (config.ADMIN_DEV_BYPASS === 'true') {
    errors.push('ADMIN_DEV_BYPASS must be "false" in production (admin auth bypass is forbidden)');
  }
  if (!isStrongPassword(config.ADMIN_PASSWORD)) {
    errors.push(
      'ADMIN_PASSWORD must be changed and contain at least 12 characters with letters and numbers in production',
    );
  }
  if (config.ADMIN_COOKIE_SECRET.length < 32) {
    errors.push('ADMIN_COOKIE_SECRET must be unique and at least 32 characters in production');
  }
  if (config.IP_HASH_SECRET.length < 32) {
    errors.push('IP_HASH_SECRET must be unique and at least 32 characters in production');
  }
  if (!config.METRICS_TOKEN || config.METRICS_TOKEN.length < 16) {
    errors.push('METRICS_TOKEN is required and must be at least 16 characters in production');
  }
  const corsOrigins = parseOrigins(config.CORS_ORIGIN);
  if (!corsOrigins.length) {
    errors.push('CORS_ORIGIN is required in production');
  }
  if (corsOrigins.includes('*')) {
    errors.push('CORS_ORIGIN must not contain wildcard "*" in production');
  }
  if (!config.PUBLIC_SITE_URL.startsWith('https://')) {
    errors.push('PUBLIC_SITE_URL must use https in production');
  }
  if (isLocalhostUrl(config.PUBLIC_SITE_URL)) {
    errors.push('PUBLIC_SITE_URL must not use localhost in production');
  }
  if (config.EMAIL_MODE === 'send' && (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS)) {
    errors.push('SMTP_HOST, SMTP_USER and SMTP_PASS are required when EMAIL_MODE="send" in production');
  }
  if (config.EMAIL_MODE !== 'send') {
    errors.push('EMAIL_MODE must be "send" in production because participant access is delivered by email');
  }
  const needsTelegramAdmin =
    config.TELEGRAM_NOTIFY_MODE === 'send' ||
    config.TELEGRAM_ADMIN_BOT_POLLING === 'on' ||
    config.TELEGRAM_BOT_POLLING === 'on';
  if (
    needsTelegramAdmin &&
    (!(config.TELEGRAM_ADMIN_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN) ||
      !(config.TELEGRAM_ADMIN_BOT_USERNAME || config.TELEGRAM_BOT_USERNAME) ||
      !config.TELEGRAM_ADMIN_CHAT_ID)
  ) {
    errors.push(
      'TELEGRAM_ADMIN_BOT_TOKEN or TELEGRAM_BOT_TOKEN, admin bot username and TELEGRAM_ADMIN_CHAT_ID are required when Telegram admin notifications are enabled',
    );
  }
  if (
    !(config.TELEGRAM_PARTICIPANT_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN) ||
    !(config.TELEGRAM_PARTICIPANT_BOT_USERNAME || config.TELEGRAM_BOT_USERNAME)
  ) {
    errors.push(
      'TELEGRAM_PARTICIPANT_BOT_TOKEN or TELEGRAM_BOT_TOKEN and participant bot username are required for participant access in production',
    );
  }
  const participantBotUsername = config.TELEGRAM_PARTICIPANT_BOT_USERNAME || config.TELEGRAM_BOT_USERNAME;
  const expectedParticipantBotUsername = config.TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME;
  if (!expectedParticipantBotUsername) {
    errors.push('TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME is required for participant Telegram in production');
  }
  if (
    expectedParticipantBotUsername &&
    participantBotUsername?.toLowerCase() !== expectedParticipantBotUsername.toLowerCase()
  ) {
    errors.push(`TELEGRAM_PARTICIPANT_BOT_USERNAME must be ${expectedParticipantBotUsername} for this deployment`);
  }
  if (config.WEBINAR_TEST_ROOM_MODE === 'on') {
    errors.push('WEBINAR_TEST_ROOM_MODE must be "off" in production');
  }
  if (config.WEBINAR_PREVIEW_MODE === 'on') {
    errors.push('WEBINAR_PREVIEW_MODE must be "off" in production');
  }
  if (!config.WEBINAR_VIDEO_HLS_URL && !config.WEBINAR_VIDEO_URL) {
    errors.push('WEBINAR_VIDEO_HLS_URL or WEBINAR_VIDEO_URL is required in production');
  }
  if (
    (config.WEBINAR_VIDEO_PROVIDER === 'hls' || config.WEBINAR_VIDEO_PROVIDER === 'streaming') &&
    !config.WEBINAR_VIDEO_HLS_URL
  ) {
    errors.push('WEBINAR_VIDEO_HLS_URL is required for hls/streaming video providers');
  }
  if (!config.WEBINAR_POSTER_URL) {
    errors.push('WEBINAR_POSTER_URL is required in production');
  }
  const remoteMediaSources = [config.WEBINAR_VIDEO_HLS_URL, config.WEBINAR_VIDEO_URL].filter(
    source => source && !isLocalMountedMediaUrl(source, config.PUBLIC_SITE_URL),
  );
  if (remoteMediaSources.length > 0 && !config.WEBINAR_MEDIA_ORIGIN_TOKEN) {
    errors.push('WEBINAR_MEDIA_ORIGIN_TOKEN is required in production for the private media origin');
  }
  if (remoteMediaSources.some(source => source && new URL(source).protocol !== 'https:')) {
    errors.push('Remote WEBINAR_VIDEO_HLS_URL/WEBINAR_VIDEO_URL must use https in production');
  }
  for (const origin of corsOrigins) {
    if (isLocalhostUrl(origin)) {
      errors.push('CORS_ORIGIN must not use localhost in production');
      break;
    }
  }
  for (const [key, value] of [
    ['WEBINAR_VIDEO_HLS_URL', config.WEBINAR_VIDEO_HLS_URL],
    ['WEBINAR_VIDEO_URL', config.WEBINAR_VIDEO_URL],
    ['WEBINAR_POSTER_URL', config.WEBINAR_POSTER_URL],
  ] as const) {
    if (value && isLocalhostUrl(value)) {
      errors.push(`${key} must not use localhost in production`);
    }
  }

  if (errors.length) {
    throw new Error(`Production security configuration is invalid:\n- ${errors.join('\n- ')}`);
  }

  return config;
}

function runtimeEnv() {
  if (process.env.NODE_ENV !== 'test') {
    return process.env;
  }

  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: process.env.PORT ?? '5174',
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL ?? 'http://127.0.0.1:5174',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test',
    ADMIN_LOGIN: process.env.ADMIN_LOGIN ?? 'testadmin@example.com',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? `TestPassword${crypto.randomInt(100000, 999999)}`,
    ADMIN_COOKIE_SECRET: process.env.ADMIN_COOKIE_SECRET ?? crypto.randomBytes(32).toString('hex'),
    IP_HASH_SECRET: process.env.IP_HASH_SECRET ?? crypto.randomBytes(32).toString('hex'),
    METRICS_TOKEN: process.env.METRICS_TOKEN,
    EMAIL_MODE: process.env.EMAIL_MODE ?? 'log',
    SMTP_PORT: process.env.SMTP_PORT ?? '587',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'АСПБ <no-reply@test.local>',
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
    TELEGRAM_GROUP_URL: process.env.TELEGRAM_GROUP_URL ?? 'https://t.me/example',
    TELEGRAM_ADMIN_BOT_POLLING: process.env.TELEGRAM_ADMIN_BOT_POLLING ?? 'off',
    TELEGRAM_ADMIN_BOT_USERNAME: process.env.TELEGRAM_ADMIN_BOT_USERNAME,
    TELEGRAM_NOTIFY_MODE: process.env.TELEGRAM_NOTIFY_MODE ?? 'log',
    TELEGRAM_BOT_POLLING: process.env.TELEGRAM_BOT_POLLING ?? 'off',
    TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME: process.env.TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME,
    TELEGRAM_PARTICIPANT_BOT_POLLING: process.env.TELEGRAM_PARTICIPANT_BOT_POLLING ?? 'off',
    TELEGRAM_CONSULTANT_BOT_POLLING: process.env.TELEGRAM_CONSULTANT_BOT_POLLING ?? 'off',
    TELEGRAM_HTTPS_PROXY: process.env.TELEGRAM_HTTPS_PROXY,
    TELEGRAM_NEWS_BROADCAST: process.env.TELEGRAM_NEWS_BROADCAST ?? 'off',
    TELEGRAM_MANUAL_BROADCAST: process.env.TELEGRAM_MANUAL_BROADCAST ?? 'off',
    TELEGRAM_NEWS_TIMES: process.env.TELEGRAM_NEWS_TIMES ?? '09:00,11:30,14:00,16:30,19:00',
    TELEGRAM_NEWS_RSS_URLS:
      process.env.TELEGRAM_NEWS_RSS_URLS ??
      'https://www.consultant.ru/rss/hotdocs.xml,https://www.consultant.ru/rss/nw.xml,https://www.consultant.ru/rss/db.xml',
    WEBINAR_VIDEO_URL: process.env.WEBINAR_VIDEO_URL,
    WEBINAR_VIDEO_HLS_URL: process.env.WEBINAR_VIDEO_HLS_URL,
    WEBINAR_POSTER_URL: process.env.WEBINAR_POSTER_URL,
    WEBINAR_MEDIA_ORIGIN_TOKEN: process.env.WEBINAR_MEDIA_ORIGIN_TOKEN,
    WEBINAR_VIDEO_PROVIDER: process.env.WEBINAR_VIDEO_PROVIDER ?? 'local',
    WEBINAR_VIDEO_DURATION_SECONDS: process.env.WEBINAR_VIDEO_DURATION_SECONDS ?? '3860',
    WEBINAR_TEST_ROOM_MODE: process.env.WEBINAR_TEST_ROOM_MODE ?? 'off',
    CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5174',
    TRUST_PROXY: process.env.TRUST_PROXY ?? 'false',
    PLATFORM_ACCOUNTS_ENABLED: process.env.PLATFORM_ACCOUNTS_ENABLED ?? 'off',
    PLATFORM_TENANCY_ENFORCEMENT: process.env.PLATFORM_TENANCY_ENFORCEMENT ?? 'off',
  };
}

export const env = validateProductionSecurity(envSchema.parse(runtimeEnv()));
