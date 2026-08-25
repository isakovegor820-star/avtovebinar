import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  getContentEnrichmentAdapter,
  type ContentEnrichmentAdapter,
  type EnrichmentSuggestion,
} from '../contentEnrichment.js';
import { AppError } from '../http.js';
import { requireTenantRole, type TenantContext } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];

const titleContentSchema = z.object({ text: z.string().trim().min(3).max(240) }).strict();
const descriptionContentSchema = z.object({ text: z.string().trim().min(10).max(8_000) }).strict();
const chapterContentSchema = z
  .object({
    startMs: z.number().int().nonnegative().max(86_400_000),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
const tagContentSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const questionContentSchema = z
  .object({
    offsetSeconds: z.number().int().nonnegative().max(86_400),
    text: z.string().trim().min(3).max(2_000),
  })
  .strict();

const providerSuggestionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('TITLE'), orderIndex: z.number().int().nonnegative(), content: titleContentSchema })
    .strict(),
  z
    .object({
      type: z.literal('DESCRIPTION'),
      orderIndex: z.number().int().nonnegative(),
      content: descriptionContentSchema,
    })
    .strict(),
  z
    .object({ type: z.literal('CHAPTER'), orderIndex: z.number().int().nonnegative(), content: chapterContentSchema })
    .strict(),
  z.object({ type: z.literal('TAG'), orderIndex: z.number().int().nonnegative(), content: tagContentSchema }).strict(),
  z
    .object({
      type: z.literal('PREPARED_QUESTION'),
      orderIndex: z.number().int().nonnegative(),
      content: questionContentSchema,
    })
    .strict(),
]);

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

function unavailable(entity = 'Suggestion'): never {
  throw new AppError(404, `${entity} not found`, undefined, 'enrichment_object_not_found');
}

function normalizeTerm(value: string) {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

function publicTerm(term: { id: string; term: string; expansion: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: term.id,
    term: term.term,
    expansion: term.expansion,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt,
  };
}

export async function listOrganizationTerms(db: PrismaClient, context: TenantContext) {
  await requireCreator(db, context);
  const terms = await db.organizationTerm.findMany({
    where: { organizationId: context.organizationId },
    orderBy: [{ normalizedTerm: 'asc' }],
  });
  return { terms: terms.map(publicTerm) };
}

export async function createOrganizationTerm(
  db: PrismaClient,
  context: TenantContext,
  input: { term: string; expansion?: string },
) {
  await requireCreator(db, context);
  const normalizedTerm = normalizeTerm(input.term);
  try {
    const term = await db.$transaction(async tx => {
      const created = await tx.organizationTerm.create({
        data: {
          organizationId: context.organizationId,
          normalizedTerm,
          term: input.term.trim(),
          expansion: input.expansion?.trim() || null,
          createdByUserId: context.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'transcript.dictionary_term.created',
          entityType: 'OrganizationTerm',
          entityId: created.id,
          afterJson: { term: created.term, expansion: created.expansion },
        },
      });
      return created;
    });
    return { term: publicTerm(term) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P2002') {
      throw new AppError(409, 'Такой термин уже есть в словаре', undefined, 'term_already_exists');
    }
    throw error;
  }
}

export async function updateOrganizationTerm(
  db: PrismaClient,
  context: TenantContext,
  termId: string,
  input: { term: string; expansion?: string },
) {
  await requireCreator(db, context);
  const existing = await db.organizationTerm.findFirst({
    where: { id: termId, organizationId: context.organizationId },
  });
  if (!existing) unavailable('Term');
  try {
    const term = await db.$transaction(async tx => {
      const updated = await tx.organizationTerm.update({
        where: { id: existing.id },
        data: {
          normalizedTerm: normalizeTerm(input.term),
          term: input.term.trim(),
          expansion: input.expansion?.trim() || null,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'transcript.dictionary_term.updated',
          entityType: 'OrganizationTerm',
          entityId: updated.id,
          beforeJson: { term: existing.term, expansion: existing.expansion },
          afterJson: { term: updated.term, expansion: updated.expansion },
        },
      });
      return updated;
    });
    return { term: publicTerm(term) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P2002') {
      throw new AppError(409, 'Такой термин уже есть в словаре', undefined, 'term_already_exists');
    }
    throw error;
  }
}

export async function deleteOrganizationTerm(db: PrismaClient, context: TenantContext, termId: string) {
  await requireCreator(db, context);
  const existing = await db.organizationTerm.findFirst({
    where: { id: termId, organizationId: context.organizationId },
  });
  if (!existing) unavailable('Term');
  await db.$transaction(async tx => {
    await tx.organizationTerm.delete({ where: { id: existing.id } });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'transcript.dictionary_term.deleted',
        entityType: 'OrganizationTerm',
        entityId: existing.id,
        beforeJson: { term: existing.term, expansion: existing.expansion },
      },
    });
  });
  return { deleted: true };
}

