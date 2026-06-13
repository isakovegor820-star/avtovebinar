import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { buildFrontendUrl } from './roomLinks.js';
import {
  consultantTelegramApiUrl,
  hasConsultantTelegramBot,
  isConsultantBotPollingEnabled,
  sendConsultantTelegramMessageToChat,
  sendTelegramMessage,
} from './telegram.js';
import { env } from './env.js';
import { createTelegramPoller, type TelegramPoller } from './telegramPoller.js';

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

async function saveConsultantEvent(input: {
  eventName: string;
  chatId: string;
  update: ConsultantTelegramUpdate;
  text?: string;
}) {
  const profile = getTelegramProfile(input.update);
  await prisma.event.create({
    data: {
      eventName: input.eventName,
      page: 'telegram_consultant_bot',
      source: 'telegram',
      metadataJson: {
        chatId: input.chatId,
        text: input.text?.slice(0, 500),
        telegramUserId: profile.telegramUserId,
        telegramUsername: profile.telegramUsername,
        telegramFirstName: profile.telegramFirstName,
      } as Prisma.InputJsonValue,
    },
  });
}

function buildContactRows(update: ConsultantTelegramUpdate, chatId: string, text: string) {
  const profile = getTelegramProfile(update);
  const username = profile.telegramUsername ? `@${profile.telegramUsername.replace(/^@/, '')}` : '—';
  return [
    'Новое сообщение в Telegram-боте консультанта АСПБ',
    '',
    `Chat ID: ${chatId}`,
    profile.telegramUserId ? `User ID: ${profile.telegramUserId}` : null,
    `Username: ${username}`,
    profile.telegramFirstName ? `Имя в Telegram: ${profile.telegramFirstName}` : null,
    '',
    `Сообщение: ${text}`,
  ].filter(Boolean);
}

async function notifyAdminAboutMessage(chatId: string, text: string, update: ConsultantTelegramUpdate) {
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
    text: buildContactRows(update, chatId, text).join('\n'),
  });
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
  await notifyAdminAboutMessage(chatId, '/contact', update);
  await sendConsultantTelegramMessageToChat(
    chatId,
    'Передал запрос менеджеру АСПБ. Напишите одним сообщением, какой вопрос хотите обсудить: партнерство, клиент с долгами, вебинар или доступ.',
  );
}

async function handleFreeText(chatId: string, text: string, update: ConsultantTelegramUpdate) {
  await saveConsultantEvent({ eventName: 'telegram_consultant_message', chatId, update, text });
  await notifyAdminAboutMessage(chatId, text, update);
  await sendConsultantTelegramMessageToChat(
    chatId,
    [
      'Сообщение получил и передал менеджеру АСПБ.',
      '',
      'Пока менеджер смотрит запрос, можно открыть регистрацию на вебинар:',
      buildFrontendUrl('/crisis_premium/register.html'),
    ].join('\n'),
  );
}

async function handleUpdate(update: ConsultantTelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = message?.text?.trim() || '';
  if (!chatId || !text) return;

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
    handleUpdate,
  });
  poller.start();
  return poller;
}

export function stopConsultantTelegramBot() {
  poller?.stop();
  poller = null;
}
