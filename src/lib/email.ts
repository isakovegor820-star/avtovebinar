import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env.js';
import { withCircuitBreaker, withRetries } from './resilience.js';
import { logger } from './logger.js';
import { buildTelegramStartUrl } from './telegram.js';
import { buildUnsubscribeUrl } from './unsubscribe.js';

type BaseEmailInput = {
  to: string;
  name: string;
  scheduledAt: Date;
  webinarUrl: string;
  partnerUrl?: string;
  timezone?: string;
};

type PasswordlessLoginEmailInput = {
  to: string;
  displayName?: string | null;
  loginUrl: string;
  expiresInMinutes: number;
};

type OrganizationInvitationEmailInput = {
  to: string;
  organizationName: string;
  roleLabel: string;
  invitationUrl: string;
  expiresInDays: number;
};

type WebinarAccessInvitationEmailInput = {
  to: string;
  organizationName: string;
  webinarTitle: string;
  invitationUrl: string;
  expiresAt: Date;
};

type SessionChangeEmailInput = BaseEmailInput & {
  kind: 'rescheduled' | 'cancelled';
  timezone: string;
  webinarTitle: string;
};

export type ReminderKind = '24h' | '3h' | '30m';
export const SMTP_OPERATION_TIMEOUT_MS = 25_000;
// The durable outbox owns retries. Retrying sendMail inside one claimed job
// makes an ambiguous timeout capable of delivering the same message twice and
// unnecessarily extends the Lead erasure fence.
export const SMTP_SEND_ATTEMPTS = 1;
export const SMTP_DELIVERY_BUDGET_MS = SMTP_OPERATION_TIMEOUT_MS * SMTP_SEND_ATTEMPTS + 5_000;

// Синглтон-транспортер с пулом соединений — переиспользуется между письмами,
// чтобы не открывать новое TLS-соединение на каждую отправку.
let cachedTransporter: Transporter | null = null;

function getTransporter() {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    // 465 = implicit TLS; остальные порты (587 и пр.) используют STARTTLS,
    // requireTLS гарантирует, что соединение не останется незашифрованным.
    secure: (env.SMTP_PORT ?? 587) === 465,
    requireTLS: (env.SMTP_PORT ?? 587) !== 465,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return cachedTransporter;
}

async function withSmtpOperationTimeout<T>(transporter: Transporter, operation: () => Promise<T>) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          if (cachedTransporter === transporter) cachedTransporter = null;
          try {
            transporter.close();
          } catch (error) {
            logger.warn({ err: error }, 'Failed to close timed-out SMTP transporter');
          } finally {
            reject(new Error(`SMTP operation exceeded ${SMTP_OPERATION_TIMEOUT_MS}ms`));
          }
        }, SMTP_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function shouldLogEmail() {
  return env.EMAIL_MODE === 'log' || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS;
}

function maskEmail(_value: string) {
  // Even a partially masked address remains personal data and should not be
  // present in routine application logs.
  return '[redacted-email]';
}

function formatScheduled(date: Date, timezone = 'Europe/Moscow') {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function timezoneDateKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysKey(dateKey: string, days: number, timezone: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return timezoneDateKey(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)), timezone);
}

function timezoneLabel(timezone: string) {
  return timezone === 'Europe/Moscow' ? 'МСК' : timezone;
}

