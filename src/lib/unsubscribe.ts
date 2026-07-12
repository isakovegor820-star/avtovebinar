import crypto from 'node:crypto';
import { env } from './env.js';

// Отписка от маркетинговых рассылок (152-ФЗ, ст.18 38-ФЗ): подписанный stateless-токен по email.
// Не требует записи в БД на каждое письмо — подпись HMAC проверяется на роуте отписки.
function sign(payload: string) {
  return crypto.createHmac('sha256', env.ADMIN_COOKIE_SECRET).update(`unsubscribe:${payload}`).digest('base64url');
}

export function buildUnsubscribeToken(email: string) {
  const payload = Buffer.from(email.trim().toLowerCase()).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token: string | undefined): string | null {
  if (!token) {
    return null;
  }
  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }
  const expected = sign(payload);
  const provided = Buffer.from(signature);
  const valid = Buffer.from(expected);
  if (provided.length !== valid.length || !crypto.timingSafeEqual(provided, valid)) {
    return null;
  }
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function buildUnsubscribeUrl(email: string) {
  const base = env.PUBLIC_SITE_URL.replace(/\/$/, '');
  return `${base}/api/unsubscribe?token=${buildUnsubscribeToken(email)}`;
}
