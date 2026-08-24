import { isIP } from 'node:net';
import type { Prisma, PrismaClient, QuestionModerationStatus, QuestionPriority } from '@prisma/client';
import { z } from 'zod';
import { classifyLegalAdviceRequest } from '../chatPolicy.js';
import { AppError } from '../http.js';
import { deleteCacheByPrefix } from '../responseCache.js';
import type { TenantContext } from './context.js';
import { moderationUnavailable, requireCurrentModeratorMembership, writeModerationAudit } from './chatModeration.js';

const entityIdSchema = z.string().trim().min(1).max(191);
const reasonSchema = z.string().trim().min(3).max(500);
const openStatuses: QuestionModerationStatus[] = ['NEW', 'IN_REVIEW', 'ACTION_REQUIRED'];
const policyVersion = 'chat-moderator-policy-v1';
const retrievalModel = 'published-grounding-v1';

export const questionQueueSchema = z
  .object({
    queue: z.enum(['all', 'new', 'repeating', 'priority']).default('new'),
    status: z.enum(['NEW', 'IN_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'REJECTED']).optional(),
  })
  .strict();

export const updateQuestionModerationSchema = z
  .object({
    status: z.enum(['NEW', 'IN_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'REJECTED']).optional(),
    priority: z.enum(['NORMAL', 'HIGH']).optional(),
    reason: reasonSchema,
    expectedRevision: z.number().int().min(0),
  })
  .strict()
  .refine(value => value.status !== undefined || value.priority !== undefined, {
    message: 'Status or priority is required',
  });

export const generateQuestionSuggestionSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();

export const reviewQuestionSuggestionSchema = z
  .object({
    action: z.enum(['PUBLISH', 'REJECT']),
    reason: reasonSchema,
    expectedQuestionRevision: z.number().int().min(0),
  })
  .strict();

type QuestionTransaction = Prisma.TransactionClient;
type Grounding =
  | {
      type: 'transcript';
      transcriptId: string;
      transcriptVersion: number;
      segmentId: string;
      timestampSeconds: number;
      label: string;
    }
  | { type: 'source'; sourceId: string; title: string; url: string }
  | null;

type SuggestionContent = {
  answer: string;
  outcome: 'GROUNDED' | 'NO_BASIS' | 'PERSONALIZED_LEGAL_ADVICE';
  handoffRequired: boolean;
  grounding: Grounding;
};

type ScopedQuestion = {
  id: string;
  organizationId: string | null;
  webinarId: string | null;
  webinarSessionId: string;
  registrationId: string;
  text: string;
  moderationStatus: QuestionModerationStatus;
  priority: QuestionPriority;
  moderationRevision: number;
  registration: { crmContactId: string | null };
};

function parseSuggestionContent(value: Prisma.JsonValue): SuggestionContent {
  const parsed = z
    .object({
      answer: z.string().min(1).max(2_000),
      outcome: z.enum(['GROUNDED', 'NO_BASIS', 'PERSONALIZED_LEGAL_ADVICE']),
      handoffRequired: z.boolean(),
      grounding: z
        .union([
          z.object({
            type: z.literal('transcript'),
            transcriptId: z.string(),
            transcriptVersion: z.number().int().positive(),
            segmentId: z.string(),
            timestampSeconds: z.number().int().min(0),
            label: z.string(),
          }),
          z.object({
            type: z.literal('source'),
            sourceId: z.string(),
            title: z.string(),
            url: z.string().url(),
          }),
          z.null(),
        ])
        .nullable(),
    })
    .safeParse(value);
  if (!parsed.success) {
    throw new AppError(409, 'Предложение имеет неподдерживаемый формат', undefined, 'question_suggestion_invalid');
  }
  return parsed.data;
}

function safePublicSourceUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase('en-US');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      isIP(hostname) !== 0
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sourceTokens(value: string) {
  const stopWords = new Set(['котор', 'какой', 'можно', 'нужно', 'этот', 'есть', 'если', 'чтобы', 'после', 'перед']);
  return Array.from(
    new Set(
      value
        .normalize('NFKC')
        .toLocaleLowerCase('ru-RU')
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter(token => token.length >= 4)
        .map(token => token.slice(0, Math.min(token.length, 6)))
        .filter(token => !stopWords.has(token)) ?? [],
    ),
  );
}

function scoreSource(question: string, source: string) {
  const candidate = sourceTokens(source);
  return sourceTokens(question).reduce(
    (score, token) => score + (candidate.some(candidateToken => candidateToken === token) ? 1 : 0),
    0,
  );
}

function transcriptLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function serializeSuggestion(suggestion: {
  id: string;
  status: string;
  revision: number;
  contentJson: Prisma.JsonValue;
  createdAt: Date;
  reviewedAt: Date | null;
  publishedChatMessageId: string | null;
}) {
  const content = parseSuggestionContent(suggestion.contentJson);
  return {
    id: suggestion.id,
    status: suggestion.status,
    revision: suggestion.revision,
    ...content,
    createdAt: suggestion.createdAt,
    reviewedAt: suggestion.reviewedAt,
    publishedChatMessageId: suggestion.publishedChatMessageId,
  };
}

async function lockQuestion(tx: QuestionTransaction, organizationId: string, questionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`question:${organizationId}:${questionId}`}, 0))`;
}

async function findScopedQuestion(
  tx: QuestionTransaction,
  context: TenantContext,
  sessionId: string,
  questionId: string,
): Promise<ScopedQuestion> {
  const question = await tx.question.findFirst({
    where: {
      id: questionId,
      organizationId: context.organizationId,
      webinarSessionId: sessionId,
      webinarSession: { organizationId: context.organizationId },
    },
    select: {
      id: true,
      organizationId: true,
      webinarId: true,
      webinarSessionId: true,
      registrationId: true,
      text: true,
      moderationStatus: true,
      priority: true,
      moderationRevision: true,
      registration: { select: { crmContactId: true } },
    },
  });
  if (!question?.organizationId || !question.webinarId) moderationUnavailable();
  return question;
}

async function writeQuestionTransition(
  tx: QuestionTransaction,
  context: TenantContext,
  question: ScopedQuestion,
  target: { status: QuestionModerationStatus; priority: QuestionPriority },
  reason: string,
  source: string,
  forceRevision = false,
) {
  const changed = question.moderationStatus !== target.status || question.priority !== target.priority;
  if (!changed && !forceRevision) return question;
  const updated = await tx.question.update({
    where: { id: question.id },
    data: {
      moderationStatus: target.status,
      priority: target.priority,
      handledByMembershipId: context.membershipId,
      moderationRevision: { increment: 1 },
    },
    select: {
      id: true,
      organizationId: true,
      webinarId: true,
      webinarSessionId: true,
      registrationId: true,
      text: true,
      moderationStatus: true,
      priority: true,
      moderationRevision: true,
      registration: { select: { crmContactId: true } },
    },
  });
  const event = await tx.questionModerationEvent.create({
    data: {
      organizationId: context.organizationId,
      webinarId: question.webinarId!,
      webinarSessionId: question.webinarSessionId,
      registrationId: question.registrationId,
      questionId: question.id,
      actorMembershipId: context.membershipId,
      fromStatus: question.moderationStatus,
      toStatus: updated.moderationStatus,
      fromPriority: question.priority,
      toPriority: updated.priority,
      reason,
      source,
      correlationId: context.correlationId,
    },
  });
  if (question.registration.crmContactId) {
    await tx.cRMContactEvent.upsert({
      where: {
        organizationId_dedupKey: {
          organizationId: context.organizationId,
          dedupKey: `question-moderation:${question.id}:${updated.moderationRevision}`,
        },
      },
      create: {
        organizationId: context.organizationId,
        contactId: question.registration.crmContactId,
        type: 'question_moderation',
        source,
        sourceEntityType: 'question_moderation_event',
        sourceEntityId: event.id,
        webinarId: question.webinarId,
        webinarSessionId: question.webinarSessionId,
        registrationId: question.registrationId,
        actorUserId: context.userId,
        correlationId: context.correlationId,
        dedupKey: `question-moderation:${question.id}:${updated.moderationRevision}`,
        occurredAt: event.createdAt,
        metadataJson: {
          questionId: question.id,
          fromStatus: question.moderationStatus,
          toStatus: updated.moderationStatus,
          fromPriority: question.priority,
          toPriority: updated.priority,
        },
      },
      update: {},
    });
  }
  await writeModerationAudit(
    tx,
    context,
    'chat.question.moderated',
    'question',
    question.id,
    {
      status: question.moderationStatus,
      priority: question.priority,
      revision: question.moderationRevision,
    },
    {
      status: updated.moderationStatus,
      priority: updated.priority,
      revision: updated.moderationRevision,
      reason,
      source,
    },
  );
  return updated;
}

export async function listModerationQuestions(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const query = questionQueueSchema.parse(input);
  await requireCurrentModeratorMembership(db, context);
  const session = await db.webinarSession.findFirst({
    where: { id: sessionId, organizationId: context.organizationId },
    select: { id: true, webinarId: true, title: true, scheduledAt: true, timezone: true },
  });
  if (!session) moderationUnavailable();
  const statusFilter = query.status
    ? { moderationStatus: query.status }
    : query.queue === 'new'
      ? { moderationStatus: 'NEW' as const }
      : query.queue === 'priority' || query.queue === 'repeating'
        ? { moderationStatus: { in: openStatuses } }
        : {};
  const questions = await db.question.findMany({
    where: {
      organizationId: context.organizationId,
      webinarId: session.webinarId,
      webinarSessionId: session.id,
      ...statusFilter,
      ...(query.queue === 'priority' ? { priority: 'HIGH' as const } : {}),
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 250,
    include: {
      aiSuggestions: {
        where: { type: 'CHAT_MODERATOR_REPLY' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  const fingerprints = questions
    .map(question => question.textFingerprint)
    .filter((value): value is string => Boolean(value));
  const repeatedCounts = fingerprints.length
    ? await db.question.groupBy({
        by: ['textFingerprint'],
        where: {
          organizationId: context.organizationId,
          webinarSessionId: session.id,
          textFingerprint: { in: fingerprints },
        },
        _count: { _all: true },
      })
    : [];
  const countByFingerprint = new Map(repeatedCounts.map(row => [row.textFingerprint, row._count._all]));
  const items = questions
    .map(question => ({
      id: question.id,
      registrationId: question.registrationId,
      text: question.text,
      participantLabel: question.publishedName || 'Участник',
      showToParticipants: question.showToParticipants,
      status: question.moderationStatus,
      priority: question.priority,
      revision: question.moderationRevision,
      repeatCount: question.textFingerprint ? (countByFingerprint.get(question.textFingerprint) ?? 1) : 1,
      createdAt: question.createdAt,
      suggestion: question.aiSuggestions[0] ? serializeSuggestion(question.aiSuggestions[0]) : null,
    }))
    .filter(question => query.queue !== 'repeating' || question.repeatCount > 1);
  return { session, queue: query.queue, questions: items };
}

export async function updateModerationQuestion(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  questionIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const questionId = entityIdSchema.parse(questionIdInput);
  const command = updateQuestionModerationSchema.parse(input);
  return db.$transaction(async tx => {
    await requireCurrentModeratorMembership(tx as unknown as PrismaClient, context);
    await lockQuestion(tx, context.organizationId, questionId);
    const question = await findScopedQuestion(tx, context, sessionId, questionId);
    if (question.moderationRevision !== command.expectedRevision) {
      throw new AppError(409, 'Вопрос уже изменён другим модератором', undefined, 'question_revision_conflict');
    }
    if (
      (command.status === undefined || command.status === question.moderationStatus) &&
      (command.priority === undefined || command.priority === question.priority)
    ) {
      throw new AppError(409, 'Состояние вопроса уже установлено', undefined, 'question_state_unchanged');
    }
    return writeQuestionTransition(
      tx,
      context,
      question,
      {
        status: command.status ?? question.moderationStatus,
        priority: command.priority ?? question.priority,
      },
      command.reason,
      'tenant_moderation',
    );
  });
}

type TranscriptHit = {
  segmentId: string;
  transcriptId: string;
  transcriptVersion: number;
  startMs: number;
  text: string;
};

async function groundedContent(
  tx: QuestionTransaction,
  question: ScopedQuestion,
): Promise<SuggestionContent & { transcriptId: string | null }> {
  if (classifyLegalAdviceRequest(question.text) === 'PERSONALIZED_LEGAL_ADVICE') {
    return {
      answer:
        'Этот вопрос требует оценки индивидуальной ситуации. AI-модератор не формирует персональную юридическую рекомендацию; передайте вопрос автору.',
      outcome: 'PERSONALIZED_LEGAL_ADVICE',
      handoffRequired: true,
      grounding: null,
      transcriptId: null,
    };
  }

  const transcriptHits = await tx.$queryRaw<TranscriptHit[]>`
    SELECT
      segment."id" AS "segmentId",
      transcript."id" AS "transcriptId",
      transcript."version" AS "transcriptVersion",
      segment."start_ms" AS "startMs",
      segment."text" AS "text"
    FROM "transcript_segments" AS segment
    JOIN "transcripts" AS transcript
      ON transcript."id" = segment."transcript_id"
      AND transcript."organization_id" = segment."organization_id"
    WHERE transcript."organization_id" = ${question.organizationId!}
      AND transcript."webinar_id" = ${question.webinarId!}
      AND transcript."status" = 'published'
      AND segment."search_vector" @@ to_tsquery(
        'russian',
        array_to_string(tsvector_to_array(to_tsvector('russian', ${question.text})), ' | ')
      )
    ORDER BY transcript."version" DESC,
      ts_rank_cd(
        segment."search_vector",
        to_tsquery('russian', array_to_string(tsvector_to_array(to_tsvector('russian', ${question.text})), ' | '))
      ) DESC,
      segment."start_ms" ASC
    LIMIT 1
  `;
  const transcriptHit = transcriptHits[0];
  if (transcriptHit) {
    const timestampSeconds = Math.floor(transcriptHit.startMs / 1_000);
    const excerpt =
      transcriptHit.text.length > 360 ? `${transcriptHit.text.slice(0, 357).trim()}…` : transcriptHit.text;
    return {
      answer: `В опубликованной расшифровке найден связанный фрагмент: «${excerpt}». Проверьте контекст на таймкоде ${transcriptLabel(timestampSeconds)}.`,
      outcome: 'GROUNDED',
      handoffRequired: false,
      grounding: {
        type: 'transcript',
        transcriptId: transcriptHit.transcriptId,
        transcriptVersion: transcriptHit.transcriptVersion,
        segmentId: transcriptHit.segmentId,
        timestampSeconds,
        label: transcriptLabel(timestampSeconds),
      },
      transcriptId: transcriptHit.transcriptId,
    };
  }

  const sources = await tx.webinarSource.findMany({
    where: { organizationId: question.organizationId!, webinarId: question.webinarId! },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, title: true, url: true, note: true },
  });
  const sourceHit = sources
    .map(source => ({
      ...source,
      safeUrl: safePublicSourceUrl(source.url),
      score: scoreSource(question.text, `${source.title} ${source.note || ''}`),
    }))
    .filter(source => source.safeUrl && source.score > 0)
    .sort((left, right) => right.score - left.score)[0];
  if (sourceHit?.safeUrl) {
    return {
      answer: `В разрешённых материалах вебинара найден источник «${sourceHit.title}». Откройте источник и проверьте применимость к вопросу.`,
      outcome: 'GROUNDED',
      handoffRequired: false,
      grounding: { type: 'source', sourceId: sourceHit.id, title: sourceHit.title, url: sourceHit.safeUrl },
      transcriptId: null,
    };
  }
  return {
    answer:
      'В опубликованной расшифровке и разрешённых источниках нет достаточного основания для ответа. Передайте вопрос автору.',
    outcome: 'NO_BASIS',
    handoffRequired: true,
    grounding: null,
    transcriptId: null,
  };
}

export async function generateGroundedQuestionSuggestion(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  questionIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const questionId = entityIdSchema.parse(questionIdInput);
  const command = generateQuestionSuggestionSchema.parse(input);
  return db.$transaction(async tx => {
    await requireCurrentModeratorMembership(tx as unknown as PrismaClient, context);
    await lockQuestion(tx, context.organizationId, questionId);
    let question = await findScopedQuestion(tx, context, sessionId, questionId);
    if (question.moderationRevision !== command.expectedRevision) {
      throw new AppError(409, 'Вопрос уже изменён другим модератором', undefined, 'question_revision_conflict');
    }
    if (question.moderationStatus === 'RESOLVED' || question.moderationStatus === 'REJECTED') {
      throw new AppError(409, 'Сначала верните вопрос в рабочую очередь', undefined, 'question_terminal_state');
    }
    const existing = await tx.aiSuggestion.findFirst({
      where: {
        organizationId: context.organizationId,
        questionId: question.id,
        questionRevision: question.moderationRevision,
        type: 'CHAT_MODERATOR_REPLY',
      },
    });
    if (existing) return serializeSuggestion(existing);

    const content = await groundedContent(tx, question);
    const targetStatus: QuestionModerationStatus = content.handoffRequired ? 'ACTION_REQUIRED' : 'IN_REVIEW';
    question = await writeQuestionTransition(
      tx,
      context,
      question,
      { status: targetStatus, priority: question.priority },
      content.handoffRequired
        ? 'Вопрос передан человеку: автоматический ответ запрещён или не имеет основания'
        : 'Подготовлено основанное предложение для проверки модератором',
      'grounded_moderator_policy',
    );
    const provenance = await tx.aiOperationProvenance.create({
      data: {
        organizationId: context.organizationId,
        webinarId: question.webinarId!,
        transcriptId: content.transcriptId,
        operationType: 'CHAT_MODERATOR_GROUNDED_REPLY',
        providerId: 'local_policy',
        modelId: retrievalModel,
        templateVersion: policyVersion,
        inputRefsJson: {
          questionId: question.id,
          questionRevision: question.moderationRevision,
          webinarSessionId: question.webinarSessionId,
          transcriptId: content.transcriptId,
          sourceId: content.grounding?.type === 'source' ? content.grounding.sourceId : null,
        },
        status: 'succeeded',
        reviewStatus: 'pending',
        completedAt: new Date(),
      },
    });
    const suggestion = await tx.aiSuggestion.create({
      data: {
        organizationId: context.organizationId,
        webinarId: question.webinarId!,
        webinarSessionId: question.webinarSessionId,
        registrationId: question.registrationId,
        questionId: question.id,
        questionRevision: question.moderationRevision,
        transcriptId: content.transcriptId,
        provenanceId: provenance.id,
        type: 'CHAT_MODERATOR_REPLY',
        contentJson: {
          answer: content.answer,
          outcome: content.outcome,
          handoffRequired: content.handoffRequired,
          grounding: content.grounding,
        },
        targetEntityType: 'question',
        targetEntityId: question.id,
      },
    });
    await writeModerationAudit(
      tx,
      context,
      'chat.question.suggestion_created',
      'ai_suggestion',
      suggestion.id,
      {},
      {
        questionId: question.id,
        outcome: content.outcome,
        groundingType: content.grounding?.type ?? null,
        autoPublished: false,
      },
    );
    return serializeSuggestion(suggestion);
  });
}

export async function reviewGroundedQuestionSuggestion(
  db: PrismaClient,
  context: TenantContext,
  sessionIdInput: unknown,
  questionIdInput: unknown,
  suggestionIdInput: unknown,
  input: unknown,
) {
  const sessionId = entityIdSchema.parse(sessionIdInput);
  const questionId = entityIdSchema.parse(questionIdInput);
  const suggestionId = entityIdSchema.parse(suggestionIdInput);
  const command = reviewQuestionSuggestionSchema.parse(input);
  const result = await db.$transaction(async tx => {
    await requireCurrentModeratorMembership(tx as unknown as PrismaClient, context);
    await lockQuestion(tx, context.organizationId, questionId);
    const question = await findScopedQuestion(tx, context, sessionId, questionId);
    if (question.moderationRevision !== command.expectedQuestionRevision) {
      throw new AppError(409, 'Вопрос уже изменён другим модератором', undefined, 'question_revision_conflict');
    }
    const suggestion = await tx.aiSuggestion.findFirst({
      where: {
        id: suggestionId,
        organizationId: context.organizationId,
        webinarId: question.webinarId!,
        webinarSessionId: sessionId,
        questionId: question.id,
        questionRevision: question.moderationRevision,
        type: 'CHAT_MODERATOR_REPLY',
      },
    });
    if (!suggestion) moderationUnavailable();
    if (suggestion.status !== 'PENDING') {
      throw new AppError(409, 'Предложение уже рассмотрено', undefined, 'question_suggestion_already_reviewed');
    }
    const content = parseSuggestionContent(suggestion.contentJson);
    let publishedChatMessageId: string | null = null;
    if (command.action === 'PUBLISH') {
      const message = await tx.webinarChatMessage.create({
        data: {
          webinarSessionId: question.webinarSessionId,
          organizationId: context.organizationId,
          webinarId: question.webinarId!,
          registrationId: null,
          kind: 'ai_moderator',
          messageType: 'AI_MODERATOR',
          authorName: 'AI-модератор',
          authorRole: 'AI-модератор',
          message: content.answer,
          isSynthetic: true,
          visibleAt: new Date(),
          metadataJson: {
            replyToQuestionId: question.id,
            suggestionId: suggestion.id,
            reviewedByMembershipId: context.membershipId,
            policyOutcome: content.outcome,
            grounding: content.grounding,
          },
        },
      });
      publishedChatMessageId = message.id;
    }
    const reviewed = await tx.aiSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: command.action === 'PUBLISH' ? 'ACCEPTED' : 'REJECTED',
        reviewedByUserId: context.userId,
        reviewedAt: new Date(),
        publishedChatMessageId,
      },
    });
    await tx.aiOperationProvenance.update({
      where: { id: suggestion.provenanceId },
      data: { reviewStatus: command.action === 'PUBLISH' ? 'accepted' : 'rejected' },
    });
    const updatedQuestion = await writeQuestionTransition(
      tx,
      context,
      question,
      {
        status: command.action === 'PUBLISH' && !content.handoffRequired ? 'RESOLVED' : 'ACTION_REQUIRED',
        priority: question.priority,
      },
      command.reason,
      'tenant_moderation_review',
      true,
    );
    await writeModerationAudit(
      tx,
      context,
      command.action === 'PUBLISH' ? 'chat.question.suggestion_published' : 'chat.question.suggestion_rejected',
      'ai_suggestion',
      suggestion.id,
      { status: suggestion.status, publishedChatMessageId: null },
      { status: reviewed.status, publishedChatMessageId, reason: command.reason },
    );
    return { suggestion: serializeSuggestion(reviewed), question: updatedQuestion };
  });
  if (result.suggestion.publishedChatMessageId) {
    deleteCacheByPrefix(`webinar-chat-real:${sessionId}:`);
  }
  return result;
}
