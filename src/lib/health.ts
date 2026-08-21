import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from './env.js';
import { verifyEmailConnectivity } from './email.js';
import { checkTelegramConnectivity } from './telegram.js';
import { EMAIL_OUTBOX_DUE_PENDING_SLA_MS, EMAIL_OUTBOX_STALE_SENDING_MS } from './emailOutboxPolicy.js';
import { USER_AUTH_EMAIL_DUE_PENDING_SLA_MS, USER_AUTH_EMAIL_STALE_SENDING_MS } from './tenancy/userAuthEmailOutbox.js';
import {
  ORGANIZATION_INVITATION_EMAIL_DUE_PENDING_SLA_MS,
  ORGANIZATION_INVITATION_EMAIL_STALE_SENDING_MS,
} from './tenancy/organizationInvitationEmailOutbox.js';
import {
  WEBINAR_ACCESS_EMAIL_DUE_PENDING_SLA_MS,
  WEBINAR_ACCESS_EMAIL_STALE_SENDING_MS,
} from './tenancy/webinarAccessInvitationEmailOutbox.js';

type HealthCheck = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

const DEPENDENCY_DATA_TIMEOUT_MS = 3500;

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function checkDatabase(): Promise<HealthCheck> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2500, 'database');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkSmtp(): Promise<HealthCheck> {
  try {
    const result = await withTimeout(verifyEmailConnectivity(), 3500, 'smtp');
    return { ...result, ok: result.mode === 'send' };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkTelegram(): Promise<HealthCheck> {
  try {
    const result = await withTimeout(checkTelegramConnectivity(), 3500, 'telegram');
    return { ...result, ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkEmailOutbox(now = new Date()): Promise<HealthCheck> {
  try {
    const staleSendingBefore = new Date(now.getTime() - EMAIL_OUTBOX_STALE_SENDING_MS);
    const [pending, failed, deadLetter, sending, staleSending, oldestScheduledDue, oldestUnscheduledDue] =
      await withTimeout(
        Promise.all([
          prisma.emailOutboxJob.count({ where: { status: 'pending' } }),
          prisma.emailOutboxJob.count({ where: { status: 'failed', nextAttemptAt: null, sentAt: null } }),
          prisma.emailOutboxJob.count({ where: { status: 'dead_letter', sentAt: null } }),
          prisma.emailOutboxJob.count({ where: { status: 'sending', sentAt: null } }),
          prisma.emailOutboxJob.count({
            where: { status: 'sending', sentAt: null, updatedAt: { lt: staleSendingBefore } },
          }),
          prisma.emailOutboxJob.findFirst({
            where: {
              status: { in: ['pending', 'failed'] },
              sentAt: null,
              nextAttemptAt: { lte: now },
            },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
            select: { nextAttemptAt: true, createdAt: true },
          }),
          prisma.emailOutboxJob.findFirst({
            where: { status: 'pending', sentAt: null, nextAttemptAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { nextAttemptAt: true, createdAt: true },
          }),
        ]),
        DEPENDENCY_DATA_TIMEOUT_MS,
        'email outbox health',
      );

    const scheduledDueAt = oldestScheduledDue?.nextAttemptAt ?? null;
    const unscheduledDueAt = oldestUnscheduledDue?.createdAt ?? null;
    const oldestDuePendingAt =
      [scheduledDueAt, unscheduledDueAt]
        .filter((value): value is Date => value instanceof Date)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const oldestDuePendingAgeMs = oldestDuePendingAt ? Math.max(0, now.getTime() - oldestDuePendingAt.getTime()) : null;
    const duePendingOverSla = oldestDuePendingAgeMs !== null && oldestDuePendingAgeMs > EMAIL_OUTBOX_DUE_PENDING_SLA_MS;

    return {
      ok: failed === 0 && deadLetter === 0 && staleSending === 0 && !duePendingOverSla,
      pending,
      failed,
      deadLetter,
      sending,
      staleSending,
      oldestDuePendingAt,
      oldestDuePendingAgeMs,
      duePendingSlaMs: EMAIL_OUTBOX_DUE_PENDING_SLA_MS,
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkUserAuthEmailOutbox(now = new Date()): Promise<HealthCheck> {
  try {
    const staleBefore = new Date(now.getTime() - USER_AUTH_EMAIL_STALE_SENDING_MS);
    const [pending, failed, deadLetter, sending, staleSending, oldestDue] = await withTimeout(
      Promise.all([
        prisma.userAuthEmailJob.count({ where: { status: 'PENDING' } }),
        prisma.userAuthEmailJob.count({ where: { status: 'FAILED' } }),
        prisma.userAuthEmailJob.count({ where: { status: 'DEAD_LETTER' } }),
        prisma.userAuthEmailJob.count({ where: { status: 'SENDING' } }),
        prisma.userAuthEmailJob.count({ where: { status: 'SENDING', claimedAt: { lt: staleBefore } } }),
        prisma.userAuthEmailJob.findFirst({
          where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: { nextAttemptAt: true },
        }),
      ]),
      DEPENDENCY_DATA_TIMEOUT_MS,
      'user auth email outbox health',
    );
    const oldestDuePendingAt = oldestDue?.nextAttemptAt ?? null;
    const oldestDuePendingAgeMs = oldestDuePendingAt ? Math.max(0, now.getTime() - oldestDuePendingAt.getTime()) : null;
    const duePendingOverSla =
      oldestDuePendingAgeMs !== null && oldestDuePendingAgeMs > USER_AUTH_EMAIL_DUE_PENDING_SLA_MS;
    return {
      ok: failed === 0 && deadLetter === 0 && staleSending === 0 && !duePendingOverSla,
      pending,
      failed,
      deadLetter,
      sending,
      staleSending,
      oldestDuePendingAt,
      oldestDuePendingAgeMs,
      duePendingSlaMs: USER_AUTH_EMAIL_DUE_PENDING_SLA_MS,
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkOrganizationInvitationEmailOutbox(now = new Date()): Promise<HealthCheck> {
  try {
    const staleBefore = new Date(now.getTime() - ORGANIZATION_INVITATION_EMAIL_STALE_SENDING_MS);
    const [pending, failed, deadLetter, sending, staleSending, oldestDue] = await withTimeout(
      Promise.all([
        prisma.organizationInvitationEmailJob.count({ where: { status: 'PENDING' } }),
        prisma.organizationInvitationEmailJob.count({ where: { status: 'FAILED' } }),
        prisma.organizationInvitationEmailJob.count({ where: { status: 'DEAD_LETTER' } }),
        prisma.organizationInvitationEmailJob.count({ where: { status: 'SENDING' } }),
        prisma.organizationInvitationEmailJob.count({ where: { status: 'SENDING', claimedAt: { lt: staleBefore } } }),
        prisma.organizationInvitationEmailJob.findFirst({
          where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: { nextAttemptAt: true },
        }),
      ]),
      DEPENDENCY_DATA_TIMEOUT_MS,
      'organization invitation email outbox health',
    );
    const oldestDuePendingAt = oldestDue?.nextAttemptAt ?? null;
    const oldestDuePendingAgeMs = oldestDuePendingAt ? Math.max(0, now.getTime() - oldestDuePendingAt.getTime()) : null;
    const duePendingOverSla =
      oldestDuePendingAgeMs !== null && oldestDuePendingAgeMs > ORGANIZATION_INVITATION_EMAIL_DUE_PENDING_SLA_MS;
    return {
      ok: failed === 0 && deadLetter === 0 && staleSending === 0 && !duePendingOverSla,
      pending,
      failed,
      deadLetter,
      sending,
      staleSending,
      oldestDuePendingAt,
      oldestDuePendingAgeMs,
      duePendingSlaMs: ORGANIZATION_INVITATION_EMAIL_DUE_PENDING_SLA_MS,
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkWebinarAccessInvitationEmailOutbox(now = new Date()): Promise<HealthCheck> {
  try {
    const staleBefore = new Date(now.getTime() - WEBINAR_ACCESS_EMAIL_STALE_SENDING_MS);
    const [pending, failed, deadLetter, sending, staleSending, oldestDue] = await withTimeout(
      Promise.all([
        prisma.webinarAccessInvitationEmailJob.count({ where: { status: 'PENDING' } }),
        prisma.webinarAccessInvitationEmailJob.count({ where: { status: 'FAILED' } }),
        prisma.webinarAccessInvitationEmailJob.count({ where: { status: 'DEAD_LETTER' } }),
        prisma.webinarAccessInvitationEmailJob.count({ where: { status: 'SENDING' } }),
        prisma.webinarAccessInvitationEmailJob.count({ where: { status: 'SENDING', claimedAt: { lt: staleBefore } } }),
        prisma.webinarAccessInvitationEmailJob.findFirst({
          where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
          orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: { nextAttemptAt: true },
        }),
      ]),
      DEPENDENCY_DATA_TIMEOUT_MS,
      'webinar access invitation email outbox health',
    );
    const oldestDuePendingAt = oldestDue?.nextAttemptAt ?? null;
    const oldestDuePendingAgeMs = oldestDuePendingAt ? Math.max(0, now.getTime() - oldestDuePendingAt.getTime()) : null;
    const duePendingOverSla =
      oldestDuePendingAgeMs !== null && oldestDuePendingAgeMs > WEBINAR_ACCESS_EMAIL_DUE_PENDING_SLA_MS;
    return {
      ok: failed === 0 && deadLetter === 0 && staleSending === 0 && !duePendingOverSla,
      pending,
      failed,
      deadLetter,
      sending,
      staleSending,
      oldestDuePendingAt,
      oldestDuePendingAgeMs,
      duePendingSlaMs: WEBINAR_ACCESS_EMAIL_DUE_PENDING_SLA_MS,
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

type WorkerSubsystem = 'reminders' | 'broadcast' | 'news' | 'botAdmin' | 'botParticipant' | 'botConsultant';

type WorkerSubsystemHealthCheck = HealthCheck & {
  expected?: WorkerSubsystem[];
  missing?: WorkerSubsystem[];
  stale?: WorkerSubsystem[];
  states?: Array<{
    subsystem: WorkerSubsystem;
    lastProgressAt: Date;
    deadlineAt: Date;
  }>;
};

export function expectedWorkerSubsystems(): WorkerSubsystem[] {
  const expected: WorkerSubsystem[] = ['reminders'];
  if (env.TELEGRAM_MANUAL_BROADCAST === 'on' || env.TELEGRAM_NEWS_BROADCAST === 'on') {
    expected.push('broadcast');
  }
  if (env.TELEGRAM_NEWS_BROADCAST === 'on') {
    expected.push('news');
  }
  if (env.TELEGRAM_ADMIN_BOT_POLLING === 'on') {
    expected.push('botAdmin');
  }
  if (
    env.TELEGRAM_PARTICIPANT_BOT_POLLING === 'on' ||
    (!env.TELEGRAM_PARTICIPANT_BOT_TOKEN && env.TELEGRAM_BOT_POLLING === 'on')
  ) {
    expected.push('botParticipant');
  }
  if (env.TELEGRAM_CONSULTANT_BOT_POLLING === 'on') {
    expected.push('botConsultant');
  }
  return expected;
}

export async function checkWorkerSubsystems(now = new Date()): Promise<WorkerSubsystemHealthCheck> {
  const expected = expectedWorkerSubsystems();
  try {
    const states = await withTimeout(
      prisma.$queryRaw<Array<{ subsystem: WorkerSubsystem; lastProgressAt: Date; deadlineAt: Date }>>(
        Prisma.sql`
          SELECT
            "subsystem",
            "last_progress_at" AS "lastProgressAt",
            "deadline_at" AS "deadlineAt"
          FROM "worker_subsystem_health"
          WHERE "subsystem" IN (${Prisma.join(expected)})
        `,
      ),
      DEPENDENCY_DATA_TIMEOUT_MS,
      'worker subsystem health',
    );
    const bySubsystem = new Map(states.map(state => [state.subsystem, state]));
    const missing = expected.filter(subsystem => !bySubsystem.has(subsystem));
    const stale = states.filter(state => state.deadlineAt.getTime() < now.getTime()).map(state => state.subsystem);
    return { ok: missing.length === 0 && stale.length === 0, expected, missing, stale, states };
  } catch (error) {
    return { ok: false, error: normalizeError(error), expected };
  }
}

function workerSubsystemsAreHealthy(check: WorkerSubsystemHealthCheck, subsystems: WorkerSubsystem[]) {
  if (check.error) return false;
  const unhealthy = new Set([...(check.missing ?? []), ...(check.stale ?? [])]);
  return subsystems.every(subsystem => !unhealthy.has(subsystem));
}

export async function getReadiness() {
  const database = await checkDatabase();
  const checks = { database };
  return {
    ok: Object.values(checks).every(check => check.ok),
    checks,
  };
}

export async function getDependencyStatus() {
  const [
    smtp,
    telegramProvider,
    emailOutboxQueue,
    userAuthEmailOutboxQueue,
    organizationInvitationEmailOutboxQueue,
    webinarAccessInvitationEmailOutboxQueue,
    workerSubsystems,
  ] = await Promise.all([
    checkSmtp(),
    checkTelegram(),
    checkEmailOutbox(),
    checkUserAuthEmailOutbox(),
    checkOrganizationInvitationEmailOutbox(),
    checkWebinarAccessInvitationEmailOutbox(),
    checkWorkerSubsystems(),
  ]);
  const expectedTelegramSubsystems = (workerSubsystems.expected ?? []).filter(subsystem => subsystem !== 'reminders');
  const telegram = {
    ...telegramProvider,
    ok: telegramProvider.ok && workerSubsystemsAreHealthy(workerSubsystems, expectedTelegramSubsystems),
  };
  const emailOutbox = {
    ...emailOutboxQueue,
    ok: emailOutboxQueue.ok && workerSubsystemsAreHealthy(workerSubsystems, ['reminders']),
  };
  const userAuthEmailOutbox = {
    ...userAuthEmailOutboxQueue,
    ok: userAuthEmailOutboxQueue.ok && workerSubsystemsAreHealthy(workerSubsystems, ['reminders']),
  };
  const organizationInvitationEmailOutbox = {
    ...organizationInvitationEmailOutboxQueue,
    ok: organizationInvitationEmailOutboxQueue.ok && workerSubsystemsAreHealthy(workerSubsystems, ['reminders']),
  };
  const webinarAccessInvitationEmailOutbox = {
    ...webinarAccessInvitationEmailOutboxQueue,
    ok: webinarAccessInvitationEmailOutboxQueue.ok && workerSubsystemsAreHealthy(workerSubsystems, ['reminders']),
  };
  const checks = {
    smtp,
    telegram,
    emailOutbox,
    userAuthEmailOutbox,
    organizationInvitationEmailOutbox,
    webinarAccessInvitationEmailOutbox,
    workerSubsystems,
  };
  return {
    ok: Object.values(checks).every(check => check.ok),
    checks,
  };
}

const DEPENDENCY_CACHE_TTL_MS = 30_000;
let dependencyCache: { expiresAt: number; value: Awaited<ReturnType<typeof getDependencyStatus>> } | null = null;
let dependencyCheckInFlight: Promise<Awaited<ReturnType<typeof getDependencyStatus>>> | null = null;

export async function getCachedDependencyStatus(now = Date.now()) {
  if (dependencyCache && dependencyCache.expiresAt > now) {
    return dependencyCache.value;
  }

  if (!dependencyCheckInFlight) {
    dependencyCheckInFlight = getDependencyStatus()
      .then(value => {
        dependencyCache = { expiresAt: Date.now() + DEPENDENCY_CACHE_TTL_MS, value };
        return value;
      })
      .finally(() => {
        dependencyCheckInFlight = null;
      });
  }

  return dependencyCheckInFlight;
}

// Anonymous probes get only one aggregate state. Component identity, provider
// errors, queue counts, worker timestamps, addresses and configuration remain
// exclusively behind METRICS_TOKEN on /health/dependencies/details.
export async function getDependencySummary() {
  const dependencies = await getCachedDependencyStatus();
  return {
    ok: dependencies.ok,
    status: dependencies.ok ? ('ok' as const) : ('degraded' as const),
  };
}

export async function getEmailDeliveryReadiness() {
  const dependencies = await getCachedDependencyStatus();
  const available = dependencies.checks.smtp.ok && dependencies.checks.emailOutbox.ok;
  return {
    available,
    status: available ? ('ok' as const) : ('degraded' as const),
    retryAfterSeconds: available ? null : Math.ceil(DEPENDENCY_CACHE_TTL_MS / 1000),
  };
}
