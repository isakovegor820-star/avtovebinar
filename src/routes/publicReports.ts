import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { createPublicContentReport } from '../lib/moderationCases.js';
import { prisma } from '../lib/prisma.js';
import { createCorrelationId, getRequestContext } from '../lib/requestContext.js';
import { isManagedPlatformFeatureEnabled } from '../lib/featureFlags.js';
import { AppError } from '../lib/http.js';

export const publicReportsRouter = Router();

publicReportsRouter.post(
  '/reports',
  asyncHandler(async (req, res) => {
    if (!(await isManagedPlatformFeatureEnabled(prisma, 'public_reporting'))) {
      throw new AppError(404, 'Жалобы ещё не включены', undefined, 'public_reporting_disabled');
    }
    const correlationId = getRequestContext()?.correlationId ?? createCorrelationId('report');
    const report = await createPublicContentReport(prisma, req.body, correlationId);
    res.status(201).json({
      ok: true,
      report: {
        id: report.id,
        category: report.category,
        status: report.status,
        createdAt: report.createdAt,
      },
      correlationId,
    });
  }),
);
