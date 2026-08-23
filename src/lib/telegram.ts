import { ASPB_PARTICIPANT_BOT_USERNAME, env } from './env.js';
import { withCircuitBreaker, withRetries } from './resilience.js';
import { logger } from './logger.js';
import { telegramFetch } from './telegramProxy.js';

type TelegramMessageInput = {
  text: string;
  replyMarkup?: Record<string, unknown>;
};

type TelegramApiPayload = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number | string;
  };
  parameters?: {
    retry_after?: number;
  };
};

type TelegramGetMePayload = TelegramApiPayload & {
  result?: {
    username?: string;
  };
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

export type TelegramSendResult = {
  sent: boolean;
  mode: 'log' | 'send';
  providerMessageId?: string | null;
};

let warnedAboutMissingChat = false;

function adminBotToken() {
  return env.TELEGRAM_ADMIN_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

function participantBotToken() {
  return env.TELEGRAM_PARTICIPANT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

function consultantBotToken() {
  return env.TELEGRAM_CONSULTANT_BOT_TOKEN;
}

function adminBotUsername() {
  return env.TELEGRAM_ADMIN_BOT_USERNAME || env.TELEGRAM_BOT_USERNAME;
}

export function getConfiguredAdminBotUsername() {
  return adminBotUsername();
}

function participantBotUsername() {
  return (
    env.TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME ||
    env.TELEGRAM_PARTICIPANT_BOT_USERNAME ||
    env.TELEGRAM_BOT_USERNAME ||
    ASPB_PARTICIPANT_BOT_USERNAME
  );
}

function consultantBotUsername() {
  return env.TELEGRAM_CONSULTANT_BOT_USERNAME;
}

function shouldLogAdminTelegram() {
  return env.TELEGRAM_NOTIFY_MODE === 'log' || !adminBotToken();
}

function shouldLogParticipantTelegram() {
  return env.TELEGRAM_NOTIFY_MODE === 'log' || !participantBotToken();
}

function shouldLogConsultantTelegram() {
  return env.TELEGRAM_NOTIFY_MODE === 'log' || !consultantBotToken();
}

function maskChatId(value: string) {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function telegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${adminBotToken()}/${method}`;
}

export function participantTelegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${participantBotToken()}/${method}`;
}

export function consultantTelegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${consultantBotToken()}/${method}`;
}

export function hasParticipantTelegramBot() {
  return Boolean(participantBotToken());
}

export function hasAdminTelegramBot() {
  return Boolean(adminBotToken());
}

export function hasConsultantTelegramBot() {
  return Boolean(consultantBotToken());
}

export function getConfiguredAdminChatId() {
  return env.TELEGRAM_ADMIN_CHAT_ID ? String(env.TELEGRAM_ADMIN_CHAT_ID).trim() : '';
}

export function hasConfiguredAdminChatId() {
  return Boolean(getConfiguredAdminChatId());
}

export function isAdminBotPollingEnabled() {
  return env.TELEGRAM_ADMIN_BOT_POLLING === 'on';
}

export function isParticipantBotPollingEnabled() {
  return (
    env.TELEGRAM_PARTICIPANT_BOT_POLLING === 'on' ||
    (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN && env.TELEGRAM_BOT_POLLING === 'on')
  );
}

export function isConsultantBotPollingEnabled() {
  return env.TELEGRAM_CONSULTANT_BOT_POLLING === 'on';
}

export function formatMoscowDate(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function compact(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value.trim() : '—';
}

export async function sendTelegramMessage(input: TelegramMessageInput) {
  const text = input.text.slice(0, 3900);

  if (shouldLogAdminTelegram()) {
    logger.info({ textLength: text.length, hasReplyMarkup: Boolean(input.replyMarkup) }, '[ASPБ telegram log]');
    return { sent: false, mode: 'log' as const };
  }

  const chatId = getConfiguredAdminChatId();
  if (!chatId) {
    if (!warnedAboutMissingChat) {
      logger.warn('[ASPБ telegram] TELEGRAM_ADMIN_CHAT_ID is empty. Admin notifications are disabled.');
      warnedAboutMissingChat = true;
    }
    return { sent: false, mode: 'send' as const, reason: 'missing_chat_id' as const };
  }

  await withCircuitBreaker(
    'telegram.admin',
    () =>
      withRetries(
        'telegram.admin.sendMessage',
        async () => {
          const response = await telegramFetch(telegramApiUrl('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              reply_markup: input.replyMarkup,
              disable_web_page_preview: true,
            }),
          });
          return readTelegramPayload(response);
        },
        {
          attempts: 3,
          baseMs: 1000,
          maxMs: 15_000,
          retryAfterMs: getTelegramRetryAfterMs,
          isRetryable: isTransientTelegramError,
        },
      ),
    { failureThreshold: 3, cooldownMs: 60_000, isFailure: isTransientTelegramError },
  );

  return { sent: true, mode: 'send' as const };
}

export async function sendManagerTelegramMessageToChat(
  chatId: string,
  text: string,
  options: { replyMarkup?: Record<string, unknown>; attempts?: number } = {},
) {
  const message = text.slice(0, 3900);

  if (shouldLogAdminTelegram()) {
    logger.info(
      { chatIdHint: maskChatId(chatId), textLength: message.length, hasReplyMarkup: Boolean(options.replyMarkup) },
      '[ASPБ telegram manager log]',
    );
    return { sent: false, mode: 'log' as const, providerMessageId: null };
  }

  const payload = await withCircuitBreaker(
    'telegram.manager',
    () =>
      withRetries(
        'telegram.manager.sendMessage',
        async () => {
          const response = await telegramFetch(telegramApiUrl('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              reply_markup: options.replyMarkup,
              disable_web_page_preview: true,
            }),
          });
          return readTelegramPayload(response);
        },
        {
          attempts: options.attempts ?? 3,
          baseMs: 1000,
          maxMs: 15_000,
          retryAfterMs: getTelegramRetryAfterMs,
          isRetryable: isTransientTelegramError,
        },
      ),
    { failureThreshold: 3, cooldownMs: 60_000, isFailure: isTransientTelegramError },
  );

  return {
    sent: true,
    mode: 'send' as const,
    providerMessageId: payload.result?.message_id ? String(payload.result.message_id) : null,
  };
}

export async function sendOperationalTelegramAlert(input: {
  code: 'telegram_broadcast_worker_failed';
  subsystem: 'broadcast';
  severity: 'warning' | 'error';
  correlationId: string;
}): Promise<TelegramSendResult & { reason?: 'unconfigured' }> {
  const safeCorrelationId = /^[A-Za-z0-9._:-]{8,128}$/.test(input.correlationId)
    ? input.correlationId
    : 'correlation_unavailable';
  if (shouldLogAdminTelegram()) {
    logger.info(
      {
        alertCode: input.code,
        subsystem: input.subsystem,
        severity: input.severity,
        correlationId: safeCorrelationId,
      },
      '[ASPБ telegram operational log]',
    );
    return { sent: false, mode: 'log', providerMessageId: null };
  }
  const chatId = env.TELEGRAM_OPERATIONAL_CHAT_ID?.trim();
  if (!chatId) {
    logger.error(
      { alertCode: input.code, subsystem: input.subsystem, correlationId: safeCorrelationId },
      '[ASPБ telegram operational] separate operational chat is not configured',
    );
    return { sent: false, mode: 'send', providerMessageId: null, reason: 'unconfigured' };
  }
  const payload = await withCircuitBreaker(
    'telegram.operational',
    () =>
      withRetries(
        'telegram.operational.sendMessage',
        async () => {
          const response = await telegramFetch(telegramApiUrl('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: [
                'Operational alert АСПБ',
                `Severity: ${input.severity}`,
                `Subsystem: ${input.subsystem}`,
                `Code: ${input.code}`,
                `Correlation ID: ${safeCorrelationId}`,
              ].join('\n'),
              disable_web_page_preview: true,
            }),
          });
          return readTelegramPayload(response);
        },
        {
          attempts: 2,
          baseMs: 1000,
          maxMs: 5000,
          retryAfterMs: getTelegramRetryAfterMs,
          isRetryable: isTransientTelegramError,
        },
      ),
    { failureThreshold: 3, cooldownMs: 60_000, isFailure: isTransientTelegramError },
  );
  return {
    sent: true,
    mode: 'send',
    providerMessageId: payload.result?.message_id ? String(payload.result.message_id) : null,
  };
}

// Inline-клавиатура из одной кнопки-ссылки (например «Войти в комнату»).
export function telegramUrlButton(text: string, url: string) {
  return { inline_keyboard: [[{ text, url }]] };
}

export async function sendTelegramMessageToChat(
  chatId: string,
  text: string,
  options: { replyMarkup?: Record<string, unknown>; attempts?: number } = {},
): Promise<TelegramSendResult> {
  const message = text.slice(0, 3900);

  if (shouldLogParticipantTelegram()) {
    logger.info({ chatIdHint: maskChatId(chatId), textLength: message.length }, '[ASPБ telegram participant log]');
    return { sent: false, mode: 'log' as const, providerMessageId: null };
  }

  const payload = await withCircuitBreaker(
    'telegram.participant',
    () =>
      withRetries(
        'telegram.participant.sendMessage',
        async () => {
          const response = await telegramFetch(participantTelegramApiUrl('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              disable_web_page_preview: true,
              // undefined-поля JSON.stringify выкидывает → обратная совместимость со старыми вызовами.
              reply_markup: options.replyMarkup,
            }),
          });
          return readTelegramPayload(response);
        },
        {
          attempts: options.attempts ?? 3,
          baseMs: 1000,
          maxMs: 15_000,
          retryAfterMs: getTelegramRetryAfterMs,
          isRetryable: isTransientTelegramError,
        },
      ),
    { failureThreshold: 3, cooldownMs: 60_000, isFailure: isTransientTelegramError },
  );

  return {
    sent: true,
    mode: 'send' as const,
    providerMessageId: payload.result?.message_id ? String(payload.result.message_id) : null,
  };
}

export async function sendConsultantTelegramMessageToChat(chatId: string, text: string): Promise<TelegramSendResult> {
  const message = text.slice(0, 3900);

  if (shouldLogConsultantTelegram()) {
    logger.info({ chatIdHint: maskChatId(chatId), textLength: message.length }, '[ASPБ telegram consultant log]');
    return { sent: false, mode: 'log' as const, providerMessageId: null };
  }

  const payload = await withCircuitBreaker(
    'telegram.consultant',
    () =>
      withRetries(
        'telegram.consultant.sendMessage',
        async () => {
          const response = await telegramFetch(consultantTelegramApiUrl('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              disable_web_page_preview: true,
            }),
          });
          return readTelegramPayload(response);
        },
        {
          attempts: 3,
          baseMs: 1000,
          maxMs: 15_000,
          retryAfterMs: getTelegramRetryAfterMs,
          isRetryable: isTransientTelegramError,
        },
      ),
    { failureThreshold: 3, cooldownMs: 60_000, isFailure: isTransientTelegramError },
  );

  return {
    sent: true,
    mode: 'send' as const,
    providerMessageId: payload.result?.message_id ? String(payload.result.message_id) : null,
  };
}

export function buildTelegramStartUrl(token?: string) {
  const username = (participantBotUsername() || '').trim();
  if (!username) {
    return undefined;
  }

  const url = new URL(`https://t.me/${username.replace(/^@/, '')}`);
  if (token) {
    url.searchParams.set('start', token);
  }
  return url.toString();
}

export function buildManagerTelegramStartUrl(payload: string) {
  const username = (adminBotUsername() || '').trim();
  if (!username) return undefined;
  const url = new URL(`https://t.me/${username.replace(/^@/, '')}`);
  url.searchParams.set('start', payload);
  return url.toString();
}

// #9 (152/149-ФЗ): осознанное решение — уведомление админам содержит контактные ПДн (телефон/email),
// т.к. менеджеры связываются с лидом прямо из Telegram (исполнение договора / законный интерес).
// Приёмник — приватный админ-чат; трансграничный характер Telegram раскрыт в политике (privacy.html).
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
      `Премьера записи: ${formatMoscowDate(input.scheduledAt)} МСК`,
      '',
      `Админка: ${input.adminUrl}`,
    ].join('\n'),
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
      `Админка: ${input.adminUrl}`,
    ].join('\n'),
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
      `Админка: ${input.adminUrl}`,
    ].join('\n'),
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
    phoneUrl ? { text: 'Позвонить', url: phoneUrl } : null,
  ].filter(Boolean);
  const actionRow = [
    { text: 'Статус: связаться', callback_data: `crm:contacted:${input.registrationId}` },
    { text: 'Горячий лид', callback_data: `hot:${input.registrationId}` },
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
    `Премьера записи: ${formatMoscowDate(input.scheduledAt)} МСК`,
  ].filter(Boolean);

  const telegramRows = [
    `Chat ID: ${input.telegramChatId}`,
    input.telegramUserId ? `User ID: ${input.telegramUserId}` : null,
    input.telegramUsername ? `Username: ${username}` : null,
    input.telegramFirstName ? `Имя в Telegram: ${input.telegramFirstName}` : null,
  ].filter(Boolean);

  return sendTelegramMessage({
    replyMarkup: {
      inline_keyboard: [firstRow, contactRow, actionRow].filter(row => row.length),
    },
    text: [
      input.title ||
        (input.isRebind
          ? 'Участник перепривязал Telegram-уведомления АСПБ'
          : 'Участник подключил Telegram-уведомления АСПБ'),
      '',
      'Данные регистрации:',
      ...registrationRows,
      '',
      'Telegram:',
      ...telegramRows,
      '',
      `Админка: ${input.adminUrl}`,
    ].join('\n'),
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
    input.telegramFirstName ? `Имя в Telegram: ${input.telegramFirstName}` : null,
  ].filter(Boolean);
  const keyboard = [
    [
      telegramUrl ? { text: 'Написать в Telegram', url: telegramUrl } : null,
      { text: 'Открыть регистрацию', url: input.registrationUrl },
    ].filter(Boolean),
  ].filter(row => row.length);

  return sendTelegramMessage({
    replyMarkup: { inline_keyboard: keyboard },
    text: [
      'Пользователь открыл бота уведомлений АСПБ без привязанной регистрации',
      '',
      'Telegram:',
      ...telegramRows,
      '',
      'Заявка на сайте пока не найдена. Если это будущий участник, ему отправлена ссылка на регистрацию.',
    ].join('\n'),
  });
}

