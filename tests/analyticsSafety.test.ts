import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    event: { create: mocks.createEvent },
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
    const failure = new Error('analytics insert failed');
    mocks.createEvent.mockRejectedValueOnce(failure);

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
        err: failure,
        operation: 'authenticated_registration',
        eventName: 'registration_submit',
        registrationId: null,
        leadId: null,
        webinarSessionId: null,
      }),
      '[ASPБ analytics] best-effort event save failed',
    );
  });
});
