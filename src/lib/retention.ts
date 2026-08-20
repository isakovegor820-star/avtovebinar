import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { anonymizeLead, pendingVerificationLeadEligibility } from './anonymizeLead.js';

export const RETENTION_POLICY_VERSION = '2026-08-20.3';
export const RETENTION_DAYS = {
  detailedEvents: 180,
  leadAttribution: 180,
  auditTechnicalTraces: 180,
  registrationTokensAfterExpiry: 7,
  // Operational PII for an unconfirmed registration. Immutable consent/terms
  // evidence follows the retention term embedded in that evidence instead.
  pendingVerification: 30,
  pendingConfirmationAfterExpiry: 7,
  questionsAndChat: 365,
  terminalEmailOutbox: 90,
  inactiveTelegramIdentifiers: 365,
  inactiveLeadPersonalData: 1095,
} as const;

const RETENTION_MIN_INTERVAL_MS = 60 * 60 * 1000;
let lastRunAt = 0;
const ACTIVE_PARTNER_STATUSES = ['new', 'qualified', 'contract_pending', 'contract_sent', 'contract_signed', 'paid'];

function daysBefore(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function normalizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export type RetentionResult = {
  expiredRegistrationTokens: number;
  detailedEventsDeleted: number;
  leadAttributionCleared: number;
  auditTechnicalTracesCleared: number;
  chatMessagesDeleted: number;
  questionsAnonymized: number;
  terminalEmailDeadLettersDeleted: number;
  terminalEmailJobsDeleted: number;
  telegramIdentifiersCleared: number;
  leadsAnonymized: number;
  pendingVerificationLeadsAnonymized: number;
};

function retentionCutoffs(now: Date) {
  return {
    events: daysBefore(now, RETENTION_DAYS.detailedEvents),
    leadAttribution: daysBefore(now, RETENTION_DAYS.leadAttribution),
    auditTechnical: daysBefore(now, RETENTION_DAYS.auditTechnicalTraces),
    expiredTokens: daysBefore(now, RETENTION_DAYS.registrationTokensAfterExpiry),
    pendingVerification: daysBefore(now, RETENTION_DAYS.pendingVerification),
    pendingConfirmationTokens: daysBefore(now, RETENTION_DAYS.pendingConfirmationAfterExpiry),
    questionsAndChat: daysBefore(now, RETENTION_DAYS.questionsAndChat),
    emailOutbox: daysBefore(now, RETENTION_DAYS.terminalEmailOutbox),
    telegramIdentifiers: daysBefore(now, RETENTION_DAYS.inactiveTelegramIdentifiers),
    inactiveLeads: daysBefore(now, RETENTION_DAYS.inactiveLeadPersonalData),
  };
}

async function anonymizeExpiredPendingVerifications(
  pendingVerificationBefore: Date,
  confirmationTokenExpiredBefore: Date,
  now: Date,
  onProgress?: () => void,
) {
  const candidates = await prisma.lead.findMany({
    where: pendingVerificationLeadEligibility(pendingVerificationBefore, confirmationTokenExpiredBefore),
    select: { id: true },
    take: 1000,
  });
  let count = 0;
  for (const candidate of candidates) {
    onProgress?.();
    const result = await anonymizeLead({
      leadId: candidate.id,
      anonymizedAt: now,
      revocationChannel: 'retention_job',
      revocationReason: 'pending_verification_expired',
      eligibility: { pendingVerificationBefore, confirmationTokenExpiredBefore },
    });
    if (result.anonymized) count += 1;
    onProgress?.();
  }
  return count;
}

async function findInactiveLeadIds(cutoff: Date) {
  const candidates = await prisma.lead.findMany({
    where: {
      NOT: { email: { endsWith: '@deleted.invalid' } },
      OR: [
        { personalDataConsentRevokedAt: { not: null } },
        {
          updatedAt: { lt: cutoff },
          registrations: { none: { registeredAt: { gte: cutoff } } },
          partnerApplications: {
            none: {
              OR: [{ status: { in: ACTIVE_PARTNER_STATUSES } }, { updatedAt: { gte: cutoff } }],
            },
          },
        },
      ],
    },
    select: { id: true },
    take: 1000,
  });
  return candidates.map(candidate => candidate.id);
}

async function anonymizeInactiveLeads(candidateIds: string[], cutoff: Date, now: Date, onProgress?: () => void) {
  let count = 0;
  for (const candidateId of candidateIds) {
    onProgress?.();
    const result = await anonymizeLead({
      leadId: candidateId,
      anonymizedAt: now,
      revocationChannel: 'retention_job',
      revocationReason: 'retention_period_expired',
      eligibility: {
        inactiveBefore: cutoff,
        activePartnerStatuses: ACTIVE_PARTNER_STATUSES,
      },
    });
    if (result.anonymized) count += 1;
    onProgress?.();
  }
  return count;
}

export async function applyRetentionPolicy(now = new Date(), onProgress?: () => void): Promise<RetentionResult> {
  const cutoffs = retentionCutoffs(now);
  // Фиксируем кандидатов до очистки attribution/Telegram: эти updateMany обновляют
  // updated_at и иначе искусственно отложили бы анонимизацию ещё на три года.
  const inactiveLeadIds = await findInactiveLeadIds(cutoffs.inactiveLeads);
  onProgress?.();
  const run = await prisma.retentionRun.create({
    data: {
      status: 'running',
      policyVersion: RETENTION_POLICY_VERSION,
      cutoffJson: Object.fromEntries(Object.entries(cutoffs).map(([key, value]) => [key, value.toISOString()])),
    },
  });

  try {
    const pendingVerificationLeadsAnonymized = await anonymizeExpiredPendingVerifications(
      cutoffs.pendingVerification,
      cutoffs.pendingConfirmationTokens,
      now,
      onProgress,
    );
    // Process candidates before attribution/Telegram cleanup updates Lead.updatedAt. Candidate
    // discovery is stale by design; the service repeats the full predicate under a per-lead lock.
    const leadsAnonymized = await anonymizeInactiveLeads(inactiveLeadIds, cutoffs.inactiveLeads, now, onProgress);
    onProgress?.();
    const result = await prisma.$transaction(async tx => {
      const expiredRegistrationTokens = await tx.registrationToken.deleteMany({
        where: { expiresAt: { not: null, lt: cutoffs.expiredTokens } },
      });
      const detailedEventsDeleted = await tx.event.deleteMany({
        where: { createdAt: { lt: cutoffs.events } },
      });
      const leadAttributionCleared = await tx.lead.updateMany({
        where: {
          updatedAt: { lt: cutoffs.leadAttribution },
          OR: [
            { source: { not: null } },
            { utmSource: { not: null } },
            { utmMedium: { not: null } },
            { utmCampaign: { not: null } },
            { utmContent: { not: null } },
            { utmTerm: { not: null } },
          ],
        },
        data: {
          source: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          utmContent: null,
          utmTerm: null,
        },
      });
      const auditTechnicalTracesCleared = await tx.auditLog.updateMany({
        where: {
          createdAt: { lt: cutoffs.auditTechnical },
          OR: [{ ipHash: { not: null } }, { userAgent: { not: null } }],
        },
        data: { ipHash: null, userAgent: null },
      });
      const chatMessagesDeleted = await tx.webinarChatMessage.deleteMany({
        where: {
          createdAt: { lt: cutoffs.questionsAndChat },
          kind: 'user',
        },
      });
      const questionsAnonymized = await tx.question.updateMany({
        where: {
          createdAt: { lt: cutoffs.questionsAndChat },
          text: { not: '[удалено по сроку хранения]' },
        },
        data: {
          text: '[удалено по сроку хранения]',
          adminNote: null,
          publishedName: null,
        },
      });
      const terminalEmailWhere: Prisma.EmailOutboxJobWhereInput = {
        updatedAt: { lt: cutoffs.emailOutbox },
        status: { in: ['sent', 'cancelled', 'dead_letter'] },
      };
      const terminalEmailJobs = await tx.emailOutboxJob.findMany({
        where: terminalEmailWhere,
        select: { id: true },
      });
      const terminalEmailDeadLettersDeleted = terminalEmailJobs.length
        ? await tx.emailOutboxDeadLetter.deleteMany({
            where: { jobId: { in: terminalEmailJobs.map(job => job.id) } },
          })
        : { count: 0 };
      const terminalEmailJobsDeleted = await tx.emailOutboxJob.deleteMany({ where: terminalEmailWhere });
      const telegramIdentifiersCleared = await tx.lead.updateMany({
        where: {
          telegramSubscribedAt: { lt: cutoffs.telegramIdentifiers },
          marketingTelegramConsent: false,
          OR: [{ marketingTelegramRevokedAt: { not: null } }, { marketingTelegramConsentAt: null }],
          registrations: { none: { registeredAt: { gte: cutoffs.telegramIdentifiers } } },
        },
        data: {
          telegramChatId: null,
          telegramUsername: null,
          telegramFirstName: null,
          telegramSubscribedAt: null,
          telegramBindingVersion: null,
        },
      });

      return {
        expiredRegistrationTokens: expiredRegistrationTokens.count,
        detailedEventsDeleted: detailedEventsDeleted.count,
        leadAttributionCleared: leadAttributionCleared.count,
        auditTechnicalTracesCleared: auditTechnicalTracesCleared.count,
        chatMessagesDeleted: chatMessagesDeleted.count,
        questionsAnonymized: questionsAnonymized.count,
        terminalEmailDeadLettersDeleted: terminalEmailDeadLettersDeleted.count,
        terminalEmailJobsDeleted: terminalEmailJobsDeleted.count,
        telegramIdentifiersCleared: telegramIdentifiersCleared.count,
      };
    });
    onProgress?.();

    const completed: RetentionResult = { ...result, leadsAnonymized, pendingVerificationLeadsAnonymized };
    await prisma.retentionRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        resultJson: completed as unknown as Prisma.InputJsonValue,
      },
    });
    logger.info(
      { retentionRunId: run.id, policyVersion: RETENTION_POLICY_VERSION, result: completed },
      '[ASPБ retention] sweep completed',
    );
    return completed;
  } catch (error) {
    await prisma.retentionRun.update({
      where: { id: run.id },
      data: { status: 'failed', completedAt: new Date(), error: normalizeError(error) },
    });
    logger.error({ err: error, retentionRunId: run.id }, '[ASPБ retention] sweep failed');
    throw error;
  }
}

export async function runRetentionSweepThrottled(now = new Date(), onProgress?: () => void) {
  const ts = now.getTime();
  if (ts - lastRunAt < RETENTION_MIN_INTERVAL_MS) {
    return null;
  }
  lastRunAt = ts;
  return applyRetentionPolicy(now, onProgress);
}
