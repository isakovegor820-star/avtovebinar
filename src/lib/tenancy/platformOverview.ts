import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';
import { getTenantAnalyticsOverview } from './analytics.js';
import { getCrmQueues } from './crm.js';
import { getCreatorWebinarReadiness } from './webinarContent.js';

const overviewQuerySchema = z.object({ webinarId: z.string().trim().min(1).max(191).optional() }).strict();

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];
const ANALYTICS_ROLES = [
  'OWNER',
  'AUTHOR',
  'ANALYST',
  'AUDITOR',
] as const satisfies readonly OrganizationMembershipRole[];
const CRM_ROLES = [
  'OWNER',
  'CRM_MANAGER',
  'ANALYST',
  'AUDITOR',
] as const satisfies readonly OrganizationMembershipRole[];

const ACTIVITY_LABELS: Record<string, string> = {
  'organization.created': 'Создана организация',
  'organization.updated': 'Обновлены настройки организации',
  'organization.invitation.created': 'Отправлено приглашение в команду',
  'organization.invitation.revoked': 'Отозвано приглашение',
  'organization.membership.role_updated': 'Изменена роль участника',
  'organization.membership.removed': 'Удалён доступ участника',
  'creator.webinar.created': 'Создан черновик вебинара',
  'creator.webinar.updated': 'Обновлён вебинар',
  'creator.webinar.published': 'Опубликован вебинар',
  'creator.webinar.archived': 'Архивирован вебинар',
  'crm.task.created': 'Создана CRM-задача',
  'crm.contact.stage_changed': 'Изменён этап контакта',
  'moderation.message.hidden': 'Скрыто сообщение',
  'moderation.message.restored': 'Восстановлено сообщение',
};

