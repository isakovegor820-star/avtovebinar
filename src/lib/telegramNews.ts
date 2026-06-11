import { Prisma } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { sendTelegramMessageToChat } from './telegram.js';
import { logger } from './logger.js';

type FeedItem = {
  title: string;
  url: string;
  summary: string;
  publishedAt?: Date;
  sourceTitle?: string;
};

type NewsCandidate = {
  postKey: string;
  title: string;
  url?: string;
  summary?: string;
  sourceTitle?: string;
};

const NEWS_KEYWORDS = [
  'банкрот',
  'несостоятельн',
  'долг',
  'должник',
  'кредитор',
  'фнс',
  'налог',
  'арест',
  'взыскан',
  'исполнительн',
  'субсидиар',
  'арбитраж',
  'блокиров',
  'ликвидац',
  'реструктур',
];

const FALLBACK_NEWS = [
  {
    title: 'Сигнал АСПБ: блокировка счета редко бывает “просто технической проблемой”',
    summary:
      'Если клиент говорит о блокировке, налоговой задолженности или просрочке по кредиту, это повод не отпускать его без маршрута диагностики.',
  },
  {
    title: 'Сигнал АСПБ: банкротный риск виден юристу раньше, чем начинается хаос',
    summary:
      'Долги, требования ФНС, кредиторское давление и субсидиарные риски часто появляются в юридической практике раньше полноценной процедуры.',
  },
  {
    title: 'Сигнал АСПБ: клиент с долгами ищет не лекцию, а понятный следующий шаг',
    summary:
      'Главная задача партнера — вовремя заметить проблему, объяснить безопасный маршрут и передать ситуацию на диагностику.',
  },
  {
    title: 'Сигнал АСПБ: “закрыться с долгами” — это уже повод для консультации',
    summary:
      'Такие фразы нельзя оставлять без ответа: человеку важно показать законный путь, а не отправлять его искать решение самому.',
  },
  {
    title: 'Сигнал АСПБ: партнерство начинается с одного правильно замеченного клиента',
    summary:
      'Не нужно вести процедуру самостоятельно. Ваша роль — увидеть сигнал и передать клиента команде, которая берет сложную часть на себя.',
  },
];

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value: string) {
  return decodeXml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const XML_TAG_PATTERNS = {
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  link: /<link[^>]*>([\s\S]*?)<\/link>/i,
  guid: /<guid[^>]*>([\s\S]*?)<\/guid>/i,
  description: /<description[^>]*>([\s\S]*?)<\/description>/i,
  pubDate: /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i,
} as const;

function xmlValue(source: string, tag: keyof typeof XML_TAG_PATTERNS) {
  const match = source.match(XML_TAG_PATTERNS[tag]);
  return match ? stripHtml(match[1]) : '';
}

function normalizeText(value: string, limit = 320) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trim()}…` : normalized;
}

function parseRss(xml: string): FeedItem[] {
  const sourceTitle = xmlValue(xml, 'title') || 'новостная лента';
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  return items
    .map(item => {
      const title = xmlValue(item, 'title');
      const url = xmlValue(item, 'link') || xmlValue(item, 'guid');
      const summary = xmlValue(item, 'description');
      const pubDate = xmlValue(item, 'pubDate');
      return {
        title,
        url,
        summary,
        sourceTitle,
        publishedAt: pubDate ? new Date(pubDate) : undefined,
      };
    })
    .filter(item => item.title && item.url);
}

function parseTimes(value: string) {
  const times = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const match = item.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return {
        label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        minuteOfDay: hour * 60 + minute,
      };
    })
    .filter(Boolean) as Array<{ label: string; minuteOfDay: number }>;

  return times.length ? times.sort((a, b) => a.minuteOfDay - b.minuteOfDay) : [{ label: '09:00', minuteOfDay: 9 * 60 }];
}

function moscowParts(now: Date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function getDueNewsSlot(now = new Date(), timesValue = env.TELEGRAM_NEWS_TIMES) {
  const { dateKey, minuteOfDay } = moscowParts(now);
  const due = parseTimes(timesValue).filter(time => time.minuteOfDay <= minuteOfDay);
  const latest = due.at(-1);

  if (!latest) return null;

  return {
    dateKey,
    timeLabel: latest.label,
    slotKey: `${dateKey}:${latest.label}`,
  };
}

function isRelevant(item: FeedItem) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  return NEWS_KEYWORDS.some(keyword => haystack.includes(keyword));
}

function makePostKey(item: FeedItem) {
  return `rss:${item.url || item.title}`;
}

async function fetchFeed(url: string) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ASPB-Autowebinar/1.0 (+local)',
    },
  });

  if (!response.ok) {
    throw new Error(`RSS fetch failed ${response.status}: ${url}`);
  }

  return parseRss(await response.text());
}

async function fetchNewsCandidates(): Promise<NewsCandidate[]> {
  const urls = env.TELEGRAM_NEWS_RSS_URLS.split(',')
    .map(url => url.trim())
    .filter(Boolean);
  const batches = await Promise.allSettled(urls.map(fetchFeed));
  const items = batches
    .flatMap(batch => (batch.status === 'fulfilled' ? batch.value : []))
    .filter(isRelevant)
    .sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));

  return items.map(item => ({
    postKey: makePostKey(item),
    title: normalizeText(item.title, 180),
    url: item.url,
    summary: normalizeText(
      item.summary || 'Короткий инфоповод для партнеров АСПБ: проверьте, нет ли похожих сигналов у ваших клиентов.',
      360,
    ),
    sourceTitle: item.sourceTitle,
  }));
}

async function pickNewsCandidate(slotKey: string): Promise<NewsCandidate> {
  const alreadySent = await prisma.telegramNewsPost.findMany({
    select: { postKey: true },
    take: 500,
    orderBy: { sentAt: 'desc' },
  });
  const sentKeys = new Set(alreadySent.map(item => item.postKey));
  const rssCandidate = (await fetchNewsCandidates()).find(item => !sentKeys.has(item.postKey));

  if (rssCandidate) return rssCandidate;

  const fallbackIndex =
    Math.abs(slotKey.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)) % FALLBACK_NEWS.length;
  const fallback = FALLBACK_NEWS[fallbackIndex];
  return {
    postKey: `fallback:${slotKey}`,
    title: fallback.title,
    summary: fallback.summary,
    sourceTitle: 'АСПБ',
  };
}

function buildNewsMessage(candidate: NewsCandidate, slotLabel: string) {
  const sourceLine = candidate.sourceTitle ? `Источник: ${candidate.sourceTitle}` : null;
  return [
    `Новости АСПБ · выпуск ${slotLabel}`,
    '',
    candidate.title,
    '',
    candidate.summary,
    '',
    'Почему это важно: такие инфоповоды помогают быстрее замечать клиентов с долгами, блокировками, налоговой нагрузкой и риском банкротства.',
    sourceLine,
    candidate.url ? `Подробнее: ${candidate.url}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function normalizeJobError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

