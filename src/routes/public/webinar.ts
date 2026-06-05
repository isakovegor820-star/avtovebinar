import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { getCountdown, getNextWebinarDate, getSessionStatus } from '../../lib/time.js';
import { DEFAULT_TIMELINE_EVENTS, WEBINAR_VIDEO_PATH } from '../../lib/webinarTimeline.js';
import { getEffectiveVideoDurationMinutes, getWebinarLiveState } from '../../lib/webinarLive.js';
import { getScriptedChatMessagesUntil } from '../../lib/scriptedChat.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { buildAccessPayload, findRegistrationForRequest, getFirstSeen, roomAccessError } from './helpers.js';
import { getCache, setCache } from '../../lib/responseCache.js';

export const webinarRouter = Router();

webinarRouter.get(
  '/webinar/current',
  asyncHandler(async (req, res) => {
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const cacheKey = `webinar-current:${firstSeenAt.toISOString()}:${scheduledAt.toISOString()}`;
    const cached = getCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(cached);
      return;
    }

    const session = await findOrCreateWebinarSession(scheduledAt);
    const serverTime = new Date();

    const payload = {
      ok: true,
      serverTime: serverTime.toISOString(),
      firstSeenAt: firstSeenAt.toISOString(),
      scheduledAt: session.scheduledAt.toISOString(),
      status: getSessionStatus(serverTime, session.scheduledAt, getEffectiveVideoDurationMinutes(session)),
      countdown: getCountdown(serverTime, session.scheduledAt),
      webinar: {
        id: session.id,
        title: session.title,
        durationMinutes: session.durationMinutes,
        videoDurationSeconds: session.videoDurationSeconds,
        roomOpenBeforeMinutes: session.roomOpenBeforeMinutes,
        replayAvailableHours: session.replayAvailableHours,
      },
      telegramUrl: env.TELEGRAM_GROUP_URL,
      telegramBotUrl: buildTelegramStartUrl(),
    };

    setCache(cacheKey, payload, 30_000);
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json(payload);
  }),
);

async function getTimelineEvents(webinarSessionId: string, videoDurationSeconds: number) {
  const cacheKey = `webinar-timeline-events:${webinarSessionId}:${videoDurationSeconds}`;
  const cached = getCache<Awaited<ReturnType<typeof prisma.webinarTimelineEvent.findMany>>>(cacheKey);
  if (cached) {
    return cached;
  }

  const events = await prisma.webinarTimelineEvent.findMany({
    where: {
      OR: [{ webinarSessionId: null }, { webinarSessionId }],
    },
    orderBy: { offsetSeconds: 'asc' },
  });
  setCache(cacheKey, events, 60_000);
  return events;
}

async function sendTimeline(req: Request, res: Response) {
  const registration = await findRegistrationForRequest(req);

  if (!registration) {
    throw new AppError(401, 'Invalid webinar token');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  if (!access.canViewRoom) {
    throw roomAccessError(access.accessStatus);
  }
  const liveState = getWebinarLiveState(now, registration.webinarSession, { testMode: access.testMode });

  const dbEvents = await getTimelineEvents(
    registration.webinarSessionId,
    registration.webinarSession.videoDurationSeconds,
  );

  const hasFreshTimeline =
    dbEvents.length > 0 &&
    dbEvents.every(event => event.offsetSeconds <= registration.webinarSession.videoDurationSeconds);

  const timeline = hasFreshTimeline
    ? dbEvents.map(event => ({
        offsetSeconds: event.offsetSeconds,
        title: event.title,
        text: event.text,
        type: event.type,
        ctaLabel: event.ctaLabel,
        ctaUrl: event.ctaUrl,
      }))
    : DEFAULT_TIMELINE_EVENTS;

  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    liveState: {
      scheduledAt: liveState.scheduledAt.toISOString(),
      durationSeconds: liveState.durationSeconds,
      liveOffsetSeconds: liveState.liveOffsetSeconds,
      elapsedSeconds: liveState.elapsedSeconds,
      isStarted: liveState.isStarted,
      isEnded: liveState.isEnded,
      status: liveState.status,
      chatStatus: liveState.chatStatus,
    },
    replayExpiresAt: access.replayExpiresAt.toISOString(),
    roomOpensAt: access.roomOpensAt.toISOString(),
    video: {
      src: registration.webinarSession.videoUrl || WEBINAR_VIDEO_PATH,
      durationSeconds: registration.webinarSession.videoDurationSeconds,
      poster: registration.webinarSession.posterUrl,
      expected: true,
    },
    timeline,
  });
}

webinarRouter.get(
  '/webinar/timeline/session/current',
  asyncHandler(async (req, res) => {
    await sendTimeline(req, res);
  }),
);

async function sendChat(req: Request, res: Response) {
  const registration = await findRegistrationForRequest(req);

  if (!registration) {
    throw new AppError(401, 'Invalid webinar token');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  if (!access.canViewRoom) {
    throw roomAccessError(access.accessStatus);
  }

  const liveState = getWebinarLiveState(now, registration.webinarSession, { testMode: access.testMode });
  const persistedMessages = await prisma.webinarChatMessage.findMany({
    where: {
      webinarSessionId: registration.webinarSessionId,
      visibleAt: { lte: now },
    },
    orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
  });

  const scriptedMessages =
    liveState.chatStatus === 'live' || access.testMode
      ? getScriptedChatMessagesUntil(
          access.testMode ? Math.max(420, liveState.liveOffsetSeconds) : liveState.liveOffsetSeconds,
        ).map(message => ({
          id: message.id,
          offsetSeconds: message.offsetSeconds,
          visibleAt: new Date(registration.webinarSession.scheduledAt.getTime() + message.offsetSeconds * 1000),
          kind: message.kind,
          authorName: message.authorName,
          authorRole: message.authorRole,
          message: message.message,
          isSynthetic: message.isSynthetic,
          videoBlock: message.videoBlock,
        }))
      : [];

  const realMessages = persistedMessages.map(message => ({
    id: message.id,
    offsetSeconds: Math.max(
      0,
      Math.floor((message.visibleAt.getTime() - registration.webinarSession.scheduledAt.getTime()) / 1000),
    ),
    visibleAt: message.visibleAt,
    kind: message.kind,
    authorName: message.authorName,
    authorRole: message.authorRole,
    message: message.message,
    isSynthetic: message.isSynthetic,
  }));

  const messages = [...scriptedMessages, ...realMessages]
    .sort((left, right) => left.visibleAt.getTime() - right.visibleAt.getTime())
    .map(message => ({
      ...message,
      visibleAt: message.visibleAt.toISOString(),
    }));

  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    liveState: {
      scheduledAt: liveState.scheduledAt.toISOString(),
      durationSeconds: liveState.durationSeconds,
      liveOffsetSeconds: liveState.liveOffsetSeconds,
      elapsedSeconds: liveState.elapsedSeconds,
      isStarted: liveState.isStarted,
      isEnded: liveState.isEnded,
      status: liveState.status,
      chatStatus: liveState.chatStatus,
    },
    lead: {
      name: registration.lead.name,
      professionalStatus: registration.lead.professionalStatus,
    },
    messages,
  });
}

webinarRouter.get(
  '/webinar/chat/session/current',
  asyncHandler(async (req, res) => {
    await sendChat(req, res);
  }),
);
