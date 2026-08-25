import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const optionalUrl = z.preprocess(value => (value === '' ? undefined : value), z.string().url().optional());
const optionalEmail = z.preprocess(value => (value === '' ? undefined : value), z.string().email().optional());
const optionalSecret = z.preprocess(value => (value === '' ? undefined : value), z.string().min(32).optional());
const optionalProviderValue = (minimumLength: number) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(minimumLength).optional(),
  );
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
  WEBINAR_ACCESS_HASH_SECRET: optionalSecret,
  METRICS_TOKEN: z.string().optional(),
  EMAIL_MODE: z.enum(['send', 'log']),
  // Allows deterministic outbox assertions without enabling SMTP. The
  // registration layer activates it only under NODE_ENV=test.
  E2E_EMAIL_OUTBOX_ENABLED: z.enum(['on', 'off']).default('off'),
  MEDIA_STORAGE_PROVIDER: z.enum(['unconfigured', 'local_fs', 's3', 'test_fake']).default('unconfigured'),
  MEDIA_LOCAL_ROOT: optionalProviderValue(2),
  MEDIA_S3_ENDPOINT: optionalUrl,
  MEDIA_S3_REGION: z.string().trim().min(1).default('ru-central1'),
  MEDIA_S3_BUCKET: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .optional(),
  ),
  MEDIA_S3_ACCESS_KEY_ID: optionalProviderValue(3),
  MEDIA_S3_SECRET_ACCESS_KEY: optionalProviderValue(16),
  MEDIA_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  MEDIA_SIGNED_OPERATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  MEDIA_TRANSCODE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(21_600).default(7_200),
  MEDIA_HLS_SEGMENT_SECONDS: z.coerce.number().int().min(2).max(20).default(6),
  MEDIA_FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
  MEDIA_FFPROBE_PATH: z.string().trim().min(1).default('ffprobe'),
  MEDIA_WORK_ROOT: optionalProviderValue(2),
  MEDIA_PROCESSING_SPACE_MULTIPLIER: z.coerce.number().int().min(2).max(8).default(4),
  MEDIA_PROCESSING_RESERVE_BYTES: z.coerce.number().int().positive().default(1_073_741_824),
  MEDIA_MIN_FREE_INODES: z.coerce.number().int().positive().default(10_000),
  MEDIA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  CONTENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  MEDIA_QUEUE_ALERT_THRESHOLD: z.coerce.number().int().positive().default(100),
  CONTENT_QUEUE_ALERT_THRESHOLD: z.coerce.number().int().positive().default(100),
  STT_PROVIDER: z.enum(['unconfigured', 'yandex_speechkit', 'test_fake']).default('unconfigured'),
  STT_YANDEX_API_KEY: optionalProviderValue(16),
  STT_YANDEX_FOLDER_ID: optionalProviderValue(3),
  STT_YANDEX_ENDPOINT: z.string().url().default('https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync'),
  STT_YANDEX_OPERATION_ENDPOINT: z.string().url().default('https://stt.api.cloud.yandex.net/operations'),
  STT_YANDEX_RESULT_ENDPOINT: z.string().url().default('https://stt.api.cloud.yandex.net/stt/v3/getRecognition'),
  STT_YANDEX_DELETE_ENDPOINT: z.string().url().default('https://stt.api.cloud.yandex.net/stt/v3/deleteRecognition'),
  STT_YANDEX_AUDIO_URI_PREFIX: optionalUrl,
  STT_YANDEX_MODEL: z.string().trim().min(1).default('general'),
  STT_YANDEX_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
  STT_YANDEX_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(21_600).default(7_200),
  AI_ENRICHMENT_PROVIDER: z.enum(['unconfigured', 'yandex_foundation_models', 'test_fake']).default('unconfigured'),
  AI_YANDEX_API_KEY: optionalProviderValue(16),
  AI_YANDEX_FOLDER_ID: optionalProviderValue(3),
  AI_YANDEX_MODEL_URI: optionalProviderValue(3),
  AI_YANDEX_ENDPOINT: z.string().url().default('https://llm.api.cloud.yandex.net/foundationModels/v1/completion'),
  AI_YANDEX_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4_294_967_296),
  MATERIAL_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(524_288_000).default(104_857_600),
  MEDIA_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(10_800),
  MEDIA_PART_SIZE_BYTES: z.coerce.number().int().min(5_242_880).default(8_388_608),
  MEDIA_UPLOAD_CSP_ORIGINS: z.string().default(''),
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
  TELEGRAM_OPERATIONAL_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_NOTIFY_MODE: z.enum(['send', 'log']),
  TELEGRAM_CALLBACK_SECRET: optionalSecret,
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
  // ASPB is a single-owner webinar service. Tenant tables remain as a data
  // boundary, but public self-service organizations are disabled in normal
  // runtime. Tests can opt out to keep cross-tenant safety coverage.
  ASPB_SINGLE_ORGANIZATION_MODE: z.enum(['on', 'off']).default('on'),
  PLATFORM_TENANCY_ENFORCEMENT: z.enum(['on', 'off']).default('off'),
  CREATOR_DASHBOARD_ENABLED: z.enum(['on', 'off']).default('off'),
  PUBLIC_CATALOG_ENABLED: z.enum(['on', 'off']).default('off'),
  TENANT_CRM_ENABLED: z.enum(['on', 'off']).default('off'),
  TENANT_TELEGRAM_BOTS_ENABLED: z.enum(['on', 'off']).default('off'),
  // Destructive retention remains disabled until a separately reviewed policy release.
  RETENTION_APPLY_ENABLED: z.enum(['on', 'off']).default('off'),
  // Имя и роль модератора эфира: показываются участникам в чате (приветствие +
  // ручные ответы из админки). Настраиваются без правки кода — поменять в .env.
  MODERATOR_NAME: z.string().trim().min(2).max(80).default('Юлия, модератор АСПБ'),
  MODERATOR_ROLE: z.string().trim().min(2).max(80).default('модератор эфира'),
});

