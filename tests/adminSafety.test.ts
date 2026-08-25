import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcastMocks = vi.hoisted(() => ({
  createTelegramBroadcastJob: vi.fn(),
  previewTelegramBroadcastRecipients: vi.fn(),
  previewTelegramBroadcastRecipientsForSnapshot: vi.fn(),
}));
const anonymizationMocks = vi.hoisted(() => ({
  anonymizeLeadInTransaction: vi.fn(),
}));

vi.mock('../src/lib/telegramBroadcastWorker.js', () => ({
  TELEGRAM_BROADCAST_CREATE_LOCK_KEY: BigInt('48192731002'),
  TELEGRAM_BROADCAST_MAX_TEXT_LENGTH: 3500,
  createTelegramBroadcastJob: broadcastMocks.createTelegramBroadcastJob,
  previewTelegramBroadcastRecipients: broadcastMocks.previewTelegramBroadcastRecipients,
  previewTelegramBroadcastRecipientsForSnapshot: broadcastMocks.previewTelegramBroadcastRecipientsForSnapshot,
}));

vi.mock('../src/lib/anonymizeLead.js', () => ({
  LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS: 60_000,
  anonymizeLeadInTransaction: anonymizationMocks.anonymizeLeadInTransaction,
}));

vi.mock('../src/lib/prisma.js', () => {
  const prisma = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    adminUser: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    event: { create: vi.fn(), updateMany: vi.fn() },
    lead: { findUnique: vi.fn(), update: vi.fn() },
    registration: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    registrationToken: { deleteMany: vi.fn() },
    emailOutboxJob: { findMany: vi.fn(), updateMany: vi.fn() },
    emailOutboxDeadLetter: { updateMany: vi.fn() },
    question: { findMany: vi.fn(), updateMany: vi.fn() },
    partnerApplication: { findMany: vi.fn(), updateMany: vi.fn() },
    webinarChatMessage: { updateMany: vi.fn() },
    telegramBroadcastJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    telegramBroadcastRecipient: { findMany: vi.fn(), update: vi.fn() },
  };
  prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
  return { prisma };
});

import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/lib/env.js';
import { adminRouter } from '../src/routes/admin.js';

type MockFn = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  $executeRaw: MockFn;
  $transaction: MockFn;
  auditLog: { create: MockFn; updateMany: MockFn; findMany: MockFn };
  event: { create: MockFn; updateMany: MockFn };
  lead: { findUnique: MockFn; update: MockFn };
  registration: { findMany: MockFn; findFirst: MockFn; update: MockFn };
  registrationToken: { deleteMany: MockFn };
  emailOutboxJob: { findMany: MockFn; updateMany: MockFn };
  emailOutboxDeadLetter: { updateMany: MockFn };
  question: { findMany: MockFn; updateMany: MockFn };
  partnerApplication: { findMany: MockFn; updateMany: MockFn };
  webinarChatMessage: { updateMany: MockFn };
  telegramBroadcastJob: { findUnique: MockFn; findFirst: MockFn; update: MockFn };
  telegramBroadcastRecipient: { findMany: MockFn; update: MockFn };
};

function routeHandler(path: string, method: string) {
  const layer = (adminRouter as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: (error?: unknown) => void) => void;
}

function invoke(handler: ReturnType<typeof routeHandler>, req: Record<string, unknown>) {
  return new Promise<{ status: number; payload?: any; error?: any }>(resolve => {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status, payload });
      },
    };
    handler(req, res, error => resolve({ status, error }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) =>
    callback(prismaMock),
  );
  prismaMock.$executeRaw.mockResolvedValue(1);
  prismaMock.auditLog.create.mockResolvedValue({});
  prismaMock.event.create.mockResolvedValue({});
});

afterEach(() => {
  env.TELEGRAM_MANUAL_BROADCAST = 'off';
});

