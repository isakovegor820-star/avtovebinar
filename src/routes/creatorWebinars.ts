import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';
import {
  getCreatorChatScenario,
  publishCreatorChatScenario,
  saveCreatorChatScenario,
} from '../lib/tenancy/chatScenario.js';
import {
  addCreatorWebinarSource,
  createCreatorWebinar,
  deleteCreatorWebinarSource,
  duplicateCreatorWebinar,
  getCreatorReferenceData,
  getCreatorWebinar,
  getCreatorWebinarReadiness,
  getCreatorWebinarPreview,
  listCreatorWebinars,
  runCreatorWebinarCommand,
  updateCreatorWebinar,
} from '../lib/tenancy/webinarContent.js';
import {
  cancelCreatorWebinarSession,
  createCreatorWebinarSchedule,
  listCreatorWebinarSessions,
  updateCreatorWebinarSession,
} from '../lib/tenancy/webinarSessions.js';
import {
  createWebinarAccessGrant,
  listWebinarAccessGrants,
  revokeWebinarAccessGrant,
} from '../lib/tenancy/webinarAccess.js';
import { listCreatorReviewTasks } from '../lib/tenancy/freshnessReview.js';
import { requireTenantRollout } from '../lib/tenancy/rolloutPolicy.js';

export const creatorWebinarsRouter = Router();

const webinarParamsSchema = z.object({ webinarId: z.string().trim().min(1).max(191) }).strict();
const sourceParamsSchema = z
  .object({
    webinarId: z.string().trim().min(1).max(191),
    sourceId: z.string().trim().min(1).max(191),
  })
  .strict();
const sessionParamsSchema = z.object({ sessionId: z.string().trim().min(1).max(191) }).strict();
const accessGrantParamsSchema = z
  .object({
    webinarId: z.string().trim().min(1).max(191),
    grantId: z.string().trim().min(1).max(191),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();

function requireCreatorDashboard() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.creatorDashboard) {
    throw new AppError(404, 'Кабинет автора ещё не включён', undefined, 'creator_dashboard_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function tenantContextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  const context = await resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: correlationId(),
  });
  await requireTenantRollout(prisma, 'CREATOR_DASHBOARD', context.organizationId);
  return context;
}

function idempotencyKey(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const value = req.get('idempotency-key');
  if (!value) {
    throw new AppError(400, 'Требуется заголовок Idempotency-Key', undefined, 'idempotency_key_required');
  }
  return value;
}

creatorWebinarsRouter.get(
  '/creator/reference-data',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenantContextFromRequest(req);
    const referenceData = await getCreatorReferenceData(prisma, context);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({ ok: true, ...referenceData, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenantContextFromRequest(req);
    const result = await listCreatorWebinars(prisma, context, req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/review-tasks',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenantContextFromRequest(req);
    const tasks = await listCreatorReviewTasks(prisma, context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, tasks, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenantContextFromRequest(req);
    const webinar = await createCreatorWebinar(prisma, context, req.body);
    res.status(201).json({ ok: true, webinar, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const webinar = await getCreatorWebinar(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, webinar, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.patch(
  '/creator/webinars/:webinarId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const webinar = await updateCreatorWebinar(prisma, context, params.webinarId, req.body, req.get('idempotency-key'));
    res.json({ ok: true, webinar, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId/readiness',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const readiness = await getCreatorWebinarReadiness(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, readiness, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId/sessions',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const sessions = await listCreatorWebinarSessions(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, sessions, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars/:webinarId/sessions',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await createCreatorWebinarSchedule(prisma, context, params.webinarId, req.body);
    res.status(201).json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.patch(
  '/creator/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = sessionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await updateCreatorWebinarSession(prisma, context, params.sessionId, req.body);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.delete(
  '/creator/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = sessionParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await cancelCreatorWebinarSession(prisma, context, params.sessionId, req.body);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId/access-grants',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const grants = await listWebinarAccessGrants(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, grants, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars/:webinarId/access-grants',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const grant = await createWebinarAccessGrant(prisma, context, params.webinarId, req.body);
    res.status(201).json({ ok: true, grant, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.delete(
  '/creator/webinars/:webinarId/access-grants/:grantId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = accessGrantParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromRequest(req);
    const grant = await revokeWebinarAccessGrant(prisma, context, params.webinarId, params.grantId);
    res.json({ ok: true, grant, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars/:webinarId/sources',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const source = await addCreatorWebinarSource(prisma, context, params.webinarId, req.body);
    res.status(201).json({ ok: true, source, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.delete(
  '/creator/webinars/:webinarId/sources/:sourceId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = sourceParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromRequest(req);
    const source = await deleteCreatorWebinarSource(prisma, context, params.webinarId, params.sourceId);
    res.json({ ok: true, source, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId/preview',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const preview = await getCreatorWebinarPreview(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...preview, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars/:webinarId/duplicate',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const result = await duplicateCreatorWebinar(
      prisma,
      context,
      params.webinarId,
      req.body ?? {},
      idempotencyKey(req),
    );
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.get(
  '/creator/webinars/:webinarId/chat-scenario',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const scenario = await getCreatorChatScenario(prisma, context, params.webinarId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, scenario, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.patch(
  '/creator/webinars/:webinarId/chat-scenario',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const scenario = await saveCreatorChatScenario(prisma, context, params.webinarId, req.body);
    res.json({ ok: true, scenario, correlationId: correlationId() });
  }),
);

creatorWebinarsRouter.post(
  '/creator/webinars/:webinarId/chat-scenario/publish',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const params = webinarParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromRequest(req);
    const result = await publishCreatorChatScenario(prisma, context, params.webinarId, idempotencyKey(req));
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

for (const action of ['submit', 'publish', 'archive'] as const) {
  creatorWebinarsRouter.post(
    `/creator/webinars/:webinarId/${action}`,
    asyncHandler(async (req, res) => {
      requireCreatorDashboard();
      const params = webinarParamsSchema.parse(req.params);
      emptyBodySchema.parse(req.body ?? {});
      const context = await tenantContextFromRequest(req);
      const result = await runCreatorWebinarCommand(prisma, context, params.webinarId, action, idempotencyKey(req));
      res.json({ ok: true, ...result, correlationId: correlationId() });
    }),
  );
}
