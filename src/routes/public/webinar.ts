import { isIP } from 'node:net';
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
import {
  buildAccessPayload,
  buildDailyRoomAccessPayload,
  findRegistrationForRequest,
  getFirstSeen,
  roomAccessError,
} from './helpers.js';
import { getCache, setCache } from '../../lib/responseCache.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';
import { publicScenarioMessageType, scenarioAuthorLabel } from '../../lib/chatPolicy.js';
import { getParticipantWebinarMaterialContent } from '../../lib/tenancy/webinarMaterials.js';
import { getPublishedViewerContent } from '../../lib/viewerContent.js';

export const webinarRouter = Router();

const MEDIA_PROCESSING_STATUSES = new Set([
  'CREATED',
  'UPLOADING',
  'VALIDATING',
  'TRANSCODING',
  'TRANSCRIBING',
  'ENRICHING',
]);

function publicTelegramUrl() {
  return buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL;
}

function persistedMessageType(message: { messageType?: string | null; kind: string }) {
  if (message.messageType) return message.messageType.toLowerCase();
  if (message.kind === 'user' || message.kind === 'participant') return 'participant';
  if (message.kind === 'moderator') return 'moderator';
  if (message.kind === 'prepared_question' || message.kind === 'agent_question' || message.kind === 'scripted_user') {
    return 'prepared_question';
  }
  if (message.kind === 'ai_manager' || message.kind === 'ai_moderator') return 'ai_moderator';
  // Unknown legacy values are deliberately not presented as participants.
  return 'system';
}

function publicMessageGrounding(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const grounding = (metadata as Record<string, unknown>).grounding;
  if (!grounding || typeof grounding !== 'object' || Array.isArray(grounding)) return null;
  const value = grounding as Record<string, unknown>;
  if (
    value.type === 'transcript' &&
    typeof value.timestampSeconds === 'number' &&
    Number.isInteger(value.timestampSeconds) &&
    value.timestampSeconds >= 0 &&
    typeof value.label === 'string'
  ) {
    return { type: 'transcript' as const, timestampSeconds: value.timestampSeconds, label: value.label.slice(0, 16) };
  }
  if (value.type === 'source' && typeof value.title === 'string' && typeof value.url === 'string') {
    try {
      const url = new URL(value.url);
      const hostname = url.hostname.toLocaleLowerCase('en-US');
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        hostname !== 'localhost' &&
        !hostname.endsWith('.local') &&
        isIP(hostname) === 0
      ) {
        return { type: 'source' as const, title: value.title.slice(0, 240), url: url.toString() };
      }
    } catch {
      return null;
    }
  }
  return null;
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
  const webinarMedia =
    registration.webinarSessionId === access.webinarSession.id
      ? await prisma.webinar.findFirst({
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
            mediaAssets: {
              orderBy: { version: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        })
      : null;
  const currentMediaAsset = webinarMedia?.currentMediaAsset ?? null;
  const latestMediaStatus = webinarMedia?.mediaAssets[0]?.status ?? null;
  const versionedMediaReady = Boolean(
    currentMediaAsset?.status === 'READY' && currentMediaAsset.manifestStorageKey && currentMediaAsset.posterStorageKey,
  );
  const configuredMediaReady = Boolean(videoConfig.hlsSrc || videoConfig.src);
  const mediaState =
    versionedMediaReady || configuredMediaReady
      ? 'ready'
      : latestMediaStatus && MEDIA_PROCESSING_STATUSES.has(latestMediaStatus)
        ? 'processing'
        : latestMediaStatus === 'FAILED'
          ? 'error'
          : 'unavailable';

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
      state: mediaState,
      src: versionedMediaReady ? null : videoConfig.src ? `${mediaBase}/video` : null,
      hlsSrc: versionedMediaReady ? `${mediaBase}/manifest` : videoConfig.hlsSrc ? `${mediaBase}/hls` : null,
      provider: versionedMediaReady ? 'versioned_private' : videoConfig.provider,
      durationSeconds: currentMediaAsset?.durationSeconds ?? access.webinarSession.videoDurationSeconds,
      poster: versionedMediaReady ? `${mediaBase}/poster` : videoConfig.poster,
      fallbackAllowed: videoConfig.fallbackAllowed,
      localFallbackAllowed: videoConfig.localFallbackAllowed,
      externalMp4Allowed: versionedMediaReady ? false : Boolean(videoConfig.src),
      expected: versionedMediaReady || configuredMediaReady,
    },
    timeline,
  });
}

async function sendRoomContent(req: Request, res: Response) {
  const registration = await findRegistrationForRequest(req);
  if (!registration) {
    throw new AppError(404, 'Room content not found', undefined, 'room_content_not_found');
  }

  const now = new Date();
  // Versioned room content is bound to the exact Registration/WebinarSession.
  // Legacy daily-slot rollover must not extend replay access or switch the
  // transcript/media scope behind an already issued participant cookie.
  const access = buildAccessPayload(registration, now);
  if (!access.canViewRoom || !access.canEnterRoom) {
    throw new AppError(404, 'Room content not found', undefined, 'room_content_not_found');
  }

  const content = await getPublishedViewerContent(
    prisma,
    {
      organizationId: access.webinarSession.organizationId,
      webinarId: access.webinarSession.webinarId,
      webinarSessionId: access.webinarSession.id,
    },
    {
      captionsPath: transcriptId =>
        `/api/media/webinar/${encodeURIComponent(access.webinarSession.id)}/captions/${encodeURIComponent(transcriptId)}`,
      materialPath: materialId => `/api/webinar/materials/${encodeURIComponent(materialId)}`,
    },
  );
  if (!content) {
    throw new AppError(404, 'Room content not found', undefined, 'room_content_not_found');
  }

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: true,
    serverTime: now.toISOString(),
    ...content,
  });
}

