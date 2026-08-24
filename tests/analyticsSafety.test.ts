import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    event: { findFirst: vi.fn() },
  },
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    error: mocks.logError,
  },
}));

import { saveEventSafely } from '../src/routes/public/helpers.js';

describe('best-effort analytics', () => {
  it('logs a structured error and preserves the committed business response path', async () => {
    const secret = 'Bearer never-log-this-token';
    const failure = new Error(`provider failed with ${secret}`);
    mocks.queryRaw.mockRejectedValueOnce(failure);

    await expect(
      saveEventSafely(
        {
          eventName: 'registration_submit',
          req: { headers: {}, cookies: {}, socket: {} },
          registration: null,
          page: '/crisis_premium/register.html',
        },
        'authenticated_registration',
      ),
    ).resolves.toBeNull();

    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: 'analytics_write_failed',
        operation: 'authenticated_registration',
        eventName: 'registration_submit',
        registrationId: null,
        leadId: null,
        webinarSessionId: null,
      }),
      '[ASPБ analytics] best-effort event save failed',
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(secret);
  });
});
