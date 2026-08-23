import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { buildFrontendUrl } from './roomLinks.js';
import {
  consultantTelegramApiUrl,
  hasConsultantTelegramBot,
  isConsultantBotPollingEnabled,
  sendConsultantTelegramMessageToChat,
  sendManagerTelegramMessageToChat,
  sendTelegramMessage,
} from './telegram.js';
import { env } from './env.js';
import { createTelegramPoller, type TelegramPoller } from './telegramPoller.js';
import { createCorrelationId } from './requestContext.js';
import { classifyTelegramConsultantText, recordTelegramConsultantMessage } from './tenancy/telegramConsultant.js';
import { createTelegramManagerCallback } from './tenancy/telegramBots.js';
import { logger } from './logger.js';

type ConsultantTelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number | string; type?: string };
    from?: { id?: number | string; username?: string; first_name?: string };
  };
};

let poller: TelegramPoller | null = null;

function isConsultantBotReady() {
  return isConsultantBotPollingEnabled() && hasConsultantTelegramBot();
}

function getTelegramProfile(update: ConsultantTelegramUpdate) {
  return {
    telegramUserId: update.message?.from?.id ? String(update.message.from.id) : null,
    telegramUsername: update.message?.from?.username ?? null,
    telegramFirstName: update.message?.from?.first_name ?? null,
  };
}

async function saveConsultantEvent(input: { eventName: string; chatId: string; update: ConsultantTelegramUpdate }) {
  const providerMessageId = input.update.message?.message_id ? String(input.update.message.message_id) : 'unknown';
  const chatHash = crypto
    .createHmac('sha256', env.IP_HASH_SECRET)
    .update(`telegram-consultant-command:v1:${input.chatId}`)
    .digest('hex');
  const correlationId = createCorrelationId('telegram_consultant_command');
  await prisma.$transaction([
    prisma.event.create({
      data: {
        eventName: input.eventName,
        page: 'telegram_consultant_bot',
        source: 'telegram',
        metadataJson: { commandEvent: true },
      },
    }),
    prisma.telegramBotEvent.upsert({
      where: { dedupKey: `consultant-command:${chatHash}:${providerMessageId}:${input.eventName}` },
      update: {},
      create: {
        botIdentity: 'CONSULTANT',
        direction: 'INBOUND',
        eventType: input.eventName,
        correlationId,
        providerMessageId,
        dedupKey: `consultant-command:${chatHash}:${providerMessageId}:${input.eventName}`,
        status: 'accepted',
        metadataJson: { commandEvent: true },
      },
    }),
  ]);
}

function buildContactRows(
  update: ConsultantTelegramUpdate,
  text: string,
  classification?: ReturnType<typeof classifyTelegramConsultantText>,
) {
  const profile = getTelegramProfile(update);
  const username = profile.telegramUsername ? `@${profile.telegramUsername.replace(/^@/, '')}` : '—';
  return [
    'Новое сообщение в Telegram-помощнике АСПБ',
    '',
    `Username: ${username}`,
    profile.telegramFirstName ? `Имя в Telegram: ${profile.telegramFirstName}` : null,
    classification
      ? `Тема: ${classification.topic}; намерение: ${classification.intent}; срочность: ${classification.urgency}`
      : null,
    '',
    `Сообщение: ${text}`,
  ].filter(Boolean);
}

async function notifyPlatformAdminAboutMessage(text: string, update: ConsultantTelegramUpdate) {
  const profile = getTelegramProfile(update);
  const telegramUrl = profile.telegramUsername
    ? `https://t.me/${profile.telegramUsername.replace(/^@/, '')}`
    : profile.telegramUserId
      ? `tg://user?id=${encodeURIComponent(profile.telegramUserId)}`
      : undefined;

  await sendTelegramMessage({
    replyMarkup: {
      inline_keyboard: [
        [
          telegramUrl ? { text: 'Написать в Telegram', url: telegramUrl } : null,
          { text: 'Открыть админку', url: buildFrontendUrl('/admin') },
        ].filter(Boolean),
      ].filter(row => row.length),
    },
    text: buildContactRows(update, text).join('\n'),
  });
}