type EnvConfig = z.infer<typeof envSchema>;
type DefaultedProviderConfigKey =
  | 'MEDIA_S3_REGION'
  | 'MEDIA_S3_FORCE_PATH_STYLE'
  | 'MEDIA_SIGNED_OPERATION_TTL_SECONDS'
  | 'MEDIA_TRANSCODE_TIMEOUT_SECONDS'
  | 'MEDIA_HLS_SEGMENT_SECONDS'
  | 'MEDIA_FFMPEG_PATH'
  | 'MEDIA_FFPROBE_PATH'
  | 'MEDIA_PROCESSING_SPACE_MULTIPLIER'
  | 'MEDIA_PROCESSING_RESERVE_BYTES'
  | 'MEDIA_MIN_FREE_INODES'
  | 'MEDIA_WORKER_CONCURRENCY'
  | 'MATERIAL_MAX_UPLOAD_BYTES'
  | 'CONTENT_WORKER_CONCURRENCY'
  | 'MEDIA_QUEUE_ALERT_THRESHOLD'
  | 'CONTENT_QUEUE_ALERT_THRESHOLD'
  | 'RETENTION_APPLY_ENABLED'
  | 'STT_YANDEX_ENDPOINT'
  | 'STT_YANDEX_OPERATION_ENDPOINT'
  | 'STT_YANDEX_RESULT_ENDPOINT'
  | 'STT_YANDEX_DELETE_ENDPOINT'
  | 'STT_YANDEX_MODEL'
  | 'STT_YANDEX_POLL_INTERVAL_MS'
  | 'STT_YANDEX_TIMEOUT_SECONDS'
  | 'AI_YANDEX_ENDPOINT'
  | 'AI_YANDEX_TIMEOUT_SECONDS';
type ProductionSecurityConfig = Omit<
  EnvConfig,
  | 'ASPB_SINGLE_ORGANIZATION_MODE'
  | 'PLATFORM_ACCOUNTS_ENABLED'
  | 'PLATFORM_TENANCY_ENFORCEMENT'
  | 'CREATOR_DASHBOARD_ENABLED'
  | 'PUBLIC_CATALOG_ENABLED'
  | 'TENANT_CRM_ENABLED'
  | 'TENANT_TELEGRAM_BOTS_ENABLED'
  | 'STT_PROVIDER'
  | 'AI_ENRICHMENT_PROVIDER'
  | DefaultedProviderConfigKey
