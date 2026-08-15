import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import {
  acquireTelegramBroadcastCreationLock,
  previewTelegramBroadcastRecipientsForSnapshot,
  runTelegramBroadcastJobOnce,
  snapshotTelegramBroadcastRecipients,
  TELEGRAM_BROADCAST_KIND_NEWS,
} from './telegramBroadcastWorker.js';
import {
  initializeWorkerSubsystemProgress,
  reportWorkerSubsystemProgress,
  stopWorkerSubsystemProgress,
} from './workerHeartbeat.js';

const RSS_FETCH_TIMEOUT_MS = 10_000;
const RSS_MAX_BODY_BYTES = 1024 * 1024;

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

async function readBoundedText(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RSS_MAX_BODY_BYTES) {
    throw new Error('RSS response is larger than the configured limit');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > RSS_MAX_BODY_BYTES) {
        await reader.cancel('RSS response exceeded the configured limit');
        throw new Error('RSS response is larger than the configured limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(body);
}

export async function fetchFeed(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('RSS fetch timed out')), RSS_FETCH_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ASPB-Autowebinar/1.0 (+local)',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Feed URLs may contain credentials. Never include the configured URL in
      // an exception that can reach logs or health details.
      throw new Error(`RSS fetch failed with HTTP ${response.status}`);
    }

    return parseRss(await readBoundedText(response));
  } finally {
    clearTimeout(timeout);
  }
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

let telegramNewsJobRunning = false;

export async function runTelegramNewsJobOnce(now = new Date(), onProgress?: () => void) {
  if (telegramNewsJobRunning) {
    return { skipped: true, reason: 'in_progress' as const };
  }

  telegramNewsJobRunning = true;
  onProgress?.();
  try {
    return await runTelegramNewsJobOnceUnlocked(now, onProgress);
  } finally {
    onProgress?.();
    telegramNewsJobRunning = false;
  }
}

async function runTelegramNewsJobOnceUnlocked(now = new Date(), onProgress?: () => void) {
  if (env.TELEGRAM_NEWS_BROADCAST !== 'on') {
    return { skipped: true, reason: 'disabled' as const };
  }

  const slot = getDueNewsSlot(now);
  if (!slot) {
    return { skipped: true, reason: 'not_due' as const };
  }

  const existingSlot = await prisma.telegramNewsPost.findFirst({ where: { slotKey: slot.slotKey } });
  onProgress?.();
  if (existingSlot) {
    return { skipped: true, reason: 'already_sent' as const, slotKey: slot.slotKey };
  }

  const candidate = await pickNewsCandidate(slot.slotKey);
  onProgress?.();
  const message = buildNewsMessage(candidate, slot.timeLabel);
  const jobId = randomUUID();
  let queued: { kind: 'queued'; jobId: string; total: number } | { kind: 'existing' } | { kind: 'no_subscribers' };
  try {
    queued = await prisma.$transaction(
      async tx => {
        await acquireTelegramBroadcastCreationLock(tx);
        const duplicate = await tx.telegramNewsPost.findFirst({ where: { slotKey: slot.slotKey } });
        if (duplicate) return { kind: 'existing' as const };

        // A repeatable-read snapshot is durable evidence and a retry cursor, not
        // authorization. The worker rechecks consent under the Lead lock directly
        // before every bounded provider request.
        const preview = await previewTelegramBroadcastRecipientsForSnapshot(tx, {
          requireActiveRegistration: false,
          onProgress,
        });
        if (preview.total === 0) return { kind: 'no_subscribers' as const };

        await tx.telegramBroadcastJob.create({
          data: {
            id: jobId,
            status: 'pending',
            kind: TELEGRAM_BROADCAST_KIND_NEWS,
            text: message,
            // Legacy JSON columns remain empty. The normalized recipient table is
            // the durable audit snapshot and the worker's only delivery cursor.
            chatIds: [],
            recipientSnapshot: Prisma.DbNull,
            consentDocumentId: preview.consentDocumentId,
            consentDocumentVersion: preview.consentDocumentVersion,
            idempotencyKey: `telegram-news:${slot.slotKey}`,
            total: preview.total,
            nextAttemptAt: now,
          },
        });

        const snapshotTotal = await snapshotTelegramBroadcastRecipients(tx, jobId, {
          requireActiveRegistration: false,
          onProgress,
        });
        if (snapshotTotal !== preview.total) {
          throw new Error(
            `Telegram news recipient snapshot changed during queueing (${snapshotTotal} != ${preview.total})`,
          );
        }

        await tx.telegramNewsPost.create({
          data: {
            id: jobId,
            postKey: candidate.postKey,
            slotKey: slot.slotKey,
            title: candidate.title,
            summary: candidate.summary,
            url: candidate.url,
            sourceTitle: candidate.sourceTitle,
            status: 'pending',
          },
        });
        return { kind: 'queued' as const, jobId, total: preview.total };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 60_000,
      },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { skipped: true, reason: 'already_sent' as const, slotKey: slot.slotKey };
    }
    throw error;
  }

  if (queued.kind === 'existing') {
    return { skipped: true, reason: 'already_sent' as const, slotKey: slot.slotKey };
  }
  if (queued.kind === 'no_subscribers') {
    return { skipped: true, reason: 'no_subscribers' as const, slotKey: slot.slotKey };
  }

  // Fast first attempt preserves the old scheduler behaviour. Any transient failure is now
  // persisted with nextAttemptAt and retried by the shared lease/fencing worker.
  await runTelegramBroadcastJobOnce(now, { jobId: queued.jobId, onProgress });
  onProgress?.();
  const persisted = await prisma.telegramBroadcastJob.findUniqueOrThrow({ where: { id: queued.jobId } });
  const status =
    persisted.status === 'completed'
      ? persisted.failed > 0
        ? 'partial_failed'
        : 'sent'
      : persisted.status === 'failed'
        ? 'retry_scheduled'
        : persisted.status === 'dead_letter'
          ? 'failed'
          : persisted.status;
  return {
    skipped: false,
    slotKey: slot.slotKey,
    sent: persisted.sent,
    failed: persisted.failed,
    status,
  };
}

export function startTelegramNewsScheduler() {
  if (env.NODE_ENV === 'test' || env.TELEGRAM_NEWS_BROADCAST !== 'on') {
    return null;
  }

  initializeWorkerSubsystemProgress('news');
  const reportProgress = () => reportWorkerSubsystemProgress('news');

  telegramNewsInterval = setInterval(() => {
    runTelegramNewsJobOnce(new Date(), reportProgress).catch(error => {
      logger.error({ err: error }, '[ASPБ telegram news]');
    });
  }, 60 * 1000);

  telegramNewsStartupTimer = setTimeout(() => {
    runTelegramNewsJobOnce(new Date(), reportProgress).catch(error => {
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
  stopWorkerSubsystemProgress('news');
}
