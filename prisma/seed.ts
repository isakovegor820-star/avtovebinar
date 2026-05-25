import { PrismaClient } from '@prisma/client';
import { getNextWebinarDate } from '../src/lib/time.js';
import { DEFAULT_TIMELINE_EVENTS } from '../src/lib/webinarTimeline.js';

const prisma = new PrismaClient();

async function main() {
  const scheduledAt = getNextWebinarDate(new Date());

  const session = await prisma.webinarSession.upsert({
    where: { scheduledAt },
    update: {
      title: 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса',
      durationMinutes: 120,
      status: 'scheduled'
    },
    create: {
      title: 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса',
      scheduledAt,
      durationMinutes: 120,
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
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
