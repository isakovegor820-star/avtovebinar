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
} from './telegram.js';
import {
  buildFrontendUrl,
  createRoomExchangeUrl,
  getRoomTokenExpiresAt,
  TELEGRAM_START_TOKEN_PURPOSE,
} from './roomLinks.js';
import { logger } from './logger.js';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number | string; type?: string };
    from?: { id?: number | string; username?: string; first_name?: string };
  };
};

let nextOffset = 0;
let polling = false;
let interval: NodeJS.Timeout | null = null;

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

    const claimedToken = await tx.registrationToken.deleteMany({
      where: {
        id: tokenRecord.id,
        tokenHash: accessTokenHash,
        purpose: TELEGRAM_START_TOKEN_PURPOSE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (claimedToken.count !== 1) {
      return null;
    }

    const previousChatId = tokenRecord.registration.lead.telegramChatId;
    const updatedLead = await tx.lead.update({
      where: { id: tokenRecord.registration.leadId },
      data: {
        telegramChatId: input.chatId,
        telegramUsername: input.telegramUsername,
        telegramFirstName: input.telegramFirstName,
        telegramSubscribedAt: now,
      },
    });

    await tx.registration.update({
      where: { id: tokenRecord.registration.id },
      data: { telegramClickedAt: tokenRecord.registration.telegramClickedAt ?? now },
    });

    return {
      registration: tokenRecord.registration,
      updatedLead,
      isRebind: Boolean(previousChatId && previousChatId !== input.chatId),
    };
  });
}

async function createRoomUrl(registrationId: string, purpose = 'telegram_room') {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { webinarSession: true },
  });

  if (!registration) {
    throw new Error(`Registration not found for Telegram room link purpose ${purpose}`);
  }

  return prisma.$transaction(tx =>
    createRoomExchangeUrl(tx, {
      registrationId,
      expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
    }),
  );
}

async function findLatestRegistrationByChat(chatId: string) {
  return prisma.registration.findFirst({
    where: {
      lead: {
        telegramChatId: chatId,
      },
    },
    include: {
      lead: true,
      webinarSession: true,
    },
    orderBy: { registeredAt: 'desc' },
  });
}