export async function getTelegramBotInfo() {
  if (!adminBotToken()) {
    return null;
  }

  const response = await telegramFetch(telegramApiUrl('getMe'));
  return response.json();
}

function normalizeTelegramUsername(value?: string | null) {
  return value?.trim().replace(/^@/, '').toLowerCase() || '';
}

function assertTelegramUsernameMatches(kind: string, actual?: string, expected?: string) {
  const normalizedExpected = normalizeTelegramUsername(expected);
  if (!normalizedExpected) return;

  const normalizedActual = normalizeTelegramUsername(actual);
  if (normalizedActual !== normalizedExpected) {
    throw new Error(
      `Telegram ${kind} username mismatch: ${kind} token returned @${normalizedActual || 'unknown'}, expected @${normalizedExpected}`,
    );
  }
}

function getTelegramRetryAfterMs(error: unknown) {
  if (!(error instanceof Error)) {
    return null;
  }

  const retryAfter = (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds;
  return retryAfter && retryAfter > 0 ? retryAfter * 1000 : null;
}

type TelegramErrorMeta = Error & {
  retryAfterSeconds?: number;
  telegramStatus?: number;
  telegramErrorCode?: number;
};

// Постоянные ошибки конкретного получателя/запроса (повтор бессмыслен): заблокировал бота,
// удалён, чат не найден, невалидный chat_id и т.п. 429/5xx/сеть/таймаут — временные.
const PERMANENT_TELEGRAM_ERROR =
  /blocked|deactivated|kicked|chat not found|user not found|peer_id_invalid|chat_id is empty|initiate conversation|not a member|have no rights|chat was upgraded|group chat was deleted/i;

export function isPermanentTelegramError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const meta = error as TelegramErrorMeta;
  if (meta.retryAfterSeconds && meta.retryAfterSeconds > 0) {
    return false; // 429 — временная
  }
  if (typeof meta.telegramStatus === 'number') {
    if (meta.telegramStatus >= 500 || meta.telegramStatus === 429) {
      return false; // серверные/лимит — временные
    }
    // 4xx считаем постоянной ТОЛЬКО для настоящего ответа Telegram (в теле есть error_code).
    // Не-JSON 4xx от прокси/WARP (error_code отсутствует) — временная, имеет смысл повторить.
    if (meta.telegramStatus >= 400 && meta.telegramErrorCode !== undefined) {
      return true;
    }
  }
  return PERMANENT_TELEGRAM_ERROR.test(meta.message);
}

