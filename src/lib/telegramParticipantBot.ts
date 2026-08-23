import { Prisma } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { hashToken } from './tokens.js';
import {
  buildTelegramStartUrl,
  formatMoscowDate,
  hasParticipantTelegramBot,
  isParticipantBotPollingEnabled,
  notifyTelegramBotStart,
  notifyTelegramSubscription,
  participantTelegramApiUrl,
  sendTelegramMessageToChat,
  telegramUrlButton,
} from './telegram.js';
import {
  buildFrontendUrl,
  createRoomExchangeUrl,
  getParticipantSessionExpiresAt,
  TELEGRAM_BINDING_VERSION,
  TELEGRAM_START_TOKEN_PURPOSE,
} from './roomLinks.js';
import { logger } from './logger.js';
import { createTelegramPoller, type TelegramPoller } from './telegramPoller.js';
import { MARKETING_TELEGRAM_CONSENT, consentEvidenceData } from './consentDocuments.js';
import {
  ANONYMIZED_LEAD_EMAIL_SUFFIX,
  acquireLeadSecurityLock,
  acquireTelegramDeliveryLock,
  isLeadIdentityActive,
  isParticipantRegistrationActive,
} from './leadSecurity.js';
import { canAccessRegisteredWebinar } from './tenancy/webinarAccess.js';
import { getWebinarAccess } from './time.js';
import { createCorrelationId } from './requestContext.js';

// A revocation may wait for one already-started Telegram provider request
// (20s hard deadline), then takes the short Lead data lock and commits.
export const TELEGRAM_REVOCATION_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number | string; type?: string };
    from?: { id?: number | string; username?: string; first_name?: string };
  };
};

let poller: TelegramPoller | null = null;

function isParticipantBotReady() {
  return isParticipantBotPollingEnabled() && hasParticipantTelegramBot();
}

