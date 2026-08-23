import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from './env.js';
import type { ReminderKind } from './email.js';
import { EMAIL_JOB_REMINDER, enqueueReminderEmail, runEmailOutboxJobOnce } from './emailOutbox.js';
import { isPermanentTelegramError, sendTelegramMessageToChat, telegramUrlButton } from './telegram.js';
import {
  createRoomExchangeUrl,
  getRoomTokenExpiresAt,
  buildFrontendUrl,
  TELEGRAM_BINDING_VERSION,
} from './roomLinks.js';
import { logger } from './logger.js';
import { createCorrelationId } from './requestContext.js';
import { runRetentionSweepThrottled } from './retention.js';
import {
  initializeWorkerSubsystemProgress,
  reportWorkerSubsystemProgress,
  stopWorkerSubsystemProgress,
} from './workerHeartbeat.js';
import {
  ANONYMIZED_LEAD_EMAIL_SUFFIX,
  acquireLeadSecurityLock,
  isParticipantRegistrationActive,
} from './leadSecurity.js';
import { cleanupExpiredUserAuth } from './tenancy/userAuth.js';
import { runUserAuthEmailOutboxJobOnce } from './tenancy/userAuthEmailOutbox.js';
import { runOrganizationInvitationEmailOutboxJobOnce } from './tenancy/organizationInvitationEmailOutbox.js';
import { cleanupOrganizationInvitations } from './tenancy/organizationInvitations.js';
import { canAccessRegisteredWebinar, cleanupExpiredWebinarAccessGrants } from './tenancy/webinarAccess.js';
import { runWebinarAccessInvitationEmailOutboxJobOnce } from './tenancy/webinarAccessInvitationEmailOutbox.js';
import { cleanupExpiredMediaUploads, runMediaJobOnce } from './tenancy/mediaPipeline.js';
import { runContentJobOnce } from './tenancy/transcripts.js';
import { runCrmDeliveryJobsOnce } from './tenancy/crmDelivery.js';

type ReminderCandidate = {
  id: string;
  reminder24hSentAt: Date | null;
  reminder3hSentAt: Date | null;
  reminder30mSentAt: Date | null;
  telegramReminder24hSentAt?: Date | null;
  telegramReminder3hSentAt?: Date | null;
  telegramReminder30mSentAt?: Date | null;
  telegramFollowupSentAt?: Date | null;
  lead?: {
    id?: string;
    telegramChatId?: string | null;
    marketingTelegramConsent?: boolean;
    marketingTelegramRevokedAt?: Date | null;
    professionalStatus?: string | null;
    updatedAt?: Date;
  };
  webinarSession: { scheduledAt: Date; durationMinutes?: number; replayAvailableHours?: number };
};

const REMINDER_THRESHOLDS: Array<{ kind: ReminderKind; msBefore: number; field: keyof ReminderCandidate }> = [
  { kind: '30m', msBefore: 30 * 60 * 1000, field: 'reminder30mSentAt' },
  { kind: '3h', msBefore: 3 * 60 * 60 * 1000, field: 'reminder3hSentAt' },
  { kind: '24h', msBefore: 24 * 60 * 60 * 1000, field: 'reminder24hSentAt' },
];

export function getDueReminderKind(registration: ReminderCandidate, now = new Date()): ReminderKind | null {
  const msUntilStart = registration.webinarSession.scheduledAt.getTime() - now.getTime();

  if (msUntilStart <= 0) {
    return null;
  }

  for (const reminder of REMINDER_THRESHOLDS) {
    if (msUntilStart <= reminder.msBefore) {
      return registration[reminder.field] ? null : reminder.kind;
    }
  }

  return null;
}

function telegramReminderField(kind: ReminderKind) {
  return {
    '24h': 'telegramReminder24hSentAt',
    '3h': 'telegramReminder3hSentAt',
    '30m': 'telegramReminder30mSentAt',
  }[kind] as 'telegramReminder24hSentAt' | 'telegramReminder3hSentAt' | 'telegramReminder30mSentAt';
}

type TelegramSentField =
  | 'telegramReminder24hSentAt'
  | 'telegramReminder3hSentAt'
  | 'telegramReminder30mSentAt'
  | 'telegramLiveSentAt'
  | 'telegramFollowupSentAt';

type TelegramClaimField =
  | 'telegramReminder24hClaimedUntil'
  | 'telegramReminder3hClaimedUntil'
  | 'telegramReminder30mClaimedUntil'
  | 'telegramLiveClaimedUntil'
  | 'telegramFollowupClaimedUntil';

type TelegramDeliveryFields = {
  sent: TelegramSentField;
  claimedUntil: TelegramClaimField;
};

const TELEGRAM_DELIVERY_LEASE_MS = 10 * 60 * 1000;
const TELEGRAM_DELIVERY_RETRY_MS = 2 * 60 * 1000;

