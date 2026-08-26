import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/lib/email.js', () => ({
  SMTP_DELIVERY_BUDGET_MS: 30_000,
  sendParticipantLoginEmail: vi.fn(),
  sendRegistrationEmail: vi.fn(),
  sendReminderEmail: vi.fn(),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    emailOutboxJob: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    emailOutboxDeadLetter: { upsert: vi.fn() },
    registration: { findUnique: vi.fn(), update: vi.fn() },
    registrationToken: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    webinar: { findFirst: vi.fn().mockResolvedValue({ visibility: 'UNLISTED' }) },
    webinarAccessGrant: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  return { prisma };
});

import { prisma } from '../src/lib/prisma.js';
import { EMAIL_OUTBOX_LINK_PENDING, enqueueRegistrationEmail, runEmailOutboxJobOnce } from '../src/lib/emailOutbox.js';

const emailStore = prisma.emailOutboxJob as unknown as {
  updateMany: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};
const registrationStore = prisma.registration as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const tokenStore = prisma.registrationToken as unknown as {
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
const executeRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
let activeClaimToken: string | null = null;

function mockSuccessfulClaim() {
  emailStore.updateMany.mockImplementation(async input => {
    if (input.data?.status === 'sending' && typeof input.data?.claimToken === 'string') {
      activeClaimToken = input.data.claimToken;
    }
    return { count: 1 };
  });
}

function emailJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email-job-1',
    type: 'registration_confirmation',
    status: 'pending',
    registrationId: 'registration-1',
    webinarSessionId: 'session-1',
    toEmail: 'person@example.com',
    toName: 'Иван Иванов',
    scheduledAt: new Date('2026-08-05T08:00:00.000Z'),
    webinarUrl: 'https://example.test/access?token=secret',
    partnerUrl: null,
    reminderKind: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date('2026-08-04T08:00:00.000Z'),
    sentAt: null,
    createdAt: new Date('2026-08-04T08:00:00.000Z'),
    updatedAt: new Date('2026-08-04T08:00:00.000Z'),
    ...overrides,
  };
}

function activeRegistration() {
  return {
    id: 'registration-1',
    leadId: 'lead-1',
    status: 'registered',
    emailVerifiedAt: new Date('2026-08-04T07:00:00.000Z'),
    lead: {
      email: 'person@example.com',
      personalDataConsentRevokedAt: null,
    },
    webinarSession: {
      organizationId: 'organization-1',
      webinarId: 'webinar-1',
      lifecycleStatus: 'SCHEDULED',
      timezone: 'Europe/Amsterdam',
      title: 'Тестовый вебинар',
      scheduledAt: new Date('2026-08-05T08:00:00.000Z'),
      durationMinutes: 65,
      videoDurationSeconds: 3860,
      replayAvailableHours: 168,
    },
  };
}

function mockPreparedJob(overrides: Record<string, unknown> = {}) {
  registrationStore.findUnique.mockResolvedValue({ leadId: 'lead-1' });
  emailStore.findUnique.mockImplementation(async input => {
    if (input.select) return { registrationId: 'registration-1' };
    return emailJob({
      status: 'sending',
      claimToken: activeClaimToken,
      registration: activeRegistration(),
      webinarSession: activeRegistration().webinarSession,
      ...overrides,
    });
  });
  tokenStore.create.mockImplementation(async () => ({ id: `token-${tokenStore.create.mock.calls.length}` }));
  tokenStore.updateMany.mockResolvedValue({ count: 2 });
  tokenStore.deleteMany.mockResolvedValue({ count: 2 });
}

afterEach(() => {
  vi.clearAllMocks();
  activeClaimToken = null;
});

