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
import { logger } from './logger.js';
import { createCorrelationId, runWithCorrelation } from './requestContext.js';

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

let nextOffset = 0;
let polling = false;
let interval: NodeJS.Timeout | null = null;

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const response = await fetch(telegramApiUrl('answerCallbackQuery'), {
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

  const [action, value, registrationId] = callback.data.split(':');
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

async function pollOnce() {
  if (polling || !isAdminBotPollingEnabled() || !hasAdminTelegramBot() || !hasConfiguredAdminChatId()) return;
  polling = true;

  try {
    const url = new URL(telegramApiUrl('getUpdates'));
    if (nextOffset) url.searchParams.set('offset', String(nextOffset));
    url.searchParams.set('limit', '20');
    url.searchParams.set('timeout', '0');
    url.searchParams.set('allowed_updates', JSON.stringify(['callback_query']));

    const response = await fetch(url);
    const payload = (await response.json()) as { ok: boolean; result?: AdminTelegramUpdate[]; description?: string };
    if (!payload.ok) {
      throw new Error(payload.description || 'Telegram admin getUpdates failed');
    }

    for (const update of payload.result || []) {
      try {
        await handleCallback(update);
      } catch (error) {
        logger.error({ err: error, updateId: update.update_id }, 'Admin Telegram bot update failed');
      } finally {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      }
    }
  } finally {
    polling = false;
  }
}

function runPollingCycle() {
  return runWithCorrelation(createCorrelationId('telegram_admin_bot'), pollOnce);
}

export function startAdminTelegramBot() {
  if (env.NODE_ENV === 'test' || !isAdminBotPollingEnabled() || !hasAdminTelegramBot() || !hasConfiguredAdminChatId()) {
    return null;
  }

  runPollingCycle().catch(error => logger.error({ err: error }, 'Admin Telegram bot polling failed'));
  interval = setInterval(() => {
    runPollingCycle().catch(error => logger.error({ err: error }, 'Admin Telegram bot polling failed'));
  }, 3500);

  logger.info('Admin Telegram bot callback polling enabled');
  return interval;
}

export function stopAdminTelegramBot() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