function telegramReminderDeliveryFields(kind: ReminderKind): TelegramDeliveryFields {
  const fields: Record<ReminderKind, TelegramDeliveryFields> = {
    '24h': {
      sent: 'telegramReminder24hSentAt',
      claimedUntil: 'telegramReminder24hClaimedUntil',
    },
    '3h': {
      sent: 'telegramReminder3hSentAt',
      claimedUntil: 'telegramReminder3hClaimedUntil',
    },
    '30m': {
      sent: 'telegramReminder30mSentAt',
      claimedUntil: 'telegramReminder30mClaimedUntil',
    },
  };
  return fields[kind];
}

async function claimTelegramDelivery(input: {
  registrationId: string;
  expectedChatId: string;
  fields: TelegramDeliveryFields;
  requireMarketingConsent?: boolean;
}) {
  // Never derive a lease from the batch-selection timestamp. Large sequential batches can run
  // longer than the lease; a late recipient would otherwise be claimed with an already-expired
  // timestamp and could immediately be picked up by another worker.
  const claimNow = new Date();
  const leaseUntil = new Date(claimNow.getTime() + TELEGRAM_DELIVERY_LEASE_MS);
  const leadWhere: Prisma.LeadWhereInput = {
    telegramChatId: input.expectedChatId,
    telegramBindingVersion: TELEGRAM_BINDING_VERSION,
    personalDataConsentRevokedAt: null,
    email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
    ...(input.requireMarketingConsent ? { marketingTelegramConsent: true, marketingTelegramRevokedAt: null } : {}),
  };
  const claimed = await prisma.registration.updateMany({
    where: {
      id: input.registrationId,
      status: 'registered',
      emailVerifiedAt: { not: null },
      [input.fields.sent]: null,
      OR: [{ [input.fields.claimedUntil]: null }, { [input.fields.claimedUntil]: { lte: claimNow } }],
      lead: leadWhere,
      webinarSession: { lifecycleStatus: { not: 'CANCELLED' } },
    } as Prisma.RegistrationWhereInput,
    data: { [input.fields.claimedUntil]: leaseUntil } as Prisma.RegistrationUpdateManyMutationInput,
  });

  return claimed.count === 1 ? leaseUntil : null;
}

async function activeTelegramChatId(leadId: string, expectedChatId: string, requireMarketingConsent = false) {
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      telegramChatId: expectedChatId,
      telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      personalDataConsentRevokedAt: null,
      email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
      ...(requireMarketingConsent ? { marketingTelegramConsent: true, marketingTelegramRevokedAt: null } : {}),
    },
    select: { telegramChatId: true },
  });
  return lead?.telegramChatId ?? null;
}

async function createRoomUrlForActiveRegistration(registrationId: string, expectedLeadId: string) {
  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, expectedLeadId);
    const activeRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      include: { lead: true, webinarSession: true },
    });
    if (
      !activeRegistration ||
      activeRegistration.leadId !== expectedLeadId ||
      !isParticipantRegistrationActive(activeRegistration) ||
      activeRegistration.webinarSession.lifecycleStatus === 'CANCELLED'
    ) {
      return null;
    }
    if (!(await canAccessRegisteredWebinar(tx as unknown as typeof prisma, activeRegistration))) {
      return null;
    }
    return createRoomExchangeUrl(tx, {
      registrationId: activeRegistration.id,
      expiresAt: getRoomTokenExpiresAt(activeRegistration.webinarSession),
    });
  });
}

async function releaseTelegramDeliveryLease(registrationId: string, fields: TelegramDeliveryFields, leaseUntil: Date) {
  return prisma.registration.updateMany({
    where: {
      id: registrationId,
      [fields.sent]: null,
      [fields.claimedUntil]: leaseUntil,
    } as Prisma.RegistrationWhereInput,
    data: { [fields.claimedUntil]: null } as Prisma.RegistrationUpdateManyMutationInput,
  });
}