webinarRouter.get(
  '/webinar/timeline/session/current',
  asyncHandler(async (req, res) => {
    await sendTimeline(req, res);
  }),
);

webinarRouter.get(
  '/webinar/content/session/current',
  asyncHandler(async (req, res) => {
    await sendRoomContent(req, res);
  }),
);

webinarRouter.get(
  '/webinar/materials/:materialId',
  asyncHandler(async (req, res) => {
    const materialId = typeof req.params.materialId === 'string' ? req.params.materialId.trim() : '';
    if (!materialId || materialId.length > 191) {
      throw new AppError(404, 'Материал не найден', undefined, 'material_not_found');
    }
    const registration = await findRegistrationForRequest(req);
    if (!registration) throw new AppError(404, 'Материал не найден', undefined, 'material_not_found');
    const access = buildAccessPayload(registration, new Date());
    if (!access.canViewRoom || !access.canEnterRoom) {
      throw new AppError(404, 'Материал не найден', undefined, 'material_not_found');
    }
    const result = await getParticipantWebinarMaterialContent(
      prisma,
      access.webinarSession.organizationId,
      access.webinarSession.webinarId,
      materialId,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="material-${result.material.id}"`);
    res.type(result.object.contentType);
    if (result.object.contentLength !== undefined) res.setHeader('Content-Length', String(result.object.contentLength));
    result.object.body.pipe(res);
  }),
);

async function sendChat(req: Request, res: Response) {
  const registration = await findRegistrationForRequest(req);

  if (!registration) {
    throw new AppError(401, 'Invalid webinar token');
  }

  const now = new Date();
  const versionedRoom = registration.accessPolicy !== 'LEGACY';
  // New registrations are always bound to their exact WebinarSession. Only the
  // legacy daily funnel keeps its historical rollover behavior.
  const access = versionedRoom
    ? buildAccessPayload(registration, now)
    : await buildDailyRoomAccessPayload(registration, now);
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
          organizationId: access.webinarSession.organizationId,
          webinarId: access.webinarSession.webinarId,
          visibleAt: { lte: now },
          hiddenAt: null,
          // Сообщения забаненных модератором участников скрыты из публичной ленты.
          // Системные сообщения (модератор/сценарий) имеют registrationId=null — их оставляем.
          OR: [{ registrationId: null }, { registration: { is: { chatBannedAt: null } } }],
        },
        orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
      });
      setCache(realMessagesCacheKey, persistedMessages, 4_000);
    }
  }

  const scenarioOffset =
    access.testMode || access.accessStatus === 'replay'
      ? access.webinarSession.videoDurationSeconds
      : liveState.liveOffsetSeconds;
  const canExposeScenario =
    canExposeChatMessages && (liveState.chatStatus === 'live' || access.testMode || access.accessStatus === 'replay');
  const publishedScenario =
    versionedRoom && canExposeScenario
      ? await prisma.chatScenario.findFirst({
          where: {
            organizationId: access.webinarSession.organizationId,
            webinarId: access.webinarSession.webinarId,
            status: 'PUBLISHED',
            runtimeEnabled: true,
          },
          orderBy: { version: 'desc' },
          include: {
            messages: {
              where: { status: 'APPROVED', offsetSeconds: { lte: scenarioOffset } },
              orderBy: [{ offsetSeconds: 'asc' }, { orderIndex: 'asc' }],
            },
          },
        })
      : null;

  const scriptedMessages =
    !versionedRoom && canExposeScenario
      ? getScriptedChatMessagesUntil(scenarioOffset, {
          durationSeconds: access.webinarSession.videoDurationSeconds,
          validateDuration: false,
        }).map(message => ({
          // Наружу отдаём только поля, нужные для интерфейса. Внутренние метаданные
          // сценария (agentId, videoBlock, topic, priority, answer/relatedVideoSeconds)
          // не являются частью публичного контракта.
          id: message.id,
          offsetSeconds: message.offsetSeconds,
          visibleAt: new Date(access.webinarSession.scheduledAt.getTime() + message.offsetSeconds * 1000),
          // Подготовленные вопросы нельзя выдавать за сообщения зрителей в реальном времени.
          kind: 'prepared_question' as const,
          authorName: 'Подготовленный вопрос',
          authorRole: 'Подготовленный вопрос',
          message: message.message,
          isSynthetic: true as const,
        }))
      : publishedScenario
        ? publishedScenario.messages.map(message => {
            const kind = publicScenarioMessageType(message.kind);
            const disclosure = scenarioAuthorLabel(message.kind);
            return {
              id: message.id,
              offsetSeconds: message.offsetSeconds,
              visibleAt: new Date(access.webinarSession.scheduledAt.getTime() + message.offsetSeconds * 1000),
              kind,
              authorName: disclosure,
              authorRole: disclosure,
              message: message.text,
              isSynthetic: true as const,
            };
          })
        : [];

  const realMessages = persistedMessages.map(message => ({
    id: message.id,
    questionId: message.questionId,
    offsetSeconds: Math.max(
      0,
      Math.floor((message.visibleAt.getTime() - access.webinarSession.scheduledAt.getTime()) / 1000),
    ),
    visibleAt: message.visibleAt,
    kind: persistedMessageType(message),
    authorName: message.authorName,
    authorRole: message.authorRole,
    message: message.message,
    isSynthetic: message.isSynthetic,
    grounding: publicMessageGrounding(message.metadataJson),
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
    scenarioVersion: publishedScenario?.version ?? (versionedRoom ? null : 'legacy-file'),
    messages,
  });
}

webinarRouter.get(
  '/webinar/chat/session/current',
  asyncHandler(async (req, res) => {
    await sendChat(req, res);
  }),
);
