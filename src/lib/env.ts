import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive(),
  PUBLIC_SITE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  ADMIN_LOGIN: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(12),
  ADMIN_COOKIE_SECRET: z.string().min(32),
  ADMIN_DEV_BYPASS: z.enum(['true', 'false']).optional(),
  IP_HASH_SECRET: z.string().min(32),
  EMAIL_MODE: z.enum(['send', 'log']),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
  TELEGRAM_GROUP_URL: z.string().url(),
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_NOTIFY_MODE: z.enum(['send', 'log']),
  TELEGRAM_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: z.string().optional(),
  TELEGRAM_PARTICIPANT_BOT_USERNAME: z.string().optional(),
  TELEGRAM_PARTICIPANT_BOT_POLLING: z.enum(['on', 'off']),
  TELEGRAM_NEWS_BROADCAST: z.enum(['on', 'off']),
  TELEGRAM_NEWS_TIMES: z.string().min(1),
  TELEGRAM_NEWS_RSS_URLS: z.string().min(1),
  WEBINAR_TEST_ROOM_MODE: z.enum(['on', 'off']),
  CORS_ORIGIN: z.string().min(1),
  WORKER_ROLE: z.enum(['api', 'webinar', 'all']).optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

function isStrongPassword(value: string) {
  return value.length >= 12 && /[a-zа-я]/i.test(value) && /\d/.test(value);
}

function parseOrigins(value: string) {
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

export function validateProductionSecurity(config: EnvConfig) {
  if (config.NODE_ENV !== 'production') {
    return config;
  }

  const errors: string[] = [];
  if (config.ADMIN_LOGIN === 'admin') {
    errors.push('ADMIN_LOGIN must not use the default "admin" in production');
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
  if (config.EMAIL_MODE !== 'send') {
    errors.push('EMAIL_MODE must be "send" in production');
  }
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    errors.push('SMTP_HOST, SMTP_USER and SMTP_PASS are required in production');
  }
  if (config.WEBINAR_TEST_ROOM_MODE === 'on') {
    errors.push('WEBINAR_TEST_ROOM_MODE must be "off" in production');
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
    ADMIN_PASSWORD: `TestPassword${crypto.randomInt(100000, 999999)}`,
    ADMIN_COOKIE_SECRET: crypto.randomBytes(32).toString('hex'),
    IP_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
    EMAIL_MODE: process.env.EMAIL_MODE ?? 'log',
    SMTP_PORT: process.env.SMTP_PORT ?? '587',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'АСПБ <no-reply@test.local>',
    TELEGRAM_GROUP_URL: process.env.TELEGRAM_GROUP_URL ?? 'https://t.me/example',
    TELEGRAM_ADMIN_BOT_POLLING: process.env.TELEGRAM_ADMIN_BOT_POLLING ?? 'off',
    TELEGRAM_NOTIFY_MODE: process.env.TELEGRAM_NOTIFY_MODE ?? 'log',
    TELEGRAM_BOT_POLLING: process.env.TELEGRAM_BOT_POLLING ?? 'off',
    TELEGRAM_PARTICIPANT_BOT_POLLING: process.env.TELEGRAM_PARTICIPANT_BOT_POLLING ?? 'off',
    TELEGRAM_NEWS_BROADCAST: process.env.TELEGRAM_NEWS_BROADCAST ?? 'off',
    TELEGRAM_NEWS_TIMES: process.env.TELEGRAM_NEWS_TIMES ?? '09:00,11:30,14:00,16:30,19:00',
    TELEGRAM_NEWS_RSS_URLS:
      process.env.TELEGRAM_NEWS_RSS_URLS ??
      'https://www.consultant.ru/rss/hotdocs.xml,https://www.consultant.ru/rss/nw.xml,https://www.consultant.ru/rss/db.xml',
    WEBINAR_TEST_ROOM_MODE: process.env.WEBINAR_TEST_ROOM_MODE ?? 'off',
    CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5174',
  };
}

export const env = validateProductionSecurity(envSchema.parse(runtimeEnv()));
