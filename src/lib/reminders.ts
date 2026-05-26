import { prisma } from './prisma.js';
import { env } from './env.js';
import { sendReminderEmail, type ReminderKind } from './email.js';
import { createAccessToken, hashToken } from './tokens.js';
import { sendTelegramMessageToChat, formatMoscowDate } from './telegram.js';
import { getReplayExpiresAt, WEBINAR_REPLAY_HOURS } from './time.js';

type ReminderCandidate = {
  id: string;
  reminder24hSentAt: Date | null;
  reminder3hSentAt: Date | null;
  reminder30mSentAt: Date | null;
  telegramReminder24hSentAt?: Date | null;
  telegramReminder3hSentAt?: Date | null;
  telegramReminder30mSentAt?: Date | null;
  telegramFollowupSentAt?: Date | null;
  lead?: {
    professionalStatus?: string | null;
  };
  webinarSession: { scheduledAt: Date; durationMinutes?: number; replayAvailableHours?: number };
};

const REMINDER_THRESHOLDS: Array<{ kind: ReminderKind; msBefore: number; field: keyof ReminderCandidate }> = [
  { kind: '30m', msBefore: 30 * 60 * 1000, field: 'reminder30mSentAt' },
  { kind: '3h', msBefore: 3 * 60 * 60 * 1000, field: 'reminder3hSentAt' },
  { kind: '24h', msBefore: 24 * 60 * 60 * 1000, field: 'reminder24hSentAt' }
];

export function getDueReminderKind(registration: ReminderCandidate, now = new Date()): ReminderKind | null {
  const msUntilStart = registration.webinarSession.scheduledAt.getTime() - now.getTime();

  if (msUntilStart <= 0) {
    return null;
  }

  for (const reminder of REMINDER_THRESHOLDS) {
    if (msUntilStart <= reminder.msBefore) {
      return registration[reminder.field] ? null : reminder.kind;
    }
  }

  return null;
}

function reminderField(kind: ReminderKind) {
  return {
    '24h': 'reminder24hSentAt',
    '3h': 'reminder3hSentAt',
    '30m': 'reminder30mSentAt'
  }[kind] as 'reminder24hSentAt' | 'reminder3hSentAt' | 'reminder30mSentAt';
}

function telegramReminderField(kind: ReminderKind) {
  return {
    '24h': 'telegramReminder24hSentAt',
    '3h': 'telegramReminder3hSentAt',
    '30m': 'telegramReminder30mSentAt'
  }[kind] as 'telegramReminder24hSentAt' | 'telegramReminder3hSentAt' | 'telegramReminder30mSentAt';
}

export function getDueTelegramReminderKind(registration: ReminderCandidate, now = new Date()): ReminderKind | null {
  const msUntilStart = registration.webinarSession.scheduledAt.getTime() - now.getTime();

  if (msUntilStart <= 0) {
    return null;
  }

  for (const reminder of REMINDER_THRESHOLDS) {
    if (msUntilStart <= reminder.msBefore) {
      return registration[telegramReminderField(reminder.kind)] ? null : reminder.kind;
    }
  }

  return null;
}

export function getPostWebinarFollowupDueAt(scheduledAt: Date, durationMinutes = 120) {
  return new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000 + 10 * 60 * 1000);
}

function buildFrontendUrl(pathname: string, token?: string) {
  const url = new URL(pathname, env.PUBLIC_SITE_URL);
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function getRoomTokenExpiresAt(registration: ReminderCandidate) {
  return getReplayExpiresAt(
    registration.webinarSession.scheduledAt,
    registration.webinarSession.durationMinutes ?? 120,
    registration.webinarSession.replayAvailableHours ?? WEBINAR_REPLAY_HOURS
  );
}

function buildSegmentTip(status?: string | null) {
  const value = (status || '').toLowerCase();
  if (value.includes('юрист') || value.includes('антикризис')) {
    return 'Подготовьте один вопрос по долговому клиенту: на эфире разберем, как передавать такие ситуации без самостоятельного ведения процедуры.';
  }

  if (value.includes('налог') || value.includes('корпоратив')) {
    return 'Вспомните клиентов с требованиями ФНС, кредитной нагрузкой и риском субсидиарной ответственности: это хорошие примеры для разбора на эфире.';
  }

  if (value.includes('руководитель') || value.includes('практик')) {
    return 'Подумайте, какие долговые обращения сейчас уходят из вашей практики без понятного маршрута — на эфире покажем, как их передавать в АСПБ.';
  }

  return 'Подготовьте один пример клиента с долгами, кредиторами, налогами или риском банкротства — на эфире покажем, когда стоит передавать на диагностику.';
}

export async function runReminderJobOnce(now = new Date()) {
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      webinarSession: {
        scheduledAt: {
          gt: now,
          lte: new Date(now.getTime() + 24 * 60 * 60 * 1000)
        }
      }
    },
    include: {
      lead: true,
      webinarSession: true
    },
    take: 100
  });

  let sent = 0;

  for (const registration of registrations) {
    const kind = getDueReminderKind(registration, now);
    if (!kind) {
      continue;
    }

    const accessToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(accessToken),
        purpose: `reminder_${kind}`,
        expiresAt: getRoomTokenExpiresAt(registration)
      }
    });

    await sendReminderEmail({
      kind,
      to: registration.lead.email,
      name: registration.lead.name,
      scheduledAt: registration.webinarSession.scheduledAt,
      webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html', accessToken),
      partnerUrl: `${buildFrontendUrl('/crisis_premium/webinar.html', accessToken)}#partnerApplication`
    });

    const field = reminderField(kind);
    await prisma.registration.update({
      where: { id: registration.id },
      data: {
        [field]: now,
        reminderSentAt: now
      }
    });
    sent += 1;
  }

  return { checked: registrations.length, sent };
}