async function consumeTelegramStartToken(
  token: string,
  input: {
    chatId: string;
    telegramUsername?: string | null;
    telegramFirstName?: string | null;
  },
) {
  const accessTokenHash = hashToken(token);
  return prisma.$transaction(async tx => {
    const tokenRecord = await tx.registrationToken.findUnique({
      where: { tokenHash: accessTokenHash },
      include: {
        registration: {
          include: { lead: true, webinarSession: true },
        },
      },
    });
    const now = new Date();

    if (
      !tokenRecord ||
      tokenRecord.purpose !== TELEGRAM_START_TOKEN_PURPOSE ||
      (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)
    ) {
      return null;
    }

    await acquireLeadSecurityLock(tx, tokenRecord.registration.leadId);
    const activeTokenRecord = await tx.registrationToken.findUnique({
      where: { tokenHash: accessTokenHash },
      include: {
        registration: {
          include: { lead: true, webinarSession: true },
        },
      },
    });
    if (
      !activeTokenRecord ||
      activeTokenRecord.id !== tokenRecord.id ||
      activeTokenRecord.purpose !== TELEGRAM_START_TOKEN_PURPOSE ||
      (activeTokenRecord.expiresAt && activeTokenRecord.expiresAt <= now) ||
      !isParticipantRegistrationActive(activeTokenRecord.registration)
    ) {
      return null;
    }

    const claimedToken = await tx.registrationToken.deleteMany({
      where: {
        id: activeTokenRecord.id,
        tokenHash: accessTokenHash,
        purpose: TELEGRAM_START_TOKEN_PURPOSE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (claimedToken.count !== 1) {
      return null;
    }

    const previousChatId = activeTokenRecord.registration.lead.telegramChatId;
    const updatedLead = await tx.lead.update({
      where: { id: activeTokenRecord.registration.leadId },
      data: {
        telegramChatId: input.chatId,
        telegramUsername: input.telegramUsername,
        telegramFirstName: input.telegramFirstName,
        telegramSubscribedAt: now,
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      },
    });

    await tx.registration.update({
      where: { id: activeTokenRecord.registration.id },
      data: { telegramClickedAt: activeTokenRecord.registration.telegramClickedAt ?? now },
    });

    return {
      registration: activeTokenRecord.registration,
      updatedLead,
      isRebind: Boolean(previousChatId && previousChatId !== input.chatId),
    };
  });
}

async function createRoomUrl(registrationId: string, purpose = 'telegram_room') {
  // Ежедневная модель: ссылка из бота должна открывать СЕГОДНЯШНюю комнату в любой день,
  // а не протухать по сессии дня регистрации. Обменный токен одноразовый; срок = срок
  // участницкой сессии (7 дней). После клика создаётся session-cookie, а доступ к комнате
  // на каждый день решает buildDailyRoomAccessPayload (берёт сессию на now).
  return prisma.$transaction(async tx => {
    const registrationRef = await tx.registration.findUnique({
      where: { id: registrationId },
      select: { leadId: true },
    });
    if (!registrationRef) return null;

    await acquireLeadSecurityLock(tx, registrationRef.leadId);
    const activeRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      include: { lead: true, webinarSession: true },
    });
    if (
      !activeRegistration ||
      !isParticipantRegistrationActive(activeRegistration) ||
      activeRegistration.webinarSession.lifecycleStatus === 'CANCELLED'
    ) {
      logger.warn({ registrationId, purpose }, 'Telegram room link skipped for inactive registration');
      return null;
    }
    if (!(await canAccessRegisteredWebinar(tx as unknown as typeof prisma, activeRegistration))) {
      logger.warn({ registrationId, purpose }, 'Telegram room link skipped for inaccessible Webinar');
      return null;
    }
    const access = getWebinarAccess(
      new Date(),
      activeRegistration.webinarSession.scheduledAt,
      activeRegistration.webinarSession.durationMinutes,
      activeRegistration.webinarSession.replayAvailableHours,
      activeRegistration.webinarSession.roomOpenBeforeMinutes,
      activeRegistration.webinarSession.replayEnabled,
    );
    if (access.accessStatus === 'closed') {
      logger.warn({ registrationId, purpose }, 'Telegram room link skipped for expired session access');
      return null;
    }

    return createRoomExchangeUrl(tx, {
      registrationId,
      expiresAt: getParticipantSessionExpiresAt(),
    });
  });
}

async function findLatestRegistrationByChat(chatId: string) {
  const accessible = await findAccessibleRegistrationsByChat(chatId);
  const rank = (status: string) => ({ live: 0, pre_live: 1, waiting: 2, replay: 3 }[status] ?? 4);
  accessible.sort((left, right) => {
    const rankDiff = rank(left.access.accessStatus) - rank(right.access.accessStatus);
    if (rankDiff) return rankDiff;
    if (['waiting', 'pre_live'].includes(left.access.accessStatus)) {
      return left.registration.webinarSession.scheduledAt.getTime() - right.registration.webinarSession.scheduledAt.getTime();
    }
    return right.registration.webinarSession.scheduledAt.getTime() - left.registration.webinarSession.scheduledAt.getTime();
  });
  return accessible[0]?.registration ?? null;
}

async function findAccessibleRegistrationsByChat(chatId: string) {
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      emailVerifiedAt: { not: null },
      webinarSession: {
        lifecycleStatus: { not: 'CANCELLED' },
        webinar: { contentStatus: 'PUBLISHED', archivedAt: null },
      },
      lead: {
        telegramChatId: chatId,
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        personalDataConsentRevokedAt: null,
        email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
      },
    },
    include: {
      lead: true,
      webinarSession: { include: { webinar: { include: { sources: { orderBy: { orderIndex: 'asc' } } } } } },
    },
    orderBy: [{ webinarSession: { scheduledAt: 'asc' } }, { registeredAt: 'desc' }],
    take: 50,
  });
  const now = new Date();
  const accessible: Array<{ registration: (typeof registrations)[number]; access: ReturnType<typeof getWebinarAccess> }> = [];
  for (const registration of registrations) {
    if (!(await canAccessRegisteredWebinar(prisma, registration, now))) continue;
    const access = getWebinarAccess(
      now,
      registration.webinarSession.scheduledAt,
      registration.webinarSession.durationMinutes,
      registration.webinarSession.replayAvailableHours,
      registration.webinarSession.roomOpenBeforeMinutes,
      registration.webinarSession.replayEnabled,
    );
    if (access.accessStatus !== 'closed') accessible.push({ registration, access });
  }
  return accessible;
}

function formatSessionDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function participantAccessLabel(status: string) {
  if (status === 'live') return 'идёт сейчас';
  if (status === 'pre_live') return 'комната открыта';
  if (status === 'replay') return 'доступна запись';
  return 'ожидает начала';
}

function safeMaterialUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function saveBotEvent(input: {
  eventName: string;
  leadId?: string;
  registrationId?: string;
  webinarSessionId?: string;
  metadata?: Record<string, unknown>;
  providerMessageId?: string;
  correlationId?: string;
}) {
  const correlationId = input.correlationId ?? createCorrelationId('telegram_participant');
  const providerMessageId = input.providerMessageId;
  const safeMetadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).filter(
      ([key, value]) => ['command', 'outcome', 'isRebind'].includes(key) && ['string', 'boolean', 'number'].includes(typeof value),
    ),
  );
  const data = {
    eventName: input.eventName,
    page: 'telegram_bot',
    source: 'telegram',
    metadataJson: safeMetadata as Prisma.InputJsonValue,
  };
  if (!input.leadId) {
    await prisma.$transaction([
      prisma.event.create({
        data: {
          ...data,
          leadId: null,
          registrationId: null,
          webinarSessionId: null,
        },
      }),
      prisma.telegramBotEvent.upsert({
        where: { dedupKey: `participant:${providerMessageId ?? correlationId}:${input.eventName}` },
        update: {},
        create: {
          botIdentity: 'PARTICIPANT',
          direction: 'INBOUND',
          eventType: input.eventName,
          correlationId,
          providerMessageId,
          dedupKey: `participant:${providerMessageId ?? correlationId}:${input.eventName}`,
          status: 'accepted',
          metadataJson: safeMetadata as Prisma.InputJsonValue,
        },
      }),
    ]);
    return true;
  }

  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, input.leadId!);
    const activeRegistration = input.registrationId
      ? await tx.registration.findUnique({
          where: { id: input.registrationId },
          include: { lead: true, webinarSession: true },
        })
      : null;
    if (
      !activeRegistration ||
      activeRegistration.leadId !== input.leadId ||
      !isParticipantRegistrationActive(activeRegistration)
    ) {
      return false;
    }

    await tx.event.create({
      data: {
        ...data,
        leadId: activeRegistration.leadId,
        registrationId: activeRegistration.id,
        webinarSessionId: input.webinarSessionId ?? activeRegistration.webinarSessionId,
      },
    });
    const exactTenantScope =
      activeRegistration.organizationId &&
      activeRegistration.webinarId &&
      activeRegistration.organizationId === activeRegistration.webinarSession.organizationId &&
      activeRegistration.webinarId === activeRegistration.webinarSession.webinarId;
    await tx.telegramBotEvent.upsert({
      where: { dedupKey: `participant:${providerMessageId ?? correlationId}:${input.eventName}` },
      update: {},
      create: {
        organizationId: exactTenantScope ? activeRegistration.organizationId : null,
        webinarId: exactTenantScope ? activeRegistration.webinarId : null,
        webinarSessionId: exactTenantScope ? activeRegistration.webinarSessionId : null,
        registrationId: exactTenantScope ? activeRegistration.id : null,
        crmContactId: exactTenantScope ? activeRegistration.crmContactId : null,
        botIdentity: 'PARTICIPANT',
        direction: 'INBOUND',
        eventType: input.eventName,
        correlationId,
        providerMessageId,
        dedupKey: `participant:${providerMessageId ?? correlationId}:${input.eventName}`,
        status: 'accepted',
        metadataJson: safeMetadata as Prisma.InputJsonValue,
      },
    });
    return true;
  });
}

