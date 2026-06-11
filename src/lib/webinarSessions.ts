import { prisma } from './prisma.js';
import { getSessionStatus, WEBINAR_DURATION_MINUTES, WEBINAR_REPLAY_HOURS, WEBINAR_TITLE } from './time.js';
import {
  WEBINAR_BROADCAST_POSTER_URL,
  WEBINAR_BROADCAST_VIDEO_URL,
  WEBINAR_VIDEO_DURATION_SECONDS,
} from './webinarTimeline.js';
import { getEffectiveVideoDurationMinutes } from './webinarLive.js';

export async function findOrCreateWebinarSession(scheduledAt: Date, now = new Date()) {
  const status = getSessionStatus(
    now,
    scheduledAt,
    getEffectiveVideoDurationMinutes({ videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS }),
  );

  return prisma.webinarSession.upsert({
    where: { scheduledAt },
    update: {
      title: WEBINAR_TITLE,
      durationMinutes: WEBINAR_DURATION_MINUTES,
      videoUrl: WEBINAR_BROADCAST_VIDEO_URL,
      posterUrl: WEBINAR_BROADCAST_POSTER_URL,
      videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status,
    },
    create: {
      title: WEBINAR_TITLE,
      scheduledAt,
      durationMinutes: WEBINAR_DURATION_MINUTES,
      videoUrl: WEBINAR_BROADCAST_VIDEO_URL,
      posterUrl: WEBINAR_BROADCAST_POSTER_URL,
      videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status,
    },
  });
}