function webinarScope(context: TenantContext): Prisma.WebinarWhereInput {
  return {
    organizationId: context.organizationId,
    ...(context.role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  };
}

function organizationTimezone(settings: Prisma.JsonValue | null, fallback?: string | null) {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const candidate = (settings as Record<string, unknown>).defaultTimezone;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback || 'Europe/Moscow';
}

function safeActivityLabel(action: string) {
  return ACTIVITY_LABELS[action] || 'Обновлены данные организации';
}

export async function getPlatformOverview(
  db: PrismaClient,
  context: TenantContext,
  rawQuery: unknown,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const query = overviewQuerySchema.parse(rawQuery);
  const creatorAccess = CREATOR_ROLES.includes(context.role as (typeof CREATOR_ROLES)[number]);
  const scope = webinarScope(context);

  const organization = await db.organization.findFirst({
    where: { id: context.organizationId, status: 'ACTIVE' },
    select: { id: true, name: true, slug: true, status: true, settingsJson: true, updatedAt: true },
  });
  const user = await db.user.findFirst({
    where: { id: context.userId, status: 'ACTIVE' },
    select: { id: true, displayName: true, emailNormalized: true, mfaEnabledAt: true },
  });
  const webinars = creatorAccess
    ? await db.webinar.findMany({
        where: scope,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          title: true,
          contentStatus: true,
          visibility: true,
          freshnessStatus: true,
          mediaStatus: true,
          transcriptStatus: true,
          scenarioStatus: true,
          updatedAt: true,
        },
      })
    : [];
  const nextSession = await db.webinarSession.findFirst({
    where: {
      organizationId: context.organizationId,
      scheduledAt: { gte: now },
      lifecycleStatus: { not: 'CANCELLED' },
      webinar: {
        organizationId: context.organizationId,
        contentStatus: { not: 'ARCHIVED' },
        ...(context.role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
      },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      timezone: true,
      lifecycleStatus: true,
      durationMinutes: true,
      webinar: { select: { id: true, title: true, contentStatus: true, visibility: true } },
      _count: { select: { registrations: true } },
    },
  });
  const reviewTasks = creatorAccess
    ? await db.authorReviewTask.findMany({
        where: {
          organizationId: context.organizationId,
          status: 'PENDING',
          webinar: {
            organizationId: context.organizationId,
            ...(context.role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
          },
        },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 5,
        select: { id: true, dueAt: true, webinar: { select: { id: true, title: true } } },
      })
    : [];
  const correctionCount = creatorAccess
    ? await db.moderationCorrectionRequest.count({
        where: {
          organizationId: context.organizationId,
          status: { in: ['OPEN', 'SUBMITTED'] },
          webinar: {
            organizationId: context.organizationId,
            ...(context.role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
          },
        },
      })
    : 0;
  const auditRows = await db.auditLog.findMany({
    where: { organizationId: context.organizationId, userId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 6,
    select: {
      id: true,
      action: true,
      entityType: true,
      createdAt: true,
      user: { select: { displayName: true } },
    },
  });

  if (!organization || !user) {
    throw new AppError(404, 'Organization overview is unavailable', undefined, 'platform_overview_unavailable');
  }

  if (query.webinarId && !webinars.some(webinar => webinar.id === query.webinarId)) {
    throw new AppError(404, 'Webinar is unavailable', undefined, 'webinar_not_found');
  }

  const selectedWebinar = webinars.find(webinar => webinar.id === query.webinarId) || webinars[0] || null;
  const [readiness, analytics, crm] = await Promise.all([
    selectedWebinar ? getCreatorWebinarReadiness(db, context, selectedWebinar.id) : Promise.resolve(null),
    ANALYTICS_ROLES.includes(context.role as (typeof ANALYTICS_ROLES)[number])
      ? getTenantAnalyticsOverview(db, context, {}, now)
      : Promise.resolve(null),
    CRM_ROLES.includes(context.role as (typeof CRM_ROLES)[number])
      ? getCrmQueues(db, context, now)
      : Promise.resolve(null),
  ]);

  const attention: Array<{
    id: string;
    kind: 'warning' | 'info';
    title: string;
    detail: string;
    href: string;
  }> = [];
  if (readiness) {
    for (const blocker of readiness.blockers.slice(0, 4)) {
      attention.push({
        id: `readiness:${blocker.code}`,
        kind: 'warning',
        title: blocker.message,
        detail: `${selectedWebinar?.title || 'Вебинар'} · шаг ${blocker.step} из 8`,
        href: `creator-webinars.html#webinar=${encodeURIComponent(readiness.webinarId)}&step=${blocker.step}`,
      });
    }
  }
  for (const task of reviewTasks) {
    attention.push({
      id: `review:${task.id}`,
      kind: task.dueAt.getTime() < now.getTime() ? 'warning' : 'info',
      title: 'Проверьте юридическую актуальность',
      detail: `${task.webinar.title} · срок ${task.dueAt.toISOString().slice(0, 10)}`,
      href: `creator-webinars.html#webinar=${encodeURIComponent(task.webinar.id)}&step=2`,
    });
  }
  if (correctionCount > 0) {
    attention.push({
      id: 'corrections',
      kind: 'warning',
      title: 'Есть запросы на исправление',
      detail: `${correctionCount} открытых запросов требуют ответа автора`,
      href: 'creator-corrections.html',
    });
  }

  const publications = webinars
    .filter(webinar => webinar.contentStatus !== 'ARCHIVED' && webinar.contentStatus !== 'PUBLISHED')
    .slice(0, 5)
    .map(webinar => ({
      id: webinar.id,
      title: webinar.title,
      contentStatus: webinar.contentStatus,
      visibility: webinar.visibility,
      updatedAt: webinar.updatedAt,
      href: `creator-webinars.html#webinar=${encodeURIComponent(webinar.id)}&step=8`,
    }));

  return {
    generatedAt: now,
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.emailNormalized,
      mfaEnabled: Boolean(user.mfaEnabledAt),
    },
    membership: { id: context.membershipId, role: context.role },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      timezone: organizationTimezone(organization.settingsJson, nextSession?.timezone),
      updatedAt: organization.updatedAt,
    },
    nextSession: nextSession
      ? {
          id: nextSession.id,
          title: nextSession.title,
          scheduledAt: nextSession.scheduledAt,
          timezone: nextSession.timezone,
          lifecycleStatus: nextSession.lifecycleStatus,
          durationMinutes: nextSession.durationMinutes,
          registrationCount: nextSession._count.registrations,
          webinar: nextSession.webinar,
        }
      : null,
    webinarOptions: webinars.map(webinar => ({
      id: webinar.id,
      title: webinar.title,
      contentStatus: webinar.contentStatus,
    })),
    selectedWebinar: selectedWebinar
      ? {
          ...selectedWebinar,
          readiness,
        }
      : null,
    attention: attention.slice(0, 8),
    metrics: analytics
      ? {
          period: analytics.period,
          registrations: analytics.metrics.registrations,
          uniqueEntries: analytics.metrics.uniqueEntries,
          questions: analytics.metrics.questions,
          ctaActions: analytics.metrics.ctaActions,
        }
      : null,
    crm: crm
      ? {
          timezone: crm.timezone,
          localDate: crm.localDate,
          counts: crm.counts,
        }
      : null,
    activity: auditRows.map(row => ({
      id: row.id,
      label: safeActivityLabel(row.action),
      actor: row.user?.displayName || 'Участник команды',
      entityType: row.entityType,
      occurredAt: row.createdAt,
    })),
    publications,
  };
}
