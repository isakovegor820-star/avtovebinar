process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createPublicReportLimiter } from '../src/app.js';
import { requestContextMiddleware } from '../src/lib/requestContext.js';

describe('public report production rate limit', () => {
  it('returns a provider-neutral 429 with a correlation ID after five requests', async () => {
    const isolatedApp = express();
    isolatedApp.use(requestContextMiddleware);
    isolatedApp.post('/reports', createPublicReportLimiter({ skipInTest: false }), (_req, res) => {
      res.status(201).json({ ok: true });
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(isolatedApp).post('/reports')).status).toBe(201);
    }
    const limited = await request(isolatedApp).post('/reports');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ ok: false, code: 'public_report_rate_limited' });
    expect(limited.body.correlationId).toBe(limited.headers['x-correlation-id']);
  });
});
