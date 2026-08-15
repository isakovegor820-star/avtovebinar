import crypto from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env } from './env.js';
import { AppError } from './http.js';

export const CSRF_COOKIE_NAME = 'aspb_csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

type PartitionedCookieOptions = CookieOptions & {
  partitioned?: boolean;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function createCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function csrfCookieOptions(): PartitionedCookieOptions {
  return {
    httpOnly: false,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    partitioned: env.NODE_ENV === 'production' ? true : undefined,
    path: '/',
    maxAge: 1000 * 60 * 60 * 12,
  };
}

function isValidCsrfToken(value: unknown): value is string {
  return typeof value === 'string' && CSRF_TOKEN_PATTERN.test(value);
}

function tokensMatch(cookieToken: string, submittedToken: string) {
  const cookieBuffer = Buffer.from(cookieToken);
  const submittedBuffer = Buffer.from(submittedToken);
  return cookieBuffer.length === submittedBuffer.length && crypto.timingSafeEqual(cookieBuffer, submittedBuffer);
}

function shouldProtectRequest(req: Request) {
  if (SAFE_METHODS.has(req.method)) {
    return false;
  }

  return (
    req.path.startsWith('/api/admin/') ||
    req.path === '/api/participant/login/request' ||
    req.path === '/api/participant/login/consume' ||
    req.path === '/api/participant/logout' ||
    req.path === '/api/registration/exchange' ||
    req.path.startsWith('/api/registration/exchange/') ||
    req.path === '/api/register' ||
    req.path === '/api/questions' ||
    req.path === '/api/partner-application'
  );
}

export function ensureCsrfToken(req: Request, res: Response, next: NextFunction) {
  const existingToken = req.cookies?.[CSRF_COOKIE_NAME];
  const token = isValidCsrfToken(existingToken) ? existingToken : createCsrfToken();
  if (!isValidCsrfToken(existingToken)) {
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
  }
  res.locals.csrfToken = token;
  next();
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (!shouldProtectRequest(req)) {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const submittedToken = req.get(CSRF_HEADER_NAME);
  if (
    !isValidCsrfToken(cookieToken) ||
    !isValidCsrfToken(submittedToken) ||
    !tokensMatch(cookieToken, submittedToken)
  ) {
    return next(new AppError(403, 'CSRF token is missing or invalid', { code: 'csrf_invalid' }));
  }

  return next();
}

export function sendCsrfToken(_req: Request, res: Response) {
  const token = res.locals.csrfToken;
  if (!isValidCsrfToken(token)) {
    throw new AppError(500, 'CSRF token was not initialized');
  }
  res.json({ ok: true, csrfToken: token });
}
