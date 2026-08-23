import crypto, { randomUUID } from 'node:crypto';
import {
  type CRMDeliveryChannel,
  type CRMDeliveryStatus,
  type OrganizationMembershipRole,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { z } from 'zod';
import {
  MARKETING_EMAIL_CONSENT,
  MARKETING_TELEGRAM_CONSENT,
  consentDocumentHash,
} from '../consentDocuments.js';
import { sendCrmMarketingEmail } from '../email.js';
import { env } from '../env.js';
import { AppError } from '../http.js';
import {
  acquireEmailDeliveryLock,
  acquireTelegramDeliveryLock,
  isParticipantRegistrationActive,
} from '../leadSecurity.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { TELEGRAM_BINDING_VERSION } from '../roomLinks.js';
import { isPermanentTelegramError, sendTelegramMessageToChat } from '../telegram.js';
import { requireTenantRole, type TenantContext } from './context.js';

const CRM_DELIVERY_WRITE_ROLES = ['OWNER', 'CRM_MANAGER'] as const satisfies readonly OrganizationMembershipRole[];
const CRM_DELIVERY_READ_ROLES = ['OWNER', 'CRM_MANAGER', 'ANALYST', 'AUDITOR'] as const satisfies readonly OrganizationMembershipRole[];
const CRM_DELIVERY_MAX_ATTEMPTS = 5;
const CRM_DELIVERY_STALE_SENDING_MS = 10 * 60 * 1000;
const CRM_DELIVERY_TRANSACTION_TIMEOUT_MS = 40_000;
const idSchema = z.string().trim().min(1).max(191);
const idempotencyKeySchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const messageSchema = z.string().trim().min(1).max(3_500);
const enqueueDeliverySchema = z.discriminatedUnion('channel', [
  z
    .object({
      channel: z.literal('EMAIL'),
      registrationId: idSchema,
      subject: z.string().trim().min(1).max(160),
      message: messageSchema,
      idempotencyKey: idempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      channel: z.literal('TELEGRAM'),
      registrationId: idSchema,
      message: messageSchema,
      idempotencyKey: idempotencyKeySchema,
    })
    .strict(),
]);
const retryDeliverySchema = z.object({ idempotencyKey: idempotencyKeySchema }).strict();

type CRMDeliveryDb = PrismaClient | Prisma.TransactionClient;

type DeliveryTarget = NonNullable<Awaited<ReturnType<typeof findDeliveryTarget>>>;

type DeliveryEligibility = {
  allowed: boolean;
  reasonCode: string | null;
  consentRecordId: string | null;
  target: DeliveryTarget;
};

export type CRMDeliverySenders = {
  sendEmail?: typeof sendCrmMarketingEmail;
  sendTelegram?: typeof sendTelegramMessageToChat;
};

function contactUnavailable(): never {
  throw new AppError(404, 'CRM contact not found', undefined, 'crm_contact_not_found');
}

function deliveryUnavailable(): never {
  throw new AppError(404, 'CRM delivery not found', undefined, 'crm_delivery_not_found');
}

function documentForChannel(channel: CRMDeliveryChannel) {
  return channel === 'EMAIL' ? MARKETING_EMAIL_CONSENT : MARKETING_TELEGRAM_CONSENT;
}

function consentKindForChannel(channel: CRMDeliveryChannel) {
  return channel === 'EMAIL' ? 'marketing_email' : 'marketing_telegram';
}

function deliveryRequestHash(input: z.infer<typeof enqueueDeliverySchema>) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        channel: input.channel,
        registrationId: input.registrationId,
        subject: input.channel === 'EMAIL' ? input.subject : null,
        message: input.message,
      }),
    )
    .digest('hex');
}