> &
  Partial<
    Pick<
      EnvConfig,
      | 'ASPB_SINGLE_ORGANIZATION_MODE'
      | 'PLATFORM_ACCOUNTS_ENABLED'
      | 'PLATFORM_TENANCY_ENFORCEMENT'
      | 'CREATOR_DASHBOARD_ENABLED'
      | 'PUBLIC_CATALOG_ENABLED'
      | 'TENANT_CRM_ENABLED'
      | 'TENANT_TELEGRAM_BOTS_ENABLED'
      | 'STT_PROVIDER'
      | 'AI_ENRICHMENT_PROVIDER'
      | DefaultedProviderConfigKey
    >
  >;

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
  if (config.E2E_EMAIL_OUTBOX_ENABLED === 'on') {
    errors.push('E2E_EMAIL_OUTBOX_ENABLED must be "off" in production');
  }
  if (config.RETENTION_APPLY_ENABLED === 'on') {
    errors.push('RETENTION_APPLY_ENABLED must remain "off" until a reviewed retention policy release');
  }
  if (config.MEDIA_STORAGE_PROVIDER === 'test_fake') {
    errors.push('MEDIA_STORAGE_PROVIDER=test_fake is forbidden in production');
  }
  if (config.STT_PROVIDER === 'test_fake') {
    errors.push('STT_PROVIDER=test_fake is forbidden in production');
  }
  if (config.AI_ENRICHMENT_PROVIDER === 'test_fake') {
    errors.push('AI_ENRICHMENT_PROVIDER=test_fake is forbidden in production');
  }
  if (config.MEDIA_STORAGE_PROVIDER === 's3') {
    if (
      !config.MEDIA_S3_ENDPOINT ||
      !config.MEDIA_S3_BUCKET ||
      !config.MEDIA_S3_ACCESS_KEY_ID ||
      !config.MEDIA_S3_SECRET_ACCESS_KEY
    ) {
      errors.push(
        'MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY are required when MEDIA_STORAGE_PROVIDER="s3"',
      );
    }
    if (
      config.MEDIA_S3_ENDPOINT &&
      (!config.MEDIA_S3_ENDPOINT.startsWith('https://') || isLocalhostUrl(config.MEDIA_S3_ENDPOINT))
    ) {
      errors.push('MEDIA_S3_ENDPOINT must use non-local HTTPS in production');
    }
  }
  if (config.MEDIA_STORAGE_PROVIDER === 'local_fs') {
    const configuredRoot = config.MEDIA_LOCAL_ROOT ? path.resolve(config.MEDIA_LOCAL_ROOT) : null;
    const publicRoot = path.resolve(process.cwd(), 'crisis_premium');
    const relativeToPublic = configuredRoot ? path.relative(publicRoot, configuredRoot) : '';
    if (
      !config.MEDIA_LOCAL_ROOT ||
      !path.isAbsolute(config.MEDIA_LOCAL_ROOT) ||
      configuredRoot === path.parse(configuredRoot ?? '/').root ||
      (configuredRoot !== null &&
        (relativeToPublic === '' || (!relativeToPublic.startsWith('..') && !path.isAbsolute(relativeToPublic))))
    ) {
      errors.push('MEDIA_LOCAL_ROOT must be an absolute private directory outside the public web root');
    }
  }
  const configuredWorkRoot = config.MEDIA_WORK_ROOT ? path.resolve(config.MEDIA_WORK_ROOT) : null;
  const publicRoot = path.resolve(process.cwd(), 'crisis_premium');
  const workRelativeToPublic = configuredWorkRoot ? path.relative(publicRoot, configuredWorkRoot) : '';
  if (
    (config.MEDIA_STORAGE_PROVIDER !== 'unconfigured' && !configuredWorkRoot) ||
    (configuredWorkRoot !== null &&
      (!path.isAbsolute(config.MEDIA_WORK_ROOT ?? '') ||
        configuredWorkRoot === path.parse(configuredWorkRoot).root ||
        workRelativeToPublic === '' ||
        (!workRelativeToPublic.startsWith('..') && !path.isAbsolute(workRelativeToPublic))))
  ) {
    errors.push('MEDIA_WORK_ROOT must be an absolute non-root private directory');
  }
  if (
    config.STT_PROVIDER === 'yandex_speechkit' &&
    (!config.STT_YANDEX_API_KEY || !config.STT_YANDEX_FOLDER_ID || !config.STT_YANDEX_AUDIO_URI_PREFIX)
  ) {
    errors.push(
      'STT_YANDEX_API_KEY, STT_YANDEX_FOLDER_ID and STT_YANDEX_AUDIO_URI_PREFIX are required when STT_PROVIDER="yandex_speechkit"',
    );
  }
  if (config.STT_PROVIDER === 'yandex_speechkit') {
    const endpoints = [
      ['STT_YANDEX_ENDPOINT', config.STT_YANDEX_ENDPOINT],
      ['STT_YANDEX_OPERATION_ENDPOINT', config.STT_YANDEX_OPERATION_ENDPOINT],
      ['STT_YANDEX_RESULT_ENDPOINT', config.STT_YANDEX_RESULT_ENDPOINT],
      ['STT_YANDEX_DELETE_ENDPOINT', config.STT_YANDEX_DELETE_ENDPOINT],
      ['STT_YANDEX_AUDIO_URI_PREFIX', config.STT_YANDEX_AUDIO_URI_PREFIX],
    ] as const;
    for (const [name, value] of endpoints) {
      if (!value || !value.startsWith('https://') || isLocalhostUrl(value)) {
        errors.push(`${name} must use non-local HTTPS when STT_PROVIDER="yandex_speechkit"`);
      }
    }
  }
  if (
    config.AI_ENRICHMENT_PROVIDER === 'yandex_foundation_models' &&
    (!config.AI_YANDEX_API_KEY || !config.AI_YANDEX_FOLDER_ID || !config.AI_YANDEX_MODEL_URI)
  ) {
    errors.push(
      'AI_YANDEX_API_KEY, AI_YANDEX_FOLDER_ID and AI_YANDEX_MODEL_URI are required when AI_ENRICHMENT_PROVIDER="yandex_foundation_models"',
    );
  }
  if (
    config.AI_ENRICHMENT_PROVIDER === 'yandex_foundation_models' &&
    (!config.AI_YANDEX_ENDPOINT ||
      !config.AI_YANDEX_ENDPOINT.startsWith('https://') ||
      isLocalhostUrl(config.AI_YANDEX_ENDPOINT))
  ) {
    errors.push('AI_YANDEX_ENDPOINT must use non-local HTTPS when AI_ENRICHMENT_PROVIDER="yandex_foundation_models"');
  }
  for (const origin of parseOrigins(config.MEDIA_UPLOAD_CSP_ORIGINS)) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.protocol !== 'https:' || isLocalhostUrl(origin)) {
        errors.push('MEDIA_UPLOAD_CSP_ORIGINS must contain comma-separated HTTPS origins without paths');
        break;
      }
    } catch {
      errors.push('MEDIA_UPLOAD_CSP_ORIGINS must contain valid origins');
      break;
    }
  }
  const needsTelegramAdminIdentity =
    config.TELEGRAM_NOTIFY_MODE === 'send' ||
    config.TELEGRAM_ADMIN_BOT_POLLING === 'on' ||
    config.TELEGRAM_BOT_POLLING === 'on';
  if (
    needsTelegramAdminIdentity &&
    (!(config.TELEGRAM_ADMIN_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN) ||
      !(config.TELEGRAM_ADMIN_BOT_USERNAME || config.TELEGRAM_BOT_USERNAME))
  ) {
    errors.push(
      'TELEGRAM_ADMIN_BOT_TOKEN or TELEGRAM_BOT_TOKEN and admin bot username are required when Telegram admin runtime is enabled',
    );
  }
  if (config.TELEGRAM_NOTIFY_MODE === 'send' && !config.TELEGRAM_ADMIN_CHAT_ID) {
    errors.push('TELEGRAM_ADMIN_CHAT_ID is required for manager notifications in send mode');
  }
  if (config.TELEGRAM_NOTIFY_MODE === 'send' && !config.TELEGRAM_OPERATIONAL_CHAT_ID) {
    errors.push('TELEGRAM_OPERATIONAL_CHAT_ID is required for PII-free operational alerts in send mode');
  }
  if (
    config.TELEGRAM_NOTIFY_MODE === 'send' &&
    config.TELEGRAM_OPERATIONAL_CHAT_ID &&
    config.TELEGRAM_OPERATIONAL_CHAT_ID === config.TELEGRAM_ADMIN_CHAT_ID
  ) {
    errors.push('TELEGRAM_OPERATIONAL_CHAT_ID must differ from TELEGRAM_ADMIN_CHAT_ID');
  }
  if (config.TENANT_TELEGRAM_BOTS_ENABLED === 'on') {
    if (config.PLATFORM_ACCOUNTS_ENABLED !== 'on' || config.TENANT_CRM_ENABLED !== 'on') {
      errors.push('TENANT_TELEGRAM_BOTS_ENABLED requires PLATFORM_ACCOUNTS_ENABLED and TENANT_CRM_ENABLED');
    }
    if (config.TELEGRAM_ADMIN_BOT_POLLING !== 'on') {
      errors.push('TELEGRAM_ADMIN_BOT_POLLING must be "on" when tenant Telegram bots are enabled');
    }
    if (!config.TELEGRAM_CALLBACK_SECRET) {
      errors.push('TELEGRAM_CALLBACK_SECRET is required when tenant Telegram bots are enabled');
    }
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
  const usesVersionedMediaAssets = ['local_fs', 's3'].includes(config.MEDIA_STORAGE_PROVIDER);
  if (!usesVersionedMediaAssets && !config.WEBINAR_VIDEO_HLS_URL && !config.WEBINAR_VIDEO_URL) {
    errors.push('WEBINAR_VIDEO_HLS_URL or WEBINAR_VIDEO_URL is required in production');
  }
  if (
    !usesVersionedMediaAssets &&
    (config.WEBINAR_VIDEO_PROVIDER === 'hls' || config.WEBINAR_VIDEO_PROVIDER === 'streaming') &&
    !config.WEBINAR_VIDEO_HLS_URL
  ) {
    errors.push('WEBINAR_VIDEO_HLS_URL is required for hls/streaming video providers');
  }
  if (!usesVersionedMediaAssets && !config.WEBINAR_POSTER_URL) {
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
    E2E_EMAIL_OUTBOX_ENABLED: process.env.E2E_EMAIL_OUTBOX_ENABLED ?? 'off',
    MEDIA_STORAGE_PROVIDER: process.env.MEDIA_STORAGE_PROVIDER ?? 'unconfigured',
    MEDIA_LOCAL_ROOT: process.env.MEDIA_LOCAL_ROOT,
    STT_PROVIDER: process.env.STT_PROVIDER ?? 'unconfigured',
    AI_ENRICHMENT_PROVIDER: process.env.AI_ENRICHMENT_PROVIDER ?? 'unconfigured',
    MEDIA_MAX_UPLOAD_BYTES: process.env.MEDIA_MAX_UPLOAD_BYTES ?? '4294967296',
    MEDIA_MAX_DURATION_SECONDS: process.env.MEDIA_MAX_DURATION_SECONDS ?? '10800',
    MEDIA_PART_SIZE_BYTES: process.env.MEDIA_PART_SIZE_BYTES ?? '8388608',
    MEDIA_UPLOAD_CSP_ORIGINS: process.env.MEDIA_UPLOAD_CSP_ORIGINS ?? '',
    SMTP_PORT: process.env.SMTP_PORT ?? '587',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'АСПБ <no-reply@test.local>',
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
    TELEGRAM_GROUP_URL: process.env.TELEGRAM_GROUP_URL ?? 'https://t.me/example',
    TELEGRAM_ADMIN_BOT_POLLING: process.env.TELEGRAM_ADMIN_BOT_POLLING ?? 'off',
    TELEGRAM_ADMIN_BOT_USERNAME: process.env.TELEGRAM_ADMIN_BOT_USERNAME,
    TELEGRAM_OPERATIONAL_CHAT_ID: process.env.TELEGRAM_OPERATIONAL_CHAT_ID,
    TELEGRAM_NOTIFY_MODE: process.env.TELEGRAM_NOTIFY_MODE ?? 'log',
    TELEGRAM_CALLBACK_SECRET: process.env.TELEGRAM_CALLBACK_SECRET,
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
    ASPB_SINGLE_ORGANIZATION_MODE: process.env.ASPB_SINGLE_ORGANIZATION_MODE ?? 'off',
    PLATFORM_TENANCY_ENFORCEMENT: process.env.PLATFORM_TENANCY_ENFORCEMENT ?? 'off',
    CREATOR_DASHBOARD_ENABLED: process.env.CREATOR_DASHBOARD_ENABLED ?? 'off',
    PUBLIC_CATALOG_ENABLED: process.env.PUBLIC_CATALOG_ENABLED ?? 'off',
    TENANT_CRM_ENABLED: process.env.TENANT_CRM_ENABLED ?? 'off',
    TENANT_TELEGRAM_BOTS_ENABLED: process.env.TENANT_TELEGRAM_BOTS_ENABLED ?? 'off',
  };
}

export const env = validateProductionSecurity(envSchema.parse(runtimeEnv()));
