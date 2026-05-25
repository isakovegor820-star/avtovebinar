import { env } from './env.js';

type TelegramMessageInput = {
  text: string;
  replyMarkup?: Record<string, unknown>;
};

type NotifyRegistrationInput = {
  name: string;
  phone: string;
  email: string;
  city?: string | null;
  professionalStatus?: string | null;
  scheduledAt: Date;
  source?: string | null;
  adminUrl: string;
};

type NotifyQuestionInput = {
  name: string;
  email: string;
  phone: string;
  text: string;
  adminUrl: string;
};

type NotifyPartnerApplicationInput = {
  name: string;
  email: string;
  phone: string;
  sphere?: string | null;
  city?: string | null;
  clientFlow?: string | null;
  preferredFormat?: string | null;
  comment?: string | null;
  adminUrl: string;
};

type NotifyTelegramSubscriptionInput = {
  title?: string;
  name: string;
  phone: string;
  email: string;
  city?: string | null;
  professionalStatus?: string | null;
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  scheduledAt: Date;
  registeredAt: Date;
  telegramChatId: string;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  telegramFirstName?: string | null;
  registrationId: string;
  isRebind?: boolean;
  adminUrl: string;
};

type NotifyTelegramBotStartInput = {
  telegramChatId: string;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  telegramFirstName?: string | null;
  registrationUrl: string;
};

let cachedAdminChatId = env.TELEGRAM_ADMIN_CHAT_ID || '';
let warnedAboutMissingChat = false;

function adminBotToken() {
  return env.TELEGRAM_ADMIN_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

function participantBotToken() {
  return env.TELEGRAM_PARTICIPANT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

function shouldLogAdminTelegram() {
  return env.TELEGRAM_NOTIFY_MODE === 'log' || !adminBotToken();
}

function shouldLogParticipantTelegram() {
  return env.TELEGRAM_NOTIFY_MODE === 'log' || !participantBotToken();
}

export function telegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${adminBotToken()}/${method}`;
}

export function participantTelegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${participantBotToken()}/${method}`;
}

export function hasParticipantTelegramBot() {
  return Boolean(participantBotToken());
}

export function hasAdminTelegramBot() {
  return Boolean(adminBotToken());
}

export function isAdminBotPollingEnabled() {
  return env.TELEGRAM_ADMIN_BOT_POLLING === 'on';
}

export function isParticipantBotPollingEnabled() {
  return env.TELEGRAM_PARTICIPANT_BOT_POLLING === 'on' || (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN && env.TELEGRAM_BOT_POLLING === 'on');
}

export function formatMoscowDate(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

export function compact(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value.trim() : '—';
}

async function discoverAdminChatId() {
  if (cachedAdminChatId || !adminBotToken()) {
    return cachedAdminChatId;
  }

  const response = await fetch(telegramApiUrl('getUpdates?limit=20'));
  const payload = (await response.json()) as {
    ok: boolean;
    result?: Array<{ message?: { chat?: { id?: number | string; type?: string } } }>;
  };

  if (!payload.ok || !payload.result?.length) {
    return '';
  }

  const updateWithChat = [...payload.result].reverse().find(update => update.message?.chat?.id);
  cachedAdminChatId = updateWithChat?.message?.chat?.id ? String(updateWithChat.message.chat.id) : '';
  return cachedAdminChatId;
}

export async function sendTelegramMessage(input: TelegramMessageInput) {
  const text = input.text.slice(0, 3900);

  if (shouldLogAdminTelegram()) {
    console.log('[ASPБ telegram log]', { text });
    return { sent: false, mode: 'log' as const };
  }

  const chatId = await discoverAdminChatId();
  if (!chatId) {
    if (!warnedAboutMissingChat) {
      console.warn('[ASPБ telegram] ADMIN_CHAT_ID is empty. Send any message to the bot, then trigger a new event.');
      warnedAboutMissingChat = true;
    }
    return { sent: false, mode: 'send' as const, reason: 'missing_chat_id' as const };
  }

  const response = await fetch(telegramApiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: input.replyMarkup,
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json()) as { ok: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || 'Telegram sendMessage failed');
  }

  return { sent: true, mode: 'send' as const };
}

export async function sendTelegramMessageToChat(chatId: string, text: string) {
  const message = text.slice(0, 3900);

  if (shouldLogParticipantTelegram()) {
    console.log('[ASPБ telegram participant log]', { chatId, text: message });
    return { sent: false, mode: 'log' as const };
  }

  const response = await fetch(participantTelegramApiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json()) as { ok: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || 'Telegram sendMessage failed');
  }

  return { sent: true, mode: 'send' as const };
}

export function buildTelegramStartUrl(token?: string) {
  const username = (env.TELEGRAM_PARTICIPANT_BOT_USERNAME || env.TELEGRAM_BOT_USERNAME).trim();
  if (!username) {
    return env.TELEGRAM_GROUP_URL;
  }

  const url = new URL(`https://t.me/${username.replace(/^@/, '')}`);
  if (token) {
    url.searchParams.set('start', token);
  }
  return url.toString();
}

export function notifyRegistration(input: NotifyRegistrationInput) {
  return sendTelegramMessage({
    text: [
      'Новая регистрация на вебинар АСПБ',
      '',
      `Имя: ${input.name}`,
      `Телефон: ${input.phone}`,
      `Email: ${input.email}`,
      `Город: ${compact(input.city)}`,
      `Статус: ${compact(input.professionalStatus)}`,
      `Источник: ${compact(input.source)}`,
      `Эфир: ${formatMoscowDate(input.scheduledAt)} МСК`,
      '',
      `Админка: ${input.adminUrl}`
    ].join('\n')
  });
}