describe('email outbox anonymization races', () => {
  it('persists only a non-secret marker when a delivery is enqueued', async () => {
    const tx = {
      emailOutboxJob: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      },
    };

    await enqueueRegistrationEmail(tx as never, {
      registrationId: 'registration-1',
      webinarSessionId: 'session-1',
      toEmail: 'person@example.com',
      toName: 'Иван Иванов',
      scheduledAt: new Date('2026-08-05T08:00:00.000Z'),
    });

    expect(tx.emailOutboxJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webinarUrl: EMAIL_OUTBOX_LINK_PENDING,
        partnerUrl: null,
      }),
    });
    expect(JSON.stringify(tx.emailOutboxJob.create.mock.calls)).not.toContain('token=');
  });

  it('delivers the confirmation link while the registration is still pending verification', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockSuccessfulClaim();
    mockPreparedJob({
      registration: {
        ...activeRegistration(),
        status: 'pending_verification',
        emailVerifiedAt: null,
      },
    });
    const sendRegistrationEmail = vi.fn().mockResolvedValue({ sent: true, mode: 'send' });

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(sendRegistrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ webinarUrl: expect.stringContaining('#token=') }),
    );
    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, cancelled: 0 });
  });

  it('rotates hashes referenced by legacy plaintext outbox links before redaction', () => {
    const migration = readFileSync(
      'prisma/migrations/20260805120000_email_outbox_bearer_redaction/migration.sql',
      'utf8',
    );
    expect(migration).toContain('DELETE FROM "registration_tokens"');
    expect(migration).toContain("\"purpose\" IN ('registration', 'participant_login')");
    expect(migration).toContain('generated-at-delivery://email-link');
    expect(migration).toContain('redacted://email-link');
  });

  it('does not send a stale in-memory payload after anonymization cancels the claimed job', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockSuccessfulClaim();
    registrationStore.findUnique.mockResolvedValue({ leadId: 'lead-1' });
    emailStore.findUnique.mockImplementation(async input =>
      input.select
        ? { registrationId: 'registration-1' }
        : emailJob({
            status: 'cancelled',
            claimToken: null,
            toEmail: 'anonymized-lead-1@deleted.invalid',
            toName: 'Удалённый пользователь',
            registration: { ...activeRegistration(), status: 'anonymized' },
          }),
    );
    const sendRegistrationEmail = vi.fn();

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(emailStore.findUnique).toHaveBeenCalledWith({
      where: { id: 'email-job-1' },
      select: { registrationId: true },
    });
    expect(sendRegistrationEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, cancelled: 1 });
  });

  it('does not overwrite a concurrent cancellation with sent after external delivery returns', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockPreparedJob();
    emailStore.updateMany.mockImplementation(async input => {
      if (input.data?.status === 'sending' && typeof input.data?.claimToken === 'string') {
        activeClaimToken = input.data.claimToken;
      }
      if (input.where?.id === 'email-job-1' && input.data?.status === 'sent') {
        return { count: 0 };
      }
      return { count: 1 };
    });
    const sendRegistrationEmail = vi.fn().mockResolvedValue({ sent: true, mode: 'send' });

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(sendRegistrationEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, cancelled: 0 });
    expect(emailStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'email-job-1',
          status: 'sending',
          sentAt: null,
          claimToken: expect.any(String),
        }),
        data: expect.objectContaining({ status: 'sent' }),
      }),
    );
  });

  it('rechecks under the lead fence after token preparation and does not send after anonymization', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockSuccessfulClaim();
    registrationStore.findUnique.mockResolvedValue({ leadId: 'lead-1' });
    let deliverableReads = 0;
    emailStore.findUnique.mockImplementation(async input => {
      if (input.select) return { registrationId: 'registration-1' };
      deliverableReads += 1;
      if (deliverableReads === 1) {
        return emailJob({
          status: 'sending',
          claimToken: activeClaimToken,
          registration: activeRegistration(),
          webinarSession: activeRegistration().webinarSession,
        });
      }
      return emailJob({
        status: 'cancelled',
        claimToken: null,
        toEmail: 'anonymized-lead-1@deleted.invalid',
        toName: 'Удалённый пользователь',
        registration: {
          ...activeRegistration(),
          status: 'anonymized',
          lead: {
            ...activeRegistration().lead,
            email: 'anonymized-lead-1@deleted.invalid',
            personalDataConsentRevokedAt: new Date(),
          },
        },
        webinarSession: activeRegistration().webinarSession,
      });
    });
    tokenStore.create.mockImplementation(async () => ({ id: `token-${tokenStore.create.mock.calls.length}` }));
    tokenStore.deleteMany.mockResolvedValue({ count: 2 });
    const sendRegistrationEmail = vi.fn();

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(deliverableReads).toBe(2);
    expect(sendRegistrationEmail).not.toHaveBeenCalled();
    expect(tokenStore.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['token-1', 'token-2'] }, registrationId: 'registration-1' },
    });
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, cancelled: 1 });
  });

  it('mints bearer links only in memory and redacts the terminal outbox row', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockSuccessfulClaim();
    mockPreparedJob();
    const sendRegistrationEmail = vi.fn().mockResolvedValue({ sent: true, mode: 'send' });

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(result.sent).toBe(1);
    const lockSql = executeRaw.mock.calls.map(call => (call[0] as { strings: string[] }).strings.join(''));
    expect(lockSql).toHaveLength(2);
    expect(lockSql[0]).toContain('48192731');
    expect(lockSql[1]).toContain('48192733');
    expect(lockSql[1]).not.toContain('48192731');
    expect(executeRaw.mock.invocationCallOrder[1]).toBeLessThan(sendRegistrationEmail.mock.invocationCallOrder[0]);
    expect(sendRegistrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        webinarUrl: expect.stringContaining('/crisis_premium/webinar.html#token='),
        partnerUrl: expect.stringContaining('/crisis_premium/webinar.html#token='),
      }),
    );
    expect(tokenStore.create).toHaveBeenCalledTimes(2);
    for (const call of tokenStore.create.mock.calls) {
      expect(call[0].data.tokenHash).toEqual(expect.any(String));
      expect(call[0].data).not.toHaveProperty('token');
    }
    expect(emailStore.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'sent',
          webinarUrl: 'redacted://email-link',
          partnerUrl: null,
        }),
      }),
    );
  });

  it('invokes the sender only once in one durable worker attempt', async () => {
    emailStore.findMany.mockResolvedValue([emailJob()]);
    mockSuccessfulClaim();
    mockPreparedJob();
    const sendRegistrationEmail = vi.fn().mockRejectedValue(new Error('ambiguous SMTP timeout'));

    const result = await runEmailOutboxJobOnce(new Date('2026-08-04T09:00:00.000Z'), {
      sendRegistrationEmail,
    });

    expect(sendRegistrationEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, cancelled: 0 });
  });

  it('uses a fresh per-job clock and preserves at least 20 minutes of link life after delivery', async () => {
    const jobs = [
      emailJob({ id: 'email-job-1', type: 'participant_access_login' }),
      emailJob({ id: 'email-job-2', type: 'participant_access_login' }),
    ];
    emailStore.findMany.mockResolvedValue(jobs);
    mockSuccessfulClaim();
    registrationStore.findUnique.mockResolvedValue({ leadId: 'lead-1' });
    emailStore.findUnique.mockImplementation(async input => {
      if (input.select) return { registrationId: 'registration-1' };
      const selected = jobs.find(job => job.id === input.where.id) ?? jobs[0];
      return {
        ...selected,
        status: 'sending',
        claimToken: activeClaimToken,
        registration: activeRegistration(),
        webinarSession: activeRegistration().webinarSession,
      };
    });
    tokenStore.create.mockImplementation(async () => ({ id: `token-${tokenStore.create.mock.calls.length}` }));
    tokenStore.updateMany.mockResolvedValue({ count: 1 });
    const sendParticipantLoginEmail = vi.fn().mockResolvedValue({ sent: true, mode: 'send' });
    const clockValues = [
      new Date('2026-08-04T09:00:00.000Z'),
      new Date('2026-08-04T09:00:30.000Z'),
      new Date('2026-08-04T09:01:00.000Z'),
      new Date('2026-08-04T09:21:00.000Z'),
      new Date('2026-08-04T09:21:30.000Z'),
      new Date('2026-08-04T09:22:00.000Z'),
    ];
    const clock = vi.fn(() => clockValues.shift()!);

    const result = await runEmailOutboxJobOnce(
      new Date('2026-08-04T08:59:00.000Z'),
      { sendParticipantLoginEmail },
      undefined,
      clock,
    );

    expect(result).toEqual({ checked: 2, sent: 2, failed: 0, cancelled: 0 });
    expect(tokenStore.create.mock.calls[0][0].data.expiresAt).toEqual(new Date('2026-08-04T09:20:00.000Z'));
    expect(tokenStore.create.mock.calls[1][0].data.expiresAt).toEqual(new Date('2026-08-04T09:41:00.000Z'));
    expect(tokenStore.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: { in: ['token-2'] } },
      data: { expiresAt: new Date('2026-08-04T09:42:00.000Z') },
    });
  });
});
