import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { acquireEmailDeliveryLock, acquireLeadSecurityLock, acquireTelegramDeliveryLock } from './leadSecurity.js';
import { EMAIL_OUTBOX_LINK_REDACTED } from './emailOutbox.js';
import { ROOM_EXCHANGE_TOKEN_PURPOSE } from './roomLinks.js';
import { createAccessToken, hashToken } from './tokens.js';

// Erasure waits for at most one bounded SMTP request (25s) and one bounded
// Telegram request (20s), then performs its database work under the Lead lock.
export const LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS = 60_000;

export type LeadAnonymizationEligibility =
  | {
      inactiveBefore: Date;
      activePartnerStatuses: string[];
    }
  | {
      pendingVerificationBefore: Date;
      confirmationTokenExpiredBefore: Date;
    };

export type LeadAnonymizationInput = {
  leadId: string;
  anonymizedAt: Date;
  revocationChannel: string;
  revocationReason: string;
  eligibility?: LeadAnonymizationEligibility;
};

async function acquireBroadcastSnapshotLock(tx: Prisma.TransactionClient, jobId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(48192732, hashtext(${jobId}))`);
}

export function pendingVerificationLeadEligibility(
  pendingVerificationBefore: Date,
  confirmationTokenExpiredBefore: Date,
): Prisma.LeadWhereInput {
  return {
    NOT: { email: { endsWith: '@deleted.invalid' } },
    consent: false,
    marketingEmailConsent: false,
    marketingTelegramConsent: false,
    personalDataConsentRevokedAt: null,
    telegramChatId: null,
    partnerApplications: { none: {} },
    questions: { none: {} },
    registrations: {
      some: {
        status: 'pending_verification',
        emailVerifiedAt: null,
        registeredAt: { lt: pendingVerificationBefore },
      },
      none: {
        OR: [
          { status: 'registered', emailVerifiedAt: { not: null } },
          {
            status: 'pending_verification',
            OR: [
              { registeredAt: { gte: pendingVerificationBefore } },
              {
                tokens: {
                  some: {
                    purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
                    OR: [{ expiresAt: null }, { expiresAt: { gte: confirmationTokenExpiredBefore } }],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

function eligibilityWhere(input: LeadAnonymizationInput): Prisma.LeadWhereInput {
  if (!input.eligibility) return { id: input.leadId };
  if ('pendingVerificationBefore' in input.eligibility) {
    return {
      id: input.leadId,
      ...pendingVerificationLeadEligibility(
        input.eligibility.pendingVerificationBefore,
        input.eligibility.confirmationTokenExpiredBefore,
      ),
    };
  }
  const cutoff = input.eligibility.inactiveBefore;
  return {
    id: input.leadId,
    NOT: { email: { endsWith: '@deleted.invalid' } },
    OR: [
      { personalDataConsentRevokedAt: { not: null } },
      {
        updatedAt: { lt: cutoff },
        registrations: { none: { registeredAt: { gte: cutoff } } },
        partnerApplications: {
          none: {
            OR: [{ status: { in: input.eligibility.activePartnerStatuses } }, { updatedAt: { gte: cutoff } }],
          },
        },
      },
    ],
  };
}

export async function anonymizeLeadInTransaction(tx: Prisma.TransactionClient, input: LeadAnonymizationInput) {
  // Global order for transactions spanning channels and Lead data. Provider
  // delivery transactions take only their own channel lock, so ordinary Lead
  // operations are never queued behind network I/O and this order cannot cycle.
  await acquireEmailDeliveryLock(tx, input.leadId);
  await acquireTelegramDeliveryLock(tx, input.leadId);
  await acquireLeadSecurityLock(tx, input.leadId);

  // Candidate discovery is only a batching optimization. This second predicate evaluation is
  // the authorization decision and happens under the same lock used by account activation.
  const eligibleLead = await tx.lead.findFirst({
    where: eligibilityWhere(input),
    select: { id: true },
  });
  if (!eligibleLead) {
    return { anonymized: false as const, reason: 'not_eligible' as const };
  }

  const anonymizedEmail = `anonymized-${input.leadId}@deleted.invalid`;
  const registrations = await tx.registration.findMany({
    where: { leadId: input.leadId },
    select: { id: true },
  });
  const registrationIds = registrations.map(registration => registration.id);
  // ConsentRecord and LegalAcceptance are database-enforced append-only audit
  // evidence. Pending-retention anonymizes the operational Lead/Registration,
  // tokens, metadata and delivery payloads but preserves those immutable rows
  // for their separately documented legal-evidence retention term.
  const questions = await tx.question.findMany({
    where: {
      OR: [{ leadId: input.leadId }, ...(registrationIds.length ? [{ registrationId: { in: registrationIds } }] : [])],
    },
    select: { id: true },
  });
  const questionIds = questions.map(question => question.id);
  const partnerApplications = await tx.partnerApplication.findMany({
    where: {
      OR: [{ leadId: input.leadId }, ...(registrationIds.length ? [{ registrationId: { in: registrationIds } }] : [])],
    },
    select: { id: true },
  });
  const partnerApplicationIds = partnerApplications.map(application => application.id);

  if (registrationIds.length > 0) {
    await tx.registrationToken.deleteMany({ where: { registrationId: { in: registrationIds } } });

    const emailJobs = await tx.emailOutboxJob.findMany({
      where: { registrationId: { in: registrationIds } },
      select: { id: true },
    });
    const emailJobIds = emailJobs.map(job => job.id);
    await tx.emailOutboxJob.updateMany({
      where: { registrationId: { in: registrationIds } },
      data: {
        toEmail: anonymizedEmail,
        toName: 'Удалённый пользователь',
        webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
        partnerUrl: null,
        lastError: null,
      },
    });
    if (emailJobIds.length > 0) {
      await tx.emailOutboxDeadLetter.updateMany({
        where: { jobId: { in: emailJobIds } },
        data: {
          reason: 'Redacted because the lead was anonymized',
          payloadJson: { redacted: true },
        },
      });
    }
    await tx.emailOutboxJob.updateMany({
      where: {
        registrationId: { in: registrationIds },
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

    for (const registration of registrations) {
      await tx.registration.update({
        where: { id: registration.id },
        data: {
          accessTokenHash: hashToken(createAccessToken()),
          status: 'anonymized',
          pendingMetadataJson: Prisma.DbNull,
          managerNote: null,
          telegramReminder24hClaimedUntil: null,
          telegramReminder3hClaimedUntil: null,
          telegramReminder30mClaimedUntil: null,
          telegramLiveClaimedUntil: null,
          telegramFollowupClaimedUntil: null,
        },
      });
    }
  }

  if (questionIds.length > 0) {
    await tx.question.updateMany({
      where: { id: { in: questionIds } },
      data: { text: '[deleted]', publishedName: null, adminNote: null, showToParticipants: false },
    });
  }
  if (partnerApplicationIds.length > 0) {
    await tx.partnerApplication.updateMany({
      where: { id: { in: partnerApplicationIds } },
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
  }
  if (registrationIds.length > 0 || questionIds.length > 0) {
    await tx.webinarChatMessage.updateMany({
      where: {
        OR: [
          ...(registrationIds.length ? [{ registrationId: { in: registrationIds } }] : []),
          ...(questionIds.length ? [{ questionId: { in: questionIds } }] : []),
        ],
      },
      data: {
        authorName: 'Удалённый пользователь',
        message: '[deleted]',
        metadataJson: Prisma.DbNull,
      },
    });
  }

  await tx.event.updateMany({
    where: {
      OR: [{ leadId: input.leadId }, ...(registrationIds.length ? [{ registrationId: { in: registrationIds } }] : [])],
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
      metadataJson: Prisma.DbNull,
    },
  });

  const relatedAuditEntities: Prisma.AuditLogWhereInput[] = [
    { entityType: 'lead', entityId: input.leadId },
    ...(registrationIds.length
      ? [{ entityType: 'registration', entityId: { in: registrationIds } } satisfies Prisma.AuditLogWhereInput]
      : []),
    ...(questionIds.length
      ? [{ entityType: 'question', entityId: { in: questionIds } } satisfies Prisma.AuditLogWhereInput]
      : []),
    ...(partnerApplicationIds.length
      ? [
          {
            entityType: 'partner_application',
            entityId: { in: partnerApplicationIds },
          } satisfies Prisma.AuditLogWhereInput,
        ]
      : []),
  ];
  await tx.auditLog.updateMany({
    where: { OR: relatedAuditEntities },
    data: {
      beforeJson: Prisma.JsonNull,
      afterJson: { redacted: true, reason: 'lead_anonymized' },
    },
  });

  const broadcastRecipients = await tx.telegramBroadcastRecipient.findMany({
    where: { leadId: input.leadId },
    select: { id: true, jobId: true, chatId: true, status: true },
  });
  const recipientsByJob = new Map<string, typeof broadcastRecipients>();
  for (const recipient of broadcastRecipients) {
    const entries = recipientsByJob.get(recipient.jobId) ?? [];
    entries.push(recipient);
    recipientsByJob.set(recipient.jobId, entries);
  }
  for (const [jobId, recipients] of [...recipientsByJob.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // Different Leads can be erased concurrently but share one denormalized
    // broadcast snapshot. Serialize the read/modify/write per job so the later
    // erasure sees the earlier redaction instead of resurrecting old JSON.
    await acquireBroadcastSnapshotLock(tx, jobId);
    const job = await tx.telegramBroadcastJob.findUnique({
      where: { id: jobId },
      select: { chatIds: true, recipientSnapshot: true },
    });
    if (job) {
      const replacements = new Map(
        recipients.map(recipient => [recipient.chatId, `anonymized:${recipient.id}`] as const),
      );
      const chatIds = Array.isArray(job.chatIds)
        ? job.chatIds.map(chatId => replacements.get(String(chatId)) ?? String(chatId))
        : [];
      const recipientSnapshot = Array.isArray(job.recipientSnapshot)
        ? job.recipientSnapshot.map(snapshot => {
            if (
              snapshot &&
              typeof snapshot === 'object' &&
              !Array.isArray(snapshot) &&
              'leadId' in snapshot &&
              snapshot.leadId === input.leadId
            ) {
              return { anonymized: true };
            }
            return snapshot;
          })
        : [];
      await tx.telegramBroadcastJob.update({
        where: { id: jobId },
        data: {
          chatIds: chatIds as Prisma.InputJsonValue,
          recipientSnapshot: recipientSnapshot as Prisma.InputJsonValue,
        },
      });
    }
    for (const recipient of recipients) {
      await tx.telegramBroadcastRecipient.update({
        where: { id: recipient.id },
        data: {
          leadId: null,
          consentRecordId: null,
          chatId: `anonymized:${recipient.id}`,
          inclusionReason: 'Recipient data removed because the lead was anonymized',
          status: recipient.status === 'pending' ? 'skipped_revoked' : recipient.status,
          unsubscribedBeforeSendAt: recipient.status === 'pending' ? input.anonymizedAt : undefined,
          lastError: null,
        },
      });
    }
  }

  await tx.lead.update({
    where: { id: input.leadId },
    data: {
      name: 'Удалённый пользователь',
      phone: '',
      email: anonymizedEmail,
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
      consentRevokedAt: input.anonymizedAt,
      personalDataConsentRevokedAt: input.anonymizedAt,
      personalDataRevocationChannel: input.revocationChannel,
      personalDataRevocationReason: input.revocationReason,
      marketingEmailRevokedAt: input.anonymizedAt,
      marketingTelegramRevokedAt: input.anonymizedAt,
    },
  });

  return {
    anonymized: true as const,
    registrationCount: registrationIds.length,
    questionCount: questionIds.length,
    partnerApplicationCount: partnerApplicationIds.length,
    broadcastRecipientCount: broadcastRecipients.length,
  };
}

export function anonymizeLead(input: LeadAnonymizationInput) {
  return prisma.$transaction(tx => anonymizeLeadInTransaction(tx, input), {
    maxWait: 5_000,
    timeout: LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS,
  });
}