function publicJob(job: {
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

export async function enqueueAiSuggestions(db: PrismaClient, context: TenantContext, webinarId: string) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: { id: true },
  });
  if (!webinar) unavailable('Webinar');
  const transcript = await db.transcript.findFirst({
    where: { organizationId: context.organizationId, webinarId, status: { in: ['REVIEWED', 'PUBLISHED'] } },
    orderBy: { version: 'desc' },
  });
  if (!transcript) {
    throw new AppError(409, 'Сначала проверьте расшифровку', undefined, 'transcript_review_required');
  }
  const dedupKey = `ai_enrich:${transcript.id}:r${transcript.revision}:v1`;
  const existing = await db.contentJob.findUnique({ where: { dedupKey } });
  if (existing) return { job: publicJob(existing), idempotent: true };
  const job = await db.$transaction(async tx => {
    const created = await tx.contentJob.upsert({
      where: { dedupKey },
      update: {},
      create: {
        organizationId: context.organizationId,
        webinarId,
        mediaAssetId: transcript.mediaAssetId,
        transcriptId: transcript.id,
        requestedByUserId: context.userId,
        correlationId: context.correlationId,
        type: 'AI_ENRICH',
        dedupKey,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'ai.suggestions.job.enqueued',
        entityType: 'ContentJob',
        entityId: created.id,
        afterJson: { webinarId, transcriptId: transcript.id, transcriptRevision: transcript.revision },
      },
    });
    return created;
  });
  return { job: publicJob(job), idempotent: false };
}

export async function processAiEnrichmentJob(
  db: PrismaClient,
  context: TenantContext,
  job: { id: string; organizationId: string; webinarId: string; transcriptId: string | null },
  adapter: ContentEnrichmentAdapter = getContentEnrichmentAdapter(),
) {
  if (!job.transcriptId)
    throw new AppError(500, 'Transcript reference is missing', undefined, 'content_job_input_invalid');
  const transcript = await db.transcript.findFirst({
    where: {
      id: job.transcriptId,
      organizationId: job.organizationId,
      webinarId: job.webinarId,
      status: { in: ['REVIEWED', 'PUBLISHED'] },
    },
    include: { webinar: { select: { title: true, language: true } }, segments: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!transcript || !transcript.segments.length) {
    throw new AppError(409, 'Reviewed transcript is unavailable', undefined, 'transcript_review_required');
  }
  const dictionary = await db.organizationTerm.findMany({
    where: { organizationId: job.organizationId },
    orderBy: { normalizedTerm: 'asc' },
    select: { term: true, expansion: true, updatedAt: true },
  });
  const inputRefs = {
    webinarId: job.webinarId,
    transcriptId: transcript.id,
    transcriptVersion: transcript.version,
    transcriptRevision: transcript.revision,
    dictionaryEntries: dictionary.length,
    dictionaryUpdatedAt: dictionary.at(-1)?.updatedAt ?? null,
  };
  let suggestions: EnrichmentSuggestion[];
  let providerModelVersion: string | undefined;
  try {
    const result = await adapter.enrich({
      webinarTitle: transcript.webinar.title,
      language: transcript.webinar.language,
      segments: transcript.segments.map(segment => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      })),
      dictionary: dictionary.map(({ term, expansion }) => ({ term, expansion })),
    });
    suggestions = z.array(providerSuggestionSchema).min(1).max(100).parse(result.suggestions);
    providerModelVersion = result.providerModelVersion;
  } catch (error) {
    await db.aiOperationProvenance.create({
      data: {
        organizationId: job.organizationId,
        webinarId: job.webinarId,
        mediaAssetId: transcript.mediaAssetId,
        transcriptId: transcript.id,
        operationType: 'content_enrichment',
        providerId: adapter.providerId,
        modelId: providerModelVersion ? `${adapter.modelId}@${providerModelVersion}` : adapter.modelId,
        templateVersion: adapter.templateVersion,
        inputRefsJson: inputRefs,
        status: 'failed',
        reviewStatus: 'not_applicable',
        completedAt: new Date(),
      },
    });
    throw error;
  }
  const provenance = await db.$transaction(async tx => {
    const operation = await tx.aiOperationProvenance.create({
      data: {
        organizationId: job.organizationId,
        webinarId: job.webinarId,
        mediaAssetId: transcript.mediaAssetId,
        transcriptId: transcript.id,
        operationType: 'content_enrichment',
        providerId: adapter.providerId,
        modelId: providerModelVersion ? `${adapter.modelId}@${providerModelVersion}` : adapter.modelId,
        templateVersion: adapter.templateVersion,
        inputRefsJson: inputRefs,
        status: 'succeeded',
        reviewStatus: 'pending',
        completedAt: new Date(),
      },
    });
    await tx.aiSuggestion.createMany({
      data: suggestions.map(suggestion => ({
        organizationId: job.organizationId,
        webinarId: job.webinarId,
        transcriptId: transcript.id,
        provenanceId: operation.id,
        type: suggestion.type,
        orderIndex: suggestion.orderIndex,
        contentJson: suggestion.content,
      })),
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: job.organizationId,
        correlationId: context.correlationId,
        action: 'ai.suggestions.generated',
        entityType: 'AiOperationProvenance',
        entityId: operation.id,
        afterJson: { webinarId: job.webinarId, transcriptId: transcript.id, suggestionCount: suggestions.length },
      },
    });
    return operation;
  });
  return { resultRefId: provenance.id };
}