async function refreshTelegramBindingForActiveRegistration(
  registrationId: string,
  expectedLeadId: string,
  input: {
    chatId: string;
    telegramUsername?: string | null;
    telegramFirstName?: string | null;
  },
) {
  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, expectedLeadId);
    const activeRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      include: { lead: true, webinarSession: true },
    });
    if (
      !activeRegistration ||
      activeRegistration.leadId !== expectedLeadId ||
      !isParticipantRegistrationActive(activeRegistration)
    ) {
      return null;
    }

    const updatedLead = await tx.lead.update({
      where: { id: expectedLeadId },
      data: {
        telegramChatId: input.chatId,
        telegramUsername: input.telegramUsername,
        telegramFirstName: input.telegramFirstName,
        telegramSubscribedAt: new Date(),
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      },
    });
    return { registration: activeRegistration, updatedLead };
  });
}

function buildSegmentTip(status?: string | null) {
  const value = (status || '').toLowerCase();
  if (value.includes('юрист') || value.includes('антикризис')) {
    return 'В записи разобрано, как работать с долговыми клиентами без самостоятельного ведения всей процедуры банкротства.';
  }

  if (value.includes('налог') || value.includes('корпоратив')) {
    return 'Подумайте о клиентах с требованиями ФНС, субсидиарными рисками и долгами, где обычной консультации уже мало.';
  }

  if (value.includes('руководитель') || value.includes('практик')) {
    return 'Посмотрите, какие долговые обращения можно не отпускать, а передавать в АСПБ по понятной партнерской модели.';
  }

  return 'Подготовьте один обезличенный пример клиента с долговой ситуацией: в записи показано, когда его стоит передать на диагностику в АСПБ.';
}

function notifyAdminSafely(task: Promise<unknown>) {
  task.catch(error => {
    logger.error({ err: error }, '[ASPБ telegram subscription notify]');
  });
}

function getTelegramProfile(update: TelegramUpdate) {
  return {
    telegramUserId: update.message?.from?.id ? String(update.message.from.id) : null,
    telegramUsername: update.message?.from?.username ?? null,
    telegramFirstName: update.message?.from?.first_name ?? null,
  };
}

