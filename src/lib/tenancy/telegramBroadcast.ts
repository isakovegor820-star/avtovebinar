import crypto from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { MARKETING_TELEGRAM_CONSENT } from '../consentDocuments.js';
import { env } from '../env.js';
import { AppError } from '../http.js';
import { ANONYMIZED_LEAD_EMAIL_SUFFIX, isParticipantRegistrationActive } from '../leadSecurity.js';
import { TELEGRAM_BINDING_VERSION } from '../roomLinks.js';
import { createAccessToken, hashToken } from '../tokens.js';
import { canAccessRegisteredWebinar } from './webinarAccess.js';
import { requireTenantRole, type TenantContext } from './context.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_TENANT_BROADCAST_RECIPIENTS = 2_000;
const APPROVED_TEMPLATE_VARIABLES = [
  'participant_name',
  'webinar_title',
  'session_datetime',
  'room_link',
] as const;
const approvedVariables = new Set<string>(APPROVED_TEMPLATE_VARIABLES);
const idSchema = z.string().trim().min(1).max(191);
const templateTextSchema = z.string().normalize('NFKC').trim().min(3).max(2_800);
const templateInputSchema = z
  .object({
    name: z.string().normalize('NFKC').trim().min(1).max(120),
    text: templateTextSchema,
  })
  .strict();
const previewInputSchema = z
  .object({
    templateId: idSchema,
    webinarId: idSchema,
    webinarSessionId: idSchema,
    segment: z.literal('registered_session'),
  })
  .strict();
const confirmInputSchema = z
  .object({
    previewId: idSchema,
    previewToken: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/),
    confirm: z.literal(true),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
const cancelInputSchema = z.object({ reason: z.string().normalize('NFKC').trim().min(3).max(500) }).strict();

type TenantBroadcastDb = Prisma.TransactionClient | PrismaClient;

type TenantBroadcastCandidate = {
  registrationId: string;
  leadId: string;
  crmContactId: string | null;
  chatId: string;
  consentRecordId: string;
  consentDocumentVersion: string;
};

function broadcastUnavailable(): never {
  throw new AppError(404, 'Telegram-рассылка недоступна', undefined, 'tenant_telegram_broadcast_unavailable');
}

function templateUnavailable(): never {
  throw new AppError(404, 'Шаблон Telegram недоступен', undefined, 'tenant_telegram_template_unavailable');
}

function parseTemplateVariables(text: string) {
  const variables = [...text.matchAll(/\{\{([a-z_]+)\}\}/gu)].map(match => match[1]!);
  const withoutApproved = text.replace(/\{\{(?:participant_name|webinar_title|session_datetime|room_link)\}\}/gu, '');
  if (withoutApproved.includes('{{') || withoutApproved.includes('}}') || variables.some(value => !approvedVariables.has(value))) {
    throw new AppError(400, 'Шаблон содержит неизвестную или некорректную переменную', undefined, 'telegram_template_variable_invalid');
  }
  return [...new Set(variables)].sort();
}

function validatePublishableTemplate(text: string) {
  const variables = parseTemplateVariables(text);
  if (!variables.includes('room_link')) {
    throw new AppError(400, 'Опубликованный шаблон должен содержать {{room_link}}', undefined, 'telegram_template_link_required');
  }
  return variables;
}

async function requireCurrentTenantMembership(
  tx: TenantBroadcastDb,
  context: TenantContext,
  roles: Array<'OWNER' | 'CRM_MANAGER'>,
) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: roles },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!membership) broadcastUnavailable();
  return membership;
}