function publicSuggestion(suggestion: {
  id: string;
  type: string;
  status: string;
  revision: number;
  orderIndex: number;
  contentJson: Prisma.JsonValue;
  editedContentJson: Prisma.JsonValue | null;
  reviewedAt: Date | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: suggestion.id,
    type: suggestion.type,
    status: suggestion.status,
    revision: suggestion.revision,
    orderIndex: suggestion.orderIndex,
    content: suggestion.editedContentJson ?? suggestion.contentJson,
    reviewedAt: suggestion.reviewedAt,
    target: suggestion.targetEntityId ? { type: suggestion.targetEntityType, id: suggestion.targetEntityId } : null,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  };
}

export async function listAiSuggestions(db: PrismaClient, context: TenantContext, webinarId: string) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: { id: true },
  });
  if (!webinar) unavailable('Webinar');
  const suggestions = await db.aiSuggestion.findMany({
    // Participant-question moderation is a separate OWNER/MODERATOR surface.
    // Never expose those drafts through the broader creator suggestion list.
    where: { organizationId: context.organizationId, webinarId, type: { not: 'CHAT_MODERATOR_REPLY' } },
    orderBy: [{ createdAt: 'desc' }, { type: 'asc' }, { orderIndex: 'asc' }],
  });
  return { suggestions: suggestions.map(publicSuggestion) };
}

function parseSuggestionContent(type: string, value: unknown) {
  if (type === 'TITLE') return titleContentSchema.parse(value);
  if (type === 'DESCRIPTION') return descriptionContentSchema.parse(value);
  if (type === 'CHAPTER') return chapterContentSchema.parse(value);
  if (type === 'TAG') return tagContentSchema.parse(value);
  if (type === 'PREPARED_QUESTION') return questionContentSchema.parse(value);
  throw new AppError(409, 'Suggestion type is unsupported', undefined, 'suggestion_type_unsupported');
}

