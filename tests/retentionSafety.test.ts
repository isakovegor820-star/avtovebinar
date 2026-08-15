import { beforeEach, describe, expect, it, vi } from 'vitest';

const securityMocks = vi.hoisted(() => ({
  acquireEmailDeliveryLock: vi.fn(),
  acquireLeadSecurityLock: vi.fn(),
  acquireTelegramDeliveryLock: vi.fn(),
}));

vi.mock('../src/lib/leadSecurity.js', () => ({
  acquireEmailDeliveryLock: securityMocks.acquireEmailDeliveryLock,
  acquireLeadSecurityLock: securityMocks.acquireLeadSecurityLock,
  acquireTelegramDeliveryLock: securityMocks.acquireTelegramDeliveryLock,
}));

vi.mock('../src/lib/roomLinks.js', () => ({
  buildFrontendUrl: (path: string) => `https://example.test${path}`,
  ROOM_EXCHANGE_TOKEN_PURPOSE: 'registration',
}));

vi.mock('../src/lib/tokens.js', () => ({
  createAccessToken: () => 'rotated-access-token',
  hashToken: (token: string) => `hash:${token}`,
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn() },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  anonymizeLead,
  anonymizeLeadInTransaction,
  LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS,
} from '../src/lib/anonymizeLead.js';
import { SMTP_DELIVERY_BUDGET_MS, SMTP_OPERATION_TIMEOUT_MS } from '../src/lib/email.js';
import { TELEGRAM_REQUEST_TIMEOUT_MS } from '../src/lib/telegramProxy.js';

type MockFn = ReturnType<typeof vi.fn>;

function createTransactionMock() {
  return {
    $executeRaw: vi.fn(),
    lead: { findFirst: vi.fn(), update: vi.fn() },
    registration: { findMany: vi.fn(), update: vi.fn() },
    registrationToken: { deleteMany: vi.fn() },
    consentRecord: { deleteMany: vi.fn() },
    legalAcceptance: { deleteMany: vi.fn() },
    emailOutboxJob: { findMany: vi.fn(), updateMany: vi.fn() },
    emailOutboxDeadLetter: { updateMany: vi.fn() },
    question: { findMany: vi.fn(), updateMany: vi.fn() },
    partnerApplication: { findMany: vi.fn(), updateMany: vi.fn() },
    webinarChatMessage: { updateMany: vi.fn() },
    event: { updateMany: vi.fn() },
    auditLog: { updateMany: vi.fn() },
    telegramBroadcastRecipient: { findMany: vi.fn(), update: vi.fn() },
    telegramBroadcastJob: { findUnique: vi.fn(), update: vi.fn() },
  };
}

const prismaMock = prisma as unknown as { $transaction: MockFn };
const anonymizedAt = new Date('2026-08-04T09:00:00.000Z');
const inactiveBefore = new Date('2023-08-05T09:00:00.000Z');
const activePartnerStatuses = ['new', 'qualified', 'contract_pending', 'contract_sent', 'contract_signed', 'paid'];

function retentionInput() {
  return {
    leadId: 'lead-1',
    anonymizedAt,
    revocationChannel: 'retention_job',
    revocationReason: 'retention_period_expired',
    eligibility: { inactiveBefore, activePartnerStatuses },
  };
}

function expectErasureLockOrder(tx: ReturnType<typeof createTransactionMock>, leadId: string) {
  expect(securityMocks.acquireEmailDeliveryLock).toHaveBeenCalledWith(tx, leadId);
  expect(securityMocks.acquireTelegramDeliveryLock).toHaveBeenCalledWith(tx, leadId);
  expect(securityMocks.acquireLeadSecurityLock).toHaveBeenCalledWith(tx, leadId);
  expect(securityMocks.acquireEmailDeliveryLock.mock.invocationCallOrder[0]).toBeLessThan(
    securityMocks.acquireTelegramDeliveryLock.mock.invocationCallOrder[0],
  );
  expect(securityMocks.acquireTelegramDeliveryLock.mock.invocationCallOrder[0]).toBeLessThan(
    securityMocks.acquireLeadSecurityLock.mock.invocationCallOrder[0],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retention lead anonymization safety', () => {
  it('rechecks pending-verification eligibility under the shared exchange lock', async () => {
    const tx = createTransactionMock();
    securityMocks.acquireLeadSecurityLock.mockResolvedValue(undefined);
    // The mailbox owner confirmed after candidate discovery but before
    // retention acquired the Lead lock, so the locked predicate no longer matches.
    tx.lead.findFirst.mockResolvedValue(null);
    const input = {
      leadId: 'lead-pending',
      anonymizedAt,
      revocationChannel: 'retention_job',
      revocationReason: 'pending_verification_expired',
      eligibility: {
        pendingVerificationBefore: new Date('2026-07-05T09:00:00.000Z'),
        confirmationTokenExpiredBefore: new Date('2026-07-28T09:00:00.000Z'),
      },
    };

    const result = await anonymizeLeadInTransaction(tx as never, input);

    expect(result).toEqual({ anonymized: false, reason: 'not_eligible' });
    expectErasureLockOrder(tx, 'lead-pending');
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'lead-pending',
        consent: false,
        registrations: expect.objectContaining({ some: expect.any(Object), none: expect.any(Object) }),
      }),
      select: { id: true },
    });
    expect(tx.registration.findMany).not.toHaveBeenCalled();
    expect(tx.lead.update).not.toHaveBeenCalled();
  });

  it('rechecks a stale candidate after the shared lead lock and preserves a lead activated while waiting', async () => {
    const tx = createTransactionMock();
    let releaseLock!: () => void;
    let activated = false;
    securityMocks.acquireLeadSecurityLock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          releaseLock = resolve;
        }),
    );
    tx.lead.findFirst.mockImplementation(async () => (activated ? null : { id: 'lead-1' }));
    prismaMock.$transaction.mockImplementation(async (callback: (transaction: typeof tx) => unknown) => callback(tx));

    // Candidate discovery happened before this call. Registration owns the same advisory lock,
    // activates the lead, commits, and only then lets retention continue.
    const anonymization = anonymizeLead(retentionInput());
    await vi.waitFor(() => expectErasureLockOrder(tx, 'lead-1'));
    expect(tx.lead.findFirst).not.toHaveBeenCalled();

    activated = true;
    releaseLock();
    const result = await anonymization;

    expect(result).toEqual({ anonymized: false, reason: 'not_eligible' });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS,
    });
    expect(LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(SMTP_DELIVERY_BUDGET_MS);
    expect(LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(
      SMTP_OPERATION_TIMEOUT_MS + TELEGRAM_REQUEST_TIMEOUT_MS,
    );
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'lead-1',
        NOT: { email: { endsWith: '@deleted.invalid' } },
        OR: [
          { personalDataConsentRevokedAt: { not: null } },
          {
            updatedAt: { lt: inactiveBefore },
            registrations: { none: { registeredAt: { gte: inactiveBefore } } },
            partnerApplications: {
              none: {
                OR: [{ status: { in: activePartnerStatuses } }, { updatedAt: { gte: inactiveBefore } }],
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    expect(tx.registration.findMany).not.toHaveBeenCalled();
    expect(tx.registrationToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.lead.update).not.toHaveBeenCalled();
  });

  it('removes PII from every related store before anonymizing an eligible lead', async () => {
    const tx = createTransactionMock();
    securityMocks.acquireLeadSecurityLock.mockResolvedValue(undefined);
    tx.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
    tx.registration.findMany.mockResolvedValue([{ id: 'registration-1' }]);
    tx.question.findMany.mockResolvedValue([{ id: 'question-1' }]);
    tx.partnerApplication.findMany.mockResolvedValue([{ id: 'application-1' }]);
    tx.emailOutboxJob.findMany.mockResolvedValue([{ id: 'email-job-1' }]);
    tx.telegramBroadcastRecipient.findMany.mockResolvedValue([
      { id: 'recipient-1', jobId: 'broadcast-1', chatId: '12345', status: 'pending' },
    ]);
    tx.telegramBroadcastJob.findUnique.mockResolvedValue({
      chatIds: ['12345', '67890'],
      recipientSnapshot: [{ leadId: 'lead-1', name: 'Иван' }, { leadId: 'lead-2' }],
    });

    const result = await anonymizeLeadInTransaction(tx as never, retentionInput());

    expect(result).toEqual({
      anonymized: true,
      registrationCount: 1,
      questionCount: 1,
      partnerApplicationCount: 1,
      broadcastRecipientCount: 1,
    });
    expectErasureLockOrder(tx, 'lead-1');
    expect(tx.registrationToken.deleteMany).toHaveBeenCalledWith({
      where: { registrationId: { in: ['registration-1'] } },
    });
    expect(tx.emailOutboxJob.updateMany).toHaveBeenCalledWith({
      where: { registrationId: { in: ['registration-1'] } },
      data: {
        toEmail: 'anonymized-lead-1@deleted.invalid',
        toName: 'Удалённый пользователь',
        webinarUrl: 'redacted://email-link',
        partnerUrl: null,
        lastError: null,
      },
    });
    expect(tx.emailOutboxJob.updateMany).toHaveBeenCalledWith({
      where: {
        registrationId: { in: ['registration-1'] },
        sentAt: null,
        status: { in: ['pending', 'failed', 'sending'] },
      },
      data: {
        status: 'cancelled',
        nextAttemptAt: null,
        lastError: 'Cancelled because the lead was anonymized',
        claimToken: null,
      },
    });
    expect(tx.emailOutboxDeadLetter.updateMany).toHaveBeenCalledWith({
      where: { jobId: { in: ['email-job-1'] } },
      data: {
        reason: 'Redacted because the lead was anonymized',
        payloadJson: { redacted: true },
      },
    });
    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: 'registration-1' },
      data: {
        accessTokenHash: 'hash:rotated-access-token',
        status: 'anonymized',
        pendingMetadataJson: expect.anything(),
        managerNote: null,
        telegramReminder24hClaimedUntil: null,
        telegramReminder3hClaimedUntil: null,
        telegramReminder30mClaimedUntil: null,
        telegramLiveClaimedUntil: null,
        telegramFollowupClaimedUntil: null,
      },
    });
    expect(tx.question.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['question-1'] } },
      data: { text: '[deleted]', publishedName: null, adminNote: null, showToParticipants: false },
    });
    expect(tx.partnerApplication.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['application-1'] } },
      data: {
        sphere: null,
        city: null,
        clientFlow: null,
        experience: null,
        comment: null,
        preferredFormat: null,
        lostReason: null,
      },
    });
    expect(tx.webinarChatMessage.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [{ registrationId: { in: ['registration-1'] } }, { questionId: { in: ['question-1'] } }],
      },
      data: {
        authorName: 'Удалённый пользователь',
        message: '[deleted]',
        metadataJson: expect.anything(),
      },
    });
    expect(tx.event.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [{ leadId: 'lead-1' }, { registrationId: { in: ['registration-1'] } }],
      },
      data: {
        leadId: null,
        registrationId: null,
        visitorId: null,
        page: null,
        source: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        userAgent: null,
        ipHash: null,
        metadataJson: expect.anything(),
      },
    });
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { entityType: 'lead', entityId: 'lead-1' },
          { entityType: 'registration', entityId: { in: ['registration-1'] } },
          { entityType: 'question', entityId: { in: ['question-1'] } },
          { entityType: 'partner_application', entityId: { in: ['application-1'] } },
        ],
      },
      data: {
        beforeJson: expect.anything(),
        afterJson: { redacted: true, reason: 'lead_anonymized' },
      },
    });
    expect(tx.telegramBroadcastJob.update).toHaveBeenCalledWith({
      where: { id: 'broadcast-1' },
      data: {
        chatIds: ['anonymized:recipient-1', '67890'],
        recipientSnapshot: [{ anonymized: true }, { leadId: 'lead-2' }],
      },
    });
    expect(tx.telegramBroadcastRecipient.update).toHaveBeenCalledWith({
      where: { id: 'recipient-1' },
      data: {
        leadId: null,
        consentRecordId: null,
        chatId: 'anonymized:recipient-1',
        inclusionReason: 'Recipient data removed because the lead was anonymized',
        status: 'skipped_revoked',
        unsubscribedBeforeSendAt: anonymizedAt,
        lastError: null,
      },
    });
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: expect.objectContaining({
        name: 'Удалённый пользователь',
        phone: '',
        email: 'anonymized-lead-1@deleted.invalid',
        city: null,
        professionalStatus: null,
        telegramChatId: null,
        telegramUsername: null,
        telegramFirstName: null,
        telegramSubscribedAt: null,
        telegramBindingVersion: null,
        source: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        consentIpHash: null,
        consent: false,
        marketingConsent: false,
        marketingEmailConsent: false,
        marketingTelegramConsent: false,
        consentRevokedAt: anonymizedAt,
        personalDataConsentRevokedAt: anonymizedAt,
        personalDataRevocationChannel: 'retention_job',
        personalDataRevocationReason: 'retention_period_expired',
        marketingEmailRevokedAt: anonymizedAt,
        marketingTelegramRevokedAt: anonymizedAt,
      }),
    });
  });
});