export function notifyQuestion(input: NotifyQuestionInput) {
  return sendTelegramMessage({
    text: [
      'Новый вопрос в вебинарной комнате',
      '',
      'Данные участника:',
      `Участник: ${input.name}`,
      `Телефон: ${input.phone}`,
      `Email: ${input.email}`,
      '',
      `Вопрос в чате: ${input.text.trim()}`,
      '',
      `Админка: ${input.adminUrl}`
    ].join('\n')
  });
}

export function notifyPartnerApplication(input: NotifyPartnerApplicationInput) {
  return sendTelegramMessage({
    text: [
      'Заявка на партнерский договор АСПБ',
      '',
      `Имя: ${input.name}`,
      `Телефон: ${input.phone}`,
      `Email: ${input.email}`,
      `Город: ${compact(input.city)}`,
      `Сфера: ${compact(input.sphere)}`,
      `Поток клиентов: ${compact(input.clientFlow)}`,
      `Формат: ${compact(input.preferredFormat)}`,
      '',
      `Комментарий: ${compact(input.comment)}`,
      '',
      `Админка: ${input.adminUrl}`
    ].join('\n')
  });
}

export function notifyTelegramSubscription(input: NotifyTelegramSubscriptionInput) {
  const username = input.telegramUsername ? `@${input.telegramUsername.replace(/^@/, '')}` : '—';
  const adminCardUrl = `${input.adminUrl}?registration=${encodeURIComponent(input.registrationId)}`;
  const telegramUrl = input.telegramUsername
    ? `https://t.me/${input.telegramUsername.replace(/^@/, '')}`
    : input.telegramUserId
      ? `tg://user?id=${encodeURIComponent(input.telegramUserId)}`
      : undefined;
  const phoneUrl = input.phone ? `tel:${input.phone.replace(/[^\d+]/g, '')}` : undefined;
  const firstRow = [{ text: 'Открыть карточку', url: adminCardUrl }];
  const contactRow = [
    telegramUrl ? { text: 'Написать в Telegram', url: telegramUrl } : null,
    phoneUrl ? { text: 'Позвонить', url: phoneUrl } : null
  ].filter(Boolean);
  const actionRow = [
    { text: 'Статус: связаться', callback_data: `crm:contacted:${input.registrationId}` },
    { text: 'Горячий лид', callback_data: `hot:${input.registrationId}` }
  ];
  const registrationRows = [
    `Имя: ${input.name}`,
    `Телефон: ${input.phone}`,
    `Email: ${input.email}`,
    input.professionalStatus ? `Статус: ${input.professionalStatus}` : null,
    input.source ? `Источник: ${input.source}` : null,
    input.utmSource ? `UTM source: ${input.utmSource}` : null,
    input.utmMedium ? `UTM medium: ${input.utmMedium}` : null,
    input.utmCampaign ? `UTM campaign: ${input.utmCampaign}` : null,
    `Регистрация: ${formatMoscowDate(input.registeredAt)} МСК`,
    `Эфир: ${formatMoscowDate(input.scheduledAt)} МСК`
  ].filter(Boolean);

  const telegramRows = [
    `Chat ID: ${input.telegramChatId}`,
    input.telegramUserId ? `User ID: ${input.telegramUserId}` : null,
    input.telegramUsername ? `Username: ${username}` : null,
    input.telegramFirstName ? `Имя в Telegram: ${input.telegramFirstName}` : null
  ].filter(Boolean);

  return sendTelegramMessage({
    replyMarkup: {
      inline_keyboard: [firstRow, contactRow, actionRow].filter(row => row.length)
    },
    text: [
      input.title || (input.isRebind ? 'Участник перепривязал Telegram-уведомления АСПБ' : 'Участник подключил Telegram-уведомления АСПБ'),
      '',
      'Данные регистрации:',
      ...registrationRows,
      '',
      'Telegram:',
      ...telegramRows,
      '',
      `Админка: ${input.adminUrl}`
    ].join('\n')
  });
}

export function notifyTelegramBotStart(input: NotifyTelegramBotStartInput) {
  const username = input.telegramUsername ? `@${input.telegramUsername.replace(/^@/, '')}` : null;
  const telegramUrl = input.telegramUsername
    ? `https://t.me/${input.telegramUsername.replace(/^@/, '')}`
    : input.telegramUserId
      ? `tg://user?id=${encodeURIComponent(input.telegramUserId)}`
      : undefined;
  const telegramRows = [
    `Chat ID: ${input.telegramChatId}`,
    input.telegramUserId ? `User ID: ${input.telegramUserId}` : null,
    username ? `Username: ${username}` : null,
    input.telegramFirstName ? `Имя в Telegram: ${input.telegramFirstName}` : null
  ].filter(Boolean);
  const keyboard = [
    [
      telegramUrl ? { text: 'Написать в Telegram', url: telegramUrl } : null,
      { text: 'Открыть регистрацию', url: input.registrationUrl }
    ].filter(Boolean)
  ].filter(row => row.length);

  return sendTelegramMessage({
    replyMarkup: { inline_keyboard: keyboard },
    text: [
      'Пользователь открыл бота уведомлений АСПБ без привязанной регистрации',
      '',
      'Telegram:',
      ...telegramRows,
      '',
      'Заявка на сайте пока не найдена. Если это будущий участник, ему отправлена ссылка на регистрацию.'
    ].join('\n')
  });
}

export async function getTelegramBotInfo() {
  if (!adminBotToken()) {
    return null;
  }

  const response = await fetch(telegramApiUrl('getMe'));
  return response.json();
}