async function lockDeliveryScope(tx: Prisma.TransactionClient, organizationId: string, suffix: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`crm-delivery:${organizationId}:${suffix}`}, ${1_406_211_408})
    )
  `;
}

async function findDeliveryTarget(
  db: CRMDeliveryDb,
  organizationId: string,
  contactId: string,
  registrationId: string,
) {
  return db.registration.findFirst({
    where: {
      id: registrationId,
      organizationId,
      crmContactId: contactId,
      webinarId: { not: null },
      userId: { not: null },
    },
    include: {
      lead: true,
      participantUser: true,
      webinarSession: { select: { id: true, webinarId: true, organizationId: true } },
    },
  });
}

async function evaluateDeliveryEligibility(
  db: CRMDeliveryDb,
  organizationId: string,
  contactId: string,
  registrationId: string,
  channel: CRMDeliveryChannel,
): Promise<DeliveryEligibility | null> {
  const target = await findDeliveryTarget(db, organizationId, contactId, registrationId);
  if (!target || !target.webinarId || !target.userId || !target.participantUser) return null;
  if (
    target.webinarSession.organizationId !== organizationId ||
    target.webinarSession.webinarId !== target.webinarId ||
    !isParticipantRegistrationActive(target) ||
    target.participantUser.status !== 'ACTIVE' ||
    !target.participantUser.emailVerifiedAt ||
    target.participantUser.emailNormalized !== target.lead.email.trim().toLowerCase()
  ) {
    return { allowed: false, reasonCode: 'crm_delivery_recipient_unavailable', consentRecordId: null, target };
  }

  const [preference, latestConsent] = await Promise.all([
    db.viewerNotificationPreference.findUnique({
      where: { userId_organizationId: { userId: target.userId, organizationId } },
    }),
    db.consentRecord.findFirst({
      where: {
        leadId: target.leadId,
        kind: consentKindForChannel(channel),
        documentId: documentForChannel(channel).id,
        registration: { organizationId, crmContactId: contactId },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    }),
  ]);
  const document = documentForChannel(channel);
  const hasCurrentEvidence =
    latestConsent?.action === 'grant' &&
    latestConsent.documentVersion === document.version &&
    latestConsent.documentHash === consentDocumentHash(document);
  const channelEnabled =
    channel === 'EMAIL'
      ? (preference?.marketingEmailEnabled ?? target.lead.marketingEmailConsent) &&
        target.lead.marketingEmailConsent &&
        Boolean(target.lead.marketingEmailConsentAt) &&
        !target.lead.marketingEmailRevokedAt
      : (preference?.marketingTelegramEnabled ?? target.lead.marketingTelegramConsent) &&
        target.lead.marketingTelegramConsent &&
        Boolean(target.lead.marketingTelegramConsentAt) &&
        !target.lead.marketingTelegramRevokedAt;
  if (!channelEnabled || !hasCurrentEvidence) {
    return {
      allowed: false,
      reasonCode: 'crm_delivery_consent_required',
      consentRecordId: null,
      target,
    };
  }
  if (
    channel === 'TELEGRAM' &&
    (!target.lead.telegramChatId || target.lead.telegramBindingVersion !== TELEGRAM_BINDING_VERSION)
  ) {
    return {
      allowed: false,
      reasonCode: 'crm_delivery_telegram_unavailable',
      consentRecordId: null,
      target,
    };
  }
  return { allowed: true, reasonCode: null, consentRecordId: latestConsent.id, target };
}

function deliveryProjection(delivery: any, canRetry: boolean) {
  return {
    id: delivery.id,
    channel: delivery.channel,
    purpose: delivery.purpose,
    status: delivery.status,
    attempts: delivery.attempts,
    registrationId: delivery.registrationId,
    webinarId: delivery.webinarId,
    webinarSessionId: delivery.webinarSessionId,
    lastErrorCode: delivery.lastErrorCode,
    nextAttemptAt: delivery.nextAttemptAt,
    sentAt: delivery.sentAt,
    completedAt: delivery.completedAt,
    createdAt: delivery.createdAt,
    canRetry:
      canRetry && ['RETRY_SCHEDULED', 'BLOCKED', 'DEAD_LETTER', 'CANCELLED'].includes(delivery.status),
  };
}

function throwEligibilityError(reasonCode: string | null): never {
  if (reasonCode === 'crm_delivery_consent_required') {
    throw new AppError(
      409,
      'Маркетинговое сообщение нельзя поставить без действующего согласия на выбранный канал',
      undefined,
      reasonCode,
    );
  }
  if (reasonCode === 'crm_delivery_telegram_unavailable') {
    throw new AppError(409, 'Telegram не привязан к этому участнику', undefined, reasonCode);
  }
  throw new AppError(409, 'Получатель сейчас недоступен для отправки', undefined, 'crm_delivery_recipient_unavailable');
}

export async function getCrmDeliveryOverview(db: PrismaClient, context: TenantContext, contactId: string) {
  requireTenantRole(context, CRM_DELIVERY_READ_ROLES);
  const contact = await db.cRMContact.findFirst({
    where: { id: contactId, organizationId: context.organizationId },
    select: {
      id: true,
      registrations: {
        where: { organizationId: context.organizationId, webinarId: { not: null }, userId: { not: null } },
        select: { id: true },
      },
    },
  });
  if (!contact) contactUnavailable();
  const canWrite = CRM_DELIVERY_WRITE_ROLES.includes(context.role as (typeof CRM_DELIVERY_WRITE_ROLES)[number]);
  const [eligibility, deliveries] = await Promise.all([
    Promise.all(
      contact.registrations.map(async registration => {
        const [email, telegram] = await Promise.all([
          evaluateDeliveryEligibility(db, context.organizationId, contact.id, registration.id, 'EMAIL'),
          evaluateDeliveryEligibility(db, context.organizationId, contact.id, registration.id, 'TELEGRAM'),
        ]);
        return {
          registrationId: registration.id,
          email: { allowed: Boolean(email?.allowed), reasonCode: email?.reasonCode ?? 'crm_delivery_recipient_unavailable' },
          telegram: {
            allowed: Boolean(telegram?.allowed),
            reasonCode: telegram?.reasonCode ?? 'crm_delivery_recipient_unavailable',
          },
        };
      }),
    ),
    db.cRMDelivery.findMany({
      where: { organizationId: context.organizationId, contactId: contact.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
  ]);
  return {
    canSend: canWrite,
    eligibility,
    deliveries: deliveries.map(delivery => deliveryProjection(delivery, canWrite)),
  };
}

export async function enqueueCrmDelivery(
  db: PrismaClient,
  context: TenantContext,
  contactIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_DELIVERY_WRITE_ROLES);
  const contactId = idSchema.parse(contactIdInput);
  const data = enqueueDeliverySchema.parse(input);
  const channel = data.channel as CRMDeliveryChannel;
  const requestHash = deliveryRequestHash(data);
  return db.$transaction(async tx => {
    await lockDeliveryScope(tx, context.organizationId, `enqueue:${data.idempotencyKey}`);
    const replay = await tx.cRMDelivery.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: context.organizationId,
          idempotencyKey: data.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (replay.requestHash !== requestHash || replay.contactId !== contactId) {
        throw new AppError(
          409,
          'Idempotency key already belongs to another delivery request',
          undefined,
          'crm_delivery_idempotency_conflict',
        );
      }
      return { delivery: deliveryProjection(replay, true), replayed: true };
    }

    const eligibility = await evaluateDeliveryEligibility(
      tx,
      context.organizationId,
      contactId,
      data.registrationId,
      channel,
    );
    if (!eligibility) contactUnavailable();
    if (!eligibility.allowed || !eligibility.consentRecordId) throwEligibilityError(eligibility.reasonCode);
    const target = eligibility.target;
    const delivery = await tx.cRMDelivery.create({
      data: {
        organizationId: context.organizationId,
        contactId,
        registrationId: target.id,
        webinarId: target.webinarId!,
        webinarSessionId: target.webinarSessionId,
        requestedByMembershipId: context.membershipId,
        channel,
        subject: data.channel === 'EMAIL' ? data.subject : null,
        body: data.message,
        consentRecordId: eligibility.consentRecordId,
        idempotencyKey: data.idempotencyKey,
        requestHash,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId,
        type: 'delivery_queued',
        source: 'tenant_crm_delivery',
        sourceEntityType: 'crm_delivery',
        sourceEntityId: delivery.id,
        webinarId: delivery.webinarId,
        webinarSessionId: delivery.webinarSessionId,
        registrationId: delivery.registrationId,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey: `crm-delivery:${delivery.id}:queued`,
        metadataJson: { channel: delivery.channel, status: delivery.status },
        occurredAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.delivery.queued',
        entityType: 'crm_delivery',
        entityId: delivery.id,
        afterJson: {
          channel: delivery.channel,
          purpose: delivery.purpose,
          registrationId: delivery.registrationId,
          webinarId: delivery.webinarId,
          webinarSessionId: delivery.webinarSessionId,
          status: delivery.status,
        },
      },
    });
    return { delivery: deliveryProjection(delivery, true), replayed: false };
  });
}

export async function retryCrmDelivery(
  db: PrismaClient,
  context: TenantContext,
  deliveryIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, CRM_DELIVERY_WRITE_ROLES);
  const deliveryId = idSchema.parse(deliveryIdInput);
  const data = retryDeliverySchema.parse(input);
  return db.$transaction(async tx => {
    await lockDeliveryScope(tx, context.organizationId, `retry:${deliveryId}`);
    const existing = await tx.cRMDelivery.findFirst({
      where: { id: deliveryId, organizationId: context.organizationId },
    });
    if (!existing) deliveryUnavailable();
    const eventKey = `crm-delivery-retry:${existing.id}:${data.idempotencyKey}`;
    const replay = await tx.cRMContactEvent.findUnique({
      where: { organizationId_dedupKey: { organizationId: context.organizationId, dedupKey: eventKey } },
    });
    if (replay) return { delivery: deliveryProjection(existing, true), replayed: true };
    if (!['RETRY_SCHEDULED', 'BLOCKED', 'DEAD_LETTER', 'CANCELLED'].includes(existing.status)) {
      throw new AppError(409, 'Delivery cannot be retried in its current state', undefined, 'crm_delivery_retry_not_allowed');
    }
    const eligibility = await evaluateDeliveryEligibility(
      tx,
      context.organizationId,
      existing.contactId,
      existing.registrationId,
      existing.channel,
    );
    if (!eligibility?.allowed || !eligibility.consentRecordId) {
      throwEligibilityError(eligibility?.reasonCode ?? null);
    }
    const requester = await tx.organizationMembership.findFirst({
      where: {
        id: existing.requestedByMembershipId,
        organizationId: context.organizationId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'CRM_MANAGER'] },
      },
    });
    if (!requester) {
      throw new AppError(
        409,
        'Create a new delivery because the original requester is no longer active',
        undefined,
        'crm_delivery_requester_inactive',
      );
    }
    const delivery = await tx.cRMDelivery.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        attempts: 0,
        consentRecordId: eligibility.consentRecordId,
        claimToken: null,
        lastErrorCode: null,
        nextAttemptAt: now,
        sentAt: null,
        completedAt: null,
      },
    });
    await tx.cRMContactEvent.create({
      data: {
        organizationId: context.organizationId,
        contactId: delivery.contactId,
        type: 'delivery_retry_requested',
        source: 'tenant_crm_delivery',
        sourceEntityType: 'crm_delivery',
        sourceEntityId: delivery.id,
        webinarId: delivery.webinarId,
        webinarSessionId: delivery.webinarSessionId,
        registrationId: delivery.registrationId,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey: eventKey,
        metadataJson: { channel: delivery.channel, status: delivery.status },
        occurredAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'crm.delivery.retry_requested',
        entityType: 'crm_delivery',
        entityId: delivery.id,
        beforeJson: { status: existing.status, attempts: existing.attempts, lastErrorCode: existing.lastErrorCode },
        afterJson: { status: delivery.status, attempts: delivery.attempts },
      },
    });
    return { delivery: deliveryProjection(delivery, true), replayed: false };
  });
}

function nextRetryAt(now: Date, attempts: number) {
  return new Date(now.getTime() + Math.min(60, 2 ** Math.max(0, attempts)) * 60_000);
}

async function recordWorkerState(
  tx: Prisma.TransactionClient,
  delivery: {
    id: string;
    organizationId: string;
    contactId: string;
    registrationId: string;
    webinarId: string;
    webinarSessionId: string;
    channel: CRMDeliveryChannel;
    attempts: number;
    claimToken?: string | null;
  },
  input: { type: string; status: CRMDeliveryStatus; errorCode?: string | null; occurredAt: Date },
) {
  await tx.cRMContactEvent.createMany({
    data: [
      {
        organizationId: delivery.organizationId,
        contactId: delivery.contactId,
        type: input.type,
        source: 'tenant_crm_delivery_worker',
        sourceEntityType: 'crm_delivery',
        sourceEntityId: delivery.id,
        webinarId: delivery.webinarId,
        webinarSessionId: delivery.webinarSessionId,
        registrationId: delivery.registrationId,
        correlationId: `crm_delivery:${delivery.id}`,
        dedupKey: `crm-delivery:${delivery.id}:${input.type}:${delivery.claimToken ?? delivery.attempts}`,
        metadataJson: {
          channel: delivery.channel,
          status: input.status,
          attempt: delivery.attempts,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        },
        occurredAt: input.occurredAt,
      },
    ],
    skipDuplicates: true,
  });
  await tx.auditLog.create({
    data: {
      organizationId: delivery.organizationId,
      correlationId: `crm_delivery:${delivery.id}`,
      action: `crm.delivery.${input.type}`,
      entityType: 'crm_delivery',
      entityId: delivery.id,
      afterJson: {
        channel: delivery.channel,
        status: input.status,
        attempt: delivery.attempts,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    },
  });
}

async function resetStaleDeliveries(now: Date) {
  const stale = await prisma.cRMDelivery.findMany({
    where: {
      status: 'SENDING',
      updatedAt: { lt: new Date(now.getTime() - CRM_DELIVERY_STALE_SENDING_MS) },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: 25,
  });
  for (const delivery of stale) {
    await prisma.$transaction(async tx => {
      const updated = await tx.cRMDelivery.updateMany({
        where: { id: delivery.id, status: 'SENDING', claimToken: delivery.claimToken },
        data: {
          status: 'RETRY_SCHEDULED',
          claimToken: null,
          lastErrorCode: 'crm_delivery_worker_interrupted',
          nextAttemptAt: now,
        },
      });
      if (updated.count === 1) {
        await recordWorkerState(tx, delivery, {
          type: 'retry_scheduled',
          status: 'RETRY_SCHEDULED',
          errorCode: 'crm_delivery_worker_interrupted',
          occurredAt: now,
        });
      }
    });
  }
}

async function markProviderFailure(
  delivery: Awaited<ReturnType<typeof prisma.cRMDelivery.findFirstOrThrow>>,
  claimToken: string,
  now: Date,
  permanent: boolean,
) {
  const exhausted = permanent || delivery.attempts >= CRM_DELIVERY_MAX_ATTEMPTS;
  const status: CRMDeliveryStatus = exhausted ? 'DEAD_LETTER' : 'RETRY_SCHEDULED';
  const errorCode = permanent ? 'crm_delivery_recipient_unavailable' : 'crm_delivery_provider_temporary_failure';
  return prisma.$transaction(async tx => {
    const updated = await tx.cRMDelivery.updateMany({
      where: { id: delivery.id, status: 'SENDING', claimToken },
      data: {
        status,
        claimToken: null,
        lastErrorCode: errorCode,
        nextAttemptAt: exhausted ? null : nextRetryAt(now, delivery.attempts),
        completedAt: exhausted ? now : null,
      },
    });
    if (updated.count !== 1) return false;
    await recordWorkerState(tx, delivery, {
      type: exhausted ? 'dead_lettered' : 'retry_scheduled',
      status,
      errorCode,
      occurredAt: now,
    });
    return true;
  });
}

export async function runCrmDeliveryJobsOnce(
  now = new Date(),
  senders: CRMDeliverySenders = {},
  onProgress?: () => void,
) {
  if (env.PLATFORM_ACCOUNTS_ENABLED !== 'on' || env.TENANT_CRM_ENABLED !== 'on') {
    return { checked: 0, sent: 0, failed: 0, blocked: 0, cancelled: 0, deadLettered: 0, disabled: true };
  }
  await resetStaleDeliveries(now);
  onProgress?.();
  const candidate = await prisma.cRMDelivery.findFirst({
    where: {
      status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
      nextAttemptAt: { lte: now },
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!candidate) return { checked: 0, sent: 0, failed: 0, blocked: 0, cancelled: 0, deadLettered: 0 };
  const claimToken = randomUUID();
  const claimed = await prisma.cRMDelivery.updateMany({
    where: { id: candidate.id, status: candidate.status, claimToken: null },
    data: {
      status: 'SENDING',
      attempts: { increment: 1 },
      claimToken,
      nextAttemptAt: null,
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) {
    return { checked: 1, sent: 0, failed: 0, blocked: 0, cancelled: 0, deadLettered: 0 };
  }
  const delivery = { ...candidate, status: 'SENDING' as const, attempts: candidate.attempts + 1, claimToken };
  onProgress?.();

  try {
    const outcome = await prisma.$transaction(
      async tx => {
        const registrationRef = await tx.registration.findUnique({
          where: { id: delivery.registrationId },
          select: { leadId: true },
        });
        if (!registrationRef) return { kind: 'blocked' as const, reasonCode: 'crm_delivery_recipient_unavailable' };
        if (delivery.channel === 'EMAIL') await acquireEmailDeliveryLock(tx, registrationRef.leadId);
        else await acquireTelegramDeliveryLock(tx, registrationRef.leadId);

        const current = await tx.cRMDelivery.findFirst({
          where: { id: delivery.id, status: 'SENDING', claimToken },
          include: { requestedByMembership: true },
        });
        if (!current) return { kind: 'not_owned' as const };
        const requesterActive =
          current.requestedByMembership.status === 'ACTIVE' &&
          ['OWNER', 'CRM_MANAGER'].includes(current.requestedByMembership.role);
        const eligibility = requesterActive
          ? await evaluateDeliveryEligibility(
              tx,
              current.organizationId,
              current.contactId,
              current.registrationId,
              current.channel,
            )
          : null;
        if (!requesterActive || !eligibility?.allowed || !eligibility.consentRecordId) {
          const reasonCode = requesterActive
            ? (eligibility?.reasonCode ?? 'crm_delivery_recipient_unavailable')
            : 'crm_delivery_requester_inactive';
          const finishedAt = new Date();
          const updated = await tx.cRMDelivery.updateMany({
            where: { id: current.id, status: 'SENDING', claimToken },
            data: {
              status: 'BLOCKED',
              claimToken: null,
              lastErrorCode: reasonCode,
              nextAttemptAt: null,
              completedAt: finishedAt,
            },
          });
          if (updated.count === 1) {
            await recordWorkerState(tx, { ...current, attempts: current.attempts }, {
              type: 'blocked',
              status: 'BLOCKED',
              errorCode: reasonCode,
              occurredAt: finishedAt,
            });
          }
          return { kind: 'blocked' as const, reasonCode };
        }

        const target = eligibility.target;
        const providerResult =
          current.channel === 'EMAIL'
            ? await (senders.sendEmail ?? sendCrmMarketingEmail)({
                to: target.participantUser!.emailNormalized,
                subject: current.subject!,
                text: current.body,
              })
            : await (senders.sendTelegram ?? sendTelegramMessageToChat)(target.lead.telegramChatId!, current.body, {
                attempts: 1,
              });
        const finishedAt = new Date();
        if (!providerResult.sent) {
          const updated = await tx.cRMDelivery.updateMany({
            where: { id: current.id, status: 'SENDING', claimToken },
            data: {
              status: 'CANCELLED',
              consentRecordId: eligibility.consentRecordId,
              claimToken: null,
              lastErrorCode: 'crm_delivery_provider_disabled',
              nextAttemptAt: null,
              completedAt: finishedAt,
            },
          });
          if (updated.count === 1) {
            await recordWorkerState(tx, current, {
              type: 'cancelled',
              status: 'CANCELLED',
              errorCode: 'crm_delivery_provider_disabled',
              occurredAt: finishedAt,
            });
          }
          return { kind: 'cancelled' as const };
        }
        const updated = await tx.cRMDelivery.updateMany({
          where: { id: current.id, status: 'SENDING', claimToken },
          data: {
            status: 'SENT',
            consentRecordId: eligibility.consentRecordId,
            claimToken: null,
            lastErrorCode: null,
            nextAttemptAt: null,
            sentAt: finishedAt,
            completedAt: finishedAt,
          },
        });
        if (updated.count === 1) {
          await recordWorkerState(tx, current, { type: 'sent', status: 'SENT', occurredAt: finishedAt });
        }
        return { kind: updated.count === 1 ? ('sent' as const) : ('not_owned' as const) };
      },
      { maxWait: 5_000, timeout: CRM_DELIVERY_TRANSACTION_TIMEOUT_MS },
    );
    onProgress?.();
    return {
      checked: 1,
      sent: outcome.kind === 'sent' ? 1 : 0,
      failed: 0,
      blocked: outcome.kind === 'blocked' ? 1 : 0,
      cancelled: outcome.kind === 'cancelled' ? 1 : 0,
      deadLettered: 0,
    };
  } catch (error) {
    const permanent = delivery.channel === 'TELEGRAM' && isPermanentTelegramError(error);
    const recorded = await markProviderFailure(delivery, claimToken, new Date(), permanent);
    logger.error(
      {
        deliveryId: delivery.id,
        organizationId: delivery.organizationId,
        channel: delivery.channel,
        errorCode: permanent ? 'crm_delivery_recipient_unavailable' : 'crm_delivery_provider_temporary_failure',
      },
      'Tenant CRM delivery failed',
    );
    const deadLettered = recorded && (permanent || delivery.attempts >= CRM_DELIVERY_MAX_ATTEMPTS);
    return {
      checked: 1,
      sent: 0,
      failed: recorded && !deadLettered ? 1 : 0,
      blocked: 0,
      cancelled: 0,
      deadLettered: deadLettered ? 1 : 0,
    };
  }
}
