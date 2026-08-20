import type { OrganizationMembershipRole, Prisma, PrismaClient, WebinarSession } from '@prisma/client';
import { z } from 'zod';
import {
  EMAIL_JOB_REMINDER,
  EMAIL_JOB_SESSION_CANCELLED,
  EMAIL_JOB_SESSION_RESCHEDULED,
  EMAIL_OUTBOX_LINK_REDACTED,
  enqueueSessionChangeEmails,
} from '../emailOutbox.js';
import { AppError } from '../http.js';
import {
  generateRecurrenceDateKeys,
  getSessionLifecycleStatus,
  isValidIanaTimezone,
  localDateKeyAt,
  localDateTimeToUtc,
} from '../sessionScheduling.js';
import { getSessionStatus } from '../time.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const;
const idSchema = z.string().trim().min(1).max(191);
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date');
const timezoneSchema = z.string().trim().min(1).max(100).refine(isValidIanaTimezone, 'Invalid IANA timezone');
const utcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform(value => new Date(value));

const sessionPolicyFields = {
  durationMinutes: z.number().int().min(1).max(180),
  roomOpenBeforeMinutes: z.number().int().min(0).max(180),
  replayAvailableHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365),
  replayEnabled: z.boolean(),
} as const;

export const creatorScheduleCreateSchema = z
  .object({
    recurrenceType: z.enum(['ONCE', 'DAILY', 'WEEKLY']),
    timezone: timezoneSchema,
    localStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema.nullable().optional(),
    maxFutureInstances: z.number().int().min(1).max(90).optional(),
    durationMinutes: sessionPolicyFields.durationMinutes,
    roomOpenBeforeMinutes: sessionPolicyFields.roomOpenBeforeMinutes.optional(),
    replayAvailableHours: sessionPolicyFields.replayAvailableHours.optional(),
    replayEnabled: sessionPolicyFields.replayEnabled.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsOn && value.endsOn < value.startsOn) {
      context.addIssue({ code: 'custom', path: ['endsOn'], message: 'End date must not precede start date' });
    }
    if (value.recurrenceType === 'ONCE' && value.maxFutureInstances && value.maxFutureInstances !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['maxFutureInstances'],
        message: 'One-time schedules create one session',
      });
    }
  });

