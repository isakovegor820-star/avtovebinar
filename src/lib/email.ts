import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env.js';
import { withCircuitBreaker, withRetries } from './resilience.js';

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

function buildEmailText(input: BaseEmailInput, intro: string) {
  const scheduled = formatScheduled(input.scheduledAt);

  return [
    `${input.name}, ${intro}`,
    '',
    'Тема: Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса',
    `Начало: ${scheduled} МСК`,
    `Ваша персональная ссылка на комнату: ${input.webinarUrl}`,
    `Telegram-уведомления: ${env.TELEGRAM_GROUP_URL}`,
    input.partnerUrl ? `Заявка на партнерский договор: ${input.partnerUrl}` : '',
    '',
    'АСПБ — Антикризисная служба помощи бизнесу',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverEmail(input: BaseEmailInput & { subject: string; text: string }) {
  const scheduled = formatScheduled(input.scheduledAt);

  if (shouldLogEmail()) {
    console.log('[ASPБ email log]', {
      to: maskEmail(input.to),
      subject: input.subject,
      scheduled,
      webinarUrl: '[redacted-personal-link]',
      telegramConfigured: Boolean(env.TELEGRAM_GROUP_URL),
      partnerUrl: input.partnerUrl ? '[redacted-personal-link]' : null,
    });
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
            to: input.to,
            subject: input.subject,
            text: input.text,
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

export async function sendReminderEmail(input: BaseEmailInput & { kind: ReminderKind }) {
  const scheduled = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(input.scheduledAt);

  const labelByKind: Record<ReminderKind, string> = {
    '24h': 'до эфира осталось около 24 часов',
    '3h': 'до эфира осталось около 3 часов',
    '30m': 'до эфира осталось около 30 минут',
  };

  const subject = `Напоминание АСПБ: эфир ${scheduled} МСК`;
  const text = buildEmailText(
    input,
    `${labelByKind[input.kind]}. Сохраните персональную ссылку и зайдите в комнату вовремя.`,
  );

  return deliverEmail({ ...input, subject, text });
}
