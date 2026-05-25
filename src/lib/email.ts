import nodemailer from 'nodemailer';
import { env } from './env.js';

type BaseEmailInput = {
  to: string;
  name: string;
  scheduledAt: Date;
  webinarUrl: string;
  partnerUrl?: string;
};

export type ReminderKind = '24h' | '3h' | '30m';

function shouldLogEmail() {
  return env.EMAIL_MODE === 'log' || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS;
}

function formatScheduled(date: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'long',
    timeStyle: 'short'
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
    'АСПБ — Антикризисная служба помощи бизнесу'
  ]
    .filter(Boolean)
    .join('\n');
}

async function deliverEmail(input: BaseEmailInput & { subject: string; text: string }) {
  const scheduled = formatScheduled(input.scheduledAt);

  if (shouldLogEmail()) {
    console.log('[ASPБ email log]', {
      to: input.to,
      subject: input.subject,
      scheduled,
      webinarUrl: input.webinarUrl,
      telegram: env.TELEGRAM_GROUP_URL,
      partnerUrl: input.partnerUrl ?? null
    });
    return { sent: false, mode: 'log' as const };
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text
  });

  return { sent: true, mode: 'send' as const };
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
    timeStyle: 'short'
  }).format(input.scheduledAt);

  const labelByKind: Record<ReminderKind, string> = {
    '24h': 'до эфира осталось около 24 часов',
    '3h': 'до эфира осталось около 3 часов',
    '30m': 'до эфира осталось около 30 минут'
  };

  const subject = `Напоминание АСПБ: эфир ${scheduled} МСК`;
  const text = buildEmailText(
    input,
    `${labelByKind[input.kind]}. Сохраните персональную ссылку и зайдите в комнату вовремя.`
  );

  return deliverEmail({ ...input, subject, text });
}