let telegramNewsJobRunning = false;

export async function runTelegramNewsJobOnce(now = new Date()) {
  if (telegramNewsJobRunning) {
    return { skipped: true, reason: 'in_progress' as const };
  }

  telegramNewsJobRunning = true;
  try {
    return await runTelegramNewsJobOnceUnlocked(now);
  } finally {
    telegramNewsJobRunning = false;
  }
}

async function runTelegramNewsJobOnceUnlocked(now = new Date()) {
  if (env.TELEGRAM_NEWS_BROADCAST !== 'on') {
    return { skipped: true, reason: 'disabled' as const };
  }

  const slot = getDueNewsSlot(now);
  if (!slot) {
    return { skipped: true, reason: 'not_due' as const };
  }

  const existingSlot = await prisma.telegramNewsPost.findFirst({ where: { slotKey: slot.slotKey } });
  if (existingSlot) {
    return { skipped: true, reason: 'already_sent' as const, slotKey: slot.slotKey };
  }

  const leads = await prisma.lead.findMany({
    where: { telegramChatId: { not: null } },
    select: { telegramChatId: true },
    take: 5000,
  });
  const chatIds = Array.from(new Set(leads.map(lead => lead.telegramChatId).filter(Boolean))) as string[];

  if (!chatIds.length) {
    return { skipped: true, reason: 'no_subscribers' as const, slotKey: slot.slotKey };
  }

  const candidate = await pickNewsCandidate(slot.slotKey);
  let post: { id: string };
  try {
    post = await prisma.telegramNewsPost.create({
      data: {
        postKey: candidate.postKey,
        slotKey: slot.slotKey,
        title: candidate.title,
        summary: candidate.summary,
        url: candidate.url,
        sourceTitle: candidate.sourceTitle,
        status: 'sending',
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { skipped: true, reason: 'already_sent' as const, slotKey: slot.slotKey };
    }
    throw error;
  }

  const message = buildNewsMessage(candidate, slot.timeLabel);
  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (const chatId of chatIds) {
    try {
      await sendTelegramMessageToChat(chatId, message);
      sent += 1;
    } catch (error) {
      failed += 1;
      lastError = normalizeJobError(error);
      logger.error({ err: error }, '[ASPБ telegram news recipient]');
    }
  }

  const status = failed === 0 ? 'sent' : sent > 0 ? 'partial_failed' : 'failed';
  await prisma.telegramNewsPost.update({
    where: { id: post.id },
    data: {
      recipientCount: sent,
      failedCount: failed,
      status,
      lastError,
      completedAt: new Date(),
    },
  });

  await prisma.event.create({
    data: {
      eventName: 'telegram_news_broadcast',
      page: 'telegram_news',
      source: 'scheduler',
      metadataJson: {
        slotKey: slot.slotKey,
        postKey: candidate.postKey,
        sent,
        failed,
        status,
      } as Prisma.InputJsonValue,
    },
  });

  return { skipped: false, slotKey: slot.slotKey, sent, failed, status };
}

export function startTelegramNewsScheduler() {
  if (env.NODE_ENV === 'test' || env.TELEGRAM_NEWS_BROADCAST !== 'on') {
    return null;
  }

  telegramNewsInterval = setInterval(() => {
    runTelegramNewsJobOnce().catch(error => {
      logger.error({ err: error }, '[ASPБ telegram news]');
    });
  }, 60 * 1000);

  telegramNewsStartupTimer = setTimeout(() => {
    runTelegramNewsJobOnce().catch(error => {
      logger.error({ err: error }, '[ASPБ telegram news]');
    });
  }, 8000);

  logger.info('[ASPБ telegram news] broadcast scheduler enabled');
  return telegramNewsInterval;
}

let telegramNewsInterval: NodeJS.Timeout | null = null;
let telegramNewsStartupTimer: NodeJS.Timeout | null = null;

export function stopTelegramNewsScheduler() {
  if (telegramNewsInterval) {
    clearInterval(telegramNewsInterval);
    telegramNewsInterval = null;
  }
  if (telegramNewsStartupTimer) {
    clearTimeout(telegramNewsStartupTimer);
    telegramNewsStartupTimer = null;
  }
}