export const creatorSessionUpdateSchema = z
  .object({
    scheduledAt: utcDateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
    durationMinutes: sessionPolicyFields.durationMinutes.optional(),
    roomOpenBeforeMinutes: sessionPolicyFields.roomOpenBeforeMinutes.optional(),
    replayAvailableHours: sessionPolicyFields.replayAvailableHours.optional(),
    replayEnabled: sessionPolicyFields.replayEnabled.optional(),
    confirmRegisteredChange: z.boolean().optional(),
    reason: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict()
  .refine(
    value =>
      value.scheduledAt !== undefined ||
      value.timezone !== undefined ||
      value.durationMinutes !== undefined ||
      value.roomOpenBeforeMinutes !== undefined ||
      value.replayAvailableHours !== undefined ||
      value.replayEnabled !== undefined,
    'At least one session field is required',
  );

export const creatorSessionCancelSchema = z
  .object({
    confirmRegisteredChange: z.boolean().optional(),
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();

type CreatorTransaction = Prisma.TransactionClient;

function webinarUnavailable(): never {
  throw new AppError(404, 'Вебинар не найден', undefined, 'webinar_not_found');
}

function sessionUnavailable(): never {
  throw new AppError(404, 'Сессия не найдена', undefined, 'webinar_session_not_found');
}

async function requireCurrentCreatorMembership(
  db: Pick<PrismaClient, 'organizationMembership'>,
  context: TenantContext,
): Promise<OrganizationMembershipRole> {
  requireTenantRole(context, CREATOR_ROLES);
  const membership = await db.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: [...CREATOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { role: true },
  });
  if (!membership) {
    throw new AppError(403, 'Требуются права автора или владельца', undefined, 'creator_permission_denied');
  }
  return membership.role;
}

function webinarScope(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

async function lockWebinar(tx: CreatorTransaction, context: TenantContext, webinarId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "webinars"
    WHERE "id" = ${webinarId} AND "organization_id" = ${context.organizationId}
    FOR UPDATE
  `;
  if (locked.length !== 1) webinarUnavailable();
}

async function findScopedWebinar(
  db: Pick<PrismaClient, 'webinar'>,
  context: TenantContext,
  role: OrganizationMembershipRole,
  webinarId: string,
) {
  const webinar = await db.webinar.findFirst({
    where: webinarScope(context, role, webinarId),
    select: { id: true, title: true, contentStatus: true },
  });
  if (!webinar) webinarUnavailable();
  return webinar;
}

async function lockSession(tx: CreatorTransaction, context: TenantContext, sessionId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "webinar_sessions"
    WHERE "id" = ${sessionId} AND "organization_id" = ${context.organizationId}
    FOR UPDATE
  `;
  if (locked.length !== 1) sessionUnavailable();
}

async function findScopedSession(
  db: Pick<PrismaClient, 'webinarSession'>,
  context: TenantContext,
  role: OrganizationMembershipRole,
  sessionId: string,
) {
  const session = await db.webinarSession.findFirst({
    where: {
      id: sessionId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!session) sessionUnavailable();
  return session;
}

function sessionProjection(session: WebinarSession, now = new Date()) {
  return {
    id: session.id,
    webinarId: session.webinarId,
    scheduleId: session.scheduleId,
    scheduledAt: session.scheduledAt,
    timezone: session.timezone,
    durationMinutes: session.durationMinutes,
    roomOpenBeforeMinutes: session.roomOpenBeforeMinutes,
    replayAvailableHours: session.replayAvailableHours,
    replayEnabled: session.replayEnabled,
    lifecycleStatus: getSessionLifecycleStatus(session, now),
    scheduleVersion: session.scheduleVersion,
    cancelledAt: session.cancelledAt,
    cancellationReason: session.cancellationReason,
    rescheduledAt: session.rescheduledAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toDatabaseDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function recurrenceInstants(input: z.infer<typeof creatorScheduleCreateSchema>, now: Date) {
  if (input.startsOn < localDateKeyAt(now, input.timezone)) {
    throw new AppError(400, 'Дата начала расписания уже прошла', undefined, 'webinar_schedule_date_invalid');
  }
  const maxFutureInstances = input.recurrenceType === 'ONCE' ? 1 : (input.maxFutureInstances ?? 30);
  const dateKeys = generateRecurrenceDateKeys({
    recurrenceType: input.recurrenceType,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    maxFutureInstances,
  });
  let instants: Date[];
  try {
    instants = dateKeys.map(dateKey => localDateTimeToUtc(dateKey, input.localStartTime, input.timezone));
  } catch {
    throw new AppError(
      400,
      'Локальное время не существует из-за перехода часового пояса',
      undefined,
      'webinar_schedule_local_time_invalid',
    );
  }
  if (instants.length === 0 || instants.some(instant => instant.getTime() <= now.getTime())) {
    throw new AppError(400, 'Все создаваемые сессии должны быть в будущем', undefined, 'webinar_schedule_date_invalid');
  }
  return { dateKeys, instants, maxFutureInstances };
}

export async function createCreatorWebinarSchedule(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const data = creatorScheduleCreateSchema.parse(input);
  const generated = recurrenceInstants(data, now);
  return db.$transaction(async tx => {
    await lockWebinar(tx, context, webinarId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const webinar = await findScopedWebinar(tx as unknown as PrismaClient, context, role, webinarId);
    if (webinar.contentStatus === 'ARCHIVED') {
      throw new AppError(409, 'Архивному вебинару нельзя добавить расписание', undefined, 'webinar_archived');
    }
    const existingSchedule = await tx.webinarSchedule.findUnique({ where: { webinarId }, select: { id: true } });
    if (existingSchedule) {
      throw new AppError(409, 'Расписание вебинара уже существует', undefined, 'webinar_schedule_exists');
    }
    const colliding = await tx.webinarSession.count({
      where: { webinarId, scheduledAt: { in: generated.instants } },
    });
    if (colliding > 0) {
      throw new AppError(409, 'Одна из сессий уже существует', undefined, 'webinar_session_time_conflict');
    }
    const schedule = await tx.webinarSchedule.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        createdById: context.userId,
        recurrenceType: data.recurrenceType,
        timezone: data.timezone,
        localStartTime: data.localStartTime,
        startsOn: toDatabaseDate(data.startsOn),
        endsOn: data.endsOn ? toDatabaseDate(data.endsOn) : null,
        maxFutureInstances: generated.maxFutureInstances,
      },
    });
    await tx.webinarSession.createMany({
      data: generated.instants.map(scheduledAt => ({
        organizationId: context.organizationId,
        webinarId,
        scheduleId: schedule.id,
        title: webinar.title,
        scheduledAt,
        timezone: data.timezone,
        durationMinutes: data.durationMinutes,
        roomOpenBeforeMinutes: data.roomOpenBeforeMinutes ?? 15,
        replayAvailableHours: data.replayAvailableHours ?? 168,
        replayEnabled: data.replayEnabled ?? true,
        lifecycleStatus: 'SCHEDULED',
        status: 'scheduled',
      })),
    });
    const sessions = await tx.webinarSession.findMany({
      where: { scheduleId: schedule.id, organizationId: context.organizationId },
      orderBy: { scheduledAt: 'asc' },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_schedule.created',
        entityType: 'webinar_schedule',
        entityId: schedule.id,
        afterJson: {
          webinarId,
          recurrenceType: schedule.recurrenceType,
          timezone: schedule.timezone,
          startsOn: data.startsOn,
          endsOn: data.endsOn ?? null,
          sessionCount: sessions.length,
          maxFutureInstances: schedule.maxFutureInstances,
        },
      },
    });
    return {
      schedule: {
        id: schedule.id,
        recurrenceType: schedule.recurrenceType,
        timezone: schedule.timezone,
        localStartTime: schedule.localStartTime,
        startsOn: data.startsOn,
        endsOn: data.endsOn ?? null,
        maxFutureInstances: schedule.maxFutureInstances,
      },
      sessions: sessions.map(session => sessionProjection(session, now)),
    };
  });
}

export async function listCreatorWebinarSessions(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  now = new Date(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const role = await requireCurrentCreatorMembership(db, context);
  await findScopedWebinar(db, context, role, webinarId);
  const sessions = await db.webinarSession.findMany({
    where: { webinarId, organizationId: context.organizationId },
    orderBy: { scheduledAt: 'asc' },
  });
  return sessions.map(session => sessionProjection(session, now));
}

async function registrationsForNotification(tx: CreatorTransaction, sessionId: string) {
  return tx.registration.findMany({
    where: { webinarSessionId: sessionId, status: 'registered', emailVerifiedAt: { not: null } },
    select: { id: true, lead: { select: { email: true, name: true } } },
  });
}

async function assertRegisteredChangeConfirmed(
  tx: CreatorTransaction,
  sessionId: string,
  confirmed: boolean | undefined,
  reason: string | undefined,
) {
  const registrationCount = await tx.registration.count({
    where: { webinarSessionId: sessionId, status: 'registered' },
  });
  if (registrationCount > 0 && (!confirmed || !reason)) {
    throw new AppError(
      409,
      'Подтвердите изменение для зарегистрированных участников и укажите причину',
      { registrationCount },
      'session_registered_change_confirmation_required',
    );
  }
  return registrationCount;
}

async function cancelPendingSessionCommunications(tx: CreatorTransaction, sessionId: string) {
  await tx.emailOutboxJob.updateMany({
    where: {
      webinarSessionId: sessionId,
      type: { in: [EMAIL_JOB_REMINDER, EMAIL_JOB_SESSION_RESCHEDULED, EMAIL_JOB_SESSION_CANCELLED] },
      status: { in: ['pending', 'failed'] },
    },
    data: {
      status: 'cancelled',
      nextAttemptAt: null,
      lastError: 'Superseded by a newer session schedule change before delivery',
      claimToken: null,
      webinarUrl: EMAIL_OUTBOX_LINK_REDACTED,
      partnerUrl: null,
    },
  });
}

export async function updateCreatorWebinarSession(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  const sessionId = idSchema.parse(sessionIdInput);
  const data = creatorSessionUpdateSchema.parse(input);
  return db.$transaction(async tx => {
    await lockSession(tx, context, sessionId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const before = await findScopedSession(tx as unknown as PrismaClient, context, role, sessionId);
    const currentLifecycle = getSessionLifecycleStatus(before, now);
    if (!['SCHEDULED', 'ROOM_OPEN'].includes(currentLifecycle)) {
      throw new AppError(409, 'Сессию уже нельзя перенести', undefined, 'webinar_session_not_editable');
    }
    if (data.scheduledAt && data.scheduledAt.getTime() <= now.getTime()) {
      throw new AppError(400, 'Новое время должно быть в будущем', undefined, 'webinar_schedule_date_invalid');
    }
    const registrationCount = await assertRegisteredChangeConfirmed(
      tx,
      sessionId,
      data.confirmRegisteredChange,
      data.reason,
    );
    const scheduledAt = data.scheduledAt ?? before.scheduledAt;
    const timezone = data.timezone ?? before.timezone;
    const durationMinutes = data.durationMinutes ?? before.durationMinutes;
    const roomOpenBeforeMinutes = data.roomOpenBeforeMinutes ?? before.roomOpenBeforeMinutes;
    const replayAvailableHours = data.replayAvailableHours ?? before.replayAvailableHours;
    const replayEnabled = data.replayEnabled ?? before.replayEnabled;
    if (data.scheduledAt) {
      const collision = await tx.webinarSession.count({
        where: { webinarId: before.webinarId, scheduledAt: data.scheduledAt, id: { not: sessionId } },
      });
      if (collision > 0) {
        throw new AppError(
          409,
          'Сессия вэбинара на это время уже существует',
          undefined,
          'webinar_session_time_conflict',
        );
      }
    }
    const nextVersion = before.scheduleVersion + 1;
    const lifecycleStatus = getSessionLifecycleStatus(
      {
        lifecycleStatus: 'SCHEDULED',
        scheduledAt,
        durationMinutes,
        roomOpenBeforeMinutes,
        replayAvailableHours,
        replayEnabled,
      },
      now,
    );
    const updated = await tx.webinarSession.update({
      where: { id: sessionId },
      data: {
        scheduledAt,
        timezone,
        durationMinutes,
        roomOpenBeforeMinutes,
        replayAvailableHours,
        replayEnabled,
        lifecycleStatus,
        status: getSessionStatus(now, scheduledAt, durationMinutes),
        scheduleVersion: nextVersion,
        rescheduledAt: data.scheduledAt !== undefined || data.timezone !== undefined ? now : before.rescheduledAt,
      },
    });
    await cancelPendingSessionCommunications(tx, sessionId);
    const registrations = await registrationsForNotification(tx, sessionId);
    const notificationsQueued = await enqueueSessionChangeEmails(tx, {
      kind: 'rescheduled',
      webinarSessionId: sessionId,
      scheduledAt,
      scheduleVersion: nextVersion,
      registrations,
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_session.rescheduled',
        entityType: 'webinar_session',
        entityId: sessionId,
        beforeJson: {
          scheduledAt: before.scheduledAt.toISOString(),
          timezone: before.timezone,
          scheduleVersion: before.scheduleVersion,
        },
        afterJson: {
          scheduledAt: updated.scheduledAt.toISOString(),
          timezone: updated.timezone,
          scheduleVersion: updated.scheduleVersion,
          registrationCount,
          notificationsQueued,
          reason: data.reason ?? null,
        },
      },
    });
    return { session: sessionProjection(updated, now), registrationCount, notificationsQueued };
  });
}

export async function cancelCreatorWebinarSession(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  const sessionId = idSchema.parse(sessionIdInput);
  const data = creatorSessionCancelSchema.parse(input);
  return db.$transaction(async tx => {
    await lockSession(tx, context, sessionId);
    const role = await requireCurrentCreatorMembership(tx as unknown as PrismaClient, context);
    const before = await findScopedSession(tx as unknown as PrismaClient, context, role, sessionId);
    const currentLifecycle = getSessionLifecycleStatus(before, now);
    if (!['SCHEDULED', 'ROOM_OPEN'].includes(currentLifecycle)) {
      throw new AppError(409, 'Сессию уже нельзя отменить', undefined, 'webinar_session_not_editable');
    }
    const registrationCount = await assertRegisteredChangeConfirmed(
      tx,
      sessionId,
      data.confirmRegisteredChange,
      data.reason,
    );
    const nextVersion = before.scheduleVersion + 1;
    const cancelled = await tx.webinarSession.update({
      where: { id: sessionId },
      data: {
        lifecycleStatus: 'CANCELLED',
        status: 'cancelled',
        cancelledAt: now,
        cancellationReason: data.reason,
        scheduleVersion: nextVersion,
      },
    });
    await cancelPendingSessionCommunications(tx, sessionId);
    const registrations = await registrationsForNotification(tx, sessionId);
    const notificationsQueued = await enqueueSessionChangeEmails(tx, {
      kind: 'cancelled',
      webinarSessionId: sessionId,
      scheduledAt: before.scheduledAt,
      scheduleVersion: nextVersion,
      registrations,
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_session.cancelled',
        entityType: 'webinar_session',
        entityId: sessionId,
        beforeJson: {
          lifecycleStatus: currentLifecycle,
          scheduledAt: before.scheduledAt.toISOString(),
          scheduleVersion: before.scheduleVersion,
        },
        afterJson: {
          lifecycleStatus: 'CANCELLED',
          scheduleVersion: nextVersion,
          registrationCount,
          notificationsQueued,
          reason: data.reason,
        },
      },
    });
    return { session: sessionProjection(cancelled, now), registrationCount, notificationsQueued };
  });
}

export const creatorSessionIdSchema = idSchema;
