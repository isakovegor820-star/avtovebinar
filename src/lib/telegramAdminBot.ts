import { prisma } from './prisma.js';
import { env } from './env.js';
import { CRM_STATUS_LABELS } from './crm.js';
import {
  getConfiguredAdminChatId,
  hasAdminTelegramBot,
  hasConfiguredAdminChatId,
  isAdminBotPollingEnabled,
  sendTelegramMessage,
  sendManagerTelegramMessageToChat,
  telegramApiUrl,
} from './telegram.js';
import { telegramFetch } from './telegramProxy.js';
import { createTelegramPoller, type TelegramPoller } from './telegramPoller.js';
import {
  claimTelegramManagerBinding,
  executeTelegramManagerCallback,
  recordTelegramManagerOutboundEvent,
} from './tenancy/telegramBots.js';
import { createCorrelationId } from './requestContext.js';

type AdminTelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
  };
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
  return (
    isAdminBotPollingEnabled() &&
    hasAdminTelegramBot() &&
    (hasConfiguredAdminChatId() || env.TENANT_TELEGRAM_BOTS_ENABLED === 'on')
  );
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  if (env.TELEGRAM_NOTIFY_MODE === 'log') return;
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

  const callbackChatId = callback.message?.chat?.id ? String(callback.message.chat.id) : '';
  if (callback.data.startsWith('tm1:')) {
    const result = await executeTelegramManagerCallback(prisma, {
      callbackData: callback.data,
      chatId: callbackChatId,
      providerCallbackId: callback.id,
    });
    await answerCallbackQuery(callback.id, result.message);
    return;
  }

  const adminChatId = getConfiguredAdminChatId();
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

async function handleManagerStart(update: AdminTelegramUpdate) {
  const message = update.message;
  if (!message) return;
  const chatId = message?.chat?.id ? String(message.chat.id) : '';
  const text = message?.text?.trim() || '';
  if (!chatId || !text.startsWith('/start mgr_')) return;
  if (message?.chat?.type && message.chat.type !== 'private') return;
  const startPayload = text.split(/\s+/)[1]?.trim();
  if (!startPayload) return;
  const correlationId = createCorrelationId('telegram_manager_start');
  const claimed = await claimTelegramManagerBinding(prisma, {
    startPayload,
    chatId,
    providerMessageId: String(message.message_id),
    correlationId,
  });
  if (!claimed) {
    await sendManagerTelegramMessageToChat(
      chatId,
      'Привязка недоступна или срок ссылки истёк. Попросите владельца организации создать новую ссылку.',
    );
    return;
  }
  const delivery = await sendManagerTelegramMessageToChat(
    chatId,
    'Чат найден. Теперь владелец организации должен подтвердить привязку в кабинете. До подтверждения CRM-кнопки не работают.',
  );
  await recordTelegramManagerOutboundEvent(prisma, {
    organizationId: claimed.organizationId,
    membershipId: claimed.membershipId,
    bindingId: claimed.bindingId,
    correlationId: claimed.correlationId,
    providerMessageId: delivery.providerMessageId,
    eventType: 'manager_binding_claim_acknowledged',
    status: delivery.sent ? 'sent' : 'logged',
  });
}

async function handleUpdate(update: AdminTelegramUpdate) {
  if (update.callback_query) {
    await handleCallback(update);
    return;
  }
  if (env.TENANT_TELEGRAM_BOTS_ENABLED === 'on' && update.message) {
    await handleManagerStart(update);
  }
}

export function startAdminTelegramBot() {
  if (env.NODE_ENV === 'test' || !isAdminBotReady()) {
    return null;
  }

  poller = createTelegramPoller<AdminTelegramUpdate>({
    name: 'ASPБ admin telegram bot',
    apiUrl: telegramApiUrl,
    allowedUpdates: ['message', 'callback_query'],
    isEnabled: isAdminBotReady,
    handleUpdate,
    progressSubsystem: 'botAdmin',
  });
  poller.start();
  return poller;
}

export { handleUpdate as handleAdminTelegramUpdate };

export function stopAdminTelegramBot() {
  poller?.stop();
  poller = null;
}
