import crypto from 'node:crypto';
import type { OrganizationMembershipRole, Prisma, PrismaClient, WebinarTranscriptStatus } from '@prisma/client';
import { env } from '../env.js';
import { AppError } from '../http.js';
import {
  getSpeechToTextAdapter,
  SpeechToTextProviderError,
  type SpeechToTextAdapter,
  type SpeechToTextInput,
  type SpeechToTextSegment,
} from '../speechToText.js';
import { requireTenantRole, type TenantContext } from './context.js';
import { processAiEnrichmentJob } from './transcriptEnrichment.js';
import type { ContentEnrichmentAdapter } from '../contentEnrichment.js';
import { getTenantRolloutDecision } from './rolloutPolicy.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];
const MAX_SEGMENTS = 5_000;
const CONTENT_JOB_LEASE_MS = 2 * 60 * 1000;

const transcriptInclude = {
  segments: { orderBy: { orderIndex: 'asc' as const } },
  aiOperations: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.TranscriptInclude;

async function requireCreator(db: PrismaClient, context: TenantContext) {
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

function creatorWebinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

function unavailable(): never {
  throw new AppError(404, 'Transcript not found', undefined, 'transcript_not_found');
}

function conflict(): never {
  throw new AppError(
    409,
    'Расшифровка уже изменилась. Обновите данные и повторите.',
    undefined,
    'transcript_revision_conflict',
  );
}

type TranscriptWithDetails = Prisma.TranscriptGetPayload<{ include: typeof transcriptInclude }>;

function publicTranscript(transcript: TranscriptWithDetails) {
  return {
    id: transcript.id,
    webinarId: transcript.webinarId,
    mediaAssetId: transcript.mediaAssetId,
    version: transcript.version,
    revision: transcript.revision,
    status: transcript.status,
    language: transcript.language,
    reviewedByUserId: transcript.reviewedByUserId,
    reviewedAt: transcript.reviewedAt,
    publishedAt: transcript.publishedAt,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
    segments: transcript.segments.map(segment => ({
      id: segment.id,
      orderIndex: segment.orderIndex,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker: segment.speaker,
      text: segment.text,
    })),
    provenance: transcript.aiOperations.map(operation => ({
      id: operation.id,
      operationType: operation.operationType,
      providerId: operation.providerId,
      modelId: operation.modelId,
      providerModelVersion: operation.providerModelVersion,
      templateVersion: operation.templateVersion,
      inputRefs: operation.inputRefsJson,
      status: operation.status,
      reviewStatus: operation.reviewStatus,
      startedAt: operation.startedAt,
      completedAt: operation.completedAt,
    })),
  };
}

function normalizeSegments(segments: SpeechToTextSegment[], durationSeconds: number) {
  if (!segments.length || segments.length > MAX_SEGMENTS) {
    throw new AppError(422, 'Расшифровка не содержит корректных сегментов', undefined, 'transcript_segments_invalid');
  }
  const durationMs = durationSeconds * 1_000;
  let previousEnd = 0;
  return segments.map((segment, orderIndex) => {
    const text = segment.text.trim();
    const speaker = segment.speaker?.trim() || null;
    if (
      !Number.isInteger(segment.startMs) ||
      !Number.isInteger(segment.endMs) ||
      segment.startMs < previousEnd ||
      segment.endMs <= segment.startMs ||
      segment.endMs > durationMs ||
      !text ||
      text.length > 10_000 ||
      (speaker !== null && speaker.length > 120)
    ) {
      throw new AppError(422, 'Таймкоды или текст сегментов некорректны', undefined, 'transcript_segments_invalid');
    }
    previousEnd = segment.endMs;
    return { orderIndex, startMs: segment.startMs, endMs: segment.endMs, speaker, text };
  });
}

async function persistTranscriptDraft(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  adapter: SpeechToTextAdapter,
  raw: { segments: SpeechToTextSegment[]; providerModelVersion?: string },
) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: {
      id: true,
      language: true,
      currentMediaAsset: {
        select: { id: true, status: true, audioStorageKey: true, durationSeconds: true },
      },
    },
  });
  if (!webinar) unavailable();
  const asset = webinar.currentMediaAsset;
  if (!asset || asset.status !== 'READY' || !asset.durationSeconds || !asset.audioStorageKey) {
    throw new AppError(409, 'Сначала активируйте готовое видео', undefined, 'transcript_media_not_ready');
  }

  const existing = await db.transcript.findFirst({
    where: { organizationId: context.organizationId, webinarId, mediaAssetId: asset.id },
    orderBy: { version: 'desc' },
    include: transcriptInclude,
  });
  if (existing) return { transcript: publicTranscript(existing), idempotent: true };

  const dictionary = await db.organizationTerm.findMany({
    where: { organizationId: context.organizationId },
    orderBy: [{ normalizedTerm: 'asc' }],
    select: { term: true, expansion: true, updatedAt: true },
  });
  const inputRefs = {
    webinarId,
    mediaAssetId: asset.id,
    mediaAssetVersion: 'current',
    dictionaryEntries: dictionary.length,
    dictionaryUpdatedAt: dictionary.at(-1)?.updatedAt ?? null,
    nativeDictionaryApplied: adapter.supportsNativeDictionary && dictionary.length > 0,
  };
  const segments = normalizeSegments(raw.segments, asset.durationSeconds);

  const transcript = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${webinarId}, 91827364))`;
    const lockedWebinar = await tx.webinar.findFirst({
      where: creatorWebinarWhere(context, role, webinarId),
      select: { currentMediaAssetId: true, transcriptStatus: true },
    });
    if (!lockedWebinar || lockedWebinar.currentMediaAssetId !== asset.id) {
      throw new AppError(409, 'Активное видео изменилось', undefined, 'transcript_media_changed');
    }
    const duplicate = await tx.transcript.findFirst({
      where: { organizationId: context.organizationId, webinarId, mediaAssetId: asset.id },
      orderBy: { version: 'desc' },
      include: transcriptInclude,
    });
    if (duplicate) return duplicate;
    const maxVersion = await tx.transcript.aggregate({
      where: { organizationId: context.organizationId, webinarId },
      _max: { version: true },
    });
    const created = await tx.transcript.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        mediaAssetId: asset.id,
        createdByUserId: context.userId,
        version: (maxVersion._max.version ?? 0) + 1,
        language: webinar.language,
      },
    });
    await tx.transcriptSegment.createMany({
      data: segments.map(segment => ({
        transcriptId: created.id,
        organizationId: context.organizationId,
        ...segment,
      })),
    });
    await tx.aiOperationProvenance.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        mediaAssetId: asset.id,
        transcriptId: created.id,
        operationType: 'speech_to_text',
        providerId: adapter.providerId,
        modelId: adapter.modelId,
        templateVersion: adapter.templateVersion,
        providerModelVersion: raw.providerModelVersion ?? null,
        inputRefsJson: inputRefs,
        status: 'succeeded',
        reviewStatus: 'pending',
        completedAt: new Date(),
      },
    });
    if (lockedWebinar.transcriptStatus !== 'PUBLISHED') {
      await tx.webinar.update({ where: { id: webinarId }, data: { transcriptStatus: 'DRAFT' } });
    }
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'transcript.generated',
        entityType: 'Transcript',
        entityId: created.id,
        afterJson: { webinarId, mediaAssetId: asset.id, version: created.version, segmentCount: segments.length },
      },
    });
    return tx.transcript.findUniqueOrThrow({ where: { id: created.id }, include: transcriptInclude });
  });

  return { transcript: publicTranscript(transcript), idempotent: false };
}

export async function enqueueTranscriptDraft(db: PrismaClient, context: TenantContext, webinarId: string) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: {
      id: true,
      currentMediaAsset: {
        select: { id: true, status: true, durationSeconds: true, audioStorageKey: true, speechSizeBytes: true },
      },
    },
  });
  if (!webinar) unavailable();
  const asset = webinar.currentMediaAsset;
  if (
    !asset ||
    asset.status !== 'READY' ||
    !asset.durationSeconds ||
    !asset.audioStorageKey ||
    !asset.speechSizeBytes
  ) {
    throw new AppError(409, 'Сначала активируйте готовое видео', undefined, 'transcript_media_not_ready');
  }
  const dedupKey = `transcribe:${asset.id}:v1`;
  const existing = await db.contentJob.findUnique({ where: { dedupKey } });
  if (existing) return { job: publicContentJob(existing), idempotent: true };
  const job = await db.$transaction(async tx => {
    const created = await tx.contentJob.upsert({
      where: { dedupKey },
      update: {},
      create: {
        organizationId: context.organizationId,
        webinarId,
        mediaAssetId: asset.id,
        requestedByUserId: context.userId,
        correlationId: context.correlationId,
        type: 'TRANSCRIBE',
        dedupKey,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'transcript.job.enqueued',
        entityType: 'ContentJob',
        entityId: created.id,
        afterJson: { webinarId, mediaAssetId: asset.id, type: created.type },
      },
    });
    return created;
  });
  return { job: publicContentJob(job), idempotent: false };
}

function publicContentJob(job: {
  id: string;
  webinarId: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  resultRefId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: job.id,
    webinarId: job.webinarId,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorCode: job.lastErrorCode,
    resultRefId: job.resultRefId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export async function getContentJobStatus(db: PrismaClient, context: TenantContext, jobId: string) {
  const role = await requireCreator(db, context);
  const job = await db.contentJob.findFirst({
    where: {
      id: jobId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!job) unavailable();
  return { job: publicContentJob(job) };
}

export async function requestContentJobCancellation(db: PrismaClient, context: TenantContext, jobId: string) {
  const role = await requireCreator(db, context);
  const job = await db.contentJob.findFirst({
    where: {
      id: jobId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!job) unavailable();
  if (['SUCCEEDED', 'DEAD_LETTER', 'CANCELLED'].includes(job.status)) {
    return { job: publicContentJob(job), idempotent: true };
  }
  const updated = await db.$transaction(async tx => {
    const next = await tx.contentJob.update({
      where: { id: job.id },
      data: { cancelRequestedAt: job.cancelRequestedAt ?? new Date(), nextAttemptAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'content.job.cancellation_requested',
        entityType: 'ContentJob',
        entityId: job.id,
        afterJson: { type: job.type, webinarId: job.webinarId },
      },
    });
    return next;
  });
  return { job: publicContentJob(updated), idempotent: Boolean(job.cancelRequestedAt) };
}

async function contextForContentJob(
  db: PrismaClient,
  job: {
    organizationId: string;
    requestedByUserId: string;
    correlationId: string | null;
  },
) {
  const membership = await db.organizationMembership.findFirst({
    where: {
      organizationId: job.organizationId,
      userId: job.requestedByUserId,
      role: { in: [...CREATOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
  });
  if (!membership) return null;
  return {
    userId: job.requestedByUserId,
    organizationId: job.organizationId,
    membershipId: membership.id,
    role: membership.role,
    permissions: membership.permissionsJson,
    correlationId: job.correlationId ?? `job_${crypto.randomUUID()}`,
  } satisfies TenantContext;
}

async function speechInputForJob(
  db: PrismaClient,
  context: TenantContext,
  job: { webinarId: string; mediaAssetId: string | null },
): Promise<SpeechToTextInput> {
  const role = await requireCreator(db, context);
  if (!job.mediaAssetId) {
    throw new AppError(409, 'Media asset is unavailable', undefined, 'transcript_media_not_ready');
  }
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, job.webinarId),
    select: { id: true, language: true, currentMediaAssetId: true },
  });
  if (!webinar || webinar.currentMediaAssetId !== job.mediaAssetId) {
    throw new AppError(409, 'Активное видео изменилось', undefined, 'transcript_media_changed');
  }
  const asset = await db.mediaAsset.findFirst({
    where: {
      id: job.mediaAssetId,
      organizationId: context.organizationId,
      webinarId: job.webinarId,
      status: 'READY',
    },
    select: { audioStorageKey: true, speechSizeBytes: true, durationSeconds: true },
  });
  if (!asset?.audioStorageKey || !asset.durationSeconds || !asset.speechSizeBytes) {
    throw new AppError(409, 'Private speech rendition is unavailable', undefined, 'stt_speech_rendition_unavailable');
  }
  const dictionary = await db.organizationTerm.findMany({
    where: { organizationId: context.organizationId },
    orderBy: [{ normalizedTerm: 'asc' }],
    take: 501,
    select: { term: true, expansion: true },
  });
  if (dictionary.length > 500) {
    throw new AppError(422, 'Словарь превышает допустимый лимит', undefined, 'stt_dictionary_limit_exceeded');
  }
  return {
    storageKey: asset.audioStorageKey,
    language: webinar.language,
    durationSeconds: asset.durationSeconds,
    audioSizeBytes: asset.speechSizeBytes,
    dictionary,
  };
}

export async function runContentJobOnce(
  db: PrismaClient,
  adapters: { speechToText?: SpeechToTextAdapter; contentEnrichment?: ContentEnrichmentAdapter } = {},
) {
  const now = new Date();
  await db.contentJob.updateMany({
    where: { status: 'RUNNING', claimExpiresAt: { lte: now } },
    data: {
      status: 'PENDING',
      nextAttemptAt: now,
      lastErrorCode: 'content_job_lease_expired',
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
  const claim = await (async () => {
    for (let claimAttempt = 0; claimAttempt < 16; claimAttempt += 1) {
      const candidate = await db.contentJob.findFirst({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const candidateClaimToken = crypto.randomUUID();
      const claimed = await db.contentJob.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: {
          status: 'RUNNING',
          claimedAt: now,
          claimExpiresAt: new Date(now.getTime() + CONTENT_JOB_LEASE_MS),
          claimToken: candidateClaimToken,
        },
      });
      if (claimed.count === 1) return candidate;
    }
    return null;
  })();
  if (!claim) return { checked: 0, succeeded: 0, failed: 0 };
  const candidate = claim;
  const job = await db.contentJob.findUniqueOrThrow({ where: { id: candidate.id } });
  if (!(await getTenantRolloutDecision(db, 'PROVIDER_JOBS', job.organizationId)).enabled) {
    await db.contentJob.updateMany({
      where: { id: job.id, status: 'RUNNING', claimToken: job.claimToken },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000),
        lastErrorCode: 'tenant_rollout_disabled',
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      },
    });
    return { checked: 1, succeeded: 0, failed: 0 };
  }
  const context = await contextForContentJob(db, job);
  if (!context) {
    let providerDeletedAt: Date | null = null;
    let failureCode = 'content_job_requester_ineligible';
    if (job.type === 'TRANSCRIBE' && job.providerJobId) {
      try {
        const cleanupAdapter = adapters.speechToText ?? getSpeechToTextAdapter();
        if (cleanupAdapter.providerId !== job.providerId) {
          throw new SpeechToTextProviderError('stt_provider_binding_mismatch', false);
        }
        await cleanupAdapter.delete(job.providerJobId);
        providerDeletedAt = new Date();
      } catch {
        failureCode = 'stt_provider_cleanup_failed';
      }
    }
    await db.$transaction(async tx => {
      await tx.contentJob.update({
        where: { id: job.id },
        data: {
          status: 'DEAD_LETTER',
          lastErrorCode: failureCode,
          providerState: providerDeletedAt ? 'DELETED' : job.providerState,
          providerDeletedAt,
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
          completedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          correlationId: job.correlationId,
          action: 'content.provider.dead_lettered',
          entityType: 'ContentJob',
          entityId: job.id,
          afterJson: {
            provider: job.providerId,
            failureCode,
            providerCleanup: providerDeletedAt ? 'deleted' : job.providerJobId ? 'failed' : 'not_submitted',
          },
        },
      });
    });
    return { checked: 1, succeeded: 0, failed: 1 };
  }
  const releaseClaim = {
    claimedAt: null,
    claimExpiresAt: null,
    claimToken: null,
  } as const;
  let adapter: SpeechToTextAdapter | null = null;
  try {
    if (job.type === 'TRANSCRIBE') {
      adapter = adapters.speechToText ?? getSpeechToTextAdapter();
      if (!adapter) throw new AppError(503, 'STT adapter unavailable', undefined, 'stt_provider_unconfigured');
      if (adapter.providerId === 'unconfigured') {
        throw new AppError(503, 'STT adapter unavailable', undefined, 'stt_provider_unconfigured');
      }
      const speechAdapter = adapter;
      if (job.providerId && job.providerId !== speechAdapter.providerId) {
        throw new SpeechToTextProviderError('stt_provider_binding_mismatch', false);
      }
      const input = await speechInputForJob(db, context, job);
      if (input.audioSizeBytes > speechAdapter.maxAudioSizeBytes) {
        throw new SpeechToTextProviderError('stt_audio_size_exceeded', false);
      }
      if (input.durationSeconds > speechAdapter.maxDurationSeconds) {
        throw new SpeechToTextProviderError('stt_audio_duration_exceeded', false);
      }
      if (job.cancelRequestedAt) {
        if (job.providerJobId) await speechAdapter.delete(job.providerJobId);
        await db.$transaction(async tx => {
          await tx.contentJob.update({
            where: { id: job.id },
            data: {
              status: 'CANCELLED',
              providerState: 'DELETED',
              providerDeletedAt: job.providerJobId ? new Date() : null,
              cancelledAt: new Date(),
              completedAt: new Date(),
              lastErrorCode: null,
              ...releaseClaim,
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId: job.organizationId,
              correlationId: job.correlationId,
              action: 'content.provider.cancelled',
              entityType: 'ContentJob',
              entityId: job.id,
              afterJson: {
                provider: speechAdapter.providerId,
                providerCleanup: job.providerJobId ? 'deleted' : 'not_submitted',
              },
            },
          });
        });
        return { checked: 1, succeeded: 0, failed: 0 };
      }
      if (!job.providerJobId) {
        const submitted = await speechAdapter.submit(input, job.dedupKey);
        const submittedAt = new Date();
        await db.$transaction(async tx => {
          await tx.contentJob.update({
            where: { id: job.id },
            data: {
              status: 'PENDING',
              providerId: speechAdapter.providerId,
              providerJobId: submitted.providerJobId,
              providerModelId: speechAdapter.modelId,
              providerModelVersion: submitted.providerModelVersion ?? null,
              providerState: 'SUBMITTED',
              providerSubmittedAt: submittedAt,
              providerDeadlineAt: new Date(submittedAt.getTime() + env.STT_YANDEX_TIMEOUT_SECONDS * 1_000),
              nextAttemptAt: new Date(submittedAt.getTime() + env.STT_YANDEX_POLL_INTERVAL_MS),
              lastErrorCode: null,
              ...releaseClaim,
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId: job.organizationId,
              correlationId: job.correlationId,
              action: 'content.provider.submitted',
              entityType: 'ContentJob',
              entityId: job.id,
              afterJson: {
                provider: speechAdapter.providerId,
                model: speechAdapter.modelId,
                nativeDictionaryApplied: submitted.dictionaryApplied,
              },
            },
          });
        });
        return { checked: 1, succeeded: 0, failed: 0 };
      }
      if (!job.providerResultStoredAt && job.providerDeadlineAt && job.providerDeadlineAt <= now) {
        throw new SpeechToTextProviderError('stt_provider_timeout', false);
      }
      let resultRefId = job.resultRefId;
      if (!job.providerResultStoredAt) {
        const poll = await speechAdapter.poll(job.providerJobId);
        if (poll.status === 'pending') {
          await db.contentJob.update({
            where: { id: job.id },
            data: {
              status: 'PENDING',
              providerState: 'PENDING',
              providerModelVersion: poll.providerModelVersion ?? job.providerModelVersion,
              nextAttemptAt: new Date(Date.now() + env.STT_YANDEX_POLL_INTERVAL_MS),
              lastErrorCode: null,
              ...releaseClaim,
            },
          });
          return { checked: 1, succeeded: 0, failed: 0 };
        }
        if (poll.status === 'failed') {
          throw new SpeechToTextProviderError(poll.errorCode, false);
        }
        const raw = await speechAdapter.getResult(job.providerJobId);
        const persisted = await persistTranscriptDraft(db, context, job.webinarId, speechAdapter, {
          ...raw,
          providerModelVersion:
            raw.providerModelVersion ?? poll.providerModelVersion ?? job.providerModelVersion ?? undefined,
        });
        resultRefId = persisted.transcript.id;
        await db.contentJob.update({
          where: { id: job.id },
          data: {
            resultRefId,
            providerState: 'RESULT_STORED',
            providerResultStoredAt: new Date(),
            providerModelVersion: raw.providerModelVersion ?? poll.providerModelVersion ?? job.providerModelVersion,
          },
        });
      }
      await speechAdapter.delete(job.providerJobId);
      await db.$transaction(async tx => {
        await tx.contentJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCEEDED',
            resultRefId,
            providerState: 'DELETED',
            providerDeletedAt: new Date(),
            lastErrorCode: null,
            completedAt: new Date(),
            ...releaseClaim,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: job.organizationId,
            correlationId: job.correlationId,
            action: 'content.provider.deleted',
            entityType: 'ContentJob',
            entityId: job.id,
            afterJson: { provider: speechAdapter.providerId, outcome: 'succeeded' },
          },
        });
      });
      return { checked: 1, succeeded: 1, failed: 0 };
    }
    if (job.cancelRequestedAt) {
      await db.contentJob.update({
        where: { id: job.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), completedAt: new Date(), ...releaseClaim },
      });
      return { checked: 1, succeeded: 0, failed: 0 };
    }
    if (job.type === 'AI_ENRICH') {
      const result = await processAiEnrichmentJob(db, context, job, adapters.contentEnrichment);
      await db.contentJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          resultRefId: result.resultRefId,
          lastErrorCode: null,
          completedAt: new Date(),
          ...releaseClaim,
        },
      });
      return { checked: 1, succeeded: 1, failed: 0 };
    }
    throw new AppError(500, 'Unsupported content job', undefined, 'content_job_type_unsupported');
  } catch (error) {
    const attempt = job.attempts + 1;
    const retryable = error instanceof SpeechToTextProviderError ? error.retryable : true;
    let safeCode = error instanceof AppError && error.code ? error.code : 'content_job_failed';
    let providerDeletedAt: Date | null = null;
    const terminal = !retryable || attempt >= job.maxAttempts;
    if (terminal && adapter && job.providerJobId) {
      try {
        await adapter.delete(job.providerJobId);
        providerDeletedAt = new Date();
      } catch {
        safeCode = 'stt_provider_cleanup_failed';
      }
    }
    const dead = terminal && (providerDeletedAt !== null || !job.providerJobId || attempt >= job.maxAttempts);
    await db.$transaction(async tx => {
      await tx.contentJob.update({
        where: { id: job.id },
        data: {
          status: dead ? 'DEAD_LETTER' : 'PENDING',
          attempts: { increment: 1 },
          lastErrorCode: safeCode,
          providerState: providerDeletedAt ? 'DELETED' : job.providerState,
          providerDeletedAt,
          nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** attempt) * 60_000),
          completedAt: dead ? new Date() : null,
          ...releaseClaim,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          correlationId: job.correlationId,
          action: dead ? 'content.provider.dead_lettered' : 'content.provider.retry_scheduled',
          entityType: 'ContentJob',
          entityId: job.id,
          afterJson: {
            provider: adapter?.providerId ?? null,
            attempt,
            maxAttempts: job.maxAttempts,
            failureCode: safeCode,
            providerCleanup: providerDeletedAt ? 'deleted' : job.providerJobId ? 'pending' : 'not_submitted',
          },
        },
      });
    });
    return { checked: 1, succeeded: 0, failed: 1 };
  }
}

export async function getCreatorTranscript(db: PrismaClient, context: TenantContext, webinarId: string) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: { id: true },
  });
  if (!webinar) unavailable();
  const transcript = await db.transcript.findFirst({
    where: { organizationId: context.organizationId, webinarId },
    orderBy: { version: 'desc' },
    include: transcriptInclude,
  });
  if (!transcript) unavailable();
  return { transcript: publicTranscript(transcript) };
}

export type UpdateTranscriptInput = {
  transcriptId: string;
  expectedRevision: number;
  status: Extract<WebinarTranscriptStatus, 'DRAFT' | 'REVIEWED'>;
  segments: SpeechToTextSegment[];
};

export async function updateCreatorTranscript(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  input: UpdateTranscriptInput,
) {
  const role = await requireCreator(db, context);
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${webinarId}, 91827364))`;
    const webinar = await tx.webinar.findFirst({
      where: creatorWebinarWhere(context, role, webinarId),
      select: { id: true, currentMediaAssetId: true, transcriptStatus: true },
    });
    if (!webinar) unavailable();
    const transcript = await tx.transcript.findFirst({
      where: { id: input.transcriptId, webinarId, organizationId: context.organizationId },
      include: { mediaAsset: { select: { durationSeconds: true } } },
    });
    if (!transcript) unavailable();
    const latest = await tx.transcript.findFirst({
      where: { webinarId, organizationId: context.organizationId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true, mediaAssetId: true },
    });
    const continuedDraft =
      transcript.status === 'PUBLISHED' &&
      latest?.id !== transcript.id &&
      latest?.version === transcript.version + 1 &&
      latest?.status === 'DRAFT' &&
      latest?.mediaAssetId === transcript.mediaAssetId
        ? latest
        : null;
    if (transcript.revision !== input.expectedRevision) conflict();
    if (latest?.id !== transcript.id && !continuedDraft) conflict();
    if (!transcript.mediaAsset.durationSeconds) {
      throw new AppError(409, 'Длительность видео не определена', undefined, 'transcript_media_duration_missing');
    }
    const segments = normalizeSegments(input.segments, transcript.mediaAsset.durationSeconds);
    const review =
      input.status === 'REVIEWED'
        ? { reviewedByUserId: context.userId, reviewedAt: new Date() }
        : { reviewedByUserId: null, reviewedAt: null };

    let transcriptId = transcript.id;
    if (transcript.status === 'PUBLISHED') {
      const draft = continuedDraft
        ? await tx.transcript.update({
            where: { id: continuedDraft.id },
            data: { status: input.status, ...review },
          })
        : await tx.transcript.create({
            data: {
              organizationId: context.organizationId,
              webinarId,
              mediaAssetId: transcript.mediaAssetId,
              createdByUserId: context.userId,
              version: transcript.version + 1,
              revision: 1,
              status: input.status,
              language: transcript.language,
              ...review,
            },
          });
      transcriptId = draft.id;
      if (continuedDraft) {
        await tx.transcriptSegment.deleteMany({
          where: { transcriptId: draft.id, organizationId: context.organizationId },
        });
      }
      await tx.transcriptSegment.createMany({
        data: segments.map(segment => ({
          transcriptId: draft.id,
          organizationId: context.organizationId,
          ...segment,
        })),
      });
    } else {
      const updated = await tx.transcript.updateMany({
        where: { id: transcript.id, organizationId: context.organizationId, revision: input.expectedRevision },
        data: { status: input.status, revision: { increment: 1 }, publishedAt: null, ...review },
      });
      if (updated.count !== 1) conflict();
      await tx.transcriptSegment.deleteMany({
        where: { transcriptId: transcript.id, organizationId: context.organizationId },
      });
      await tx.transcriptSegment.createMany({
        data: segments.map(segment => ({
          transcriptId: transcript.id,
          organizationId: context.organizationId,
          ...segment,
        })),
      });
    }

    if (webinar.transcriptStatus !== 'PUBLISHED') {
      await tx.webinar.update({ where: { id: webinarId }, data: { transcriptStatus: input.status } });
    }
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: input.status === 'REVIEWED' ? 'transcript.reviewed' : 'transcript.updated',
        entityType: 'Transcript',
        entityId: transcriptId,
        beforeJson: {
          transcriptId: transcript.id,
          version: transcript.version,
          revision: transcript.revision,
          status: transcript.status,
        },
        afterJson: { segmentCount: segments.length, status: input.status },
      },
    });
    return tx.transcript.findUniqueOrThrow({ where: { id: transcriptId }, include: transcriptInclude });
  });
  return { transcript: publicTranscript(result) };
}

