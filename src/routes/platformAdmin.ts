import { Router } from 'express';
import { z } from 'zod';
import { isManagedPlatformFeatureEnabled } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import {
  applyModerationAction,
  listModerationReports,
  requestWebinarCorrection,
  reviewWebinarCorrection,
  transitionModerationReport,
} from '../lib/moderationCases.js';
import {
  parsePlatformId,
  rollbackPlatformChange,
  updatePlatformFeatureFlag,
  updatePlatformOrganization,
  updatePlatformTaxonomy,
} from '../lib/platformGovernance.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { getPlatformAnalyticsAggregates } from '../lib/tenancy/analytics.js';
import { requireAdmin, requireRole, type AdminRequest } from './admin.js';

export const platformAdminRouter = Router();
const itemParams = z.object({ id: z.string().trim().min(1).max(191) }).strict();
const taxonomyParams = z
  .object({ kind: z.enum(['practice_area', 'jurisdiction']), id: z.string().trim().min(1).max(191) })
  .strict();
const flagParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/) }).strict();

function actor(req: AdminRequest) {
  if (!req.admin?.id)
    throw new AppError(401, 'Admin authorization required', undefined, 'admin_authorization_required');
  return req.admin.id;
}

function correlationId() {
  return getRequestContext()?.correlationId ?? 'admin_unknown_correlation';
}

platformAdminRouter.get(
  '/api/admin/moderation/reports',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const result = await listModerationReports(prisma, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

platformAdminRouter.patch(
  '/api/admin/moderation/reports/:id/status',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { id } = itemParams.parse(req.params);
    const report = await transitionModerationReport(prisma, id, req.body, actor(req), correlationId());
    res.json({ ok: true, report, correlationId: correlationId() });
  }),
);

platformAdminRouter.post(
  '/api/admin/moderation/reports/:id/actions',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    if (!(await isManagedPlatformFeatureEnabled(prisma, 'moderation_actions'))) {
      throw new AppError(409, 'Moderation actions are disabled', undefined, 'moderation_actions_disabled');
    }
    const { id } = itemParams.parse(req.params);
    const result = await applyModerationAction(prisma, id, req.body, actor(req), correlationId());
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

platformAdminRouter.post(
  '/api/admin/moderation/reports/:id/correction-requests',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { id } = itemParams.parse(req.params);
    const correction = await requestWebinarCorrection(prisma, id, req.body, actor(req), correlationId());
    res.status(201).json({ ok: true, correction, correlationId: correlationId() });
  }),
);

platformAdminRouter.post(
  '/api/admin/moderation/corrections/:id/review',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { id } = itemParams.parse(req.params);
    const result = await reviewWebinarCorrection(prisma, id, req.body, actor(req), correlationId());
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

platformAdminRouter.get(
  '/api/admin/analytics/organizations',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const result = await getPlatformAnalyticsAggregates(prisma, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

platformAdminRouter.get(
  '/api/admin/platform/feature-flags',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler<AdminRequest>(async (_req, res) => {
    const flags = await prisma.platformFeatureFlag.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, enabled: true, revision: true, description: true, updatedAt: true },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, flags, correlationId: correlationId() });
  }),
);

platformAdminRouter.patch(
  '/api/admin/platform/organizations/:id',
  requireAdmin,
  requireRole(['owner']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { id } = itemParams.parse(req.params);
    const organization = await updatePlatformOrganization(
      prisma,
      parsePlatformId(id),
      req.body,
      actor(req),
      correlationId(),
    );
    res.json({ ok: true, organization, correlationId: correlationId() });
  }),
);

platformAdminRouter.patch(
  '/api/admin/platform/taxonomy/:kind/:id',
  requireAdmin,
  requireRole(['owner']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const params = taxonomyParams.parse(req.params);
    const taxonomy = await updatePlatformTaxonomy(
      prisma,
      params.kind,
      params.id,
      req.body,
      actor(req),
      correlationId(),
    );
    res.json({ ok: true, taxonomy, correlationId: correlationId() });
  }),
);

platformAdminRouter.patch(
  '/api/admin/platform/feature-flags/:key',
  requireAdmin,
  requireRole(['owner']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { key } = flagParams.parse(req.params);
    const flag = await updatePlatformFeatureFlag(prisma, key, req.body, actor(req), correlationId());
    res.json({ ok: true, flag, correlationId: correlationId() });
  }),
);

platformAdminRouter.post(
  '/api/admin/platform/changes/:id/rollback',
  requireAdmin,
  requireRole(['owner']),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { id } = itemParams.parse(req.params);
    const result = await rollbackPlatformChange(prisma, id, req.body, actor(req), correlationId());
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);