function templateProjection(template: {
  id: string;
  name: string;
  text: string;
  variablesJson: Prisma.JsonValue;
  version: number;
  status: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: template.id,
    name: template.name,
    text: template.text,
    variables: template.variablesJson,
    version: template.version,
    status: template.status,
    publishedAt: template.publishedAt,
    archivedAt: template.archivedAt,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function jobProjection(job: {
  id: string;
  webinarId: string | null;
  webinarSessionId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  segmentKey: string | null;
  status: string;
  total: number;
  sent: number;
  failed: number;
  nextIndex: number;
  attempts: number;
  pauseRequestedAt: Date | null;
  pausedAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    webinarId: job.webinarId,
    webinarSessionId: job.webinarSessionId,
    templateId: job.templateId,
    templateVersion: job.templateVersion,
    segment: job.segmentKey,
    status: job.status,
    progress: {
      total: job.total,
      processed: job.nextIndex,
      sent: job.sent,
      failed: job.failed,
      remaining: Math.max(0, job.total - job.nextIndex),
    },
    attempts: job.attempts,
    pauseRequestedAt: job.pauseRequestedAt,
    pausedAt: job.pausedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    cancelledAt: job.cancelledAt,
    cancelReason: job.cancelReason,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function collectTenantBroadcastCandidates(
  db: TenantBroadcastDb,
  input: { organizationId: string; webinarId: string; webinarSessionId: string },
  now: Date,
) {
  const registrations = await db.registration.findMany({
    where: {
      organizationId: input.organizationId,
      webinarId: input.webinarId,
      webinarSessionId: input.webinarSessionId,
      status: 'registered',
      emailVerifiedAt: { not: null },
      webinarSession: {
        organizationId: input.organizationId,
        webinarId: input.webinarId,
        lifecycleStatus: { not: 'CANCELLED' },
        webinar: { contentStatus: 'PUBLISHED', archivedAt: null },
      },
      lead: {
        telegramChatId: { not: null },
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
        marketingTelegramConsent: true,
        marketingTelegramConsentAt: { not: null },
        marketingTelegramRevokedAt: null,
        personalDataConsentRevokedAt: null,
        email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
        consentRecords: {
          some: {
            kind: 'marketing_telegram',
            action: 'grant',
            documentId: MARKETING_TELEGRAM_CONSENT.id,
            documentVersion: MARKETING_TELEGRAM_CONSENT.version,
          },
        },
      },
    },
    include: {
      lead: {
        include: {
          consentRecords: {
            where: {
              kind: 'marketing_telegram',
              action: 'grant',
              documentId: MARKETING_TELEGRAM_CONSENT.id,
              documentVersion: MARKETING_TELEGRAM_CONSENT.version,
            },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      },
      webinarSession: { include: { webinar: { select: { visibility: true } } } },
    },
    orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    take: MAX_TENANT_BROADCAST_RECIPIENTS + 1,
  });
  if (registrations.length > MAX_TENANT_BROADCAST_RECIPIENTS) {
    throw new AppError(409, 'Сегмент превышает безопасный лимит рассылки', undefined, 'tenant_telegram_segment_too_large');
  }
  const candidates: TenantBroadcastCandidate[] = [];
  const seenChatIds = new Set<string>();
  for (const registration of registrations) {
    if (!isParticipantRegistrationActive(registration)) continue;
    if (
      registration.webinarSession.webinar.visibility === 'PRIVATE' &&
      !(await canAccessRegisteredWebinar(db, registration, now))
    ) {
      continue;
    }
    const chatId = registration.lead.telegramChatId;
    const consent = registration.lead.consentRecords[0];
    if (!chatId || !consent || seenChatIds.has(chatId)) continue;
    seenChatIds.add(chatId);
    candidates.push({
      registrationId: registration.id,
      leadId: registration.leadId,
      crmContactId: registration.crmContactId,
      chatId,
      consentRecordId: consent.id,
      consentDocumentVersion: consent.documentVersion,
    });
  }
  return candidates;
}

function tenantBroadcastSnapshotHash(candidates: TenantBroadcastCandidate[]) {
  const digest = crypto.createHmac('sha256', env.IP_HASH_SECRET);
  for (const candidate of candidates) {
    const chatHash = crypto.createHmac('sha256', env.IP_HASH_SECRET).update(`telegram-broadcast-chat:v1:${candidate.chatId}`).digest('hex');
    digest.update(
      [candidate.registrationId, candidate.leadId, candidate.crmContactId ?? '', candidate.consentRecordId, chatHash].join('|'),
    );
    digest.update('\n');
  }
  return digest.digest('hex');
}

export async function createTenantTelegramBroadcastTemplate(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
) {
  requireTenantRole(context, ['OWNER']);
  const data = templateInputSchema.parse(input);
  const variables = parseTemplateVariables(data.text);
  return db.$transaction(async tx => {
    await requireCurrentTenantMembership(tx, context, ['OWNER']);
    const latest = await tx.telegramBroadcastTemplate.findFirst({
      where: { organizationId: context.organizationId, name: data.name },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const template = await tx.telegramBroadcastTemplate.create({
      data: {
        organizationId: context.organizationId,
        name: data.name,
        text: data.text,
        variablesJson: variables,
        version: (latest?.version ?? 0) + 1,
        createdByMembershipId: context.membershipId,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'telegram.broadcast_template.created',
        entityType: 'telegram_broadcast_template',
        entityId: template.id,
        afterJson: { name: template.name, version: template.version, variables },
      },
    });
    return templateProjection(template);
  });
}

export async function listTenantTelegramBroadcastTemplates(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, ['OWNER', 'CRM_MANAGER']);
  await requireCurrentTenantMembership(db, context, ['OWNER', 'CRM_MANAGER']);
  const templates = await db.telegramBroadcastTemplate.findMany({
    where: { organizationId: context.organizationId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return templates.map(templateProjection);
}

export async function publishTenantTelegramBroadcastTemplate(
  db: PrismaClient,
  context: TenantContext,
  templateIdInput: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const templateId = idSchema.parse(templateIdInput);
  return db.$transaction(async tx => {
    await requireCurrentTenantMembership(tx, context, ['OWNER']);
    const template = await tx.telegramBroadcastTemplate.findFirst({
      where: { id: templateId, organizationId: context.organizationId },
    });
    if (!template) templateUnavailable();
    if (template.status === 'published') return { template: templateProjection(template), replayed: true };
    if (template.status !== 'draft') templateUnavailable();
    const variables = validatePublishableTemplate(template.text);
    const published = await tx.telegramBroadcastTemplate.update({
      where: { id: template.id },
      data: {
        status: 'published',
        variablesJson: variables,
        publishedByMembershipId: context.membershipId,
        publishedAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'telegram.broadcast_template.published',
        entityType: 'telegram_broadcast_template',
        entityId: template.id,
        afterJson: { name: template.name, version: template.version, variables },
      },
    });
    return { template: templateProjection(published), replayed: false };
  });
}

export async function previewTenantTelegramBroadcast(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const data = previewInputSchema.parse(input);
  if (env.TELEGRAM_MANUAL_BROADCAST !== 'on') {
    throw new AppError(503, 'Tenant Telegram broadcast is disabled', undefined, 'tenant_telegram_broadcast_disabled');
  }
  return db.$transaction(
    async tx => {
      await requireCurrentTenantMembership(tx, context, ['OWNER']);
      const [template, session] = await Promise.all([
        tx.telegramBroadcastTemplate.findFirst({
          where: { id: data.templateId, organizationId: context.organizationId, status: 'published' },
        }),
        tx.webinarSession.findFirst({
          where: {
            id: data.webinarSessionId,
            webinarId: data.webinarId,
            organizationId: context.organizationId,
            lifecycleStatus: { not: 'CANCELLED' },
            webinar: { contentStatus: 'PUBLISHED', archivedAt: null },
          },
          select: { id: true },
        }),
      ]);
      if (!template || !session) broadcastUnavailable();
      validatePublishableTemplate(template.text);
      const candidates = await collectTenantBroadcastCandidates(
        tx,
        { organizationId: context.organizationId, webinarId: data.webinarId, webinarSessionId: data.webinarSessionId },
        now,
      );
      const rawToken = createAccessToken();
      const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
      const preview = await tx.telegramBroadcastPreview.create({
        data: {
          organizationId: context.organizationId,
          webinarId: data.webinarId,
          webinarSessionId: data.webinarSessionId,
          templateId: template.id,
          templateVersion: template.version,
          segmentKey: data.segment,
          total: candidates.length,
          snapshotHash: tenantBroadcastSnapshotHash(candidates),
          tokenHash: hashToken(rawToken),
          expiresAt,
          createdByMembershipId: context.membershipId,
          correlationId: context.correlationId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'telegram.broadcast.previewed',
          entityType: 'telegram_broadcast_preview',
          entityId: preview.id,
          afterJson: {
            webinarId: data.webinarId,
            webinarSessionId: data.webinarSessionId,
            templateId: template.id,
            templateVersion: template.version,
            segment: data.segment,
            total: candidates.length,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
      return {
        previewId: preview.id,
        previewToken: rawToken,
        expiresAt,
        total: candidates.length,
        segment: data.segment,
        template: { id: template.id, name: template.name, version: template.version, text: template.text },
        webinarId: data.webinarId,
        webinarSessionId: data.webinarSessionId,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 },
  );
}

export async function confirmTenantTelegramBroadcast(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  requireTenantRole(context, ['OWNER']);
  const data = confirmInputSchema.parse(input);
  if (env.TELEGRAM_MANUAL_BROADCAST !== 'on') {
    throw new AppError(503, 'Tenant Telegram broadcast is disabled', undefined, 'tenant_telegram_broadcast_disabled');
  }
  const scopedIdempotencyKey = `tenant:${context.organizationId}:${data.idempotencyKey}`;
  return db.$transaction(
    async tx => {
      await requireCurrentTenantMembership(tx, context, ['OWNER']);
      const duplicate = await tx.telegramBroadcastJob.findUnique({ where: { idempotencyKey: scopedIdempotencyKey } });
      if (duplicate) {
        if (duplicate.organizationId !== context.organizationId) broadcastUnavailable();
        return { job: jobProjection(duplicate), replayed: true };
      }
      await tx.$queryRaw`SELECT "id" FROM "telegram_broadcast_previews" WHERE "id" = ${data.previewId} FOR UPDATE`;
      const preview = await tx.telegramBroadcastPreview.findFirst({
        where: {
          id: data.previewId,
          organizationId: context.organizationId,
          tokenHash: hashToken(data.previewToken),
          consumedAt: null,
          expiresAt: { gt: now },
          createdByMembershipId: context.membershipId,
        },
      });
      if (!preview) broadcastUnavailable();
      const template = await tx.telegramBroadcastTemplate.findFirst({
        where: {
          id: preview.templateId,
          organizationId: context.organizationId,
          version: preview.templateVersion,
          status: 'published',
        },
      });
      if (!template) broadcastUnavailable();
      const candidates = await collectTenantBroadcastCandidates(
        tx,
        {
          organizationId: context.organizationId,
          webinarId: preview.webinarId,
          webinarSessionId: preview.webinarSessionId,
        },
        now,
      );
      if (candidates.length !== preview.total || tenantBroadcastSnapshotHash(candidates) !== preview.snapshotHash) {
        throw new AppError(409, 'Состав сегмента изменился. Выполните preview повторно.', undefined, 'tenant_telegram_preview_stale');
      }
      const job = await tx.telegramBroadcastJob.create({
        data: {
          status: candidates.length > 0 ? 'pending' : 'completed',
          kind: 'marketing_telegram',
          text: template.text,
          chatIds: [],
          recipientSnapshot: Prisma.DbNull,
          consentDocumentId: MARKETING_TELEGRAM_CONSENT.id,
          consentDocumentVersion: MARKETING_TELEGRAM_CONSENT.version,
          organizationId: context.organizationId,
          webinarId: preview.webinarId,
          webinarSessionId: preview.webinarSessionId,
          requesterMembershipId: context.membershipId,
          templateId: template.id,
          templateVersion: template.version,
          segmentKey: preview.segmentKey,
          previewId: preview.id,
          correlationId: context.correlationId,
          idempotencyKey: scopedIdempotencyKey,
          total: candidates.length,
          nextAttemptAt: candidates.length > 0 ? now : null,
          completedAt: candidates.length > 0 ? null : now,
        },
      });
      if (candidates.length > 0) {
        await tx.telegramBroadcastRecipient.createMany({
          data: candidates.map(candidate => ({
            jobId: job.id,
            leadId: candidate.leadId,
            organizationId: context.organizationId,
            webinarId: preview.webinarId,
            webinarSessionId: preview.webinarSessionId,
            registrationId: candidate.registrationId,
            crmContactId: candidate.crmContactId,
            chatId: candidate.chatId,
            consentRecordId: candidate.consentRecordId,
            consentDocumentVersion: candidate.consentDocumentVersion,
            inclusionReason: 'exact registered WebinarSession with current Telegram marketing consent',
            correlationId: context.correlationId,
          })),
        });
      }
      await tx.telegramBroadcastPreview.update({ where: { id: preview.id }, data: { consumedAt: now } });
      await tx.telegramBotEvent.create({
        data: {
          organizationId: context.organizationId,
          webinarId: preview.webinarId,
          webinarSessionId: preview.webinarSessionId,
          membershipId: context.membershipId,
          botIdentity: 'PARTICIPANT',
          direction: 'INTERNAL',
          eventType: 'tenant_broadcast_queued',
          correlationId: context.correlationId,
          dedupKey: `tenant-broadcast:${job.id}:queued`,
          status: job.status,
          metadataJson: { total: candidates.length, segment: preview.segmentKey, templateVersion: template.version },
          occurredAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'telegram.broadcast.confirmed',
          entityType: 'telegram_broadcast_job',
          entityId: job.id,
          afterJson: {
            webinarId: preview.webinarId,
            webinarSessionId: preview.webinarSessionId,
            templateId: template.id,
            templateVersion: template.version,
            segment: preview.segmentKey,
            total: candidates.length,
          },
        },
      });
      return { job: jobProjection(job), replayed: false };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 },
  );
}

export async function listTenantTelegramBroadcastJobs(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, ['OWNER', 'CRM_MANAGER']);
  await requireCurrentTenantMembership(db, context, ['OWNER', 'CRM_MANAGER']);
  const jobs = await db.telegramBroadcastJob.findMany({
    where: { organizationId: context.organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return jobs.map(jobProjection);
}

async function mutateTenantBroadcastControl(
  db: PrismaClient,
  context: TenantContext,
  jobIdInput: unknown,
  action: 'pause' | 'resume' | 'cancel',
  input: unknown,
  now: Date,
) {
  requireTenantRole(context, ['OWNER']);
  const jobId = idSchema.parse(jobIdInput);
  const cancelData = action === 'cancel' ? cancelInputSchema.parse(input) : null;
  return db.$transaction(async tx => {
    await requireCurrentTenantMembership(tx, context, ['OWNER']);
    await tx.$queryRaw`SELECT "id" FROM "telegram_broadcast_jobs" WHERE "id" = ${jobId} FOR UPDATE`;
    const job = await tx.telegramBroadcastJob.findFirst({ where: { id: jobId, organizationId: context.organizationId } });
    if (!job) broadcastUnavailable();
    let updated = job;
    let replayed = false;
    if (action === 'pause') {
      if (job.status === 'paused' || job.pauseRequestedAt) {
        replayed = true;
      } else if (['pending', 'failed'].includes(job.status)) {
        updated = await tx.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            status: 'paused',
            pauseRequestedAt: now,
            pauseRequestedByMembershipId: context.membershipId,
            pausedAt: now,
            pausedByMembershipId: context.membershipId,
            nextAttemptAt: null,
            claimToken: null,
          },
        });
      } else if (job.status === 'sending') {
        updated = await tx.telegramBroadcastJob.update({
          where: { id: job.id },
          data: { pauseRequestedAt: now, pauseRequestedByMembershipId: context.membershipId },
        });
      } else {
        broadcastUnavailable();
      }
    } else if (action === 'resume') {
      if (job.status === 'pending' && !job.pauseRequestedAt) {
        replayed = true;
      } else if (job.status === 'paused') {
        updated = await tx.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            pauseRequestedAt: null,
            pauseRequestedByMembershipId: null,
            pausedAt: null,
            pausedByMembershipId: null,
            nextAttemptAt: now,
          },
        });
      } else {
        broadcastUnavailable();
      }
    } else {
      if (job.status === 'cancelled' || job.cancelRequestedAt) {
        replayed = true;
      } else if (['pending', 'failed', 'paused'].includes(job.status)) {
        updated = await tx.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            status: 'cancelled',
            cancelRequestedAt: now,
            cancelRequestedByMembershipId: context.membershipId,
            cancelledAt: now,
            cancelledByMembershipId: context.membershipId,
            cancelReason: cancelData!.reason,
            completedAt: now,
            nextAttemptAt: null,
            claimToken: null,
          },
        });
        await tx.telegramBroadcastRecipient.updateMany({
          where: { jobId: job.id, status: 'pending' },
          data: { status: 'cancelled', cancelledAt: now, lastError: 'broadcast_cancelled_by_owner' },
        });
      } else if (job.status === 'sending') {
        updated = await tx.telegramBroadcastJob.update({
          where: { id: job.id },
          data: {
            cancelRequestedAt: now,
            cancelRequestedByMembershipId: context.membershipId,
            cancelReason: cancelData!.reason,
          },
        });
      } else {
        broadcastUnavailable();
      }
    }
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: `telegram.broadcast.${action}${replayed ? '_replayed' : ''}`,
        entityType: 'telegram_broadcast_job',
        entityId: job.id,
        beforeJson: { status: job.status },
        afterJson: { status: updated.status, requested: Boolean(updated.pauseRequestedAt || updated.cancelRequestedAt) },
      },
    });
    return { job: jobProjection(updated), replayed };
  });
}

export function pauseTenantTelegramBroadcast(
  db: PrismaClient,
  context: TenantContext,
  jobId: unknown,
  now = new Date(),
) {
  return mutateTenantBroadcastControl(db, context, jobId, 'pause', {}, now);
}

export function resumeTenantTelegramBroadcast(
  db: PrismaClient,
  context: TenantContext,
  jobId: unknown,
  now = new Date(),
) {
  return mutateTenantBroadcastControl(db, context, jobId, 'resume', {}, now);
}

export function cancelTenantTelegramBroadcast(
  db: PrismaClient,
  context: TenantContext,
  jobId: unknown,
  input: unknown,
  now = new Date(),
) {
  return mutateTenantBroadcastControl(db, context, jobId, 'cancel', input, now);
}
