import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags, isManagedPlatformFeatureEnabled } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import {
  getTenantAnalyticsOverview,
  getTenantContentAnalytics,
  getTenantLiveAnalytics,
  getTenantRetention,
} from '../lib/tenancy/analytics.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';
import { requireTenantRollout } from '../lib/tenancy/rolloutPolicy.js';

export const tenantAnalyticsRouter = Router();

async function requireAnalyticsDashboard() {
  const flags = getPlatformFeatureFlags();
  if (
    !flags.platformAccounts ||
    !flags.creatorDashboard ||
    !(await isManagedPlatformFeatureEnabled(prisma, 'analytics_dashboard'))
  ) {
    throw new AppError(404, 'Аналитика ещё не включена', undefined, 'analytics_dashboard_disabled');
  }
}

async function contextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  const context = await resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: getRequestContext()?.correlationId,
  });
  await requireTenantRollout(prisma, 'ANALYTICS_MODERATION', context.organizationId);
  return context;
}

function sendPrivate(res: Parameters<Parameters<typeof tenantAnalyticsRouter.get>[1]>[1]) {
  res.setHeader('Cache-Control', 'private, no-store');
}

tenantAnalyticsRouter.get(
  '/analytics/overview',
  asyncHandler(async (req, res) => {
    await requireAnalyticsDashboard();
    const context = await contextFromRequest(req);
    const result = await getTenantAnalyticsOverview(prisma, context, req.query);
    sendPrivate(res);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantAnalyticsRouter.get(
  '/analytics/retention',
  asyncHandler(async (req, res) => {
    await requireAnalyticsDashboard();
    const query = z
      .object({ playback: z.enum(['LIVE', 'REPLAY']) })
      .passthrough()
      .parse(req.query);
    const { playback, ...filters } = query;
    const context = await contextFromRequest(req);
    const result = await getTenantRetention(prisma, context, filters, playback);
    sendPrivate(res);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantAnalyticsRouter.get(
  '/analytics/live',
  asyncHandler(async (req, res) => {
    await requireAnalyticsDashboard();
    const context = await contextFromRequest(req);
    const result = await getTenantLiveAnalytics(prisma, context, req.query);
    sendPrivate(res);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantAnalyticsRouter.get(
  '/analytics/content',
  asyncHandler(async (req, res) => {
    await requireAnalyticsDashboard();
    const context = await contextFromRequest(req);
    const result = await getTenantContentAnalytics(prisma, context, req.query);
    sendPrivate(res);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);