async function handleStart(chatId: string, text: string, update: TelegramUpdate) {
  const correlationId = createCorrelationId('telegram_participant_start');
  const providerMessageId = update.message?.message_id ? String(update.message.message_id) : undefined;
  const { telegramUserId, telegramUsername, telegramFirstName } = getTelegramProfile(update);
  const payload = text.split(/\s+/)[1]?.trim();
  if (!payload) {
    const existingRegistration = await findLatestRegistrationByChat(chatId);
    if (existingRegistration) {
      const refreshed = await refreshTelegramBindingForActiveRegistration(
        existingRegistration.id,
        existingRegistration.leadId,
        { chatId, telegramUsername, telegramFirstName },
      );
      if (!refreshed) {
        await sendTelegramMessageToChat(
          chatId,
          'Эта регистрация больше не активна. Зарегистрируйтесь заново, чтобы подключить уведомления.',
        );
        return;
      }
      const { registration: activeRegistration, updatedLead } = refreshed;
      const roomUrl = await createRoomUrl(activeRegistration.id, 'telegram_repeat_start_room');
      if (!roomUrl) {
        await sendTelegramMessageToChat(chatId, 'Не удалось создать ссылку: регистрация больше не активна.');
        return;
      }
      await saveBotEvent({
        eventName: 'telegram_repeat_start',
        leadId: activeRegistration.leadId,
        registrationId: activeRegistration.id,
        webinarSessionId: activeRegistration.webinarSessionId,
        metadata: {
          outcome: 'already_bound',
        },
        providerMessageId,
        correlationId,
      });
      notifyAdminSafely(
        notifyTelegramSubscription({
          title: 'Участник повторно открыл Telegram-уведомления АСПБ',
          name: updatedLead.name,
          phone: updatedLead.phone,
          email: updatedLead.email,
          city: updatedLead.city,
          professionalStatus: updatedLead.professionalStatus,
          source: updatedLead.source,
          utmSource: updatedLead.utmSource,
          utmMedium: updatedLead.utmMedium,
          utmCampaign: updatedLead.utmCampaign,
          scheduledAt: activeRegistration.webinarSession.scheduledAt,
          registeredAt: activeRegistration.registeredAt,
          telegramChatId: chatId,
          telegramUserId,
          telegramUsername,
          telegramFirstName,
          registrationId: activeRegistration.id,
          adminUrl: buildFrontendUrl('/admin'),
        }),
      );
      await sendTelegramMessageToChat(
        chatId,
        [
          `${activeRegistration.lead.name}, напоминания уже подключены.`,
          '',
          `Вебинар: ${activeRegistration.webinarSession.title}`,
          `Начало: ${formatMoscowDate(activeRegistration.webinarSession.scheduledAt)} МСК`,
          '',
          'Команды: /status — регистрация, /room — ссылка в комнату.',
        ].join('\n'),
        { replyMarkup: telegramUrlButton('▶ Войти в комнату', roomUrl) },
      );
      return;
    }

    await saveBotEvent({
      eventName: 'telegram_start_without_registration',
      metadata: {
        outcome: 'registration_required',
      },
      providerMessageId,
      correlationId,
    });
    notifyAdminSafely(
      notifyTelegramBotStart({
        telegramChatId: chatId,
        telegramUserId,
        telegramUsername,
        telegramFirstName,
        registrationUrl: buildFrontendUrl('/crisis_premium/register.html'),
      }),
    );

    await sendTelegramMessageToChat(
      chatId,
      [
        'АСПБ на связи.',
        '',
        'Чтобы подключить персональные напоминания, зарегистрируйтесь на вебинар и нажмите кнопку Telegram на странице успешной регистрации.',
        '',
        `Регистрация: ${buildFrontendUrl('/crisis_premium/register.html')}`,
      ].join('\n'),
    );
    return;
  }

  const claimedStart = await consumeTelegramStartToken(payload, {
    chatId,
    telegramUsername,
    telegramFirstName,
  });
  if (!claimedStart) {
    await sendTelegramMessageToChat(
      chatId,
      [
        'Не удалось привязать регистрацию.',
        '',
        'Откройте Telegram-кнопку именно со страницы “Вы зарегистрированы” или зарегистрируйтесь заново.',
      ].join('\n'),
    );
    return;
  }

  const { registration, updatedLead, isRebind } = claimedStart;

  await saveBotEvent({
    eventName: 'telegram_subscribe',
    leadId: registration.leadId,
    registrationId: registration.id,
    webinarSessionId: registration.webinarSessionId,
    metadata: {
      isRebind,
      outcome: 'bound',
    },
    providerMessageId,
    correlationId,
  });

  const roomUrl = await createRoomUrl(registration.id, 'telegram_start_room');
  if (!roomUrl) {
    await sendTelegramMessageToChat(
      chatId,
      'Привязка не завершена: регистрация больше не активна. Зарегистрируйтесь заново.',
    );
    return;
  }

  notifyAdminSafely(
    notifyTelegramSubscription({
      name: updatedLead.name,
      phone: updatedLead.phone,
      email: updatedLead.email,
      city: updatedLead.city,
      professionalStatus: updatedLead.professionalStatus,
      source: updatedLead.source,
      utmSource: updatedLead.utmSource,
      utmMedium: updatedLead.utmMedium,
      utmCampaign: updatedLead.utmCampaign,
      scheduledAt: registration.webinarSession.scheduledAt,
      registeredAt: registration.registeredAt,
      telegramChatId: chatId,
      telegramUserId,
      telegramUsername,
      telegramFirstName,
      registrationId: registration.id,
      isRebind,
      adminUrl: buildFrontendUrl('/admin'),
    }),
  );

  await sendTelegramMessageToChat(
    chatId,
    [
      `${registration.lead.name}, готово — напоминания подключены.`,
      '',
      `Вебинар: ${registration.webinarSession.title}`,
      `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      '',
      'До премьеры подготовьте 1–2 обезличенных примера клиентов с долгами, налогами или риском банкротства.',
      buildSegmentTip(registration.lead.professionalStatus),
      '',
      'Напомню за 24 часа, за 3 часа и за 30 минут до старта.',
    ].join('\n'),
    { replyMarkup: telegramUrlButton('▶ Войти в комнату', roomUrl) },
  );
}

async function handleStatus(chatId: string) {
  const registration = await findLatestRegistrationByChat(chatId);
  if (!registration) {
    await sendTelegramMessageToChat(
      chatId,
      'Пока не вижу привязанной регистрации. Зарегистрируйтесь на сайте и нажмите Telegram-кнопку на success-странице.',
    );
    return;
  }

  const roomUrl = await createRoomUrl(registration.id, 'telegram_status_room');
  if (!roomUrl) {
    await sendTelegramMessageToChat(chatId, 'Эта регистрация больше не активна. Зарегистрируйтесь заново.');
    return;
  }
  await sendTelegramMessageToChat(
    chatId,
    [
      'Ваша регистрация активна.',
      '',
      `Участник: ${registration.lead.name}`,
      `Премьера записи: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
    ].join('\n'),
    { replyMarkup: telegramUrlButton('▶ Войти в комнату', roomUrl) },
  );
}