function formatRelativeScheduled(date: Date, timezone: string, now = new Date()) {
  const scheduledKey = timezoneDateKey(date, timezone);
  const todayKey = timezoneDateKey(now, timezone);
  const day =
    scheduledKey === todayKey
      ? 'сегодня'
      : scheduledKey === addDaysKey(todayKey, 1, timezone)
        ? 'завтра'
        : new Intl.DateTimeFormat('ru-RU', {
            timeZone: timezone,
            day: '2-digit',
            month: 'long',
          }).format(date);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${day} в ${time} (${timezoneLabel(timezone)})`;
}

function buildEmailText(input: BaseEmailInput, intro: string) {
  const timezone = input.timezone ?? 'Europe/Moscow';
  const scheduled = formatScheduled(input.scheduledAt, timezone);
  const telegramUrl = buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL;

  return [
    `${input.name}, ${intro}`,
    '',
    'Тема: Экономика кризиса: как бухгалтеру и юристу развиваться в условиях нестабильности',
    `Начало: ${scheduled} (${timezoneLabel(timezone)})`,
    `Ваша персональная ссылка на комнату: ${input.webinarUrl}`,
    `Telegram-уведомления: ${telegramUrl}`,
    input.partnerUrl ? `Заявка на партнерский договор: ${input.partnerUrl}` : '',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverEmail(input: {
  to: string;
  subject: string;
  text: string;
  scheduledAt?: Date;
  webinarUrl?: string;
  partnerUrl?: string;
  includeUnsubscribe?: boolean;
  redactSubjectInLogs?: boolean;
}) {
  const scheduled = input.scheduledAt ? formatScheduled(input.scheduledAt) : undefined;

  if (shouldLogEmail()) {
    logger.info(
      {
        to: maskEmail(input.to),
        subject: input.redactSubjectInLogs ? '[redacted-custom-subject]' : input.subject,
        scheduled,
        personalUrl: input.webinarUrl ? '[redacted-personal-link]' : null,
        telegramConfigured: Boolean(env.TELEGRAM_GROUP_URL),
        partnerUrl: input.partnerUrl ? '[redacted-personal-link]' : null,
      },
      '[ASPБ email log]',
    );
    return { sent: false, mode: 'log' as const };
  }

  const unsubscribeUrl = input.includeUnsubscribe === false ? null : await buildUnsubscribeUrl(input.to);
  const unsubscribeMailto = `mailto:${env.EMAIL_REPLY_TO ?? env.EMAIL_FROM}?subject=unsubscribe`;
  const messageText = unsubscribeUrl ? `${input.text}\n\nОтписаться от рассылок: ${unsubscribeUrl}` : input.text;

  await withCircuitBreaker(
    'smtp',
    () =>
      withRetries(
        'smtp.sendMail',
        () => {
          // A timed-out attempt closes and evicts its pooled transporter. Resolve
          // it per attempt so the retry opens a fresh connection instead of
          // reusing the closed pool.
          const transporter = getTransporter();
          return withSmtpOperationTimeout(transporter, () =>
            transporter.sendMail({
              from: env.EMAIL_FROM,
              replyTo: env.EMAIL_REPLY_TO,
              to: input.to,
              subject: input.subject,
              text: messageText,
              headers:
                input.includeUnsubscribe === false
                  ? undefined
                  : {
                      // 152-ФЗ/38-ФЗ: возможность отписки в каждом маркетинговом письме.
                      'List-Unsubscribe': unsubscribeUrl
                        ? `<${unsubscribeUrl}>, <${unsubscribeMailto}>`
                        : `<${unsubscribeMailto}>`,
                    },
            }),
          );
        },
        { attempts: SMTP_SEND_ATTEMPTS, baseMs: 1000, maxMs: 5_000 },
      ),
    { failureThreshold: 3, cooldownMs: 60_000 },
  );

  return { sent: true, mode: 'send' as const };
}

export async function sendCrmMarketingEmail(input: { to: string; subject: string; text: string }) {
  return deliverEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    redactSubjectInLogs: true,
  });
}

export async function sendUserPasswordlessLoginEmail(input: PasswordlessLoginEmailInput) {
  const subject = 'Вход в платформу АСПБ';
  const greeting = input.displayName?.trim() ? `${input.displayName.trim()},` : 'Здравствуйте,';
  const text = [
    greeting,
    '',
    'Откройте ссылку, чтобы войти в платформу юридических вебинаров АСПБ:',
    input.loginUrl,
    '',
    `Ссылка действует ${input.expiresInMinutes} минут и только один раз.`,
    'Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');

  return deliverEmail({
    to: input.to,
    subject,
    text,
    webinarUrl: input.loginUrl,
    includeUnsubscribe: false,
  });
}

export async function sendOrganizationInvitationEmail(input: OrganizationInvitationEmailInput) {
  const subject = `Приглашение в ${input.organizationName}`;
  const text = [
    'Здравствуйте,',
    '',
    `Вас пригласили в организацию «${input.organizationName}» на платформе АСПБ.`,
    `Роль: ${input.roleLabel}.`,
    `Принять приглашение: ${input.invitationUrl}`,
    '',
    `Ссылка действует ${input.expiresInDays} дней и только один раз.`,
    'Если вы не ожидали приглашение, просто проигнорируйте это письмо.',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');
  return deliverEmail({
    to: input.to,
    subject,
    text,
    webinarUrl: input.invitationUrl,
    includeUnsubscribe: false,
  });
}

export async function sendWebinarAccessInvitationEmail(input: WebinarAccessInvitationEmailInput) {
  const expires = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(input.expiresAt);
  const subject = `Приглашение на закрытый вебинар «${input.webinarTitle}»`;
  const text = [
    'Здравствуйте,',
    '',
    `Организация «${input.organizationName}» пригласила вас на закрытый вебинар:`,
    input.webinarTitle,
    `Принять приглашение: ${input.invitationUrl}`,
    '',
    `Доступ действует до ${expires} (МСК); ссылка принятия одноразовая.`,
    'Войдите с тем же email, на который получено пиглашение.',
    'Если вы не ожидали приглашение, просто проигнорируйте это письмо.',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');
  return deliverEmail({
    to: input.to,
    subject,
    text,
    webinarUrl: input.invitationUrl,
    includeUnsubscribe: false,
  });
}

export async function sendAuthorReviewDueEmail(input: {
  to: string;
  displayName?: string | null;
  webinarTitle: string;
  reviewUrl: string;
  dueAt: Date;
}) {
  const dueAt = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(input.dueAt);
  const subject = `Проверьте актуальность вебинара «${input.webinarTitle}»`;
  const greeting = input.displayName?.trim() ? `${input.displayName.trim()},` : 'Здравствуйте,';
  const text = [
    greeting,
    '',
    `Наступил срок проверки актуальности вебинара «${input.webinarTitle}» (${dueAt}).`,
    'Вебинар продолжает быть опубликованным: текст и доступ для участников автоматически не изменялись.',
    `Открыть проверку: ${input.reviewUrl}`,
    '',
    'Это сервисное уведомление для автора.',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');

  return deliverEmail({
    to: input.to,
    subject,
    text,
    webinarUrl: input.reviewUrl,
    includeUnsubscribe: false,
  });
}

export async function verifyEmailConnectivity() {
  if (shouldLogEmail()) {
    return { ok: true, mode: 'log' as const };
  }

  const transporter = getTransporter();
  await withCircuitBreaker('smtp', () => withSmtpOperationTimeout(transporter, () => transporter.verify()), {
    failureThreshold: 3,
    cooldownMs: 60_000,
  });
  return { ok: true, mode: 'send' as const };
}

export async function sendRegistrationEmail(input: BaseEmailInput) {
  const subject = 'Вы зарегистрированы на вебинар АСПБ';
  const text = buildEmailText(input, 'вы зарегистрированы на вебинар АСПБ.');

  return deliverEmail({ ...input, subject, text });
}

export async function sendParticipantLoginEmail(input: BaseEmailInput) {
  const subject = 'Ваша ссылка для входа в Мой доступ АСПБ';
  const timezone = input.timezone ?? 'Europe/Moscow';
  const scheduled = formatScheduled(input.scheduledAt, timezone);
  const text = [
    `${input.name}, вы запросили вход в Мой доступ АСПБ.`,
    '',
    'Откройте одноразовую ссылку, чтобы восстановить доступ на этом устройстве:',
    input.webinarUrl,
    '',
    `Ближайший вебинар: ${scheduled} (${timezoneLabel(timezone)})`,
    'Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');

  return deliverEmail({ ...input, subject, text });
}

export async function sendReminderEmail(input: BaseEmailInput & { kind: ReminderKind }) {
  const timezone = input.timezone ?? 'Europe/Moscow';
  const scheduled = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(input.scheduledAt);

  const labelByKind: Record<ReminderKind, string> = {
    '24h': `премьера записи начнётся ${formatRelativeScheduled(input.scheduledAt, timezone)}`,
    '3h': `премьера записи начнётся ${formatRelativeScheduled(input.scheduledAt, timezone)}`,
    '30m': `премьера записи начнётся ${formatRelativeScheduled(input.scheduledAt, timezone)}`,
  };

  const subject = `Напоминание АСПБ: премьера записи ${scheduled} (${timezoneLabel(timezone)})`;
  const text = buildEmailText(
    input,
    `${labelByKind[input.kind]}. Сохраните персональную ссылку и зайдите в комнату вовремя.`,
  );

  return deliverEmail({ ...input, subject, text });
}

export async function sendSessionChangeEmail(input: SessionChangeEmailInput) {
  const scheduled = new Intl.DateTimeFormat('ru-RU', {
    timeZone: input.timezone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(input.scheduledAt);
  const timezoneLabel = input.timezone.replaceAll('_', ' ');
  const rescheduled = input.kind === 'rescheduled';
  const subject = rescheduled ? 'Изменилось время вебинара АСПБ' : 'Вебинар АСПБ отменён';
  const text = [
    `${input.name},`,
    '',
    `Вебинар: ${input.webinarTitle}`,
    rescheduled
      ? `Время вебинара изменилось. Новое начало: ${scheduled} (${timezoneLabel}).`
      : `Вебинар, назначенный на ${scheduled} (${timezoneLabel}), отменён.`,
    rescheduled ? `Ваша персональная ссылка на комнату: ${input.webinarUrl}` : '',
    '',
    'Это сервисное уведомление об изменении вашей регистрации.',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ]
    .filter(Boolean)
    .join('\n');

  return deliverEmail({
    to: input.to,
    subject,
    text,
    scheduledAt: input.scheduledAt,
    webinarUrl: rescheduled ? input.webinarUrl : undefined,
    includeUnsubscribe: false,
  });
}

export async function sendReplayEmail(input: BaseEmailInput) {
  void input;
  logger.info('[ASPБ email] replay follow-up email skipped: recordings are available in the account library');
  return { sent: false, mode: 'disabled' as const };
}