export async function publishCreatorTranscript(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  input: { transcriptId: string; expectedRevision: number },
) {
  const role = await requireCreator(db, context);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${webinarId}, 91827364))`;
    const webinar = await tx.webinar.findFirst({
      where: creatorWebinarWhere(context, role, webinarId),
      select: { id: true },
    });
    if (!webinar) unavailable();
    const transcript = await tx.transcript.findFirst({
      where: { id: input.transcriptId, webinarId, organizationId: context.organizationId },
      include: transcriptInclude,
    });
    if (!transcript) unavailable();
    const latest = await tx.transcript.findFirst({
      where: { webinarId, organizationId: context.organizationId },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== transcript.id || transcript.revision !== input.expectedRevision) conflict();
    if (transcript.status === 'PUBLISHED') {
      return { transcript: publicTranscript(transcript), idempotent: true };
    }
    if (transcript.status !== 'REVIEWED' || transcript.segments.length === 0) {
      throw new AppError(
        409,
        'Публикация доступна только после проверки расшифровки',
        undefined,
        'transcript_review_required',
      );
    }
    await tx.transcript.updateMany({
      where: { webinarId, organizationId: context.organizationId, status: 'PUBLISHED', id: { not: transcript.id } },
      data: { status: 'REVIEWED', revision: { increment: 1 } },
    });
    const publishedAt = new Date();
    const updated = await tx.transcript.updateMany({
      where: {
        id: transcript.id,
        organizationId: context.organizationId,
        revision: input.expectedRevision,
        status: 'REVIEWED',
      },
      data: { status: 'PUBLISHED', revision: { increment: 1 }, publishedAt },
    });
    if (updated.count !== 1) conflict();
    await tx.webinar.update({ where: { id: webinarId }, data: { transcriptStatus: 'PUBLISHED' } });
    await tx.aiOperationProvenance.updateMany({
      where: { transcriptId: transcript.id, organizationId: context.organizationId, reviewStatus: 'pending' },
      data: { reviewStatus: 'accepted' },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'transcript.published',
        entityType: 'Transcript',
        entityId: transcript.id,
        beforeJson: { status: transcript.status, revision: transcript.revision },
        afterJson: { status: 'PUBLISHED', publishedAt },
      },
    });
    const published = await tx.transcript.findUniqueOrThrow({
      where: { id: transcript.id },
      include: transcriptInclude,
    });
    return { transcript: publicTranscript(published), idempotent: false };
  });
}

export async function getPublishedTranscript(db: PrismaClient, organizationId: string, webinarId: string) {
  const transcript = await db.transcript.findFirst({
    where: { organizationId, webinarId, status: 'PUBLISHED' },
    include: { segments: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!transcript) return null;
  return {
    id: transcript.id,
    version: transcript.version,
    language: transcript.language,
    publishedAt: transcript.publishedAt,
    segments: transcript.segments.map(segment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker: segment.speaker,
      text: segment.text,
    })),
  };
}

function transcriptTimestamp(milliseconds: number, separator: '.' | ',') {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function webVttText(value: string) {
  return value.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderTranscriptVtt(
  segments: Array<{ startMs: number; endMs: number; speaker?: string | null; text: string }>,
) {
  const cues = segments.map((segment, index) => {
    const speaker = segment.speaker ? `${webVttText(segment.speaker)}: ` : '';
    return `${index + 1}\n${transcriptTimestamp(segment.startMs, '.')} --> ${transcriptTimestamp(segment.endMs, '.')}\n${speaker}${webVttText(segment.text)}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export async function exportCreatorTranscript(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  format: 'txt' | 'vtt',
) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: { id: true, slug: true, title: true },
  });
  if (!webinar) unavailable();
  const transcript = await db.transcript.findFirst({
    where: { organizationId: context.organizationId, webinarId, status: 'PUBLISHED' },
    include: { segments: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!transcript) unavailable();
  if (format === 'vtt') {
    return {
      fileName: `${webinar.slug}-transcript-v${transcript.version}.vtt`,
      contentType: 'text/vtt; charset=utf-8',
      content: renderTranscriptVtt(transcript.segments),
    };
  }
  const lines = transcript.segments.map(segment => {
    const speaker = segment.speaker ? `${segment.speaker}: ` : '';
    return `[${transcriptTimestamp(segment.startMs, ',')}] ${speaker}${segment.text}`;
  });
  return {
    fileName: `${webinar.slug}-transcript-v${transcript.version}.txt`,
    contentType: 'text/plain; charset=utf-8',
    content: `${webinar.title}\n\n${lines.join('\n')}\n`,
  };
}
