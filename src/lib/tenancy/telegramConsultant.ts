import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { classifyLegalAdviceRequest } from '../chatPolicy.js';
import { env } from '../env.js';
import { AppError } from '../http.js';
import { createCorrelationId } from '../requestContext.js';
import { ANONYMIZED_LEAD_EMAIL_SUFFIX } from '../leadSecurity.js';
import { TELEGRAM_BINDING_VERSION } from '../roomLinks.js';
import { requireTenantRole, type TenantContext } from './context.js';
import { buildServerDedupKey, recordAnalyticsEvent } from '../analyticsEvents.js';

const idSchema = z.string().trim().min(1).max(191);
const providerMessageIdSchema = z.string().trim().min(1).max(191);
const consultantTextSchema = z
  .string()
  .normalize('NFKC')
  .transform(value =>
    [...value]
      .filter(character => {
        const code = character.codePointAt(0) ?? 0;
        return !((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127);
      })
      .join('')
      .replace(/\r\n?/gu, '\n')
      .replace(/\n{4,}/gu, '\n\n\n')
      .trim(),
  )
  .pipe(z.string().min(1).max(4_000));
const topicSchema = z.enum(['bankruptcy', 'tax', 'debt', 'partnership', 'webinar_access', 'other']);
const intentSchema = z.enum(['navigation', 'legal_question', 'manager_contact', 'partnership', 'other']);
const urgencySchema = z.enum(['low', 'normal', 'high']);
const correctionSchema = z
  .object({
    topic: topicSchema.optional(),
    intent: intentSchema.optional(),
    urgency: urgencySchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine(value => Boolean(value.topic || value.intent || value.urgency), {
    message: 'At least one classification correction is required',
  });

export type TelegramConsultantClassification = ReturnType<typeof classifyTelegramConsultantText>;

export function classifyTelegramConsultantText(input: string) {
  const text = consultantTextSchema.parse(input);
  const normalized = text.toLocaleLowerCase('ru-RU');
  const topic = /банкрот|субсидиар|несостоятельн/iu.test(normalized)
    ? 'bankruptcy'
    : /налог|фнс|доначислен|провер[кч]/iu.test(normalized)
      ? 'tax'
      : /долг|кредит|взыскан|исполнительн/iu.test(normalized)
        ? 'debt'
        : /партн[её]р|договор|вознагражден/iu.test(normalized)
          ? 'partnership'
          : /вебинар|комнат|запис|материал|доступ|ссылк/iu.test(normalized)
            ? 'webinar_access'
            : 'other';
  const legalAdvice = classifyLegalAdviceRequest(text) === 'PERSONALIZED_LEGAL_ADVICE';
  const intent = legalAdvice
    ? 'legal_question'
    : /свяж|позвон|менеджер|человек|оператор/iu.test(normalized)
      ? 'manager_contact'
      : topic === 'partnership'
        ? 'partnership'
        : topic === 'webinar_access'
          ? 'navigation'
          : 'other';
  const urgency = /сроч|сегодня|завтра|суд|заседан|пристав|блокиров|арест/iu.test(normalized)
    ? 'high'
    : /когда|срок|скоро|недел/iu.test(normalized)
      ? 'normal'
      : 'low';
  return {
    text,
    topic: topicSchema.parse(topic),
    intent: intentSchema.parse(intent),
    urgency: urgencySchema.parse(urgency),
    requiresHuman: legalAdvice || intent === 'manager_contact' || urgency === 'high',
    model: 'local_policy',
    version: 'telegram-intent-v1',
  };
}

function hashConsultantChatId(chatId: string) {
  return crypto.createHmac('sha256', env.IP_HASH_SECRET).update(`telegram-consultant-chat:v1:${chatId}`).digest('hex');
}

function consultantMessageProjection(message: {
  id: string;
  registrationId: string | null;
  webinarId: string | null;
  webinarSessionId: string | null;
  crmContactId: string | null;
  text: string;
  topic: string;
  intent: string;
  urgency: string;
  classificationModel: string;
  classificationVersion: string;
  correctedTopic: string | null;
  correctedIntent: string | null;
  correctedUrgency: string | null;
  correctionReason: string | null;
  status: string;
  handedOffAt: Date | null;
  correctedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: message.id,
    registrationId: message.registrationId,
    webinarId: message.webinarId,
    webinarSessionId: message.webinarSessionId,
    crmContactId: message.crmContactId,
    text: message.text,
    classification: {
      topic: message.correctedTopic ?? message.topic,
      intent: message.correctedIntent ?? message.intent,
      urgency: message.correctedUrgency ?? message.urgency,
      original: { topic: message.topic, intent: message.intent, urgency: message.urgency },
      corrected: Boolean(message.correctedAt),
      correctionReason: message.correctionReason,
      model: message.classificationModel,
      version: message.classificationVersion,
    },
    status: message.status,
    handedOffAt: message.handedOffAt,
    correctedAt: message.correctedAt,
    createdAt: message.createdAt,
  };
}

async function resolveConsultantRegistrationScope(tx: Prisma.TransactionClient, chatId: string) {
  const candidates = await tx.registration.findMany({
    where: {
      organizationId: { not: null },
      webinarId: { not: null },
      crmContactId: { not: null },
      status: 'registered',
      emailVerifiedAt: { not: null },
      webinarSession: { lifecycleStatus: { not: 'CANCELLED' } },
      lead: {
        telegramChatId: chatId,
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        personalDataConsentRevokedAt: null,
        email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
      },
    },
    include: { lead: { select: { id: true } }, webinarSession: true },
    orderBy: [{ registeredAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  const organizations = new Set(candidates.map(candidate => candidate.organizationId));
  if (organizations.size !== 1) return null;
  const registration = candidates[0];
  if (
    !registration?.organizationId ||
    !registration.webinarId ||
    !registration.crmContactId ||
    registration.organizationId !== registration.webinarSession.organizationId ||
    registration.webinarId !== registration.webinarSession.webinarId
  ) {
    return null;
  }
  return registration;
}

export async function recordTelegramConsultantMessage(
  db: PrismaClient,
  input: {
    chatId: string;
    providerMessageId: unknown;
    text: string;
    correlationId?: string;
  },
  now = new Date(),
) {
  const providerMessageId = providerMessageIdSchema.parse(input.providerMessageId);
  const classification = classifyTelegramConsultantText(input.text);
  const chatIdHash = hashConsultantChatId(input.chatId);
  const providerMessageKey = crypto
    .createHash('sha256')
    .update(`consultant:${chatIdHash}:${providerMessageId}`)
    .digest('hex');
  const correlationId = input.correlationId ?? createCorrelationId('telegram_consultant');

  return db.$transaction(async tx => {
    const duplicate = await tx.telegramConsultantMessage.findUnique({ where: { providerMessageKey } });
    if (duplicate) {
      return {
        message: consultantMessageProjection(duplicate),
        scope: {
          organizationId: duplicate.organizationId,
          webinarId: duplicate.webinarId,
          webinarSessionId: duplicate.webinarSessionId,
          registrationId: duplicate.registrationId,
          crmContactId: duplicate.crmContactId,
        },
        correlationId: duplicate.correlationId,
        classification: {
          topic: duplicate.topic,
          intent: duplicate.intent,
          urgency: duplicate.urgency,
          requiresHuman:
            duplicate.intent === 'legal_question' ||
            duplicate.intent === 'manager_contact' ||
            duplicate.urgency === 'high',
        },
        replayed: true,
      };
    }
    const registration = await resolveConsultantRegistrationScope(tx, input.chatId);
    const organizationId = registration?.organizationId ?? null;
    const webinarId = registration?.webinarId ?? null;
    const webinarSessionId = registration?.webinarSessionId ?? null;
    const registrationId = registration?.id ?? null;
    const crmContactId = registration?.crmContactId ?? null;
    const message = await tx.telegramConsultantMessage.create({
      data: {
        organizationId,
        webinarId,
        webinarSessionId,
        registrationId,
        crmContactId,
        chatIdHash,
        providerMessageId,
        providerMessageKey,
        correlationId,
        text: classification.text,
        topic: classification.topic,
        intent: classification.intent,
        urgency: classification.urgency,
        classificationModel: classification.model,
        classificationVersion: classification.version,
        status: 'HANDED_TO_HUMAN',
        handedOffAt: now,
      },
    });
    await recordAnalyticsEvent(tx as unknown as PrismaClient, {
      eventName: 'telegram_consultant_message',
      source: 'telegram',
      dedupKey: buildServerDedupKey('telegram_consultant_message', providerMessageKey),
      correlationId,
      scope: registration ? { kind: 'trusted', registrationId: registration.id } : { kind: 'platform' },
      page: '/telegram/consultant',
      attributes: {
        topic: classification.topic,
        intent: classification.intent,
        urgency: classification.urgency,
        handedToHuman: true,
        classificationModel: classification.model,
        classificationVersion: classification.version,
      },
    });
    await tx.telegramBotEvent.create({
      data: {
        organizationId,
        webinarId,
        webinarSessionId,
        registrationId,
        crmContactId,
        botIdentity: 'CONSULTANT',
        direction: 'INBOUND',
        eventType: 'consultant_message_classified',
        correlationId,
        providerMessageId,
        dedupKey: `consultant:${providerMessageKey}`,
        status: 'handed_to_human',
        metadataJson: {
          topic: classification.topic,
          intent: classification.intent,
          urgency: classification.urgency,
          requiresHuman: classification.requiresHuman,
          classificationModel: classification.model,
          classificationVersion: classification.version,
        },
        occurredAt: now,
      },
    });
    if (organizationId && crmContactId) {
      await tx.cRMContactEvent.create({
        data: {
          organizationId,
          contactId: crmContactId,
          type: 'telegram_consultant_message',
          source: 'telegram_consultant_bot',
          sourceEntityType: 'telegram_consultant_message',
          sourceEntityId: message.id,
          webinarId,
          webinarSessionId,
          registrationId,
          correlationId,
          dedupKey: `telegram-consultant-message:${message.id}`,
          occurredAt: now,
          metadataJson: {
            topic: classification.topic,
            intent: classification.intent,
            urgency: classification.urgency,
            textStoredSeparately: true,
          },
        },
      });
    }
    return {
      message: consultantMessageProjection(message),
      scope: { organizationId, webinarId, webinarSessionId, registrationId, crmContactId },
      correlationId,
      classification,
      replayed: false,
    };
  });
}

export async function listTelegramConsultantMessages(db: PrismaClient, context: TenantContext, queryInput: unknown) {
  requireTenantRole(context, ['OWNER', 'CRM_MANAGER']);
  const query = z
    .object({
      status: z.enum(['NEW', 'HANDED_TO_HUMAN', 'RESOLVED']).optional(),
      topic: topicSchema.optional(),
      urgency: urgencySchema.optional(),
    })
    .strict()
    .parse(queryInput);
  const messages = await db.telegramConsultantMessage.findMany({
    where: {
      organizationId: context.organizationId,
      status: query.status,
      topic: query.topic,
      urgency: query.urgency,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return messages.map(consultantMessageProjection);
}

export async function correctTelegramConsultantClassification(
  db: PrismaClient,
  context: TenantContext,
  messageIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER', 'CRM_MANAGER']);
  const messageId = idSchema.parse(messageIdInput);
  const data = correctionSchema.parse(input);
  return db.$transaction(async tx => {
    const currentMembership = await tx.organizationMembership.findFirst({
      where: {
        id: context.membershipId,
        organizationId: context.organizationId,
        userId: context.userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'CRM_MANAGER'] },
        user: { kind: 'HUMAN', status: 'ACTIVE' },
        organization: { status: 'ACTIVE' },
      },
    });
    const message = await tx.telegramConsultantMessage.findFirst({
      where: { id: messageId, organizationId: context.organizationId },
    });
    if (!currentMembership || !message) {
      throw new AppError(404, 'Сообщение недоступно', undefined, 'telegram_consultant_message_unavailable');
    }
    const updated = await tx.telegramConsultantMessage.update({
      where: { id: message.id },
      data: {
        correctedTopic: data.topic,
        correctedIntent: data.intent,
        correctedUrgency: data.urgency,
        correctionReason: data.reason,
        handledByMembershipId: currentMembership.id,
        correctedAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'telegram.consultant_classification.corrected',
        entityType: 'telegram_consultant_message',
        entityId: message.id,
        beforeJson: { topic: message.topic, intent: message.intent, urgency: message.urgency },
        afterJson: {
          topic: data.topic ?? message.topic,
          intent: data.intent ?? message.intent,
          urgency: data.urgency ?? message.urgency,
          reason: data.reason,
        },
      },
    });
    if (message.crmContactId) {
      await tx.cRMContactEvent.create({
        data: {
          organizationId: context.organizationId,
          contactId: message.crmContactId,
          type: 'telegram_consultant_classification_corrected',
          source: 'tenant_crm',
          sourceEntityType: 'telegram_consultant_message',
          sourceEntityId: message.id,
          webinarId: message.webinarId,
          webinarSessionId: message.webinarSessionId,
          registrationId: message.registrationId,
          actorUserId: context.userId,
          correlationId: context.correlationId,
          dedupKey: `telegram-consultant-correction:${message.id}:${now.toISOString()}`,
          occurredAt: now,
          metadataJson: {
            topic: data.topic ?? message.topic,
            intent: data.intent ?? message.intent,
            urgency: data.urgency ?? message.urgency,
          },
        },
      });
    }
    return consultantMessageProjection(updated);
  });
}
