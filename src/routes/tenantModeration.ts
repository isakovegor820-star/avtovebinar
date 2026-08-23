import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import {
  listModerationMessages,
  listModerationSessions,
  moderateChatMessage,
  moderateRegistrationChatAccess,
} from '../lib/tenancy/chatModeration.js';
import {
  generateGroundedQuestionSuggestion,
  listModerationQuestions,
  reviewGroundedQuestionSuggestion,
  updateModerationQuestion,
} from '../lib/tenancy/questionModeration.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';

export const tenantModerationRouter = Router();

const sessionParamsSchema = z.object({ sessionId: z.string().trim().min(1).max(191) }).strict();
const messageParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(191),
    messageId: z.string().trim().min(1).max(191),
  })
  .strict();
const registrationParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(191),
    registrationId: z.string().trim().min(1).max(191),
  })
  .strict();
const questionParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(191),
    questionId: z.string().trim().min(1).max(191),
  })
  .strict();
const questionSuggestionParamsSchema = questionParamsSchema
  .extend({ suggestionId: z.string().trim().min(1).max(191) })
  .strict();

function requireModerationDashboard() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.creatorDashboard) {
    throw new AppError(404, 'Модерация ещё не включена', undefined, 'moderation_dashboard_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function tenantContextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: correlationId(),
  });
}

tenantModerationRouter.get(
  '/moderation/sessions',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const context = await tenantContextFromRequest(req);
    const sessions = await listModerationSessions(prisma, context, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, sessions, correlationId: correlationId() });
  }),
);

tenantModerationRouter.get(
  '/moderation/sessions/:sessionId/messages',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = sessionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await listModerationMessages(prisma, context, params.sessionId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantModerationRouter.patch(
  '/moderation/sessions/:sessionId/messages/:messageId',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = messageParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const message = await moderateChatMessage(prisma, context, params.sessionId, params.messageId, req.body);
    res.json({ ok: true, message, correlationId: correlationId() });
  }),
);

tenantModerationRouter.get(
  '/moderation/sessions/:sessionId/questions',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = sessionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await listModerationQuestions(prisma, context, params.sessionId, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantModerationRouter.patch(
  '/moderation/sessions/:sessionId/questions/:questionId',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = questionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const question = await updateModerationQuestion(
      prisma,
      context,
      params.sessionId,
      params.questionId,
      req.body,
    );
    res.json({ ok: true, question, correlationId: correlationId() });
  }),
);

tenantModerationRouter.post(
  '/moderation/sessions/:sessionId/questions/:questionId/suggestions',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = questionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const suggestion = await generateGroundedQuestionSuggestion(
      prisma,
      context,
      params.sessionId,
      params.questionId,
      req.body,
    );
    res.status(201).json({ ok: true, suggestion, correlationId: correlationId() });
  }),
);

tenantModerationRouter.post(
  '/moderation/sessions/:sessionId/questions/:questionId/suggestions/:suggestionId/review',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = questionSuggestionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await reviewGroundedQuestionSuggestion(
      prisma,
      context,
      params.sessionId,
      params.questionId,
      params.suggestionId,
      req.body,
    );
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantModerationRouter.patch(
  '/moderation/sessions/:sessionId/registrations/:registrationId/chat-access',
  asyncHandler(async (req, res) => {
    requireModerationDashboard();
    const params = registrationParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const registration = await moderateRegistrationChatAccess(
      prisma,
      context,
      params.sessionId,
      params.registrationId,
      req.body,
    );
    res.json({ ok: true, registration, correlationId: correlationId() });
  }),
);
