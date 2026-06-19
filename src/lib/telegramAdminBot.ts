import { prisma } from './prisma.js';
import { env } from './env.js';
import { CRM_STATUS_LABELS } from './crm.js';
import {
  getConfiguredAdminChatId,
  hasAdminTelegramBot,
  hasConfiguredAdminChatId,
  isAdminBotPollingEnabled,
  sendTelegramMessage,
  telegramApiUrl,
} from './telegram.js';
import { telegramFetch } from './telegramProxy.js';
import { createTelegramPoller, type TelegramPoller } from './telegramPoller.js';

type AdminTelegramUpdate = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      chat?: { id?: number | string };
    };
    from?: { id?: number | string; username?: string };
  };
};

let poller: TelegramPoller | null = null;

function isAdminBotReady() {
  return isAdminBotPollingEnabled() && hasAdminTelegramBot() && hasConfiguredAdminChatId();
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const response = await telegramFetch(telegramApiUrl('answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }),
  });
  const payload = (await response.json()) as { ok: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || 'Telegram answerCallbackQuery failed');
  }
}

async function handleCallback(update: AdminTelegramUpdate) {
  const callback = update.callback_query;
  if (!callback?.id || !callback.data) return;

  const adminChatId = getConfiguredAdminChatId();
  const callbackChatId = callback.message?.chat?.id ? String(callback.message.chat.id) : '';
  if (!adminChatId) {
    await answerCallbackQuery(callback.id, 'Админ-чат не настроен');
    return;
  }

  if (callbackChatId !== adminChatId) {
    await answerCallbackQuery(callback.id, 'Нет доступа к действию');
    return;
  }

  const [action, value, explicitRegistrationId] = callback.data.split(':');
  const registrationId = explicitRegistrationId || (action === 'hot' ? value : undefined);
  if (!registrationId) {
    await answerCallbackQuery(callback.id, 'Не хватает ID регистрации');
    return;
  }

  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { lead: true },
  });

  if (!registration) {
    await answerCallbackQuery(callback.id, 'Регистрация не найдена');
    return;
  }

  if (action === 'crm') {
    await prisma.registration.update({
      where: { id: registrationId },
      data: { crmStatus: value || 'contacted' },
    });
    await answerCallbackQuery(
      callback.id,
      `Статус: ${CRM_STATUS_LABELS[value as keyof typeof CRM_STATUS_LABELS] || value}`,
    );
    await sendTelegramMessage({
      text: [
        'CRM-статус обновлен',
        '',
        `Участник: ${registration.lead.name}`,
        `Статус: ${CRM_STATUS_LABELS[value as keyof typeof CRM_STATUS_LABELS] || value}`,
        `Админка: ${env.PUBLIC_SITE_URL}/admin?registration=${registrationId}`,
      ].join('\n'),
    });
    return;
  }

  if (action === 'hot') {
    await prisma.registration.update({
      where: { id: registrationId },
      data: { isHot: true },
    });
    await answerCallbackQuery(callback.id, 'Помечен как горячий лид');
    await sendTelegramMessage({
      text: [
        'Горячий лид отмечен',
        '',
        `Участник: ${registration.lead.name}`,
        `Телефон: ${registration.lead.phone}`,
        `Email: ${registration.lead.email}`,
        `Админка: ${env.PUBLIC_SITE_URL}/admin?registration=${registrationId}`,
      ].join('\n'),
    });
    return;
  }

  await answerCallbackQuery(callback.id, 'Неизвестное действие');
}

export function startAdminTelegramBot() {
  if (env.NODE_ENV === 'test' || !isAdminBotReady()) {
    return null;
  }

  poller = createTelegramPoller<AdminTelegramUpdate>({
    name: 'ASPБ admin telegram bot',
    apiUrl: telegramApiUrl,
    allowedUpdates: ['callback_query'],
    isEnabled: isAdminBotReady,
    handleUpdate: handleCallback,
  });
  poller.start();
  return poller;
}

export function stopAdminTelegramBot() {
  poller?.stop();
  poller = null;
}
