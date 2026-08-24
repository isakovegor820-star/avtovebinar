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
  writeMediaUploadPart,
} from '../lib/tenancy/mediaPipeline.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';
import {
  completeWebinarMaterialUpload,
  createWebinarMaterialUpload,
  deleteCreatorWebinarMaterial,
  getCreatorWebinarMaterialContent,
  listCreatorWebinarMaterials,
  recordWebinarMaterialUploadPart,
  resumeWebinarMaterialUpload,
  writeWebinarMaterialUploadPart,
} from '../lib/tenancy/webinarMaterials.js';
import { requireTenantRollout } from '../lib/tenancy/rolloutPolicy.js';

export const creatorMediaRouter = Router();

const idSchema = z.string().trim().min(1).max(191);
const webinarParamsSchema = z.object({ webinarId: idSchema }).strict();
const uploadParamsSchema = z.object({ uploadId: idSchema }).strict();
const uploadPartContentParamsSchema = z
  .object({ uploadId: idSchema, partNumber: z.coerce.number().int().positive().max(10_000) })
  .strict();
const assetParamsSchema = z.object({ assetId: idSchema }).strict();
const materialParamsSchema = z.object({ materialId: idSchema }).strict();
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
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

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

creatorMediaRouter.post(
  '/creator/webinars/:webinarId/uploads',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = webinarParamsSchema.parse(req.params);
    const idempotencyKey = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!idempotencyKey.success) {
      throw new AppError(
        400,
        'Для загрузки требуется корректный Idempotency-Key',
        undefined,
        'media_upload_idempotency_key_required',
      );
    }
    const result = await createMediaUpload(prisma, context, webinarId, {
      ...createUploadSchema.parse(req.body),
      idempotencyKey: idempotencyKey.data,
    });
    res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.get(
  '/creator/webinars/:webinarId/materials',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = webinarParamsSchema.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      materials: await listCreatorWebinarMaterials(prisma, context, webinarId),
      correlationId: context.correlationId,
    });
  }),
);

creatorMediaRouter.post(
  '/creator/webinars/:webinarId/materials/uploads',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { webinarId } = webinarParamsSchema.parse(req.params);
    const key = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new AppError(
        400,
        'Для загрузки требуется корректный Idempotency-Key',
        undefined,
        'material_upload_idempotency_key_required',
      );
    }
    const result = await createWebinarMaterialUpload(prisma, context, webinarId, {
      ...(req.body as Record<string, unknown>),
      idempotencyKey: key.data,
    });
    res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.put(
  '/creator/material-uploads/:uploadId/parts/:partNumber/content',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId, partNumber } = uploadPartContentParamsSchema.parse(req.params);
    const rawLength = req.get('content-length');
    if (!rawLength || !/^\d{1,12}$/.test(rawLength)) {
      throw new AppError(
        411,
        'Для части требуется точный Content-Length',
        undefined,
        'material_upload_length_required',
      );
    }
    if (req.get('content-encoding')) {
      throw new AppError(
        415,
        'Сжатие тела загрузки не поддерживается',
        undefined,
        'material_upload_encoding_unsupported',
      );
    }
    const contentType = (req.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (!contentType)
      throw new AppError(415, 'MIME-тип части не указан', undefined, 'material_upload_part_mime_required');
    const result = await writeWebinarMaterialUploadPart(
      prisma,
      context,
      uploadId,
      partNumber,
      Number(rawLength),
      contentType,
      req,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"${result.etag}"`);
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/material-uploads/:uploadId/parts',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const result = await recordWebinarMaterialUploadPart(prisma, context, uploadId, uploadPartSchema.parse(req.body));
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/material-uploads/:uploadId/complete',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const { parts } = completeUploadSchema.parse(req.body);
    const result = await completeWebinarMaterialUpload(prisma, context, uploadId, parts);
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.post(
  '/creator/material-uploads/:uploadId/resume',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenant(req);
    const { uploadId } = uploadParamsSchema.parse(req.params);
    const result = await resumeWebinarMaterialUpload(prisma, context, uploadId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.get(
  '/creator/materials/:materialId/content',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { materialId } = materialParamsSchema.parse(req.params);
    const result = await getCreatorWebinarMaterialContent(prisma, context, materialId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="material-${result.material.id}"`);
    res.type(result.object.contentType);
    if (result.object.contentLength !== undefined) res.setHeader('Content-Length', String(result.object.contentLength));
    result.object.body.pipe(res);
  }),
);

creatorMediaRouter.delete(
  '/creator/materials/:materialId',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { materialId } = materialParamsSchema.parse(req.params);
    const material = await deleteCreatorWebinarMaterial(prisma, context, materialId, req.body);
    res.json({ ok: true, material, correlationId: context.correlationId });
  }),
);

creatorMediaRouter.put(
  '/creator/uploads/:uploadId/parts/:partNumber/content',
  asyncHandler(async (req, res) => {
    requireCreatorDashboard();
    const context = await tenant(req);
    const { uploadId, partNumber } = uploadPartContentParamsSchema.parse(req.params);
    const rawContentLength = req.get('content-length');
    if (!rawContentLength || !/^\d{1,13}$/.test(rawContentLength)) {
      throw new AppError(
        411,
        'Для части файла требуется точный Content-Length',
        undefined,
        'media_upload_length_required',
      );
    }
    if (req.get('content-encoding')) {
      throw new AppError(415, 'Сжатие тела загрузки не поддерживается', undefined, 'media_upload_encoding_unsupported');
    }
    const contentType = (req.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (!contentType) {
      throw new AppError(415, 'MIME-тип части не указан', undefined, 'media_upload_part_mime_required');
    }
    const result = await writeMediaUploadPart(
      prisma,
      context,
      uploadId,
      partNumber,
      Number(rawContentLength),
      contentType,
      req,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"${result.etag}"`);
    res.json({ ok: true, ...result, correlationId: context.correlationId });
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
