import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import {
  activateMediaAsset,
  cancelMediaAsset,
  completeMediaUpload,
  createMediaUpload,
  getMediaAssetStatus,
  recordMediaUploadPart,
  resumeMediaUpload,
  retryMediaAsset,
} from '../lib/tenancy/mediaPipeline.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';

export const creatorMediaRouter = Router();

const idSchema = z.string().trim().min(1).max(191);
const webinarParamsSchema = z.object({ webinarId: idSchema }).strict();
const uploadParamsSchema = z.object({ uploadId: idSchema }).strict();
const assetParamsSchema = z.object({ assetId: idSchema }).strict();
const createUploadSchema = z
  .object({
    fileName: z.string().trim().min(5).max(240),
    mimeType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']),
    sizeBytes: z
      .union([z.string().regex(/^\d{1,13}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
      .transform(value => BigInt(value)),
    checksumSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
const completeUploadSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().positive().max(10_000),
            etag: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();
const uploadPartSchema = z
  .object({
    partNumber: z.number().int().positive().max(10_000),
    etag: z.string().trim().min(1).max(256),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();

function requireCreatorDashboard() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.creatorDashboard) {
    throw new AppError(404, 'Кабинет автора ещё не включён', undefined, 'creator_dashboard_disabled');
  }
}

async function tenant(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: getRequestContext()?.correlationId,
  });
}

creatorMediaRouter.post(
  '/creator/webinars/:webinarId/uploads',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = webinarParamsSchema.parse(req.params);
    const result = await createMediaUpload(prisma, context, webinarId, createUploadSchema.parse(req.body));
    res.status(201).json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/uploads/:uploadId/complete',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const { parts } = completeUploadSchema.parse(req.body);
    const result = await completeMediaUpload(prisma, context, uploadId, parts);
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/uploads/:uploadId/parts',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const result = await recordMediaUploadPart(prisma, context, uploadId, uploadPartSchema.parse(req.body));
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/uploads/:uploadId/resume',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const result = await resumeMediaUpload(prisma, context, uploadId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.get(
  '/creator/media/:assetId/status',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { assetId } = assetParamsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...(await getMediaAssetStatus(prisma, context, assetId)),
      correlationId: context.correlationId,
    });
  }),
);

for (const [path, action] of [
  ['retry', retryMediaAsset],
  ['cancel', cancelMediaAsset],
  ['activate', activateMediaAsset],
] as const) {
  creatorMediaRouter.post(
    `/creator/media/:assetId/${path}`,
    asyncHandler(async (req, res) => {
      requireCreatorDashboard();
      emptyBodySchema.parse(req.body ?? {});
      const context = await tenant(req);
      const { assetId } = assetParamsSchema.parse(req.params);
      res.json({ ok: true, ...(await action(prisma, context, assetId)), correlationId: context.correlationId });
    }),
  );
}
