import { prisma } from './prisma.js';
import { env } from './env.js';
import type { ReminderKind } from './email.js';
import { EMAIL_JOB_REMINDER, enqueueReminderEmail, runEmailOutboxJobOnce } from './emailOutbox.js';
import { sendTelegramMessageToChat, telegramUrlButton } from './telegram.js';
import { createRoomExchangeUrl, getRoomTokenExpiresAt, buildFrontendUrl } from './roomLinks.js';
import { logger } from './logger.js';

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
  { kind: '24h', msBefore: 24 * 60 * 60 * 1000, field: 'reminder24hSentAt' },
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

function telegramReminderField(kind: ReminderKind) {
  return {
    '24h': 'telegramReminder24hSentAt',
    '3h': 'telegramReminder3hSentAt',
    '30m': 'telegramReminder30mSentAt',
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

export function formatWebinarRelativeDate(scheduledAt: Date, now = new Date()) {
  const scheduledKey = moscowDateKey(scheduledAt);
  const todayKey = moscowDateKey(now);
  if (scheduledKey === todayKey) return 'сегодня';
  if (scheduledKey === addDaysKey(todayKey, 1)) return 'завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'long',
  }).format(scheduledAt);
}

function formatWebinarReminderLabel(scheduledAt: Date, now = new Date()) {
  const day = formatWebinarRelativeDate(scheduledAt, now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }).format(scheduledAt);
  return `${day} в ${time} МСК`;
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

// Размер батча и предохранитель от бесконечного цикла при курсорной пагинации.
const REMINDER_BATCH_SIZE = 100;
const REMINDER_MAX_BATCHES = 50;