export async function runTelegramReminderJobOnce(now = new Date()) {
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      lead: {
        telegramChatId: { not: null }
      },
      webinarSession: {
        scheduledAt: {
          gt: now,
          lte: new Date(now.getTime() + 24 * 60 * 60 * 1000)
        }
      }
    },
    include: {
      lead: true,
      webinarSession: true
    },
    take: 100
  });

  let sent = 0;
  for (const registration of registrations) {
    const kind = getDueTelegramReminderKind(registration, now);
    if (!kind || !registration.lead.telegramChatId) {
      continue;
    }

    const accessToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(accessToken),
        purpose: `telegram_reminder_${kind}`,
        expiresAt: getRoomTokenExpiresAt(registration)
      }
    });

    const label = {
      '24h': 'завтра',
      '3h': 'через несколько часов',
      '30m': 'через 30 минут'
    }[kind];
    const roomUrl = buildFrontendUrl('/crisis_premium/webinar.html', accessToken);

    await sendTelegramMessageToChat(
      registration.lead.telegramChatId,
      [
        `Напоминание АСПБ: вебинар ${label}.`,
        '',
        kind === '24h'
          ? buildSegmentTip(registration.lead.professionalStatus)
          : kind === '3h'
            ? 'Подготовьте один вопрос по клиенту с долгами — его можно будет задать в вебинарной комнате.'
            : 'Эфир скоро. Переходите по персональной ссылке и подключайтесь к комнате.',
        '',
        `Тема: ${registration.webinarSession.title}`,
        `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
        '',
        `Ваша персональная комната: ${roomUrl}`
      ].join('\n')
    );

    await prisma.registration.update({
      where: { id: registration.id },
      data: {
        [telegramReminderField(kind)]: now
      }
    });
    sent += 1;
  }

  return { checked: registrations.length, sent };
}

export async function runTelegramFollowupJobOnce(now = new Date()) {
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      telegramFollowupSentAt: null,
      partnerApplications: { none: {} },
      lead: {
        telegramChatId: { not: null }
      },
      webinarSession: {
        scheduledAt: {
          lte: now,
          gte: new Date(now.getTime() - 12 * 60 * 60 * 1000)
        }
      }
    },
    include: {
      lead: true,
      webinarSession: true
    },
    take: 100
  });

  let sent = 0;
  for (const registration of registrations) {
    if (!registration.lead.telegramChatId) continue;
    const dueAt = getPostWebinarFollowupDueAt(registration.webinarSession.scheduledAt, registration.webinarSession.durationMinutes);
    if (now < dueAt || now.getTime() - dueAt.getTime() > 3 * 60 * 60 * 1000) {
      continue;
    }

    const accessToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(accessToken),
        purpose: 'telegram_post_webinar_partner',
        expiresAt: getRoomTokenExpiresAt(registration)
      }
    });

    const partnerUrl = `${buildFrontendUrl('/crisis_premium/webinar.html', accessToken)}#partnerApplication`;
    await sendTelegramMessageToChat(
      registration.lead.telegramChatId,
      [
        'Если вы узнали своих клиентов в примерах вебинара, сделайте следующий шаг.',
        '',
        'Оставьте заявку на партнерский договор: менеджер АСПБ покажет, как передавать такие ситуации и фиксировать условия сотрудничества.',
        '',
        `Заявка: ${partnerUrl}`
      ].join('\n')
    );

    await prisma.registration.update({
      where: { id: registration.id },
      data: { telegramFollowupSentAt: now }
    });
    sent += 1;
  }

  return { checked: registrations.length, sent };
}

export function startReminderScheduler() {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  const interval = setInterval(() => {
    runReminderJobOnce().catch(error => {
      console.error('[ASPБ reminders]', error);
    });
    runTelegramReminderJobOnce().catch(error => {
      console.error('[ASPБ telegram reminders]', error);
    });
    runTelegramFollowupJobOnce().catch(error => {
      console.error('[ASPБ telegram followup]', error);
    });
  }, 60 * 1000);

  setTimeout(() => {
    runReminderJobOnce().catch(error => {
      console.error('[ASPБ reminders]', error);
    });
    runTelegramReminderJobOnce().catch(error => {
      console.error('[ASPБ telegram reminders]', error);
    });
    runTelegramFollowupJobOnce().catch(error => {
      console.error('[ASPБ telegram followup]', error);
    });
  }, 5000);

  return interval;
}
