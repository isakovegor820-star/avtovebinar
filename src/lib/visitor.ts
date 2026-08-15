import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from './env.js';

export const VISITOR_COOKIE_NAME = 'aspb_visitor_id';
export const COOKIE_CONSENT_NAME = 'aspb_cookie_consent';
export const VISITOR_COOKIE_TTL_DAYS = 180;

const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{32,96}$/;

export function parseVisitorId(value: unknown) {
  return typeof value === 'string' && VISITOR_ID_PATTERN.test(value) ? value : null;
}

export function getVisitorId(req: Request) {
  return parseVisitorId(req.cookies?.[VISITOR_COOKIE_NAME]) ?? parseVisitorId(req.res?.locals.visitorId);
}

export function hasAnalyticsConsent(req: Request) {
  return req.cookies?.[COOKIE_CONSENT_NAME] === 'accepted';
}

export function visitorIdentityMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!hasAnalyticsConsent(req)) {
    res.locals.visitorId = null;
    if (parseVisitorId(req.cookies?.[VISITOR_COOKIE_NAME])) {
      res.clearCookie(VISITOR_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: '/',
      });
    }
    next();
    return;
  }

  const visitorId = parseVisitorId(req.cookies?.[VISITOR_COOKIE_NAME]) ?? crypto.randomBytes(24).toString('base64url');
  res.locals.visitorId = visitorId;

  if (!parseVisitorId(req.cookies?.[VISITOR_COOKIE_NAME])) {
    res.cookie(VISITOR_COOKIE_NAME, visitorId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/',
      maxAge: VISITOR_COOKIE_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
  }

  next();
}
