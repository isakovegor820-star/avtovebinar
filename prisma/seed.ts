import { PrismaClient } from '@prisma/client';
import { getNextWebinarDate, WEBINAR_REPLAY_HOURS } from '../src/lib/time.js';
import { hashPassword } from '../src/lib/passwords.js';
import { DEFAULT_TIMELINE_EVENTS } from '../src/lib/webinarTimeline.js';

const prisma = new PrismaClient();

async function main() {
  const scheduledAt = getNextWebinarDate(new Date());

  const session = await prisma.webinarSession.upsert({
    where: { scheduledAt },
    update: {
      title: 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса',
      durationMinutes: 120,
      videoUrl: '/crisis_premium/assets/webinar.mp4',
      videoDurationSeconds: 568,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status: 'scheduled'
    },
    create: {
      title: 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса',
      scheduledAt,
      durationMinutes: 120,
      videoUrl: '/crisis_premium/assets/webinar.mp4',
      videoDurationSeconds: 568,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status: 'scheduled'
    }
  });

  const existingTimeline = await prisma.webinarTimelineEvent.count({
    where: { webinarSessionId: session.id }
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
        ctaUrl: event.ctaUrl
      }))
    });
  }

  const adminLogin = process.env.ADMIN_LOGIN || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminEmail = adminLogin.includes('@') ? adminLogin.toLowerCase() : `${adminLogin}@local.admin`;

  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {
      name: adminLogin,
      role: 'owner',
      isActive: true
    },
    create: {
      name: adminLogin,
      email: adminEmail,
      passwordHash: hashPassword(adminPassword),
      role: 'owner'
    }
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