async function handleWebinars(chatId: string) {
  const accessible = await findAccessibleRegistrationsByChat(chatId);
  if (!accessible.length) {
    await sendTelegramMessageToChat(
      chatId,
      'Доступных вебинаров пока нет. Откройте каталог и зарегистрируйтесь на нужную сессию.',
      { replyMarkup: telegramUrlButton('Открыть каталог', buildFrontendUrl('/crisis_premium/catalog.html')) },
    );
    return;
  }
  const rows = accessible.slice(0, 8).flatMap(({ registration, access }, index) => [
    `${index + 1}. ${registration.webinarSession.webinar.title}`,
    `${formatSessionDate(registration.webinarSession.scheduledAt, registration.webinarSession.timezone)} (${registration.webinarSession.timezone}) — ${participantAccessLabel(access.accessStatus)}`,
  ]);
  await sendTelegramMessageToChat(
    chatId,
    [
      'Ваши доступные вебинары:',
      '',
      ...rows,
      accessible.length > 8 ? `Показаны 8 из ${accessible.length}. Полный список — в кабинете.` : '',
      '',
      '/room — открыть актуальную комнату',
      '/materials — материалы актуального вебинара',
    ]
      .filter(Boolean)
      .join('\n'),
    { replyMarkup: telegramUrlButton('Открыть кабинет', buildFrontendUrl('/crisis_premium/account.html')) },
  );
}

async function handleMy(chatId: string) {
  const accessible = await findAccessibleRegistrationsByChat(chatId);
  const current = await findLatestRegistrationByChat(chatId);
  if (!current) {
    await sendTelegramMessageToChat(
      chatId,
      'Активный доступ не найден. Зарегистрируйтесь на вебинар или проверьте срок ранее выданного доступа.',
      { replyMarkup: telegramUrlButton('Открыть каталог', buildFrontendUrl('/crisis_premium/catalog.html')) },
    );
    return;
  }
  const currentAccess = accessible.find(item => item.registration.id === current.id)?.access;
  await sendTelegramMessageToChat(
    chatId,
    [
      'Мой доступ:',
      '',
      `Актуальный вебинар: ${current.webinarSession.webinar.title}`,
      `Сессия: ${formatSessionDate(current.webinarSession.scheduledAt, current.webinarSession.timezone)} (${current.webinarSession.timezone})`,
      `Состояние: ${participantAccessLabel(currentAccess?.accessStatus ?? 'waiting')}`,
      `Всего доступно: ${accessible.length}`,
      '',
      'Настройки маркетинговых и сервисных уведомлений изменяются отдельно в кабинете.',
    ].join('\n'),
    { replyMarkup: telegramUrlButton('Открыть кабинет', buildFrontendUrl('/crisis_premium/account.html')) },
  );
}

