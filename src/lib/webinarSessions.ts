import type { Prisma, WebinarSession } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  getSessionStatus,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
  WEBINAR_ROOM_OPEN_BEFORE_MINUTES,
  WEBINAR_TITLE,
} from './time.js';
import {
  WEBINAR_BROADCAST_POSTER_URL,
  WEBINAR_BROADCAST_VIDEO_URL,
  WEBINAR_RECORDING_POSTER_PATH,
  WEBINAR_RECORDING_VIDEO_PATH,
  WEBINAR_VIDEO_DURATION_SECONDS,
} from './webinarTimeline.js';
import { getEffectiveVideoDurationMinutes } from './webinarLive.js';

function pointsToRecordingAsset(value: string | null | undefined) {
  if (!value) return false;
  return value.endsWith(WEBINAR_RECORDING_VIDEO_PATH) || value.endsWith(WEBINAR_RECORDING_POSTER_PATH);
}

function getDailySessionRepairData(session: WebinarSession) {
  const data: Prisma.WebinarSessionUpdateInput = {};

  if (!session.videoUrl || pointsToRecordingAsset(session.videoUrl)) {
    data.videoUrl = WEBINAR_BROADCAST_VIDEO_URL;
  }

  if (!session.posterUrl || pointsToRecordingAsset(session.posterUrl)) {
    data.posterUrl = WEBINAR_BROADCAST_POSTER_URL;
  }

  if ([568, 3300].includes(session.videoDurationSeconds)) {
    data.videoDurationSeconds = WEBINAR_VIDEO_DURATION_SECONDS;
  }

  return data;
}

export async function findOrCreateWebinarSession(scheduledAt: Date, now = new Date()) {
  const status = getSessionStatus(
    now,
    scheduledAt,
    getEffectiveVideoDurationMinutes({ videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS }),
  );

  const session = await prisma.webinarSession
    .upsert({
      where: { scheduledAt },
      update: {
        status,
      },
      create: {
        title: WEBINAR_TITLE,
        scheduledAt,
        durationMinutes: WEBINAR_DURATION_MINUTES,
        videoUrl: WEBINAR_BROADCAST_VIDEO_URL,
        posterUrl: WEBINAR_BROADCAST_POSTER_URL,
        videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS,
        roomOpenBeforeMinutes: WEBINAR_ROOM_OPEN_BEFORE_MINUTES,
        replayAvailableHours: WEBINAR_REPLAY_HOURS,
        replayEnabled: true,
        liveMode: 'simulated',
        status,
      },
    })
    .catch(async (error: unknown) => {
      // Гонка при первом обращении к новой дате эфира: два параллельных INSERT в upsert →
      // P2002 (@@unique([scheduledAt])). Строку уже создал конкурент — читаем её, чтобы
      // регистрация не падала с 500 и лид не терялся.
      if ((error as { code?: string })?.code === 'P2002') {
        const existing = await prisma.webinarSession.findUnique({ where: { scheduledAt } });
        if (existing) return existing;
      }
      throw error;
    });

  const repairData = getDailySessionRepairData(session);
  if (Object.keys(repairData).length === 0) {
    return session;
  }

  return prisma.webinarSession.update({
    where: { id: session.id },
    data: repairData,
  });
}
