import crypto from 'node:crypto';
import { env } from './env.js';

export function createAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashIp(ip: string | undefined) {
  if (!ip) {
    return null;
  }

  return crypto.createHmac('sha256', env.IP_HASH_SECRET).update(ip).digest('hex');
}

function sign(value: string) {
  return crypto.createHmac('sha256', env.ADMIN_COOKIE_SECRET).update(value).digest('base64url');
}

function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminSession(admin?: { id?: string; email?: string; role?: string; sessionVersion?: number }) {
  const payload = JSON.stringify({
    login: env.ADMIN_LOGIN,
    adminId: admin?.id ?? null,
    email: admin?.email ?? null,
    role: admin?.role ?? 'owner',
    sessionVersion: admin?.sessionVersion ?? 1,
    sessionId: crypto.randomUUID(),
    issuedAt: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000,
  });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function parseAdminSession(token: string | undefined) {
  if (!token) {
    return null;
  }

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || !timingSafeEqualString(sign(encoded), signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      login?: string;
      adminId?: string | null;
      email?: string | null;
      role?: string | null;
      sessionVersion?: number;
      sessionId?: string;
      issuedAt?: number;
      exp?: number;
    };

    if (
      payload.login !== env.ADMIN_LOGIN ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now() ||
      typeof payload.sessionVersion !== 'number' ||
      typeof payload.sessionId !== 'string'
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function verifyAdminSession(token: string | undefined) {
  return Boolean(parseAdminSession(token));
}
