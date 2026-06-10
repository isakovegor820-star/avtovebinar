import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { getCountdown, getCurrentOrNextWebinarDate, getSessionStatus, getWebinarRoomState } from '../../lib/time.js';
import { DEFAULT_TIMELINE_EVENTS } from '../../lib/webinarTimeline.js';
import { getEffectiveVideoDurationMinutes, getWebinarLiveState } from '../../lib/webinarLive.js';
import { getScriptedChatMessagesUntil } from '../../lib/scriptedChat.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { buildAccessPayload, findRegistrationForRequest, getFirstSeen, roomAccessError } from './helpers.js';
import { getCache, setCache } from '../../lib/responseCache.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';

export const webinarRouter = Router();

webinarRouter.get(
  '/webinar/current',
  asyncHandler(async (req, res) => {
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getCurrentOrNextWebinarDate(new Date());
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
  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  const videoConfig = getWebinarVideoConfig(access.webinarSession);

  const dbEvents = await getTimelineEvents(registration.webinarSessionId, access.webinarSession.videoDurationSeconds);

  const hasFreshTimeline =
    dbEvents.length > 0 && dbEvents.every(event => event.offsetSeconds <= access.webinarSession.videoDurationSeconds);

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
    roomState: getWebinarRoomState(access),
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
      src: videoConfig.src,
      hlsSrc: videoConfig.hlsSrc,
      provider: videoConfig.provider,
      durationSeconds: access.webinarSession.videoDurationSeconds,
      poster: videoConfig.poster,
      fallbackAllowed: videoConfig.fallbackAllowed,
      expected: Boolean(videoConfig.hlsSrc || videoConfig.src),
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

  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  const realMessagesCacheKey = `webinar-chat-real:${registration.webinarSessionId}:${Math.floor(now.getTime() / 4_000)}`;
  let persistedMessages =
    getCache<Awaited<ReturnType<typeof prisma.webinarChatMessage.findMany>>>(realMessagesCacheKey);
  if (!persistedMessages) {
    persistedMessages = await prisma.webinarChatMessage.findMany({
      where: {
        webinarSessionId: registration.webinarSessionId,
        visibleAt: { lte: now },
      },
      orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
    });
    setCache(realMessagesCacheKey, persistedMessages, 4_000);
  }

  const scriptedMessages =
    liveState.chatStatus === 'live' || access.testMode || access.accessStatus === 'replay'
      ? getScriptedChatMessagesUntil(
          access.testMode || access.accessStatus === 'replay'
            ? access.webinarSession.videoDurationSeconds
            : liveState.liveOffsetSeconds,
          {
            durationSeconds: access.webinarSession.videoDurationSeconds,
          },
        ).map(message => ({
          id: message.id,
          offsetSeconds: message.offsetSeconds,
          answerStartSeconds: message.answerStartSeconds,
          relatedVideoSeconds: message.relatedVideoSeconds,
          agentId: message.agentId,
          visibleAt: new Date(access.webinarSession.scheduledAt.getTime() + message.offsetSeconds * 1000),
          kind: message.kind,
          authorName: message.authorName,
          authorRole: message.authorRole,
          message: message.message,
          isSynthetic: message.isSynthetic,
          videoBlock: message.videoBlock,
          topic: message.topic,
          priority: message.priority,
        }))
      : [];

  const realMessages = persistedMessages.map(message => ({
    id: message.id,
    questionId: message.questionId,
    offsetSeconds: Math.max(
      0,
      Math.floor((message.visibleAt.getTime() - access.webinarSession.scheduledAt.getTime()) / 1000),
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

  res.setHeader('Cache-Control', 'private, max-age=4');
  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    roomState: getWebinarRoomState(access),
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
