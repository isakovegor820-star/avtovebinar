import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(5174),
  PUBLIC_SITE_URL: z.string().url().default('http://127.0.0.1:5174'),
  DATABASE_URL: z.string().min(1),
  ADMIN_LOGIN: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12),
  ADMIN_COOKIE_SECRET: z.string().min(32),
  IP_HASH_SECRET: z.string().min(32),
  EMAIL_MODE: z.enum(['send', 'log']).default('log'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('АСПБ <no-reply@aspb.local>'),
  TELEGRAM_GROUP_URL: z.string().url().default('https://t.me/example'),
  TELEGRAM_ADMIN_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_ADMIN_BOT_POLLING: z.enum(['on', 'off']).default('off'),
  TELEGRAM_NOTIFY_MODE: z.enum(['send', 'log']).default('log'),
  TELEGRAM_BOT_POLLING: z.enum(['on', 'off']).default('off'),
  TELEGRAM_PARTICIPANT_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_PARTICIPANT_BOT_USERNAME: z.string().optional().default(''),
  TELEGRAM_PARTICIPANT_BOT_POLLING: z.enum(['on', 'off']).default('off'),
  TELEGRAM_NEWS_BROADCAST: z.enum(['on', 'off']).default('off'),
  TELEGRAM_NEWS_TIMES: z.string().default('09:00,11:30,14:00,16:30,19:00'),
  TELEGRAM_NEWS_RSS_URLS: z
    .string()
    .default(
      'https://www.consultant.ru/rss/hotdocs.xml,https://www.consultant.ru/rss/nw.xml,https://www.consultant.ru/rss/db.xml',
    ),
  WEBINAR_TEST_ROOM_MODE: z.enum(['on', 'off']).default('on'),
  CORS_ORIGIN: z.string().optional().default('http://127.0.0.1:5174'),
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
    ADMIN_PASSWORD: `TestPassword${crypto.randomInt(100000, 999999)}`,
    ADMIN_COOKIE_SECRET: crypto.randomBytes(32).toString('hex'),
    IP_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
  };
}

export const env = validateProductionSecurity(envSchema.parse(runtimeEnv()));