// Для retry/circuit-breaker: повторяем и считаем сбоем только временные ошибки.
function isTransientTelegramError(error: unknown): boolean {
  return !isPermanentTelegramError(error);
}

// Безопасное чтение ответа Telegram: не-JSON тело (например HTML 5xx от прокси/WARP) не валит
// процесс SyntaxError'ом, а превращается в осмысленную ошибку с HTTP-статусом.
async function readTelegramPayload(response: Response): Promise<TelegramApiPayload> {
  let payload: (TelegramApiPayload & { error_code?: number }) | null;
  try {
    payload = (await response.json()) as TelegramApiPayload & { error_code?: number };
  } catch {
    payload = null;
  }
  if (payload?.ok) {
    return payload;
  }
  throw Object.assign(new Error(payload?.description || `Telegram HTTP ${response.status}`), {
    retryAfterSeconds: payload?.parameters?.retry_after,
    telegramStatus: response.status,
    telegramErrorCode: payload?.error_code,
  });
}

export async function checkTelegramConnectivity() {
  const hasActiveTelegramRuntime =
    env.TELEGRAM_NOTIFY_MODE === 'send' ||
    isAdminBotPollingEnabled() ||
    isParticipantBotPollingEnabled() ||
    isConsultantBotPollingEnabled();
  if (!hasActiveTelegramRuntime) {
    return { ok: true, mode: 'log' as const };
  }

  const checks: Array<{
    kind: 'admin bot' | 'participant bot' | 'consultant bot';
    expectedUsername?: string;
    request: Promise<Response>;
  }> = [];
  if (hasAdminTelegramBot()) {
    checks.push({
      kind: 'admin bot',
      expectedUsername: adminBotUsername(),
      request: withCircuitBreaker('telegram.admin', () => telegramFetch(telegramApiUrl('getMe'))),
    });
  }
  if (hasParticipantTelegramBot()) {
    checks.push({
      kind: 'participant bot',
      expectedUsername: participantBotUsername(),
      request: withCircuitBreaker('telegram.participant', () => telegramFetch(participantTelegramApiUrl('getMe'))),
    });
  }
  if (hasConsultantTelegramBot()) {
    checks.push({
      kind: 'consultant bot',
      expectedUsername: consultantBotUsername(),
      request: withCircuitBreaker('telegram.consultant', () => telegramFetch(consultantTelegramApiUrl('getMe'))),
    });
  }

  const responses = await Promise.all(checks.map(check => check.request));
  const bots: Record<string, { username: string | null }> = {};
  for (const [index, response] of responses.entries()) {
    const check = checks[index];
    const payload = (await response.json()) as TelegramGetMePayload;
    if (!payload.ok) {
      throw new Error(payload.description || 'Telegram getMe failed');
    }
    assertTelegramUsernameMatches(check.kind, payload.result?.username, check.expectedUsername);
    bots[check.kind.replace(' bot', '')] = { username: payload.result?.username ?? null };
  }

  return { ok: true, mode: env.TELEGRAM_NOTIFY_MODE as 'send' | 'log', bots };
}
