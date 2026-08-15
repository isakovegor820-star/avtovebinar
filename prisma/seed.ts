import { Prisma, PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { getNextWebinarDate, WEBINAR_DURATION_MINUTES, WEBINAR_REPLAY_HOURS, WEBINAR_TITLE } from '../src/lib/time.js';
import { hashPassword } from '../src/lib/passwords.js';
import {
  WEBINAR_BROADCAST_POSTER_URL,
  WEBINAR_BROADCAST_VIDEO_URL,
  DEFAULT_TIMELINE_EVENTS,
  WEBINAR_VIDEO_DURATION_SECONDS,
} from '../src/lib/webinarTimeline.js';

const prisma = new PrismaClient();

type SeedAdminClient = Pick<Prisma.TransactionClient, 'adminUser' | '$executeRaw'>;
const INITIAL_OWNER_SEED_LOCK_ID = 1_096_175_682n;

export async function createInitialOwnerIfMissing(
  client: SeedAdminClient,
  adminLogin = process.env.ADMIN_LOGIN,
  adminPassword = process.env.ADMIN_PASSWORD,
) {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${INITIAL_OWNER_SEED_LOCK_ID})`;
  const anyExistingAdmin = await client.adminUser.findFirst({ select: { id: true } });

  // ADMIN_LOGIN is configuration, not an instruction to create another owner.
  // Once the admin table is non-empty, bootstrap is permanently a no-op.
  if (anyExistingAdmin) return { created: false };

  if (!adminLogin) {
    throw new Error('ADMIN_LOGIN is required for seeding the initial owner admin user');
  }

  const adminEmail = adminLogin.includes('@') ? adminLogin.toLowerCase() : `${adminLogin}@local.admin`;
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required when creating the initial owner admin user');
  }

  try {
    await client.adminUser.create({
      data: {
        name: adminLogin,
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        role: 'owner',
        isActive: true,
      },
    });
    return { created: true };
  } catch (error) {
    // Defensive fallback for a creator outside the seed lock. Never follow a
    // unique conflict with an owner/reactivation update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { created: false };
    }
    throw error;
  }
}

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
    posterUrl: WEBINAR_BROADCAST_POSTER_URL,
    videoUrl: WEBINAR_BROADCAST_VIDEO_URL,
    hlsUrl: null,
    durationSeconds: WEBINAR_VIDEO_DURATION_SECONDS,
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

  await prisma.$transaction(tx => createInitialOwnerIfMissing(tx));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
