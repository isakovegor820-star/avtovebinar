import { prisma } from './prisma.js';
import { getSessionStatus, WEBINAR_DURATION_MINUTES, WEBINAR_REPLAY_HOURS, WEBINAR_TITLE } from './time.js';
import { WEBINAR_VIDEO_DURATION_SECONDS, WEBINAR_VIDEO_PATH } from './webinarTimeline.js';
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
      videoDurationSeconds: WEBINAR_VIDEO_DURATION_SECONDS,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status,
    },
  });
}
