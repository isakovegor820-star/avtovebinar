import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import {
  getCountdown,
  getNextWebinarDate,
  getSessionStatus,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
  WEBINAR_TITLE,
} from '../../lib/time.js';
import { DEFAULT_TIMELINE_EVENTS, WEBINAR_VIDEO_PATH } from '../../lib/webinarTimeline.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { buildAccessPayload, findRegistrationForRequest, getFirstSeen, roomAccessError } from './helpers.js';

export const webinarRouter = Router();

async function findOrCreateWebinarSession(scheduledAt: Date) {
  const now = new Date();
  const status = getSessionStatus(now, scheduledAt, WEBINAR_DURATION_MINUTES);

  return prisma.webinarSession.upsert({
    where: { scheduledAt },
    update: {
      status,
      videoUrl: WEBINAR_VIDEO_PATH,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
    },
    create: {
      title: WEBINAR_TITLE,
      scheduledAt,
      durationMinutes: WEBINAR_DURATION_MINUTES,
      videoUrl: WEBINAR_VIDEO_PATH,
      videoDurationSeconds: 568,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status,
    },
  });
}

webinarRouter.get(
  '/webinar/current',
  asyncHandler(async (req, res) => {
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const serverTime = new Date();

    res.json({
      ok: true,
      serverTime: serverTime.toISOString(),
      firstSeenAt: firstSeenAt.toISOString(),
      scheduledAt: session.scheduledAt.toISOString(),
      status: getSessionStatus(serverTime, session.scheduledAt, session.durationMinutes),
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
    });
  }),
);

async function sendTimeline(req: Request, res: Response, token?: string | null) {
  const registration = await findRegistrationForRequest(req, token);

  if (!registration) {
    throw new AppError(401, 'Invalid webinar token');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  if (!access.canEnterRoom) {
    throw roomAccessError(access.accessStatus);
  }

  const dbEvents = await prisma.webinarTimelineEvent.findMany({
    where: {
      OR: [{ webinarSessionId: null }, { webinarSessionId: registration.webinarSessionId }],
    },
    orderBy: { offsetSeconds: 'asc' },
  });

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

  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
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

webinarRouter.get(
  '/webinar/timeline/:token',
  asyncHandler(async (req, res) => {
    const token = z.string().min(20).parse(req.params.token);
    await sendTimeline(req, res, token);
  }),
);
