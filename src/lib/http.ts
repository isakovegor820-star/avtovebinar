import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './logger.js';
import { getRequestContext } from './requestContext.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public code?: string,
  ) {
    super(message);
  }
}

export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function getClientIp(req: Request) {
  if (typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }

  return req.socket.remoteAddress ?? '0.0.0.0';
}

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const correlationId = getRequestContext()?.correlationId;
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      ok: false,
      error: error.message,
      code: error.code ?? (isErrorDetails(error.details) ? error.details.code : undefined),
      details: error.details,
      correlationId,
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: error.flatten(),
      code: 'validation_failed',
      correlationId,
    });
  }

  if (isPayloadTooLargeError(error)) {
    const analyticsRequest = req.originalUrl === '/api/events' || req.originalUrl.startsWith('/api/events?');
    return res.status(413).json({
      ok: false,
      error: analyticsRequest ? 'Analytics request is too large' : 'Размер запроса превышает допустимый',
      code: analyticsRequest ? 'analytics_payload_too_large' : 'payload_too_large',
      correlationId,
    });
  }

  if (env.NODE_ENV === 'production') {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, message }, 'Unhandled API error');
  } else {
    logger.error(error, 'Unhandled API error');
  }

  return res.status(500).json({
    ok: false,
    error: 'Internal server error',
    code: 'internal_error',
    correlationId,
  });
}

function isPayloadTooLargeError(value: unknown): value is { status: 413 } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { status?: unknown; statusCode?: unknown; type?: unknown };
  return candidate.status === 413 || candidate.statusCode === 413 || candidate.type === 'entity.too.large';
}

function isErrorDetails(value: unknown): value is { code: string } {
  return Boolean(
    value && typeof value === 'object' && 'code' in value && typeof (value as { code?: unknown }).code === 'string',
  );
}