async function deferTelegramDelivery(
  registrationId: string,
  fields: TelegramDeliveryFields,
  leaseUntil: Date,
  now: Date,
  error: unknown,
) {
  const retryAfterSeconds =
    error instanceof Error ? (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds : undefined;
  const retryDelayMs = Math.max(
    TELEGRAM_DELIVERY_RETRY_MS,
    retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0,
  );
  return prisma.registration.updateMany({
    where: {
      id: registrationId,
      [fields.sent]: null,
      [fields.claimedUntil]: leaseUntil,
    } as Prisma.RegistrationWhereInput,
    data: {
      [fields.claimedUntil]: new Date(now.getTime() + retryDelayMs),
    } as Prisma.RegistrationUpdateManyMutationInput,
  });
}

async function markTelegramDeliverySent(
  registrationId: string,
  fields: TelegramDeliveryFields,
  leaseUntil: Date,
  sentAt: Date,
  event?: {
    organizationId: string;
    webinarId: string;
    webinarSessionId: string;
    scopedRegistrationId?: string;
    crmContactId?: string | null;
    eventType: 'session_reminder_24h' | 'session_reminder_3h' | 'session_reminder_30m' | 'session_live' | 'session_followup';
    scheduleVersion: number;
    correlationId: string;
    providerMessageId?: string | null;
    deliveryMode: 'log' | 'send';
  },
) {
  await prisma.$transaction(async tx => {
    const updated = await tx.registration.updateMany({
      where: {
        id: registrationId,
        [fields.sent]: null,
        [fields.claimedUntil]: leaseUntil,
      } as Prisma.RegistrationWhereInput,
      data: {
        [fields.sent]: sentAt,
        [fields.claimedUntil]: null,
      } as Prisma.RegistrationUpdateManyMutationInput,
    });
    if (updated.count !== 1) {
      throw new Error('Telegram delivery succeeded, but its lease could not be finalized');
    }
    if (event) {
      await tx.telegramBotEvent.create({
        data: {
          organizationId: event.organizationId,
          webinarId: event.webinarId,
          webinarSessionId: event.webinarSessionId,
          registrationId: event.scopedRegistrationId ?? null,
          crmContactId: event.scopedRegistrationId ? (event.crmContactId ?? null) : null,
          botIdentity: 'PARTICIPANT',
          direction: 'OUTBOUND',
          eventType: event.eventType,
          correlationId: event.correlationId,
          providerMessageId: event.providerMessageId ?? null,
          dedupKey: `participant:${registrationId}:session:${event.webinarSessionId}:${event.eventType}:schedule:${event.scheduleVersion}`,
          status: event.deliveryMode === 'send' ? 'sent' : 'logged',
          metadataJson: {
            scheduleVersion: event.scheduleVersion,
            deliveryMode: event.deliveryMode,
          },
          occurredAt: sentAt,
        },
      });
    }
  });
}

async function disableUndeliverableTelegramChat(input: {
  leadId: string;
  leadUpdatedAt: Date;
  registrationId: string;
  chatId: string;
  fields: TelegramDeliveryFields;
  leaseUntil: Date;
}) {
  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, input.leadId);
    // Fence by the exact lease before mutating the Lead. A stale worker must not clear a valid
    // Telegram binding after a newer worker reclaimed/finalized this delivery.
    const released = await tx.registration.updateMany({
      where: {
        id: input.registrationId,
        [input.fields.sent]: null,
        [input.fields.claimedUntil]: input.leaseUntil,
      } as Prisma.RegistrationWhereInput,
      data: { [input.fields.claimedUntil]: null } as Prisma.RegistrationUpdateManyMutationInput,
    });
    if (released.count !== 1) {
      return false;
    }

    // Permanent Telegram errors mean this exact chat can no longer receive messages. Clearing
    // only the stale transport address prevents an endless retry loop without fabricating a
    // successful send or a legal consent revocation.
    const cleared = await tx.lead.updateMany({
      where: {
        id: input.leadId,
        telegramChatId: input.chatId,
        updatedAt: input.leadUpdatedAt,
      },
      data: { telegramChatId: null },
    });
    return cleared.count === 1;
  });
}

async function handleTelegramDeliveryError(input: {
  error: unknown;
  leadId: string;
  leadUpdatedAt: Date;
  registrationId: string;
  chatId: string;
  fields: TelegramDeliveryFields;
  leaseUntil: Date;
  now: Date;
  label: string;
}) {
  const permanent = isPermanentTelegramError(input.error);
  let permanentChatDisabled = false;
  if (permanent) {
    permanentChatDisabled = await disableUndeliverableTelegramChat(input).catch(cleanupError => {
      logger.error(
        { err: cleanupError, registrationId: input.registrationId },
        `${input.label} не удалось отключить недоставляемый Telegram chat`,
      );
      return false;
    });
  } else {
    await deferTelegramDelivery(input.registrationId, input.fields, input.leaseUntil, input.now, input.error).catch(
      retryError =>
        logger.error(
          { err: retryError, registrationId: input.registrationId },
          `${input.label} не удалось назначить повтор; lease освободится по timeout`,
        ),
    );
  }
  logger.error(
    { err: input.error, registrationId: input.registrationId, permanent },
    permanent
      ? permanentChatDisabled
        ? `${input.label} постоянная ошибка получателя — Telegram chat отключён`
        : `${input.label} постоянная ошибка получателя, но lease уже потеряна — Telegram chat сохранён`
      : `${input.label} временная ошибка — назначен короткий retry`,
  );
}