async function saveBotEvent(input: {
  eventName: string;
  leadId?: string;
  registrationId?: string;
  webinarSessionId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.event.create({
    data: {
      eventName: input.eventName,
      leadId: input.leadId ?? null,
      registrationId: input.registrationId ?? null,
      webinarSessionId: input.webinarSessionId ?? null,
      page: 'telegram_bot',
      source: 'telegram',
      metadataJson: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

function buildSegmentTip(status?: string | null) {
  const value = (status || '').toLowerCase();
  if (value.includes('юрист') || value.includes('антикризис')) {
    return 'На эфире разберем, как работать с долговыми клиентами без самостоятельного ведения всей процедуры банкротства.';
  }

  if (value.includes('налог') || value.includes('корпоратив')) {
    return 'Подумайте о клиентах с требованиями ФНС, субсидиарными рисками и долгами, где обычной консультации уже мало.';
  }

  if (value.includes('руководитель') || value.includes('практик')) {
    return 'Посмотрите, какие долговые обращения можно не отпускать, а передавать в АСПБ по понятной партнерской модели.';
  }

  return 'Подготовьте один пример клиента с долговой ситуацией: на эфире покажем, когда его стоит передать на диагностику в АСПБ.';
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
  const { telegramUserId, telegramUsername, telegramFirstName } = getTelegramProfile(update);
  const payload = text.split(/\s+/)[1]?.trim();
  if (!payload) {
    const existingRegistration = await findLatestRegistrationByChat(chatId);
    if (existingRegistration) {
      const updatedLead = await prisma.lead.update({
        where: { id: existingRegistration.leadId },
        data: {
          telegramChatId: chatId,
          telegramUsername,
          telegramFirstName,
          telegramSubscribedAt: existingRegistration.lead.telegramSubscribedAt ?? new Date(),
        },
      });
      const roomUrl = await createRoomUrl(existingRegistration.id, 'telegram_repeat_start_room');
      await saveBotEvent({
        eventName: 'telegram_repeat_start',
        leadId: existingRegistration.leadId,
        registrationId: existingRegistration.id,
        webinarSessionId: existingRegistration.webinarSessionId,
        metadata: {
          username: telegramUsername,
          telegramFirstName,
          telegramUserId,
        },
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
          scheduledAt: existingRegistration.webinarSession.scheduledAt,
          registeredAt: existingRegistration.registeredAt,
          telegramChatId: chatId,
          telegramUserId,
          telegramUsername,
          telegramFirstName,
          registrationId: existingRegistration.id,
          adminUrl: buildFrontendUrl('/admin'),
        }),
      );
      await sendTelegramMessageToChat(
        chatId,
        [
          `${existingRegistration.lead.name}, вы уже подключили уведомления АСПБ.`,
          '',
          `Вебинар: ${existingRegistration.webinarSession.title}`,
          `Начало: ${formatMoscowDate(existingRegistration.webinarSession.scheduledAt)} МСК`,
          '',
          'Ваш доступ сохранен. Вот свежая персональная ссылка в вебинарную комнату:',
          roomUrl,
          '',
          'Команды:',
          '/status — проверить регистрацию',
          '/room — получить ссылку в комнату',
        ].join('\n'),
      );
      return;
    }

    await saveBotEvent({
      eventName: 'telegram_start_without_registration',
      metadata: {
        chatId,
        username: telegramUsername,
        telegramFirstName,
        telegramUserId,
      },
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
      username: telegramUsername,
      telegramFirstName,
      telegramUserId,
      isRebind,
    },
  });

  const roomUrl = await createRoomUrl(registration.id, 'telegram_start_room');

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
      `${registration.lead.name}, Telegram-напоминания подключены.`,
      '',
      'До вебинара подготовьте 1-2 клиента, у которых есть долги, блокировки, кредиты или налоговые проблемы.',
      buildSegmentTip(registration.lead.professionalStatus),
      'На эфире покажем, как понять, когда такого клиента стоит передать на диагностику в АСПБ.',
      '',
      `Вебинар: ${registration.webinarSession.title}`,
      `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      '',
      `Ваша персональная комната: ${roomUrl}`,
      '',
      'Я напомню о вебинаре заранее и пришлю важные новости АСПБ.',
    ].join('\n'),
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
  await sendTelegramMessageToChat(
    chatId,
    [
      'Ваша регистрация активна.',
      '',
      `Участник: ${registration.lead.name}`,
      `Эфир: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      `Статус: ${registration.status}`,
      '',
      `Комната: ${roomUrl}`,
    ].join('\n'),
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
  await sendTelegramMessageToChat(chatId, `Ваша вебинарная комната:\n${roomUrl}`);
}

async function handleHelp(chatId: string) {
  await sendTelegramMessageToChat(
    chatId,
    [
      'Команды АСПБ:',
      '',
      '/status — проверить регистрацию и время эфира',
      '/room — получить персональную ссылку в комнату',
      '/help — помощь',
      '',
      `Регистрация: ${buildFrontendUrl('/crisis_premium/register.html')}`,
    ].join('\n'),
  );
}

async function handleUpdate(update: TelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = message?.text?.trim() || '';
  if (!chatId || !text) return;

  if (text.startsWith('/start')) {
    await handleStart(chatId, text, update);
    return;
  }

  if (text.startsWith('/status')) {
    await handleStatus(chatId);
    return;
  }

  if (text.startsWith('/room')) {
    await handleRoom(chatId);
    return;
  }

  if (text.startsWith('/help')) {
    await handleHelp(chatId);
    return;
  }

  await sendTelegramMessageToChat(
    chatId,
    'Сообщение получил. Для проверки регистрации используйте /status, для ссылки на вебинарную комнату — /room.',
  );
}

async function pollOnce() {
  if (polling || !isParticipantBotPollingEnabled() || !hasParticipantTelegramBot()) return;
  polling = true;

  try {
    const url = new URL(participantTelegramApiUrl('getUpdates'));
    if (nextOffset) url.searchParams.set('offset', String(nextOffset));
    url.searchParams.set('limit', '20');
    url.searchParams.set('timeout', '0');
    url.searchParams.set('allowed_updates', JSON.stringify(['message']));

    const response = await fetch(url);
    const payload = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!payload.ok) {
      throw new Error(payload.description || 'Telegram getUpdates failed');
    }

    for (const update of payload.result || []) {
      try {
        await handleUpdate(update);
      } catch (error) {
        logger.error({ err: error, updateId: update.update_id }, '[ASPБ telegram bot update]');
      } finally {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      }
    }
  } finally {
    polling = false;
  }
}

export function startParticipantTelegramBot() {
  if (env.NODE_ENV === 'test' || !isParticipantBotPollingEnabled() || !hasParticipantTelegramBot()) {
    return null;
  }

  pollOnce().catch(error => logger.error({ err: error }, '[ASPБ telegram bot]'));
  interval = setInterval(() => {
    pollOnce().catch(error => logger.error({ err: error }, '[ASPБ telegram bot]'));
  }, 3500);

  logger.info('[ASPБ telegram bot] participant polling enabled');
  return interval;
}

export function stopParticipantTelegramBot() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export { buildTelegramStartUrl, handleUpdate as handleParticipantTelegramUpdate };
