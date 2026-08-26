import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import {
  enqueueTranscriptDraft,
  exportCreatorTranscript,
  getContentJobStatus,
  getCreatorTranscript,
  publishCreatorTranscript,
  requestContentJobCancellation,
  updateCreatorTranscript,
} from '../lib/tenancy/transcripts.js';
import {
  createOrganizationTerm,
  deleteOrganizationTerm,
  enqueueAiSuggestions,
  listAiSuggestions,
  listOrganizationTerms,
  reviewAiSuggestion,
  updateOrganizationTerm,
} from '../lib/tenancy/transcriptEnrichment.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';
import { requireTenantRollout } from '../lib/tenancy/rolloutPolicy.js';
import {
  createCreatorWebinarChapter,
  deleteCreatorWebinarChapter,
  listCreatorWebinarChapters,
  reorderCreatorWebinarChapters,
  updateCreatorWebinarChapter,
} from '../lib/tenancy/webinarChapters.js';

export const creatorTranscriptsRouter = Router();

const idSchema = z.string().trim().min(1).max(191);
const paramsSchema = z.object({ webinarId: idSchema }).strict();
const jobParamsSchema = z.object({ jobId: idSchema }).strict();
const termParamsSchema = z.object({ termId: idSchema }).strict();
const suggestionParamsSchema = z.object({ webinarId: idSchema, suggestionId: idSchema }).strict();
const chapterParamsSchema = z.object({ webinarId: idSchema, chapterId: idSchema }).strict();
const emptyBodySchema = z.object({}).strict();
const transcriptReferenceSchema = z
  .object({
    transcriptId: idSchema,
    expectedRevision: z.number().int().positive().max(1_000_000),
  })
  .strict();
const segmentSchema = z
  .object({
    startMs: z.number().int().nonnegative().max(86_400_000),
    endMs: z.number().int().positive().max(86_400_000),
    speaker: z.string().trim().min(1).max(120).optional(),
    text: z.string().trim().min(1).max(10_000),
  })
  .strict();
const updateSchema = transcriptReferenceSchema
  .extend({
    status: z.enum(['DRAFT', 'REVIEWED']),
    segments: z.array(segmentSchema).min(1).max(5_000),
  })
  .strict();
const termSchema = z
  .object({
    term: z.string().trim().min(1).max(160),
    expansion: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const reviewSuggestionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('ACCEPT'),
      expectedRevision: z.number().int().positive(),
      content: z.unknown().optional(),
    })
    .strict(),
  z.object({ action: z.literal('REJECT'), expectedRevision: z.number().int().positive() }).strict(),
]);
const exportQuerySchema = z.object({ format: z.enum(['txt', 'vtt']) }).strict();

function requireCreatorDashboard() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.creatorDashboard) {
    throw new AppError(404, 'Кабинет автора ещё не включён', undefined, 'creator_dashboard_disabled');
  }
}

async function tenant(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  const context = await resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: getRequestContext()?.correlationId,
  });
  await requireTenantRollout(prisma, 'CREATOR_DASHBOARD', context.organizationId);
  return context;
}

creatorTranscriptsRouter.post(
  '/creator/webinars/:webinarId/transcript',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const result = await enqueueTranscriptDraft(prisma, context, webinarId);
    res.status(202).json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.get(
  '/creator/content-jobs/:jobId/status',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { jobId } = jobParamsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...(await getContentJobStatus(prisma, context, jobId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.get(
  '/creator/webinars/:webinarId/chapters',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...(await listCreatorWebinarChapters(prisma, context, webinarId, req.query)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.post(
  '/creator/webinars/:webinarId/chapters',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const chapter = await createCreatorWebinarChapter(prisma, context, webinarId, req.body);
    res.status(201).json({ ok: true, chapter, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.patch(
  '/creator/webinars/:webinarId/chapters/reorder',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const chapters = await reorderCreatorWebinarChapters(prisma, context, webinarId, req.body);
    res.json({ ok: true, chapters, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.patch(
  '/creator/webinars/:webinarId/chapters/:chapterId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId, chapterId } = chapterParamsSchema.parse(req.params);
    const chapter = await updateCreatorWebinarChapter(prisma, context, webinarId, chapterId, req.body);
    res.json({ ok: true, chapter, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.delete(
  '/creator/webinars/:webinarId/chapters/:chapterId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId, chapterId } = chapterParamsSchema.parse(req.params);
    const chapter = await deleteCreatorWebinarChapter(prisma, context, webinarId, chapterId, req.body);
    res.json({ ok: true, chapter, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.post(
  '/creator/content-jobs/:jobId/cancel',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { jobId } = jobParamsSchema.parse(req.params);
    res.json({
      ok: true,
      ...(await requestContentJobCancellation(prisma, context, jobId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.get(
  '/creator/webinars/:webinarId/transcript',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...(await getCreatorTranscript(prisma, context, webinarId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.patch(
  '/creator/webinars/:webinarId/transcript',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const result = await updateCreatorTranscript(prisma, context, webinarId, updateSchema.parse(req.body));
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.post(
  '/creator/webinars/:webinarId/transcript/publish',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const result = await publishCreatorTranscript(
      prisma,
      context,
      webinarId,
      transcriptReferenceSchema.parse(req.body),
    );
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.get(
  '/creator/webinars/:webinarId/transcript/export',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    const { format } = exportQuerySchema.parse(req.query);
    const result = await exportCreatorTranscript(prisma, context, webinarId, format);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.type(result.contentType).send(result.content);
  }),
);

creatorTranscriptsRouter.get(
  '/creator/term-dictionary',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...(await listOrganizationTerms(prisma, context)), correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.post(
  '/creator/term-dictionary',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const result = await createOrganizationTerm(prisma, context, termSchema.parse(req.body));
    res.status(201).json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorTranscriptsRouter.patch(
  '/creator/term-dictionary/:termId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { termId } = termParamsSchema.parse(req.params);
    res.json({
      ok: true,
      ...(await updateOrganizationTerm(prisma, context, termId, termSchema.parse(req.body))),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.delete(
  '/creator/term-dictionary/:termId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { termId } = termParamsSchema.parse(req.params);
    res.json({
      ok: true,
      ...(await deleteOrganizationTerm(prisma, context, termId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.post(
  '/creator/webinars/:webinarId/ai-suggestions',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    res.status(202).json({
      ok: true,
      ...(await enqueueAiSuggestions(prisma, context, webinarId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.get(
  '/creator/webinars/:webinarId/ai-suggestions',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = paramsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...(await listAiSuggestions(prisma, context, webinarId)),
      correlationId: context.correlationId,
    });
  }),
);

creatorTranscriptsRouter.patch(
  '/creator/webinars/:webinarId/ai-suggestions/:suggestionId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId, suggestionId } = suggestionParamsSchema.parse(req.params);
    const result = await reviewAiSuggestion(
      prisma,
      context,
      webinarId,
      suggestionId,
      reviewSuggestionSchema.parse(req.body),
    );
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);
