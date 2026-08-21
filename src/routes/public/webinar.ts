import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { getCountdown, getDailyBroadcastDate, getSessionStatus, getWebinarRoomState } from '../../lib/time.js';
import { DEFAULT_TIMELINE_EVENTS } from '../../lib/webinarTimeline.js';
import { getEffectiveVideoDurationMinutes, getWebinarLiveState } from '../../lib/webinarLive.js';
import { getScriptedChatMessagesUntil } from '../../lib/scriptedChat.js';
import { buildModeratorIntroMessage } from '../../lib/moderator.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { buildDailyRoomAccessPayload, findRegistrationForRequest, getFirstSeen, roomAccessError } from './helpers.js';
import { getCache, setCache } from '../../lib/responseCache.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';

export const webinarRouter = Router();

function publicTelegramUrl() {
  return buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL;
}

webinarRouter.get(
  '/webinar/current',
  asyncHandler(async (req, res) => {
    // Фиксируем первичное касание отдельно от расписания. Оно не влияет на слот.
    getFirstSeen(req, res);
    const serverTime = new Date();
    const scheduledAt = getDailyBroadcastDate(serverTime);
    const cacheKey = `webinar-current:${scheduledAt.toISOString()}`;
    const cached = getCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(cached);
      return;
    }

    const session = await findOrCreateWebinarSession(scheduledAt, serverTime);

    const payload = {
      ok: true,
      serverTime: serverTime.toISOString(),
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
      telegramUrl: publicTelegramUrl(),
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
  const access = await buildDailyRoomAccessPayload(registration, now);
  if (!access.canViewRoom) {
    throw roomAccessError(access.accessStatus);
  }
  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  const basePayload = {
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    roomState: getWebinarRoomState(access),
    countdown: access.countdown,
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
  };

  res.setHeader('Cache-Control', 'private, max-age=30');
  if (!access.canEnterRoom) {
    res.json(basePayload);
    return;
  }

  const videoConfig = getWebinarVideoConfig(access.webinarSession);
  const mediaBase = `/api/media/webinar/${encodeURIComponent(access.webinarSession.id)}`;
  const currentMediaAsset =
    registration.webinarSessionId === access.webinarSession.id
      ? (
          await prisma.webinar.findFirst({
            where: {
              id: access.webinarSession.webinarId,
              organizationId: access.webinarSession.organizationId,
            },
            select: {
              currentMediaAsset: {
                select: {
                  id: true,
                  status: true,
                  manifestStorageKey: true,
                  posterStorageKey: true,
                  durationSeconds: true,
                },
              },
            },
          })
        )?.currentMediaAsset
      : null;
  const versionedMediaReady = Boolean(
    currentMediaAsset?.status === 'READY' && currentMediaAsset.manifestStorageKey && currentMediaAsset.posterStorageKey,
  );

  const dbEvents = await getTimelineEvents(access.webinarSession.id, access.webinarSession.videoDurationSeconds);

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

  res.json({
    ...basePayload,
    video: {
      src: versionedMediaReady ? null : videoConfig.src ? `${mediaBase}/video` : null,
      hlsSrc: versionedMediaReady ? `${mediaBase}/manifest` : videoConfig.hlsSrc ? `${mediaBase}/hls` : null,
      provider: versionedMediaReady ? 'versioned_private' : videoConfig.provider,
      durationSeconds: currentMediaAsset?.durationSeconds ?? access.webinarSession.videoDurationSeconds,
      poster: versionedMediaReady ? `${mediaBase}/poster` : videoConfig.poster,
      fallbackAllowed: videoConfig.fallbackAllowed,
      localFallbackAllowed: videoConfig.localFallbackAllowed,
      externalMp4Allowed: versionedMediaReady ? false : Boolean(videoConfig.src),
      expected: versionedMediaReady || Boolean(videoConfig.hlsSrc || videoConfig.src),
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
  const access = await buildDailyRoomAccessPayload(registration, now);
  if (!access.canViewRoom) {
    throw roomAccessError(access.accessStatus);
  }

  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  const canExposeChatMessages = access.canEnterRoom || access.testMode || liveState.status === 'finished';
  let persistedMessages: Awaited<ReturnType<typeof prisma.webinarChatMessage.findMany>> = [];
  if (canExposeChatMessages) {
    const realMessagesCacheKey = `webinar-chat-real:${access.webinarSession.id}:${Math.floor(now.getTime() / 4_000)}`;
    const cachedPersistedMessages =
      getCache<Awaited<ReturnType<typeof prisma.webinarChatMessage.findMany>>>(realMessagesCacheKey);
    if (cachedPersistedMessages) {
      persistedMessages = cachedPersistedMessages;
    } else {
      persistedMessages = await prisma.webinarChatMessage.findMany({
        where: {
          webinarSessionId: access.webinarSession.id,
          visibleAt: { lte: now },
          // Сообщения забаненных модератором участников скрыты из публичной ленты.
          // Системные сообщения (модератор/сценарий) имеют registrationId=null — их оставляем.
          OR: [{ registrationId: null }, { registration: { is: { chatBannedAt: null } } }],
        },
        orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
      });
      setCache(realMessagesCacheKey, persistedMessages, 4_000);
    }
  }

  const scriptedMessages =
    canExposeChatMessages && (liveState.chatStatus === 'live' || access.testMode || access.accessStatus === 'replay')
      ? getScriptedChatMessagesUntil(
          access.testMode || access.accessStatus === 'replay'
            ? access.webinarSession.videoDurationSeconds
            : liveState.liveOffsetSeconds,
          {
            durationSeconds: access.webinarSession.videoDurationSeconds,
            validateDuration: false,
          },
        ).map(message => ({
          // Наружу отдаём только поля, нужные для интерфейса. Внутренние метаданные
          // сценария (agentId, videoBlock, topic, priority, answer/relatedVideoSeconds)
          // не являются частью публичного контракта.
          id: message.id,
          offsetSeconds: message.offsetSeconds,
          visibleAt: new Date(access.webinarSession.scheduledAt.getTime() + message.offsetSeconds * 1000),
          // Подготовленные вопросы нельзя выдавать за сообщения зрителей в реальном времени.
          kind:
            message.kind === 'agent_question' || message.kind === 'scripted_user' ? 'prepared_question' : message.kind,
          authorName: message.authorName,
          authorRole: 'подготовленный вопрос',
          message: message.message,
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
  }));

  // Закреплённое приветствие модератора: всегда первым, когда чат открыт. offsetSeconds=0
  // и visibleAt чуть раньше старта гарантируют, что оно не отсекается гейтом и сортируется вверх.
  const moderatorIntro = canExposeChatMessages ? [buildModeratorIntroMessage(access.webinarSession)] : [];

  const messages = [...moderatorIntro, ...scriptedMessages, ...realMessages]
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