export async function reviewAiSuggestion(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  suggestionId: string,
  input: { expectedRevision: number; action: 'ACCEPT' | 'REJECT'; content?: unknown },
) {
  const role = await requireCreator(db, context);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${suggestionId}, 72645193))`;
    const webinar = await tx.webinar.findFirst({
      where: creatorWebinarWhere(context, role, webinarId),
      select: { id: true },
    });
    if (!webinar) unavailable('Webinar');
    const suggestion = await tx.aiSuggestion.findFirst({
      where: { id: suggestionId, organizationId: context.organizationId, webinarId },
    });
    if (!suggestion) unavailable();
    if (suggestion.type === 'CHAT_MODERATOR_REPLY' || !suggestion.transcriptId) unavailable();
    const transcriptId = suggestion.transcriptId;
    if (suggestion.status !== 'PENDING' || suggestion.revision !== input.expectedRevision) {
      throw new AppError(409, 'Предложение уже изменилось', undefined, 'suggestion_revision_conflict');
    }
    let targetEntityType: string | null = null;
    let targetEntityId: string | null = null;
    let editedContentJson: Prisma.InputJsonValue | undefined;
    if (input.action === 'ACCEPT') {
      const content = parseSuggestionContent(suggestion.type, input.content ?? suggestion.contentJson);
      editedContentJson = content;
      if (suggestion.type === 'TITLE') {
        await tx.webinar.update({
          where: { id: webinarId },
          data: { title: (content as z.infer<typeof titleContentSchema>).text, contentVersion: { increment: 1 } },
        });
        targetEntityType = 'Webinar';
        targetEntityId = webinarId;
      } else if (suggestion.type === 'DESCRIPTION') {
        await tx.webinar.update({
          where: { id: webinarId },
          data: {
            description: (content as z.infer<typeof descriptionContentSchema>).text,
            contentVersion: { increment: 1 },
          },
        });
        targetEntityType = 'Webinar';
        targetEntityId = webinarId;
      } else if (suggestion.type === 'CHAPTER') {
        const value = content as z.infer<typeof chapterContentSchema>;
        const chapterTranscript = await tx.transcript.findFirst({
          where: { id: transcriptId, webinarId, organizationId: context.organizationId },
          select: { status: true, mediaAsset: { select: { durationSeconds: true } } },
        });
        if (!chapterTranscript || chapterTranscript.status === 'PUBLISHED') {
          throw new AppError(
            409,
            'Опубликованная расшифровка неизменяема. Создайте новую версию расшифровки.',
            undefined,
            'chapter_published_immutable',
          );
        }
        if (
          !chapterTranscript.mediaAsset.durationSeconds ||
          value.startMs >= chapterTranscript.mediaAsset.durationSeconds * 1_000
        ) {
          throw new AppError(
            422,
            'Таймкод главы находится за пределами видео',
            undefined,
            'chapter_start_out_of_bounds',
          );
        }
        const max = await tx.webinarChapter.aggregate({
          where: { webinarId, transcriptId },
          _max: { orderIndex: true },
        });
        const chapter = await tx.webinarChapter.create({
          data: {
            organizationId: context.organizationId,
            webinarId,
            transcriptId,
            startMs: value.startMs,
            title: value.title,
            description: value.description ?? null,
            orderIndex: (max._max.orderIndex ?? -1) + 1,
            origin: 'AI_REVIEWED',
            createdByUserId: context.userId,
          },
        });
        targetEntityType = 'WebinarChapter';
        targetEntityId = chapter.id;
      } else if (suggestion.type === 'TAG') {
        const value = content as z.infer<typeof tagContentSchema>;
        const tag = await tx.webinarTag.upsert({
          where: { webinarId_normalizedName: { webinarId, normalizedName: normalizeTerm(value.name) } },
          update: { name: value.name },
          create: {
            organizationId: context.organizationId,
            webinarId,
            normalizedName: normalizeTerm(value.name),
            name: value.name,
          },
        });
        targetEntityType = 'WebinarTag';
        targetEntityId = tag.id;
      } else {
        const value = content as z.infer<typeof questionContentSchema>;
        const latest = await tx.chatScenario.findFirst({
          where: { webinarId, organizationId: context.organizationId, runtimeEnabled: true },
          orderBy: { version: 'desc' },
        });
        const maximum = await tx.chatScenario.aggregate({
          where: { webinarId, organizationId: context.organizationId },
          _max: { version: true },
        });
        const scenario =
          !latest || latest.status === 'PUBLISHED'
            ? await tx.chatScenario.create({
                data: {
                  organizationId: context.organizationId,
                  webinarId,
                  version: (maximum._max.version ?? 0) + 1,
                  status: 'DRAFT',
                  createdById: context.userId,
                },
              })
            : latest;
        const max = await tx.chatScenarioMessage.aggregate({
          where: { scenarioId: scenario.id },
          _max: { orderIndex: true },
        });
        const message = await tx.chatScenarioMessage.create({
          data: {
            organizationId: context.organizationId,
            scenarioId: scenario.id,
            orderIndex: (max._max.orderIndex ?? -1) + 1,
            offsetSeconds: value.offsetSeconds,
            kind: 'PREPARED_QUESTION',
            status: 'APPROVED',
            text: value.text,
            authorLabel: 'Подготовленный вопрос',
            isSynthetic: true,
            metadataJson: { source: 'ai_suggestion', suggestionId: suggestion.id },
          },
        });
        await tx.webinar.update({ where: { id: webinarId }, data: { scenarioStatus: 'DRAFT' } });
        targetEntityType = 'ChatScenarioMessage';
        targetEntityId = message.id;
      }
    }
    const reviewedAt = new Date();
    const updated = await tx.aiSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: input.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
        revision: { increment: 1 },
        editedContentJson,
        reviewedByUserId: context.userId,
        reviewedAt,
        targetEntityType,
        targetEntityId,
      },
    });
    const pending = await tx.aiSuggestion.count({
      where: { provenanceId: suggestion.provenanceId, status: 'PENDING' },
    });
    if (pending === 0) {
      await tx.aiOperationProvenance.update({
        where: { id: suggestion.provenanceId },
        data: { reviewStatus: 'accepted' },
      });
    }
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: input.action === 'ACCEPT' ? 'ai.suggestion.accepted' : 'ai.suggestion.rejected',
        entityType: 'AiSuggestion',
        entityId: suggestion.id,
        beforeJson: { status: suggestion.status, revision: suggestion.revision },
        afterJson: { status: updated.status, targetEntityType, targetEntityId },
      },
    });
    return { suggestion: publicSuggestion(updated) };
  });
}
