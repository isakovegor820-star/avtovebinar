import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './logger.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
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
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim();
  }

  return req.socket.remoteAddress;
}

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      ok: false,
      error: error.message,
      details: error.details,
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: error.flatten(),
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
  });
}