describe('admin transaction safety', () => {
  it('serializes concurrent broadcast creation so only one active job is queued', async () => {
    env.TELEGRAM_MANUAL_BROADCAST = 'on';
    let active = false;
    let transactionTail = Promise.resolve();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(prismaMock);
      } finally {
        release();
      }
    });
    prismaMock.telegramBroadcastJob.findUnique.mockResolvedValue(null);
    prismaMock.telegramBroadcastJob.findFirst.mockImplementation(async () =>
      active ? { id: 'job-1', status: 'pending', completedAt: null } : null,
    );
    broadcastMocks.previewTelegramBroadcastRecipientsForSnapshot.mockResolvedValue({
      enabled: true,
      total: 1,
      consentDocumentId: 'telegram-consent',
      consentDocumentVersion: 'v1',
      recipients: [{ leadId: 'lead-1', chatId: '12345' }],
    });
    broadcastMocks.createTelegramBroadcastJob.mockImplementation(async () => {
      active = true;
      return { jobId: 'job-1', total: 1, queued: true, delayMs: 40 };
    });

    const handler = routeHandler('/api/admin/telegram/broadcast', 'post');
    const baseRequest = {
      body: { text: 'Важное сообщение', confirmRecipientCount: 1 },
      admin: { id: 'owner-1', role: 'owner', email: 'owner@example.com' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const [first, second] = await Promise.all([
      invoke(handler, {
        ...baseRequest,
        body: { ...baseRequest.body, idempotencyKey: '00000000-0000-4000-8000-000000000001' },
      }),
      invoke(handler, {
        ...baseRequest,
        body: { ...baseRequest.body, idempotencyKey: '00000000-0000-4000-8000-000000000002' },
      }),
    ]);

    expect([first.status, second.status]).toContain(202);
    expect([first.error?.statusCode, second.error?.statusCode]).toContain(409);
    expect(broadcastMocks.createTelegramBroadcastJob).toHaveBeenCalledTimes(1);
    expect(broadcastMocks.previewTelegramBroadcastRecipientsForSnapshot).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('routes manual anonymization through the shared transaction service and preserves audit/result', async () => {
    anonymizationMocks.anonymizeLeadInTransaction.mockResolvedValue({
      anonymized: true,
      registrationCount: 1,
      questionCount: 2,
      partnerApplicationCount: 3,
      broadcastRecipientCount: 4,
    });

    const result = await invoke(routeHandler('/api/admin/leads/:id/anonymize', 'post'), {
      params: { id: 'lead-1' },
      admin: { id: 'owner-1', role: 'owner', email: 'owner@example.com' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    });

    expect(result.error).toBeUndefined();
    expect(result.payload).toEqual({
      ok: true,
      anonymized: true,
      registrationCount: 1,
      questionCount: 2,
      partnerApplicationCount: 3,
      broadcastRecipientCount: 4,
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 60_000,
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(anonymizationMocks.anonymizeLeadInTransaction).toHaveBeenCalledTimes(1);
    expect(anonymizationMocks.anonymizeLeadInTransaction).toHaveBeenCalledWith(prismaMock, {
      leadId: 'lead-1',
      anonymizedAt: expect.any(Date),
      revocationChannel: 'admin',
      revocationReason: 'manual_admin_anonymization',
    });
    const anonymizationInput = anonymizationMocks.anonymizeLeadInTransaction.mock.calls[0][1] as {
      anonymizedAt: Date;
    };
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminUserId: 'owner-1',
        action: 'lead.anonymize',
        entityType: 'lead',
        entityId: 'lead-1',
        beforeJson: { id: 'lead-1', hadPersonalData: true },
        afterJson: { anonymized: true, anonymizedAt: anonymizationInput.anonymizedAt.toISOString() },
      }),
    });
  });

  it('keeps the manual anonymization 404 and does not write a success audit for a missing lead', async () => {
    anonymizationMocks.anonymizeLeadInTransaction.mockResolvedValue({
      anonymized: false,
      reason: 'not_eligible',
    });

    const result = await invoke(routeHandler('/api/admin/leads/:id/anonymize', 'post'), {
      params: { id: 'missing-lead' },
      admin: { id: 'owner-1', role: 'owner', email: 'owner@example.com' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    });

    expect(result.error).toMatchObject({ statusCode: 404, message: 'Лид не найден' });
    expect(anonymizationMocks.anonymizeLeadInTransaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('clears the admin cookie with the same security scope used when setting it', () => {
    const clearCookie = vi.fn();
    const json = vi.fn();
    routeHandler('/api/admin/logout', 'post')({}, { clearCookie, json }, vi.fn());

    expect(clearCookie).toHaveBeenCalledWith('aspb_admin_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      partitioned: undefined,
      path: '/',
    });
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('uses a strict viewer allowlist while leaving owner details intact', async () => {
    const registration = {
      id: 'registration-1',
      status: 'registered',
      crmStatus: 'new',
      isHot: true,
      managerNote: 'Секретная заметка',
      accessTokenHash: 'must-never-reach-viewer',
      assignedManagerId: 'manager-1',
      assignedManager: { id: 'manager-1', name: 'Менеджер', email: 'manager@example.com', role: 'manager' },
      nextContactAt: new Date('2026-08-05T10:00:00.000Z'),
      registeredAt: new Date('2026-08-04T10:00:00.000Z'),
      successViewedAt: null,
      roomEnteredAt: null,
      telegramClickedAt: null,
      chatBannedAt: null,
      lead: {
        id: 'lead-1',
        name: 'Иван Иванов',
        phone: '+79990001122',
        email: 'ivan@example.com',
        city: 'Москва',
        professionalStatus: 'Юрист',
        source: 'private-source',
        utmSource: 'private-utm',
        utmMedium: 'cpc',
        utmCampaign: 'secret-campaign',
        telegramChatId: '12345',
        telegramUsername: 'ivan_private',
        telegramFirstName: 'Иван',
        telegramSubscribedAt: new Date('2026-08-04T10:00:00.000Z'),
      },
      webinarSession: {
        id: 'session-1',
        title: 'Вебинар',
        scheduledAt: new Date('2026-08-05T10:00:00.000Z'),
        durationMinutes: 60,
        status: 'scheduled',
        videoUrl: 'private-video-url',
      },
      questions: [
        {
          id: 'question-1',
          registrationId: 'registration-1',
          text: 'Персональный вопрос',
          publishedName: 'Иван',
          adminNote: 'Приватная заметка',
          isAnswered: false,
          forwardedAt: null,
          createdAt: new Date('2026-08-04T10:00:00.000Z'),
        },
      ],
      partnerApplications: [
        {
          id: 'application-1',
          registrationId: 'registration-1',
          sphere: 'Сфера',
          city: 'Москва',
          clientFlow: '10 клиентов',
          experience: 'Описание',
          comment: 'Телефон клиента',
          preferredFormat: 'online',
          status: 'new',
          assignedManagerId: null,
          nextContactAt: null,
          contractSentAt: null,
          contractSignedAt: null,
          createdAt: new Date('2026-08-04T10:00:00.000Z'),
        },
      ],
      events: [
        {
          id: 'event-1',
          eventName: 'page_view',
          webinarSessionId: 'session-1',
          page: '/private',
          source: 'private-source',
          utmSource: 'private-utm',
          utmMedium: 'cpc',
          utmCampaign: 'secret-campaign',
          visitorId: 'visitor-secret',
          userAgent: 'private-agent',
          ipHash: 'private-ip',
          metadataJson: { email: 'ivan@example.com' },
          createdAt: new Date('2026-08-04T10:00:00.000Z'),
        },
      ],
    };
    prismaMock.registration.findFirst.mockResolvedValue(registration);
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    const handler = routeHandler('/api/admin/registrations/:id', 'get');

    const viewerResult = await invoke(handler, {
      params: { id: 'registration-1' },
      admin: { id: 'viewer-1', role: 'viewer', email: 'viewer@example.com' },
    });
    const viewer = viewerResult.payload.registration;
    expect(viewer.accessTokenHash).toBeUndefined();
    expect(viewer.managerNote).toBeNull();
    expect(viewer.lead).toMatchObject({ city: null, professionalStatus: null, source: null, utmSource: null });
    expect(viewer.assignedManager.email).toBeUndefined();
    expect(viewer.questions[0]).toMatchObject({ text: '[hidden]', publishedName: null, adminNote: null });
    expect(viewer.partnerApplications[0]).toMatchObject({ city: null, comment: null, sphere: null });
    expect(viewer.events[0]).toMatchObject({ source: null, visitorId: null, metadataJson: null });
    expect(viewer.webinarSession.videoUrl).toBeUndefined();

    const ownerResult = await invoke(handler, {
      params: { id: 'registration-1' },
      admin: { id: 'owner-1', role: 'owner', email: 'owner@example.com' },
    });
    expect(ownerResult.payload.registration).toBe(registration);
    expect(ownerResult.payload.registration.managerNote).toBe('Секретная заметка');
    expect(ownerResult.payload.registration.lead.city).toBe('Москва');
  });
});
