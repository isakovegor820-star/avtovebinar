import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

type RequestContext = {
  correlationId: string;
  userId?: string | null;
  adminId?: string | null;
  organizationId?: string | null;
};

const storage = new AsyncLocalStorage<RequestContext>();

function normalizeCorrelationId(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(trimmed) ? trimmed : null;
}

export function createCorrelationId(prefix = 'req') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const headerId = normalizeCorrelationId(req.headers['x-correlation-id']);
  const correlationId = headerId ?? createCorrelationId();

  res.setHeader('x-correlation-id', correlationId);
  storage.run({ correlationId }, next);
}

export function getRequestContext() {
  return storage.getStore();
}

export function setContextIdentity(input: {
  userId?: string | null;
  adminId?: string | null;
  organizationId?: string | null;
}) {
  const context = storage.getStore();
  if (!context) {
    return;
  }

  if (input.userId !== undefined) {
    context.userId = input.userId;
  }
  if (input.adminId !== undefined) {
    context.adminId = input.adminId;
  }
  if (input.organizationId !== undefined) {
    context.organizationId = input.organizationId;
  }
}

export function runWithCorrelation<T>(correlationId: string, task: () => T) {
  return storage.run({ correlationId }, task);
}