async function notifyTenantManagers(record: Awaited<ReturnType<typeof recordTelegramConsultantMessage>>) {
  const scope = record.scope;
  if (
    !scope.organizationId ||
    !scope.registrationId ||
    !scope.crmContactId ||
    !scope.webinarId ||
    !scope.webinarSessionId
  ) {
    return 0;
  }
  const bindings = await prisma.telegramManagerChatBinding.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      membership: {
        status: 'ACTIVE',
        role: { in: ['OWNER', 'CRM_MANAGER'] },
        user: { kind: 'HUMAN', status: 'ACTIVE' },
      },
    },
    include: { membership: true },
    orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  let notified = 0;
  for (const binding of bindings) {
    if (!binding.chatId) continue;
    const context = {
      userId: binding.membership.userId,
      organizationId: binding.organizationId,
      membershipId: binding.membershipId,
      role: binding.membership.role,
      permissions: binding.membership.permissionsJson,
      correlationId: record.correlationId,
    };
    const accept = await createTelegramManagerCallback(prisma, context, {
      bindingId: binding.id,
      registrationId: scope.registrationId,
      crmContactId: scope.crmContactId,
      action: 'ACCEPT_CONTACT',
      idempotencyKey: `consultant:${record.message.id}:${binding.id}:accept`,
    });
    const hot = await createTelegramManagerCallback(prisma, context, {
      bindingId: binding.id,
      registrationId: scope.registrationId,
      crmContactId: scope.crmContactId,
      action: 'MARK_HOT',
      payload: { reason: 'Приоритет по входящему сообщению Telegram-помощника' },
      idempotencyKey: `consultant:${record.message.id}:${binding.id}:hot`,
    });
    const delivery = await sendManagerTelegramMessageToChat(
      binding.chatId,
      [
        'Новое обращение из Telegram-помощника АСПБ',
        '',
        `Автоматическая классификация: ${record.classification.topic}; ${record.classification.intent}; ${record.classification.urgency}`,
        'Классификацию можно исправить в tenant CRM.',
        '',
        record.message.text,
      ].join('\n'),
      {
        replyMarkup: {
          inline_keyboard: [
            [
              { text: 'Принять контакт', callback_data: accept.callbackData },
              { text: 'Отметить hot', callback_data: hot.callbackData },
            ],
            [
              {
                text: 'Открыть CRM',
                url: `${buildFrontendUrl('/crisis_premium/crm.html')}?contact=${encodeURIComponent(scope.crmContactId)}`,
              },
            ],
          ],
        },
      },
    );
    await prisma.telegramBotEvent.create({
      data: {
        organizationId: scope.organizationId,
        webinarId: scope.webinarId,
        webinarSessionId: scope.webinarSessionId,
        registrationId: scope.registrationId,
        crmContactId: scope.crmContactId,
        membershipId: binding.membershipId,
        managerBindingId: binding.id,
        botIdentity: 'MANAGER',
        direction: 'OUTBOUND',
        eventType: 'consultant_handoff_notified',
        correlationId: record.correlationId,
        providerMessageId: delivery.providerMessageId,
        dedupKey: `consultant:${record.message.id}:${binding.id}:notified`,
        status: delivery.sent ? 'sent' : 'logged',
        metadataJson: {
          topic: record.classification.topic,
          intent: record.classification.intent,
          urgency: record.classification.urgency,
        },
      },
    });
    notified += 1;
  }
  return notified;
}

async function handleStart(chatId: string, update: ConsultantTelegramUpdate) {
  await saveConsultantEvent({ eventName: 'telegram_consultant_start', chatId, update });
  await sendConsultantTelegramMessageToChat(
    chatId,
    [
      'АСПБ на связи.',
      '',
      'Я помогу быстро выбрать следующий шаг:',
      '/webinar — регистрация на вебинар',
      '/partner — партнерская модель',
      '/contact — связаться с менеджером',
      '/help — все команды',
    ].join('\n'),
  );
}

async function handleHelp(chatId: string) {
  await sendConsultantTelegramMessageToChat(
    chatId,
    [
      'Команды бота АСПБ:',
      '',
      '/webinar — получить ссылку на регистрацию',
      '/partner — узнать про партнерскую модель',
      '/contact — передать запрос менеджеру',
      '/help — помощь',
    ].join('\n'),
  );
}

