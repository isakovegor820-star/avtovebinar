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
};

export type ReminderKind = '24h' | '3h' | '30m';

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
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return cachedTransporter;
}

function shouldLogEmail() {
  return env.EMAIL_MODE === 'log' || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS;
}

function maskEmail(value: string) {
  const [name, domain] = value.split('@');
  if (!name || !domain) return '[redacted-email]';
  return `${name.slice(0, 2)}***@${domain}`;
}

function formatScheduled(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function moscowDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return moscowDateKey(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)));
}

function formatRelativeScheduled(date: Date, now = new Date()) {
  const scheduledKey = moscowDateKey(date);
  const todayKey = moscowDateKey(now);
  const day =
    scheduledKey === todayKey
      ? 'сегодня'
      : scheduledKey === addDaysKey(todayKey, 1)
        ? 'завтра'
        : new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Moscow',
            day: '2-digit',
            month: 'long',
          }).format(date);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${day} в ${time} МСК`;
}

function buildEmailText(input: BaseEmailInput, intro: string) {
  const scheduled = formatScheduled(input.scheduledAt);
  const telegramUrl = buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL;

  return [
    `${input.name}, ${intro}`,
    '',
    'Тема: Экономика кризиса: как бухгалтеру и юристу развиваться в условиях нестабильности',
    `Начало: ${scheduled} МСК`,
    `Ваша персональная ссылка на комнату: ${input.webinarUrl}`,
    `Telegram-уведомления: ${telegramUrl}`,
    input.partnerUrl ? `Заявка на партнерский договор: ${input.partnerUrl}` : '',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
    `Отписаться от рассылок: ${buildUnsubscribeUrl(input.to)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverEmail(input: BaseEmailInput & { subject: string; text: string }) {
  const scheduled = formatScheduled(input.scheduledAt);

  if (shouldLogEmail()) {
    logger.info(
      {
        to: maskEmail(input.to),
        subject: input.subject,
        scheduled,
        webinarUrl: '[redacted-personal-link]',
        telegramConfigured: Boolean(env.TELEGRAM_GROUP_URL),
        partnerUrl: input.partnerUrl ? '[redacted-personal-link]' : null,
      },
      '[ASPБ email log]',
    );
    return { sent: false, mode: 'log' as const };
  }

  const transporter = getTransporter();

  await withCircuitBreaker(
    'smtp',
    () =>
      withRetries(
        'smtp.sendMail',
        () =>
          transporter.sendMail({
            from: env.EMAIL_FROM,
            replyTo: env.EMAIL_REPLY_TO,
            to: input.to,
            subject: input.subject,
            text: input.text,
            headers: {
              // 152-ФЗ/38-ФЗ: возможность отписки в каждом письме (почтовый клиент покажет «Отписаться»).
              'List-Unsubscribe': `<${buildUnsubscribeUrl(input.to)}>, <mailto:${
                env.EMAIL_REPLY_TO ?? env.EMAIL_FROM
              }?subject=unsubscribe>`,
            },
          }),
        { attempts: 3, baseMs: 1000, maxMs: 10_000 },
      ),
    { failureThreshold: 3, cooldownMs: 60_000 },
  );

  return { sent: true, mode: 'send' as const };
}

export async function verifyEmailConnectivity() {
  if (shouldLogEmail()) {
    return { ok: true, mode: 'log' as const };
  }

  await withCircuitBreaker('smtp', () => getTransporter().verify(), { failureThreshold: 3, cooldownMs: 60_000 });
  return { ok: true, mode: 'send' as const };
}

export async function sendRegistrationEmail(input: BaseEmailInput) {
  const subject = 'Вы зарегистрированы на вебинар АСПБ';
  const text = buildEmailText(input, 'вы зарегистрированы на вебинар АСПБ.');

  return deliverEmail({ ...input, subject, text });
}

export async function sendParticipantLoginEmail(input: BaseEmailInput) {
  const subject = 'Ваша ссылка для входа в Мой доступ АСПБ';
  const scheduled = formatScheduled(input.scheduledAt);
  const text = [
    `${input.name}, вы запросили вход в Мой доступ АСПБ.`,
    '',
    'Откройте одноразовую ссылку, чтобы восстановить доступ на этом устройстве:',
    input.webinarUrl,
    '',
    `Ближайший вебинар: ${scheduled} МСК`,
    'Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ].join('\n');

  return deliverEmail({ ...input, subject, text });
}

export async function sendReminderEmail(input: BaseEmailInput & { kind: ReminderKind }) {
  const scheduled = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(input.scheduledAt);

  const labelByKind: Record<ReminderKind, string> = {
    '24h': `эфир начнется ${formatRelativeScheduled(input.scheduledAt)}`,
    '3h': `эфир начнется ${formatRelativeScheduled(input.scheduledAt)}`,
    '30m': `эфир начнется ${formatRelativeScheduled(input.scheduledAt)}`,
  };

  const subject = `Напоминание АСПБ: эфир ${scheduled} МСК`;
  const text = buildEmailText(
    input,
    `${labelByKind[input.kind]}. Сохраните персональную ссылку и зайдите в комнату вовремя.`,
  );

  return deliverEmail({ ...input, subject, text });
}

export async function sendReplayEmail(input: BaseEmailInput) {
  void input;
  logger.info('[ASPБ email] replay follow-up email skipped: recordings are available in the account library');
  return { sent: false, mode: 'disabled' as const };
}