export function getDueTelegramReminderKind(registration: ReminderCandidate, now = new Date()): ReminderKind | null {
  const msUntilStart = registration.webinarSession.scheduledAt.getTime() - now.getTime();

  if (msUntilStart <= 0) {
    return null;
  }

  for (const reminder of REMINDER_THRESHOLDS) {
    if (msUntilStart <= reminder.msBefore) {
      return registration[telegramReminderField(reminder.kind)] ? null : reminder.kind;
    }
  }

  return null;
}

export function getPostWebinarFollowupDueAt(scheduledAt: Date, durationMinutes = 120) {
  return new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000 + 10 * 60 * 1000);
}

function moscowDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return moscowDateKey(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)));
}

export function formatWebinarRelativeDate(scheduledAt: Date, now = new Date()) {
  const scheduledKey = moscowDateKey(scheduledAt);
  const todayKey = moscowDateKey(now);
  if (scheduledKey === todayKey) return 'сегодня';
  if (scheduledKey === addDaysKey(todayKey, 1)) return 'завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'long',
  }).format(scheduledAt);
}

function formatWebinarReminderLabel(scheduledAt: Date, now = new Date()) {
  const day = formatWebinarRelativeDate(scheduledAt, now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }).format(scheduledAt);
  return `${day} в ${time} МСК`;
}

function buildSegmentTip(status?: string | null) {
  const value = (status || '').toLowerCase();
  if (value.includes('юрист') || value.includes('антикризис')) {
    return 'Подготовьте один вопрос по долговому клиенту: в записи разобрано, как передавать такие ситуации без самостоятельного ведения процедуры.';
  }

  if (value.includes('налог') || value.includes('корпоратив')) {
    return 'Вспомните клиентов с требованиями ФНС, кредитной нагрузкой и риском субсидиарной ответственности: это хорошие примеры для вопроса команде после премьеры.';
  }

  if (value.includes('руководитель') || value.includes('практик')) {
    return 'Подумайте, какие долговые обращения сейчас уходят из вашей практики без понятного маршрута — в записи показано, как их передавать в АСПБ.';
  }

  return 'Подготовьте один обезличенный пример клиента с долгами, кредиторами, налогами или риском банкротства — в записи показано, когда стоит передавать на диагностику.';
}

// Размер батча и предохранитель от бесконечного цикла при курсорной пагинации.
const REMINDER_BATCH_SIZE = 100;
const REMINDER_MAX_BATCHES = 50;