async function handleWebinar(chatId: string) {
  await sendConsultantTelegramMessageToChat(
    chatId,
    [
      'Регистрация на вебинар АСПБ:',
      buildFrontendUrl('/crisis_premium/register.html'),
      '',
      'После регистрации можно подключить персональные Telegram-напоминания и получить ссылку в вебинарную комнату.',
    ].join('\n'),
  );
}

async function handlePartner(chatId: string) {
  await sendConsultantTelegramMessageToChat(
    chatId,
    [
      'Партнерская модель АСПБ подходит юристам, консультантам и экспертам, которые видят у клиентов долги, ФНС, кредиты или банкротные риски.',
      '',
      'На вебинаре показываем, какие обращения можно передавать на диагностику и как устроен маршрут клиента.',
      '',
      `Регистрация: ${buildFrontendUrl('/crisis_premium/register.html')}`,
    ].join('\n'),
  );
}

async function handleContact(chatId: string, update: ConsultantTelegramUpdate) {
  await saveConsultantEvent({ eventName: 'telegram_consultant_contact_request', chatId, update });
  await notifyPlatformAdminAboutMessage('/contact', update);
  await sendConsultantTelegramMessageToChat(
    chatId,
    'Передал запрос менеджеру АСПБ. Напишите одним сообщением, какой вопрос хотите обсудить: партнерство, клиент с долгами, вебинар или доступ.',
  );
}

async function handleFreeText(chatId: string, text: string, update: ConsultantTelegramUpdate) {
  const record = await recordTelegramConsultantMessage(prisma, {
    chatId,
    providerMessageId: String(update.message?.message_id ?? ''),
    text,
    correlationId: createCorrelationId('telegram_consultant_message'),
  });
  if (!record.replayed) {
    const notified = await notifyTenantManagers(record);
    if (!record.scope.organizationId) {
      await notifyPlatformAdminAboutMessage(record.message.text, update);
    } else if (notified === 0) {
      logger.warn(
        { organizationId: record.scope.organizationId, consultantMessageId: record.message.id },
        'Tenant consultant handoff has no active manager chat binding',
      );
    }
  }
  const legalQuestion = record.classification.intent === 'legal_question';
  await sendConsultantTelegramMessageToChat(
    chatId,
    legalQuestion
      ? [
          'Я помощник по навигации, а не юридический консультант, поэтому не даю индивидуальных советов по вашей ситуации.',
          '',
          'Я передал вопрос человеку. Пока можно открыть вебинары и материалы АСПБ:',
          buildFrontendUrl('/crisis_premium/catalog.html'),
        ].join('\n')
      : [
          'Сообщение получил и передал человеку.',
          '',
          'Я могу помочь с навигацией по вебинарам, материалам и доступу, но не заменяю юридическую консультацию.',
          buildFrontendUrl('/crisis_premium/catalog.html'),
        ].join('\n'),
  );
}

export async function handleConsultantTelegramUpdate(update: ConsultantTelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = message?.text?.trim() || '';
  if (!chatId || !text) return;
  // Только личные диалоги (в группах/каналах не реагируем и не пересылаем админу).
  if (message?.chat?.type && message.chat.type !== 'private') return;

  if (text.startsWith('/start')) {
    await handleStart(chatId, update);
    return;
  }

  if (text.startsWith('/help')) {
    await handleHelp(chatId);
    return;
  }

  if (text.startsWith('/webinar')) {
    await handleWebinar(chatId);
    return;
  }

  if (text.startsWith('/partner')) {
    await handlePartner(chatId);
    return;
  }

  if (text.startsWith('/contact')) {
    await handleContact(chatId, update);
    return;
  }

  await handleFreeText(chatId, text, update);
}

export function startConsultantTelegramBot() {
  if (env.NODE_ENV === 'test' || !isConsultantBotReady()) {
    return null;
  }

  poller = createTelegramPoller<ConsultantTelegramUpdate>({
    name: 'ASPБ consultant telegram bot',
    apiUrl: consultantTelegramApiUrl,
    allowedUpdates: ['message'],
    isEnabled: isConsultantBotReady,
    handleUpdate: handleConsultantTelegramUpdate,
    progressSubsystem: 'botConsultant',
  });
  poller.start();
  return poller;
}

export function stopConsultantTelegramBot() {
  poller?.stop();
  poller = null;
}