async function handleMaterials(chatId: string) {
  const registration = await findLatestRegistrationByChat(chatId);
  if (!registration) {
    await sendTelegramMessageToChat(chatId, 'Материалы недоступны: активная регистрация не найдена.');
    return;
  }
  const materials = registration.webinarSession.webinar.sources
    .map(source => ({ title: source.title.trim(), url: safeMaterialUrl(source.url) }))
    .filter(source => source.title.length > 0);
  if (!materials.length) {
    await sendTelegramMessageToChat(
      chatId,
      `К вебинару «${registration.webinarSession.webinar.title}» материалы пока не опубликованы.`,
    );
    return;
  }
  const rows = materials.slice(0, 10).map((material, index) =>
    material.url ? `${index + 1}. ${material.title}\n${material.url}` : `${index + 1}. ${material.title}`,
  );
  const roomUrl = await createRoomUrl(registration.id, 'telegram_materials_room');
  await sendTelegramMessageToChat(
    chatId,
    [
      `Материалы: ${registration.webinarSession.webinar.title}`,
      '',
      ...rows,
      materials.length > 10 ? `Показаны 10 из ${materials.length}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    roomUrl ? { replyMarkup: telegramUrlButton('Открыть вебинар', roomUrl) } : {},
  );
}

async function handleRoom(chatId: string) {
  const registration = await findLatestRegistrationByChat(chatId);
  if (!registration) {
    await sendTelegramMessageToChat(
      chatId,
      'Сначала привяжите регистрацию через Telegram-кнопку на странице успешной регистрации.',
    );
    return;
  }

  const roomUrl = await createRoomUrl(registration.id, 'telegram_room_command');
  if (!roomUrl) {
    await sendTelegramMessageToChat(chatId, 'Эта регистрация больше не активна. Зарегистрируйтесь заново.');
    return;
  }
  await sendTelegramMessageToChat(chatId, 'Ваша персональная вебинарная комната:', {
    replyMarkup: telegramUrlButton('▶ Войти в комнату', roomUrl),
  });
}

async function handleHelp(chatId: string) {
  await sendTelegramMessageToChat(
    chatId,
    [
      'Команды АСПБ:',
      '',
      '/webinars — доступные вебинары и сессии',
      '/my — мой доступ и кабинет',
      '/status — проверить регистрацию и время премьеры записи',
      '/room — получить персональную ссылку в комнату',
      '/materials — материалы актуального вебинара',
      '/unsubscribe — немедленно отказаться от рекламы в Telegram',
      '/help — помощь',
      '',
      `Регистрация: ${buildFrontendUrl('/crisis_premium/register.html')}`,
    ].join('\n'),
  );
}

async function handleMarketingUnsubscribe(chatId: string) {
  const lead = await prisma.lead.findFirst({
    where: { telegramChatId: chatId, telegramBindingVersion: TELEGRAM_BINDING_VERSION },
    include: {
      consentRecords: {
        where: {
          kind: 'marketing_telegram',
          action: 'grant',
          documentId: MARKETING_TELEGRAM_CONSENT.id,
        },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!lead) {
    await sendTelegramMessageToChat(chatId, 'Рекламная подписка для этого чата не найдена.');
    return;
  }

  const revokedAt = new Date();
  const revoked = await prisma.$transaction(async tx => {
    // Global order for any transaction that needs both locks:
    // TelegramDelivery -> Lead.
    await acquireTelegramDeliveryLock(tx, lead.id);
    await acquireLeadSecurityLock(tx, lead.id);
    const currentLead = await tx.lead.findUnique({
      where: { id: lead.id },
      include: {
        consentRecords: {
          where: {
            kind: 'marketing_telegram',
            action: 'grant',
            documentId: MARKETING_TELEGRAM_CONSENT.id,
          },
          orderBy: { occurredAt: 'desc' },
          take: 1,
        },
      },
    });
    if (
      !currentLead ||
      !isLeadIdentityActive(currentLead) ||
      currentLead.telegramChatId !== chatId ||
      currentLead.telegramBindingVersion !== TELEGRAM_BINDING_VERSION
    ) {
      return false;
    }

    await tx.lead.update({
      where: { id: currentLead.id },
      data: {
        marketingTelegramConsent: false,
        marketingTelegramRevokedAt: revokedAt,
        marketingTelegramRevocationChannel: 'telegram_command',
        marketingTelegramRevocationReason: 'recipient_request',
        marketingConsent: currentLead.marketingEmailConsent,
      },
    });
    // A queued broadcast snapshot is not authorization. Mark pending rows inside the
    // same Lead lock so a provider result from an older worker cannot overwrite this
    // revocation with `sent` (the worker finalizes recipients through status/identity CAS).
    await tx.telegramBroadcastRecipient.updateMany({
      where: { leadId: currentLead.id, status: 'pending' },
      data: {
        status: 'skipped_revoked',
        unsubscribedBeforeSendAt: revokedAt,
        lastError: 'Recipient revoked Telegram marketing consent before delivery',
      },
    });
    await tx.consentRecord.create({
      data: consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
        leadId: currentLead.id,
        email: currentLead.email,
        kind: 'marketing_telegram',
        action: 'revoke',
        sourceForm: 'telegram_participant_bot',
        req: {
          headers: { 'user-agent': 'telegram-participant-bot' },
          socket: {},
        },
        occurredAt: revokedAt,
        revocationChannel: 'telegram_command',
        revocationReason: 'recipient_request',
        revokedConsentId: currentLead.consentRecords[0]?.id,
      }),
    });
    return true;
  }, TELEGRAM_REVOCATION_TRANSACTION_OPTIONS);

  if (!revoked) {
    await sendTelegramMessageToChat(chatId, 'Рекламная подписка для этого чата не найдена.');
    return;
  }

  await sendTelegramMessageToChat(
    chatId,
    'Готово: рекламные сообщения и новости АСПБ в Telegram отключены немедленно. Организационные сообщения о вашей регистрации регулируются отдельно.',
  );
}

async function handleUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message) return;
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = message?.text?.trim() || '';
  if (!chatId || !text) return;
  // Только личные диалоги: в группе/канале chat.id — это id чата, а не пользователя, и
  // привязка регистрации/персональные ссылки ушли бы всей группе.
  if (message?.chat?.type && message.chat.type !== 'private') return;

  if (text.startsWith('/start')) {
    await handleStart(chatId, text, update);
    return;
  }

  const command = text.startsWith('/') ? text.split(/\s+/)[0]!.split('@')[0]!.toLowerCase() : 'free_text';
  const commandRegistration = await findLatestRegistrationByChat(chatId);
  await saveBotEvent({
    eventName: 'telegram_participant_command',
    leadId: commandRegistration?.leadId,
    registrationId: commandRegistration?.id,
    webinarSessionId: commandRegistration?.webinarSessionId,
    metadata: { command },
    providerMessageId: String(message.message_id),
    correlationId: createCorrelationId('telegram_participant_command'),
  });

  if (text.startsWith('/unsubscribe') || text.startsWith('/stop') || /^стоп$/i.test(text)) {
    await handleMarketingUnsubscribe(chatId);
    return;
  }

  if (text.startsWith('/status')) {
    await handleStatus(chatId);
    return;
  }

  if (text.startsWith('/webinars')) {
    await handleWebinars(chatId);
    return;
  }

  if (text.startsWith('/my')) {
    await handleMy(chatId);
    return;
  }

  if (text.startsWith('/room')) {
    await handleRoom(chatId);
    return;
  }

  if (text.startsWith('/materials')) {
    await handleMaterials(chatId);
    return;
  }

  if (text.startsWith('/help')) {
    await handleHelp(chatId);
    return;
  }

  await sendTelegramMessageToChat(
    chatId,
    'Сообщение получил. Используйте /webinars для списка доступов, /room для актуальной комнаты или /help для всех команд.',
  );
}

export function startParticipantTelegramBot() {
  if (env.NODE_ENV === 'test' || !isParticipantBotReady()) {
    return null;
  }

  poller = createTelegramPoller<TelegramUpdate>({
    name: 'ASPБ participant telegram bot',
    apiUrl: participantTelegramApiUrl,
    allowedUpdates: ['message'],
    isEnabled: isParticipantBotReady,
    handleUpdate,
    progressSubsystem: 'botParticipant',
  });
  poller.start();
  return poller;
}

export function stopParticipantTelegramBot() {
  poller?.stop();
  poller = null;
}

export { buildTelegramStartUrl, handleUpdate as handleParticipantTelegramUpdate };