export async function runReminderJobOnce(now = new Date(), onProgress?: () => void) {
  let checked = 0;
  let sent = 0;
  let cursor: string | undefined;

  for (let batch = 0; batch < REMINDER_MAX_BATCHES; batch += 1) {
    onProgress?.();
    const registrations = await prisma.registration.findMany({
      where: {
        status: 'registered',
        emailVerifiedAt: { not: null },
        lead: {
          personalDataConsentRevokedAt: null,
          email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
        },
        webinarSession: {
          lifecycleStatus: { not: 'CANCELLED' },
          scheduledAt: {
            gt: now,
            lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        },
      },
      include: {
        lead: true,
        webinarSession: true,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (registrations.length === 0) {
      break;
    }

    checked += registrations.length;
    cursor = registrations[registrations.length - 1].id;
    onProgress?.();

    // Один batch-запрос вместо N COUNT'ов (устраняет N+1): какие email-напоминания
    // уже поставлены для регистраций этого батча. Ключ — `registrationId:reminderKind`.
    const existingJobs = await prisma.emailOutboxJob.findMany({
      where: { registrationId: { in: registrations.map(item => item.id) }, type: EMAIL_JOB_REMINDER },
      select: { registrationId: true, reminderKind: true, sessionScheduleVersion: true },
    });
    const existingReminderKeys = new Set(
      existingJobs.map(job => `${job.registrationId}:${job.reminderKind}:${job.sessionScheduleVersion}`),
    );

    for (const registration of registrations) {
      onProgress?.();
      const kind = getDueReminderKind(registration, now);
      if (!kind) {
        continue;
      }

      if (existingReminderKeys.has(`${registration.id}:${kind}:${registration.webinarSession.scheduleVersion}`)) {
        continue;
      }

      const created = await prisma.$transaction(async tx => {
        await acquireLeadSecurityLock(tx, registration.leadId);
        const activeRegistration = await tx.registration.findUnique({
          where: { id: registration.id },
          include: { lead: true, webinarSession: true },
        });
        if (
          !activeRegistration ||
          activeRegistration.leadId !== registration.leadId ||
          !isParticipantRegistrationActive(activeRegistration) ||
          activeRegistration.webinarSession.lifecycleStatus === 'CANCELLED' ||
          getDueReminderKind(activeRegistration, now) !== kind
        ) {
          return 0;
        }

        return enqueueReminderEmail(tx, {
          kind,
          registrationId: activeRegistration.id,
          webinarSessionId: activeRegistration.webinarSessionId,
          toEmail: activeRegistration.lead.email,
          toName: activeRegistration.lead.name,
          scheduledAt: activeRegistration.webinarSession.scheduledAt,
          scheduleVersion: activeRegistration.webinarSession.scheduleVersion,
        });
      });
      // createMany(skipDuplicates) вернёт 0, если напоминание уже было поставлено гонкой —
      // тогда не считаем его отправленным (точная метрика).
      if (created > 0) {
        sent += 1;
      }
      onProgress?.();
    }

    if (registrations.length < REMINDER_BATCH_SIZE) {
      break;
    }
  }

  return { checked, sent };
}

export async function runTelegramReminderJobOnce(now = new Date(), onProgress?: () => void) {
  let checked = 0;
  let sent = 0;
  let cursor: string | undefined;

  for (let batch = 0; batch < REMINDER_MAX_BATCHES; batch += 1) {
    onProgress?.();
    const registrations = await prisma.registration.findMany({
      where: {
        status: 'registered',
        emailVerifiedAt: { not: null },
        lead: {
          telegramChatId: { not: null },
          telegramBindingVersion: TELEGRAM_BINDING_VERSION,
          personalDataConsentRevokedAt: null,
          email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
        },
        webinarSession: {
          lifecycleStatus: { not: 'CANCELLED' },
          scheduledAt: {
            gt: now,
            lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        },
      },
      include: {
        lead: true,
        webinarSession: true,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (registrations.length === 0) {
      break;
    }

    checked += registrations.length;
    cursor = registrations[registrations.length - 1].id;
    onProgress?.();

    for (const registration of registrations) {
      onProgress?.();
      const kind = getDueTelegramReminderKind(registration, now);
      if (!kind || !registration.lead.telegramChatId) {
        continue;
      }

      const fields = telegramReminderDeliveryFields(kind);
      const leaseUntil = await claimTelegramDelivery({
        registrationId: registration.id,
        expectedChatId: registration.lead.telegramChatId,
        fields,
      });
      if (!leaseUntil) {
        continue;
      }

      const label = formatWebinarReminderLabel(registration.webinarSession.scheduledAt, now);
      try {
        const roomUrl = await createRoomUrlForActiveRegistration(registration.id, registration.lead.id);
        if (!roomUrl) {
          await releaseTelegramDeliveryLease(registration.id, fields, leaseUntil);
          continue;
        }

        // Re-read the transport address immediately before the external side effect. This is an
        // organizational registration reminder; marketing opt-out is enforced on follow-up.
        const chatId = await activeTelegramChatId(registration.lead.id, registration.lead.telegramChatId);
        if (!chatId) {
          await releaseTelegramDeliveryLease(registration.id, fields, leaseUntil);
          continue;
        }

        const correlationId = createCorrelationId(`telegram_reminder_${kind}`);
        const deliveryResult = await sendTelegramMessageToChat(
          chatId,
          [
            kind === '24h'
              ? `Напоминание: вебинар АСПБ ${label}.`
              : kind === '3h'
                ? `Вебинар АСПБ уже ${label}.`
                : `Скоро начинаем: вебинар АСПБ ${label}.`,
            '',
            kind === '24h'
              ? buildSegmentTip(registration.lead.professionalStatus)
              : kind === '3h'
                ? 'Подготовьте один вопрос по клиенту с долгами — зададите его прямо в комнате.'
                : 'Заходите заранее, чтобы не пропустить старт.',
            '',
            `Тема: ${registration.webinarSession.title}`,
          ].join('\n'),
          {
            replyMarkup: telegramUrlButton(kind === '30m' ? '▶ Войти в комнату' : '▶ Открыть комнату', roomUrl),
            attempts: 1,
          },
        );
        await markTelegramDeliverySent(registration.id, fields, leaseUntil, new Date(), {
          organizationId: registration.webinarSession.organizationId,
          webinarId: registration.webinarSession.webinarId,
          webinarSessionId: registration.webinarSessionId,
          scopedRegistrationId:
            registration.organizationId === registration.webinarSession.organizationId &&
            registration.webinarId === registration.webinarSession.webinarId
              ? registration.id
              : undefined,
          crmContactId: registration.crmContactId,
          eventType: `session_reminder_${kind}`,
          scheduleVersion: registration.webinarSession.scheduleVersion,
          correlationId,
          providerMessageId: deliveryResult.providerMessageId,
          deliveryMode: deliveryResult.mode,
        });
        sent += 1;
      } catch (error) {
        await handleTelegramDeliveryError({
          error,
          leadId: registration.lead.id,
          leadUpdatedAt: registration.lead.updatedAt,
          registrationId: registration.id,
          chatId: registration.lead.telegramChatId,
          fields,
          leaseUntil,
          now: new Date(),
          label: '[ASPБ telegram reminder]',
        });
      } finally {
        onProgress?.();
      }
    }

    if (registrations.length < REMINDER_BATCH_SIZE) {
      break;
    }
  }

  return { checked, sent };
}

const TELEGRAM_LIVE_WINDOW_MS = 20 * 60 * 1000; // «эфир начался» — в первые 20 минут после старта
const TELEGRAM_FOLLOWUP_GRACE_MS = 10 * 60 * 1000; // «после эфира» — спустя 10 минут после конца
const TELEGRAM_FOLLOWUP_WINDOW_MS = 12 * 60 * 60 * 1000; // не догоняем эфиры старше 12 часов
const TELEGRAM_LIVE_FOLLOWUP_BATCH = 500;

// «🔴 Эфир начался» участникам с привязанным Telegram. CAS-lease сериализует реплики,
// а telegramLiveSentAt записывается только после успешной внешней отправки.
export async function runTelegramLiveJobOnce(now = new Date(), onProgress?: () => void) {
  let sent = 0;
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      emailVerifiedAt: { not: null },
      telegramLiveSentAt: null,
      OR: [{ telegramLiveClaimedUntil: null }, { telegramLiveClaimedUntil: { lte: now } }],
      lead: {
        telegramChatId: { not: null },
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        personalDataConsentRevokedAt: null,
        email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
      },
      webinarSession: {
        lifecycleStatus: { not: 'CANCELLED' },
        scheduledAt: { lte: now, gt: new Date(now.getTime() - TELEGRAM_LIVE_WINDOW_MS) },
      },
    },
    include: { lead: true, webinarSession: true },
    orderBy: { id: 'asc' },
    take: TELEGRAM_LIVE_FOLLOWUP_BATCH,
  });

  for (const registration of registrations) {
    onProgress?.();
    if (!registration.lead.telegramChatId) continue;
    const fields: TelegramDeliveryFields = {
      sent: 'telegramLiveSentAt',
      claimedUntil: 'telegramLiveClaimedUntil',
    };
    const leaseUntil = await claimTelegramDelivery({
      registrationId: registration.id,
      expectedChatId: registration.lead.telegramChatId,
      fields,
    });
    if (!leaseUntil) continue;

    try {
      const roomUrl = await createRoomUrlForActiveRegistration(registration.id, registration.lead.id);
      if (!roomUrl) {
        await releaseTelegramDeliveryLease(registration.id, fields, leaseUntil);
        continue;
      }

      const chatId = await activeTelegramChatId(registration.lead.id, registration.lead.telegramChatId);
      if (!chatId) {
        await releaseTelegramDeliveryLease(registration.id, fields, leaseUntil);
        continue;
      }
      const correlationId = createCorrelationId('telegram_session_live');
      const deliveryResult = await sendTelegramMessageToChat(chatId, 'Премьера записи началась — можно подключиться к комнате.', {
        replyMarkup: telegramUrlButton('▶ Открыть премьеру', roomUrl),
        attempts: 1,
      });
      await markTelegramDeliverySent(registration.id, fields, leaseUntil, new Date(), {
        organizationId: registration.webinarSession.organizationId,
        webinarId: registration.webinarSession.webinarId,
        webinarSessionId: registration.webinarSessionId,
        scopedRegistrationId:
          registration.organizationId === registration.webinarSession.organizationId &&
          registration.webinarId === registration.webinarSession.webinarId
            ? registration.id
            : undefined,
        crmContactId: registration.crmContactId,
        eventType: 'session_live',
        scheduleVersion: registration.webinarSession.scheduleVersion,
        correlationId,
        providerMessageId: deliveryResult.providerMessageId,
        deliveryMode: deliveryResult.mode,
      });
      sent += 1;
    } catch (error) {
      await handleTelegramDeliveryError({
        error,
        leadId: registration.lead.id,
        leadUpdatedAt: registration.lead.updatedAt,
        registrationId: registration.id,
        chatId: registration.lead.telegramChatId,
        fields,
        leaseUntil,
        now: new Date(),
        label: '[ASPБ telegram live]',
      });
    } finally {
      onProgress?.();
    }
  }

  return { sent };
}

// «После эфира»: благодарность + запись + призыв к партнёрской заявке. Отдельная
// восстанавливаемая lease не подменяет telegramFollowupSentAt фактом ещё не сделанной отправки.
export async function runTelegramFollowupJobOnce(now = new Date(), onProgress?: () => void) {
  let sent = 0;
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      emailVerifiedAt: { not: null },
      telegramFollowupSentAt: null,
      OR: [{ telegramFollowupClaimedUntil: null }, { telegramFollowupClaimedUntil: { lte: now } }],
      lead: {
        telegramChatId: { not: null },
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        personalDataConsentRevokedAt: null,
        email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
        marketingTelegramConsent: true,
        marketingTelegramRevokedAt: null,
      },
      webinarSession: {
        lifecycleStatus: { not: 'CANCELLED' },
        scheduledAt: { lt: now, gt: new Date(now.getTime() - TELEGRAM_FOLLOWUP_WINDOW_MS - 6 * 60 * 60 * 1000) },
      },
    },
    include: { lead: true, webinarSession: true },
    orderBy: { id: 'asc' },
    take: TELEGRAM_LIVE_FOLLOWUP_BATCH,
  });

  const recordingsUrl = buildFrontendUrl('/crisis_premium/recordings.html');

  for (const registration of registrations) {
    onProgress?.();
    if (!registration.lead.telegramChatId) continue;
    const durationMs = (registration.webinarSession.durationMinutes ?? 65) * 60 * 1000;
    const endAt = registration.webinarSession.scheduledAt.getTime() + durationMs;
    if (now.getTime() < endAt + TELEGRAM_FOLLOWUP_GRACE_MS || now.getTime() > endAt + TELEGRAM_FOLLOWUP_WINDOW_MS) {
      continue;
    }

    const fields: TelegramDeliveryFields = {
      sent: 'telegramFollowupSentAt',
      claimedUntil: 'telegramFollowupClaimedUntil',
    };
    const leaseUntil = await claimTelegramDelivery({
      registrationId: registration.id,
      expectedChatId: registration.lead.telegramChatId,
      fields,
      requireMarketingConsent: true,
    });
    if (!leaseUntil) continue;

    try {
      // This second read is deliberately adjacent to send: a consent revocation that races with
      // candidate selection or lease acquisition prevents the follow-up from leaving the process.
      const chatId = await activeTelegramChatId(registration.lead.id, registration.lead.telegramChatId, true);
      if (!chatId) {
        await releaseTelegramDeliveryLease(registration.id, fields, leaseUntil);
        continue;
      }
      const correlationId = createCorrelationId('telegram_session_followup');
      const deliveryResult = await sendTelegramMessageToChat(
        chatId,
        [
          'Спасибо, что были на вебинаре АСПБ.',
          '',
          'Запись и материалы — в разделе «Записи». Если есть клиент с долгами, налогами или риском банкротства — оставьте партнёрскую заявку, поможем довести.',
        ].join('\n'),
        { replyMarkup: telegramUrlButton('Смотреть запись', recordingsUrl), attempts: 1 },
      );
      await markTelegramDeliverySent(registration.id, fields, leaseUntil, new Date(), {
        organizationId: registration.webinarSession.organizationId,
        webinarId: registration.webinarSession.webinarId,
        webinarSessionId: registration.webinarSessionId,
        scopedRegistrationId:
          registration.organizationId === registration.webinarSession.organizationId &&
          registration.webinarId === registration.webinarSession.webinarId
            ? registration.id
            : undefined,
        crmContactId: registration.crmContactId,
        eventType: 'session_followup',
        scheduleVersion: registration.webinarSession.scheduleVersion,
        correlationId,
        providerMessageId: deliveryResult.providerMessageId,
        deliveryMode: deliveryResult.mode,
      });
      sent += 1;
    } catch (error) {
      await handleTelegramDeliveryError({
        error,
        leadId: registration.lead.id,
        leadUpdatedAt: registration.lead.updatedAt,
        registrationId: registration.id,
        chatId: registration.lead.telegramChatId,
        fields,
        leaseUntil,
        now: new Date(),
        label: '[ASPБ telegram followup]',
      });
    } finally {
      onProgress?.();
    }
  }

  return { sent };
}

export async function runReplayFollowupJobOnce(now = new Date()) {
  void now;
  return { checked: 0, emailQueued: 0, telegramSent: 0, disabled: true };
}

export async function cleanupExpiredRegistrationTokens(now = new Date()) {
  const result = await prisma.registrationToken.deleteMany({
    where: {
      expiresAt: {
        lt: now,
      },
    },
  });

  return { deleted: result.count };
}

// Guard-флаг: не запускаем новый прогон джоб, пока предыдущий не завершился.
// Защищает от дублей напоминаний, если джобы не успели за интервал тика.
let reminderCycleRunning = false;
let reminderCyclePromise: Promise<void> | null = null;
let reminderInterval: NodeJS.Timeout | null = null;
let reminderStartupTimer: NodeJS.Timeout | null = null;
let consecutiveFailedReminderCycles = 0;
let workerRestartRequested = false;
const REMINDER_FAILURE_RESTART_THRESHOLD = 5;

async function runReminderCycle() {
  // Локальный guard — защита от наложения тиков в одном процессе.
  if (reminderCycleRunning) {
    return;
  }
  reminderCycleRunning = true;

  // Распределённый lock убран намеренно: прежний pg_try_advisory_lock был session-level, а при
  // пуле соединений acquire и release попадали на РАЗНЫЕ коннекты — лок утекал и со временем
  // намертво блокировал прогон напоминаний (боты «переставали работать»). Идемпотентность теперь
  // гарантируется на уровне БД: уникальный индекс (registrationId, type, reminderKind) на
  // email-джобах и восстанавливаемые CAS-leases в Telegram-доставке. Несколько реплик не
  // отправляют одновременно, а claim после падения снова становится доступным по timeout.
  try {
    const reportProgress = () => reportWorkerSubsystemProgress('reminders');
    const runStep = async (label: string, task: () => Promise<unknown>) => {
      try {
        reportProgress();
        await task();
        return true;
      } catch (error) {
        logger.error({ err: error }, label);
        return false;
      } finally {
        // This records completed pipeline work. The independent process heartbeat
        // intentionally keeps ticking even when a step is stuck, while this file
        // becomes stale and makes the worker unhealthy.
        reportProgress();
      }
    };
    const results = [];
    results.push(await runStep('[ASPБ reminders]', () => runReminderJobOnce(new Date(), reportProgress)));
    results.push(await runStep('[ASPБ email outbox]', () => runEmailOutboxJobOnce(new Date(), {}, reportProgress)));
    results.push(
      await runStep('[ASPБ tenant CRM delivery]', () => runCrmDeliveryJobsOnce(new Date(), {}, reportProgress)),
    );
    results.push(
      await runStep('[ASPБ user auth email outbox]', () =>
        runUserAuthEmailOutboxJobOnce(new Date(), {}, reportProgress),
      ),
    );
    results.push(
      await runStep('[ASPБ organization invitation email outbox]', () =>
        runOrganizationInvitationEmailOutboxJobOnce(new Date(), {}, reportProgress),
      ),
    );
    results.push(
      await runStep('[ASPБ Webinar access invitation email outbox]', () =>
        runWebinarAccessInvitationEmailOutboxJobOnce(new Date(), {}, reportProgress),
      ),
    );
    results.push(await runStep('[ASPБ media pipeline]', () => runMediaJobOnce(prisma, undefined, reportProgress)));
    results.push(await runStep('[ASPБ media upload cleanup]', () => cleanupExpiredMediaUploads(prisma)));
    results.push(await runStep('[ASPБ content pipeline]', () => runContentJobOnce(prisma)));
    results.push(await runStep('[ASPБ telegram live]', () => runTelegramLiveJobOnce(new Date(), reportProgress)));
    results.push(
      await runStep('[ASPБ telegram reminders]', () => runTelegramReminderJobOnce(new Date(), reportProgress)),
    );
    results.push(
      await runStep('[ASPБ telegram followup]', () => runTelegramFollowupJobOnce(new Date(), reportProgress)),
    );
    results.push(await runStep('[ASPБ token cleanup]', cleanupExpiredRegistrationTokens));
    results.push(await runStep('[ASPБ user auth cleanup]', () => cleanupExpiredUserAuth(prisma)));
    results.push(await runStep('[ASPБ organization invitation cleanup]', () => cleanupOrganizationInvitations(prisma)));
    results.push(await runStep('[ASPБ Webinar access cleanup]', () => cleanupExpiredWebinarAccessGrants(prisma)));
    results.push(await runStep('[ASPБ retention]', () => runRetentionSweepThrottled(new Date(), reportProgress)));
    const healthy = results.every(Boolean);
    if (healthy) {
      consecutiveFailedReminderCycles = 0;
    } else {
      consecutiveFailedReminderCycles += 1;
      if (consecutiveFailedReminderCycles >= REMINDER_FAILURE_RESTART_THRESHOLD) {
        throw new Error(`Reminder worker stayed unhealthy for ${consecutiveFailedReminderCycles} consecutive cycles`);
      }
    }
  } finally {
    reminderCycleRunning = false;
  }
}

export function startReminderScheduler() {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  initializeWorkerSubsystemProgress('reminders');

  const run = () => {
    reminderCyclePromise = runReminderCycle()
      .catch(error => {
        logger.error({ err: error, consecutiveFailedReminderCycles }, '[ASPБ reminder cycle]');
        if (env.NODE_ENV === 'production' && !workerRestartRequested) {
          workerRestartRequested = true;
          logger.fatal(
            { consecutiveFailedReminderCycles },
            '[ASPБ reminder cycle] sustained failure; exiting so the process supervisor can restart the worker',
          );
          setImmediate(() => process.exit(1));
        }
      })
      .finally(() => {
        reminderCyclePromise = null;
      });
  };

  reminderInterval = setInterval(() => {
    run();
  }, 60 * 1000);

  reminderStartupTimer = setTimeout(run, 5000);

  return reminderInterval;
}

export async function stopReminderScheduler() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  if (reminderStartupTimer) {
    clearTimeout(reminderStartupTimer);
    reminderStartupTimer = null;
  }
  if (reminderCyclePromise) {
    await reminderCyclePromise;
  }
  consecutiveFailedReminderCycles = 0;
  workerRestartRequested = false;
  stopWorkerSubsystemProgress('reminders');
}
