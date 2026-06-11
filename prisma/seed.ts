import { PrismaClient } from '@prisma/client';
import { getNextWebinarDate, WEBINAR_DURATION_MINUTES, WEBINAR_REPLAY_HOURS, WEBINAR_TITLE } from '../src/lib/time.js';
import { hashPassword } from '../src/lib/passwords.js';
import {
  WEBINAR_BROADCAST_POSTER_URL,
  WEBINAR_BROADCAST_VIDEO_URL,
  WEBINAR_RECORDING_POSTER_PATH,
  WEBINAR_RECORDING_VIDEO_PATH,
  DEFAULT_TIMELINE_EVENTS,
  WEBINAR_VIDEO_DURATION_SECONDS,
} from '../src/lib/webinarTimeline.js';

const prisma = new PrismaClient();

async function main() {
  const scheduledAt = getNextWebinarDate(new Date());

  const session = await prisma.webinarSession.upsert({
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
      status: 'scheduled',
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
      status: 'scheduled',
    },
  });

  const existingTimeline = await prisma.webinarTimelineEvent.count({
    where: { webinarSessionId: session.id },
  });

  if (existingTimeline === 0) {
    await prisma.webinarTimelineEvent.createMany({
      data: DEFAULT_TIMELINE_EVENTS.map(event => ({
        webinarSessionId: session.id,
        offsetSeconds: event.offsetSeconds,
        title: event.title,
        text: event.text,
        type: event.type,
        ctaLabel: event.ctaLabel,
        ctaUrl: event.ctaUrl,
      })),
    });
  }

  const existingRecording = await prisma.webinarRecording.findFirst({
    where: { webinarSessionId: session.id },
    orderBy: { createdAt: 'asc' },
  });

  const recordingData = {
    title: session.title,
    description:
      'Запись вебинара АСПБ о том, как бухгалтеру, юристу или консультанту развиваться на рынке банкротства и передавать клиентов в партнерской модели.',
    posterUrl: WEBINAR_RECORDING_POSTER_PATH,
    videoUrl: WEBINAR_RECORDING_VIDEO_PATH,
    hlsUrl: null,
    durationSeconds: 568,
    publishedAt: new Date('2026-06-10T17:05:00.000Z'),
    visible: true,
    orderIndex: 0,
    category: 'webinar',
  };

  if (existingRecording) {
    await prisma.webinarRecording.update({
      where: { id: existingRecording.id },
      data: recordingData,
    });
  } else {
    await prisma.webinarRecording.create({
      data: {
        webinarSessionId: session.id,
        ...recordingData,
      },
    });
  }

  const adminLogin = process.env.ADMIN_LOGIN;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminLogin || !adminPassword) {
    throw new Error('ADMIN_LOGIN and ADMIN_PASSWORD are required for seeding the owner admin user');
  }
  const adminEmail = adminLogin.includes('@') ? adminLogin.toLowerCase() : `${adminLogin}@local.admin`;

  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {
      name: adminLogin,
      role: 'owner',
      isActive: true,
    },
    create: {
      name: adminLogin,
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: 'owner',
    },
  });
}

main().finally(async () => {
  await prisma.$disconnect();
});