export async function runReminderJobOnce(now = new Date()) {
  let checked = 0;
  let sent = 0;
  let cursor: string | undefined;

  for (let batch = 0; batch < REMINDER_MAX_BATCHES; batch += 1) {
    const registrations = await prisma.registration.findMany({
      where: {
        status: 'registered',
        webinarSession: {
          scheduledAt: {
            gt: now,
            lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        },
      },
      include: {
        lead: true,
        webinarSession: true,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (registrations.length === 0) {
      break;
    }

    checked += registrations.length;
    cursor = registrations[registrations.length - 1].id;

    // Один batch-запрос вместо N COUNT'ов (устраняет N+1): какие email-напоминания
    // уже поставлены для регистраций этого батча. Ключ — `registrationId:reminderKind`.
    const existingJobs = await prisma.emailOutboxJob.findMany({
      where: { registrationId: { in: registrations.map(item => item.id) }, type: EMAIL_JOB_REMINDER },
      select: { registrationId: true, reminderKind: true },
    });
    const existingReminderKeys = new Set(existingJobs.map(job => `${job.registrationId}:${job.reminderKind}`));

    for (const registration of registrations) {
      const kind = getDueReminderKind(registration, now);
      if (!kind) {
        continue;
      }

      if (existingReminderKeys.has(`${registration.id}:${kind}`)) {
        continue;
      }

      const created = await prisma.$transaction(async tx => {
        const webinarUrl = await createRoomExchangeUrl(tx, {
          registrationId: registration.id,
          expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
        });
        const partnerUrl = await createRoomExchangeUrl(tx, {
          registrationId: registration.id,
          expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
          hash: 'partnerApplication',
        });
        return enqueueReminderEmail(tx, {
          kind,
          registrationId: registration.id,
          webinarSessionId: registration.webinarSessionId,
          toEmail: registration.lead.email,
          toName: registration.lead.name,
          scheduledAt: registration.webinarSession.scheduledAt,
          webinarUrl,
          partnerUrl,
        });
      });
      // createMany(skipDuplicates) вернёт 0, если напоминание уже было поставлено гонкой —
      // тогда не считаем его отправленным (точная метрика).
      if (created > 0) {
        sent += 1;
      }
    }

    if (registrations.length < REMINDER_BATCH_SIZE) {
      break;
    }
  }

  return { checked, sent };
}

export async function runTelegramReminderJobOnce(now = new Date()) {
  let checked = 0;
  let sent = 0;
  let cursor: string | undefined;

  for (let batch = 0; batch < REMINDER_MAX_BATCHES; batch += 1) {
    const registrations = await prisma.registration.findMany({
      where: {
        status: 'registered',
        lead: {
          telegramChatId: { not: null },
        },
        webinarSession: {
          scheduledAt: {
            gt: now,
            lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        },
      },
      include: {
        lead: true,
        webinarSession: true,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (registrations.length === 0) {
      break;
    }

    checked += registrations.length;
    cursor = registrations[registrations.length - 1].id;

    for (const registration of registrations) {
      const kind = getDueTelegramReminderKind(registration, now);
      if (!kind || !registration.lead.telegramChatId) {
        continue;
      }

      const field = telegramReminderField(kind);
      // Атомарно «застолбить» отправку ДО неё: ставим метку только если она ещё пуста.
      // Если другой тик/реплика уже застолбил (count !== 1) — пропускаем без дубля.
      const claimed = await prisma.registration.updateMany({
        where: { id: registration.id, [field]: null },
        data: { [field]: now },
      });
      if (claimed.count !== 1) {
        continue;
      }

      const label = formatWebinarReminderLabel(registration.webinarSession.scheduledAt, now);
      try {
        const roomUrl = await prisma.$transaction(tx =>
          createRoomExchangeUrl(tx, {
            registrationId: registration.id,
            expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
          }),
        );

        await sendTelegramMessageToChat(
          registration.lead.telegramChatId,
          [
            kind === '24h'
              ? `Напоминание: вебинар АСПБ ${label}.`
              : kind === '3h'
                ? `Вебинар АСПБ уже ${label}.`
                : `Скоро начинаем: вебинар АСПБ ${label}.`,
            '',
            kind === '24h'
              ? buildSegmentTip(registration.lead.professionalStatus)
              : kind === '3h'
                ? 'Подготовьте один вопрос по клиенту с долгами — зададите его прямо в комнате.'
                : 'Заходите заранее, чтобы не пропустить старт.',
            '',
            `Тема: ${registration.webinarSession.title}`,
          ].join('\n'),
          { replyMarkup: telegramUrlButton(kind === '30m' ? '▶ Войти в комнату' : '▶ Открыть комнату', roomUrl) },
        );
        sent += 1;
      } catch (error) {
        // Отправка/подготовка не удалась — снимаем метку, чтобы напоминание повторилось
        // на следующем тике. Один сбойный получатель не должен ронять весь прогон.
        await prisma.registration.update({ where: { id: registration.id }, data: { [field]: null } }).catch(() => {});
        logger.error(
          { err: error, registrationId: registration.id, kind },
          '[ASPБ telegram reminder] отправка не удалась, метка снята для повтора',
        );
      }
    }

    if (registrations.length < REMINDER_BATCH_SIZE) {
      break;
    }
  }

  return { checked, sent };
}

const TELEGRAM_LIVE_WINDOW_MS = 20 * 60 * 1000; // «эфир начался» — в первые 20 минут после старта
const TELEGRAM_FOLLOWUP_GRACE_MS = 10 * 60 * 1000; // «после эфира» — спустя 10 минут после конца
const TELEGRAM_FOLLOWUP_WINDOW_MS = 12 * 60 * 60 * 1000; // не догоняем эфиры старше 12 часов
const TELEGRAM_LIVE_FOLLOWUP_BATCH = 500;

// «🔴 Эфир начался» участникам с привязанным Telegram. Идемпотентно через CAS-claim
// telegramLiveSentAt: ровно один раз на регистрацию, без дублей при рестарте/репликах.
export async function runTelegramLiveJobOnce(now = new Date()) {
  let sent = 0;
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      telegramLiveSentAt: null,
      lead: { telegramChatId: { not: null } },
      webinarSession: { scheduledAt: { lte: now, gt: new Date(now.getTime() - TELEGRAM_LIVE_WINDOW_MS) } },
    },
    include: { lead: true, webinarSession: true },
    take: TELEGRAM_LIVE_FOLLOWUP_BATCH,
  });

  for (const registration of registrations) {
    if (!registration.lead.telegramChatId) continue;
    const claimed = await prisma.registration.updateMany({
      where: { id: registration.id, telegramLiveSentAt: null },
      data: { telegramLiveSentAt: now },
    });
    if (claimed.count !== 1) continue;

    try {
      const roomUrl = await prisma.$transaction(tx =>
        createRoomExchangeUrl(tx, {
          registrationId: registration.id,
          expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
        }),
      );
      await sendTelegramMessageToChat(
        registration.lead.telegramChatId,
        '🔴 Эфир начался — подключайтесь, мы уже в комнате.',
        { replyMarkup: telegramUrlButton('▶ Войти в эфир', roomUrl) },
      );
      sent += 1;
    } catch (error) {
      await prisma.registration
        .update({ where: { id: registration.id }, data: { telegramLiveSentAt: null } })
        .catch(() => {});
      logger.error(
        { err: error, registrationId: registration.id },
        '[ASPБ telegram live] отправка не удалась, метка снята',
      );
    }
  }

  return { sent };
}

// «После эфира»: благодарность + запись + призыв к партнёрской заявке. Шлётся один раз
// (CAS-claim telegramFollowupSentAt) спустя время после фактического конца эфира.
export async function runTelegramFollowupJobOnce(now = new Date()) {
  let sent = 0;
  const registrations = await prisma.registration.findMany({
    where: {
      status: 'registered',
      telegramFollowupSentAt: null,
      lead: { telegramChatId: { not: null } },
      webinarSession: {
        scheduledAt: { lt: now, gt: new Date(now.getTime() - TELEGRAM_FOLLOWUP_WINDOW_MS - 6 * 60 * 60 * 1000) },
      },
    },
    include: { lead: true, webinarSession: true },
    take: TELEGRAM_LIVE_FOLLOWUP_BATCH,
  });

  const recordingsUrl = buildFrontendUrl('/crisis_premium/recordings.html');

  for (const registration of registrations) {
    if (!registration.lead.telegramChatId) continue;
    const durationMs = (registration.webinarSession.durationMinutes ?? 65) * 60 * 1000;
    const endAt = registration.webinarSession.scheduledAt.getTime() + durationMs;
    if (now.getTime() < endAt + TELEGRAM_FOLLOWUP_GRACE_MS || now.getTime() > endAt + TELEGRAM_FOLLOWUP_WINDOW_MS) {
      continue;
    }

    const claimed = await prisma.registration.updateMany({
      where: { id: registration.id, telegramFollowupSentAt: null },
      data: { telegramFollowupSentAt: now },
    });
    if (claimed.count !== 1) continue;

    try {
      await sendTelegramMessageToChat(
        registration.lead.telegramChatId,
        [
          'Спасибо, что были на вебинаре АСПБ.',
          '',
          'Запись и материалы — в разделе «Записи». Если есть клиент с долгами, налогами или риском банкротства — оставьте партнёрскую заявку, поможем довести.',
        ].join('\n'),
        { replyMarkup: telegramUrlButton('Смотреть запись', recordingsUrl) },
      );
      sent += 1;
    } catch (error) {
      await prisma.registration
        .update({ where: { id: registration.id }, data: { telegramFollowupSentAt: null } })
        .catch(() => {});
      logger.error(
        { err: error, registrationId: registration.id },
        '[ASPБ telegram followup] отправка не удалась, метка снята',
      );
    }
  }

  return { sent };
}

export async function runReplayFollowupJobOnce(now = new Date()) {
  void now;
  return { checked: 0, emailQueued: 0, telegramSent: 0, disabled: true };
}

export async function cleanupExpiredRegistrationTokens(now = new Date()) {
  const result = await prisma.registrationToken.deleteMany({
    where: {
      expiresAt: {
        lt: now,
      },
    },
  });

  return { deleted: result.count };
}

// Guard-флаг: не запускаем новый прогон джоб, пока предыдущий не завершился.
// Защищает от дублей напоминаний, если джобы не успели за интервал тика.
let reminderCycleRunning = false;
let reminderCyclePromise: Promise<void> | null = null;
let reminderInterval: NodeJS.Timeout | null = null;
let reminderStartupTimer: NodeJS.Timeout | null = null;

async function runReminderCycle() {
  // Локальный guard — защита от наложения тиков в одном процессе.
  if (reminderCycleRunning) {
    return;
  }
  reminderCycleRunning = true;

  // Распределённый lock убран намеренно: прежний pg_try_advisory_lock был session-level, а при
  // пуле соединений acquire и release попадали на РАЗНЫЕ коннекты — лок утекал и со временем
  // намертво блокировал прогон напоминаний (боты «переставали работать»). Идемпотентность теперь
  // гарантируется на уровне БД: уникальный индекс (registrationId, type, reminderKind) на
  // email-джобах + CAS-claim (updateMany … count === 1) в outbox/broadcast — дублей не будет
  // даже при нескольких репликах, и при этом ничто не может «залипнуть».
  try {
    await runReminderJobOnce().catch(error => logger.error({ err: error }, '[ASPБ reminders]'));
    await runEmailOutboxJobOnce().catch(error => logger.error({ err: error }, '[ASPБ email outbox]'));
    await runTelegramLiveJobOnce().catch(error => logger.error({ err: error }, '[ASPБ telegram live]'));
    await runTelegramReminderJobOnce().catch(error => logger.error({ err: error }, '[ASPБ telegram reminders]'));
    await runTelegramFollowupJobOnce().catch(error => logger.error({ err: error }, '[ASPБ telegram followup]'));
    await cleanupExpiredRegistrationTokens().catch(error => logger.error({ err: error }, '[ASPБ token cleanup]'));
  } finally {
    reminderCycleRunning = false;
  }
}

export function startReminderScheduler() {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  const run = () => {
    reminderCyclePromise = runReminderCycle()
      .catch(error => logger.error({ err: error }, '[ASPБ reminder cycle]'))
      .finally(() => {
        reminderCyclePromise = null;
      });
  };

  reminderInterval = setInterval(() => {
    run();
  }, 60 * 1000);

  reminderStartupTimer = setTimeout(run, 5000);

  return reminderInterval;
}

export async function stopReminderScheduler() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  if (reminderStartupTimer) {
    clearTimeout(reminderStartupTimer);
    reminderStartupTimer = null;
  }
  if (reminderCyclePromise) {
    await reminderCyclePromise;
  }
}
