import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../env.js';
import { AppError } from '../http.js';
import {
  getPrivateMediaStorageAdapter,
  getMediaUploadBrowserContract,
  type CompletedUploadPart,
  type PrivateMediaStorageAdapter,
} from '../mediaStorage.js';
import { requireTenantRole, type TenantContext } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];
const ALLOWED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const ALLOWED_EXTENSIONS = new Set(['mp4', 'mov', 'webm']);
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_JOB_LEASE_GRACE_MS = 10 * 60 * 1000;
const MEDIA_JOB_LEASE_RENEW_INTERVAL_MS = 30 * 1000;

class MediaJobClaimLostError extends Error {
  constructor() {
    super('media_job_claim_lost');
  }
}

type MediaDb = Pick<
  PrismaClient,
  'organizationMembership' | 'webinar' | 'mediaAsset' | 'mediaUpload' | 'mediaJob' | 'auditLog' | '$transaction'
>;

async function requireCreator(db: Pick<PrismaClient, 'organizationMembership'>, context: TenantContext) {
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
  if (!membership)
    throw new AppError(403, 'Требуются права автора или владельца', undefined, 'creator_permission_denied');
  return membership.role;
}

function creatorWebinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

function unavailable(): never {
  throw new AppError(404, 'Media asset not found', undefined, 'media_asset_not_found');
}

function publicAsset(asset: {
  id: string;
  webinarId: string;
  version: number;
  status: string;
  progressPercent: number | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: bigint;
  durationSeconds: number | null;
  failureCode: string | null;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: asset.id,
    webinarId: asset.webinarId,
    version: asset.version,
    status: asset.status,
    progressPercent: asset.progressPercent,
    originalFileName: asset.originalFileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes.toString(),
    durationSeconds: asset.durationSeconds,
    failureCode: asset.failureCode,
    readyAt: asset.readyAt,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function parseCompletedParts(value: Prisma.JsonValue | null): CompletedUploadPart[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const partNumber = 'partNumber' in item ? item.partNumber : undefined;
      const etag = 'etag' in item ? item.etag : undefined;
      return Number.isInteger(partNumber) && Number(partNumber) > 0 && typeof etag === 'string'
        ? [{ partNumber: Number(partNumber), etag }]
        : [];
    })
    .sort((left, right) => left.partNumber - right.partNumber);
}

function normalizeEtag(value: string) {
  return value.trim().replace(/^"|"$/g, '');
}

function providerErrorCode(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === 'object' &&
    'safeCode' in error &&
    typeof (error as { safeCode?: unknown }).safeCode === 'string' &&
    /^media_[a-z0-9_]+$/.test((error as { safeCode: string }).safeCode)
  ) {
    return (error as { safeCode: string }).safeCode;
  }
  if (error instanceof AppError && error.code && /^media_[a-z0-9_]+$/.test(error.code)) return error.code;
  return fallback;
}

async function listProviderParts(
  storage: PrivateMediaStorageAdapter,
  upload: {
    providerUploadKey: string;
    asset: { storageKey: string; sizeBytes: bigint };
    partSizeBytes: number;
    uploadedPartsJson: Prisma.JsonValue | null;
  },
) {
  if (!storage.listMultipartUploadParts) return null;
  let providerParts: CompletedUploadPart[];
  try {
    providerParts = await storage.listMultipartUploadParts({
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.asset.storageKey,
    });
  } catch (error) {
    throw new AppError(
      503,
      'Не удалось сверить загрузку с хранилищем',
      undefined,
      providerErrorCode(error, 'media_upload_reconciliation_failed'),
    );
  }
  const partCount = partCountForUpload(upload);
  const byNumber = new Map<number, CompletedUploadPart>();
  for (const part of providerParts) {
    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > partCount ||
      !part.etag.trim() ||
      byNumber.has(part.partNumber)
    ) {
      throw new AppError(
        503,
        'Хранилище вернуло некорректный checkpoint',
        undefined,
        'media_upload_reconciliation_invalid',
      );
    }
    byNumber.set(part.partNumber, { partNumber: part.partNumber, etag: normalizeEtag(part.etag) });
  }
  return [...byNumber.values()].sort((left, right) => left.partNumber - right.partNumber);
}

function partCountForUpload(upload: { asset: { sizeBytes: bigint }; partSizeBytes: number }) {
  return Math.ceil(Number(upload.asset.sizeBytes) / upload.partSizeBytes);
}

function assertUploadActive(upload: { status: string; expiresAt: Date }) {
  if (upload.status !== 'UPLOADING' || upload.expiresAt <= new Date()) {
    throw new AppError(409, 'Загрузка больше не активна', undefined, 'media_upload_inactive');
  }
}

export type CreateMediaUploadInput = {
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksumSha256?: string;
};

export async function createMediaUpload(
  db: MediaDb,
  context: TenantContext,
  webinarId: string,
  input: CreateMediaUploadInput,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const role = await requireCreator(db, context);
  const extension = input.fileName.split('.').pop()?.toLowerCase();
  if (!extension || !ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME.has(input.mimeType)) {
    throw new AppError(400, 'Поддерживаются только MP4, MOV и WebM', undefined, 'media_type_not_supported');
  }
  if (input.sizeBytes <= 0n || input.sizeBytes > BigInt(env.MEDIA_MAX_UPLOAD_BYTES)) {
    throw new AppError(400, 'Размер видео превышает допустимый лимит', undefined, 'media_size_limit_exceeded');
  }
  if (input.checksumSha256 && !CHECKSUM_PATTERN.test(input.checksumSha256)) {
    throw new AppError(400, 'Некорректная контрольная сумма', undefined, 'media_checksum_invalid');
  }
  const webinar = await db.webinar.findFirst({
    where: creatorWebinarWhere(context, role, webinarId),
    select: { id: true },
  });
  if (!webinar) unavailable();

  const assetId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const storageKey = `organizations/${context.organizationId}/webinars/${webinarId}/assets/${assetId}/source`;
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
  const signedOperationExpiresAt = new Date(Date.now() + env.MEDIA_SIGNED_OPERATION_TTL_SECONDS * 1_000);
  const partOperationExpiresAt = storage.name === 'local_fs' ? expiresAt : signedOperationExpiresAt;
  const partCount = Math.ceil(Number(input.sizeBytes) / env.MEDIA_PART_SIZE_BYTES);
  let signed: Awaited<ReturnType<PrivateMediaStorageAdapter['createMultipartUpload']>>;
  try {
    signed = await storage.createMultipartUpload({
      applicationUploadId: uploadId,
      storageKey,
      mimeType: input.mimeType,
      partCount,
      expiresAt: partOperationExpiresAt,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      'Не удалось начать загрузку',
      undefined,
      providerErrorCode(error, 'media_upload_init_failed'),
    );
  }

  const persistUpload = () =>
    db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${webinarId}, 48192741))`;
      const nextVersion =
        (
          await tx.mediaAsset.aggregate({
            where: { webinarId, organizationId: context.organizationId },
            _max: { version: true },
          })
        )._max.version ?? 0;
      const asset = await tx.mediaAsset.create({
        data: {
          id: assetId,
          organizationId: context.organizationId,
          webinarId,
          createdByUserId: context.userId,
          version: nextVersion + 1,
          status: 'UPLOADING',
          progressPercent: 0,
          originalFileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expectedChecksumSha256: input.checksumSha256 ?? null,
          storageKey,
        },
      });
      const upload = await tx.mediaUpload.create({
        data: {
          id: uploadId,
          organizationId: context.organizationId,
          assetId: asset.id,
          provider: storage.name,
          providerUploadKey: signed.providerUploadKey,
          status: 'UPLOADING',
          partSizeBytes: env.MEDIA_PART_SIZE_BYTES,
          expiresAt,
        },
      });
      await tx.webinar.updateMany({
        where: { id: webinarId, organizationId: context.organizationId, currentMediaAssetId: null },
        data: { mediaStatus: 'PROCESSING' },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'media.upload.created',
          entityType: 'MediaAsset',
          entityId: asset.id,
          afterJson: {
            webinarId,
            version: asset.version,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes.toString(),
            expectedChecksumProvided: Boolean(input.checksumSha256),
          },
        },
      });
      return { asset, upload };
    });
  let created: Awaited<ReturnType<typeof persistUpload>>;
  try {
    created = await persistUpload();
  } catch (error) {
    try {
      await storage.abortMultipartUpload({ providerUploadKey: signed.providerUploadKey, storageKey });
    } catch {
      // The provider lifecycle rule and periodic cleanup remain the final safety net.
    }
    throw error;
  }
  return {
    asset: publicAsset(created.asset),
    uploadId: created.upload.id,
    expiresAt,
    limits: {
      maxBytes: String(env.MEDIA_MAX_UPLOAD_BYTES),
      maxDurationSeconds: env.MEDIA_MAX_DURATION_SECONDS,
      partSizeBytes: env.MEDIA_PART_SIZE_BYTES,
    },
    parts: signed.partUrls,
    uploadContract: getMediaUploadBrowserContract(storage.name),
  };
}

export async function recordMediaUploadPart(
  db: MediaDb,
  context: TenantContext,
  uploadId: string,
  part: CompletedUploadPart,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const role = await requireCreator(db, context);
  const scopedUpload = await db.mediaUpload.findFirst({
    where: {
      id: uploadId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { asset: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
    },
    include: { asset: true },
  });
  if (!scopedUpload) unavailable();
  assertUploadActive(scopedUpload);
  if (scopedUpload.provider !== storage.name) {
    throw new AppError(409, 'Upload provider mismatch', undefined, 'media_upload_provider_mismatch');
  }
  const providerParts = await listProviderParts(storage, scopedUpload);
  let trustedPart = part;
  if (providerParts) {
    const providerPart = providerParts.find(item => item.partNumber === part.partNumber);
    if (!providerPart || normalizeEtag(providerPart.etag) !== normalizeEtag(part.etag)) {
      throw new AppError(409, 'Часть ещё не подтверждена хранилищем', undefined, 'media_upload_part_unconfirmed');
    }
    trustedPart = providerPart;
  }
  return persistMediaUploadPartCheckpoint(db, context, role, uploadId, trustedPart, Boolean(providerParts));
}

async function persistMediaUploadPartCheckpoint(
  db: MediaDb,
  context: TenantContext,
  role: OrganizationMembershipRole,
  uploadId: string,
  trustedPart: CompletedUploadPart,
  reconciled: boolean,
) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uploadId}, 74185296))`;
    const upload = await tx.mediaUpload.findFirst({
      where: {
        id: uploadId,
        organizationId: context.organizationId,
        ...(role === 'AUTHOR' ? { asset: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
      },
      include: { asset: true },
    });
    if (!upload) unavailable();
    assertUploadActive(upload);
    const partCount = partCountForUpload(upload);
    if (trustedPart.partNumber > partCount) {
      throw new AppError(400, 'Номер части выходит за пределы загрузки', undefined, 'media_upload_part_invalid');
    }
    const byNumber = new Map(parseCompletedParts(upload.uploadedPartsJson).map(item => [item.partNumber, item]));
    const idempotent =
      normalizeEtag(byNumber.get(trustedPart.partNumber)?.etag ?? '') === normalizeEtag(trustedPart.etag);
    byNumber.set(trustedPart.partNumber, trustedPart);
    const completedParts = [...byNumber.values()].sort((left, right) => left.partNumber - right.partNumber);
    await tx.mediaUpload.update({
      where: { id: upload.id },
      data: { uploadedPartsJson: completedParts, ...(reconciled ? { lastReconciledAt: new Date() } : {}) },
    });
    await tx.mediaAsset.update({
      where: { id: upload.assetId },
      data: { progressPercent: Math.min(15, Math.floor((completedParts.length / partCount) * 15)) },
    });
    return { uploadId: upload.id, completedParts, partCount, idempotent };
  });
}

export async function writeMediaUploadPart(
  db: MediaDb,
  context: TenantContext,
  uploadId: string,
  partNumber: number,
  contentLength: number,
  contentType: string,
  body: Readable,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const role = await requireCreator(db, context);
  const upload = await db.mediaUpload.findFirst({
    where: {
      id: uploadId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { asset: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
    },
    include: { asset: true },
  });
  if (!upload) unavailable();
  assertUploadActive(upload);
  if (upload.provider !== storage.name || !storage.writeMultipartUploadPart) {
    throw new AppError(404, 'Media asset not found', undefined, 'media_asset_not_found');
  }
  const partCount = partCountForUpload(upload);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw new AppError(400, 'Номер части выходит за пределы загрузки', undefined, 'media_upload_part_invalid');
  }
  const finalPartBytes = Number(upload.asset.sizeBytes) - upload.partSizeBytes * (partCount - 1);
  const expectedSizeBytes = partNumber === partCount ? finalPartBytes : upload.partSizeBytes;
  if (contentLength !== expectedSizeBytes) {
    throw new AppError(400, 'Размер части не совпадает с ожидаемым', undefined, 'media_upload_part_size_mismatch');
  }
  if (contentType.toLowerCase() !== upload.asset.mimeType.toLowerCase()) {
    throw new AppError(400, 'MIME-тип части не совпадает с файлом', undefined, 'media_upload_part_mime_mismatch');
  }
  let written: Awaited<ReturnType<NonNullable<PrivateMediaStorageAdapter['writeMultipartUploadPart']>>>;
  try {
    written = await storage.writeMultipartUploadPart({
      applicationUploadId: upload.id,
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.asset.storageKey,
      partNumber,
      expectedSizeBytes,
      body,
    });
  } catch (error) {
    const code = providerErrorCode(error, 'media_upload_part_failed');
    const statusCode =
      code === 'media_upload_part_conflict' ? 409 : code === 'media_upload_part_size_mismatch' ? 400 : 503;
    throw new AppError(
      statusCode,
      statusCode === 409
        ? 'Эта часть уже загружена с другим содержимым'
        : statusCode === 400
          ? 'Размер части не совпадает с ожидаемым'
          : 'Не удалось сохранить часть файла',
      undefined,
      code,
    );
  }
  const checkpoint = await persistMediaUploadPartCheckpoint(
    db,
    context,
    role,
    uploadId,
    { partNumber, etag: normalizeEtag(written.etag) },
    true,
  );
  return { ...checkpoint, etag: normalizeEtag(written.etag), checkpointed: true as const };
}

export async function resumeMediaUpload(
  db: MediaDb,
  context: TenantContext,
  uploadId: string,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const role = await requireCreator(db, context);
  const upload = await db.mediaUpload.findFirst({
    where: {
      id: uploadId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { asset: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
    },
    include: { asset: true },
  });
  if (!upload) unavailable();
  assertUploadActive(upload);
  if (upload.provider !== storage.name) {
    throw new AppError(409, 'Upload provider mismatch', undefined, 'media_upload_provider_mismatch');
  }
  const partCount = partCountForUpload(upload);
  let providerParts: CompletedUploadPart[] | null;
  try {
    providerParts = await listProviderParts(storage, upload);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'media_upload_already_completed') throw error;
    providerParts = parseCompletedParts(upload.uploadedPartsJson);
    if (providerParts.length !== partCount || providerParts.some((part, index) => part.partNumber !== index + 1)) {
      throw new AppError(
        409,
        'Загрузка завершена у провайдера, но checkpoints неполны',
        undefined,
        'media_upload_completion_recovery_incomplete',
      );
    }
  }
  const completedParts = providerParts ?? parseCompletedParts(upload.uploadedPartsJson);
  if (providerParts) {
    await db.mediaUpload.update({
      where: { id: upload.id },
      data: { uploadedPartsJson: providerParts, lastReconciledAt: new Date() },
    });
  }
  const completedNumbers = new Set(completedParts.map(part => part.partNumber));
  const missingPartNumbers = Array.from({ length: partCount }, (_, index) => index + 1).filter(
    partNumber => !completedNumbers.has(partNumber),
  );
  const signedOperationExpiresAt = new Date(Date.now() + env.MEDIA_SIGNED_OPERATION_TTL_SECONDS * 1_000);
  const partOperationExpiresAt = storage.name === 'local_fs' ? upload.expiresAt : signedOperationExpiresAt;
  let parts: Awaited<ReturnType<PrivateMediaStorageAdapter['signMultipartUploadParts']>>;
  try {
    parts = await storage.signMultipartUploadParts({
      applicationUploadId: upload.id,
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.asset.storageKey,
      partNumbers: missingPartNumbers,
      expiresAt: partOperationExpiresAt,
    });
  } catch (error) {
    throw new AppError(
      503,
      'Не удалось продолжить загрузку',
      undefined,
      providerErrorCode(error, 'media_upload_sign_failed'),
    );
  }
  await db.auditLog.create({
    data: {
      userId: context.userId,
      organizationId: context.organizationId,
      correlationId: context.correlationId,
      action: 'media.upload.resumed',
      entityType: 'MediaUpload',
      entityId: upload.id,
      afterJson: {
        completedPartCount: completedParts.length,
        missingPartCount: missingPartNumbers.length,
        providerReconciled: Boolean(providerParts),
      },
    },
  });
  return {
    asset: publicAsset(upload.asset),
    uploadId: upload.id,
    expiresAt: upload.expiresAt,
    limits: {
      maxBytes: String(env.MEDIA_MAX_UPLOAD_BYTES),
      maxDurationSeconds: env.MEDIA_MAX_DURATION_SECONDS,
      partSizeBytes: upload.partSizeBytes,
    },
    completedParts,
    parts,
    uploadContract: getMediaUploadBrowserContract(storage.name),
  };
}

export async function completeMediaUpload(
  db: MediaDb,
  context: TenantContext,
  uploadId: string,
  parts: CompletedUploadPart[],
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const role = await requireCreator(db, context);
  const upload = await db.mediaUpload.findFirst({
    where: {
      id: uploadId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { asset: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
    },
    include: { asset: true },
  });
  if (!upload) unavailable();
  if (upload.provider !== storage.name)
    throw new AppError(409, 'Upload provider mismatch', undefined, 'media_upload_provider_mismatch');
  if (upload.status === 'COMPLETED') {
    const job = await db.mediaJob.findUnique({ where: { dedupKey: `media_process:${upload.assetId}:v1` } });
    return { asset: publicAsset(upload.asset), jobId: job?.id ?? null, idempotent: true };
  }
  assertUploadActive(upload);
  let providerParts: CompletedUploadPart[] | null;
  try {
    providerParts = await listProviderParts(storage, upload);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'media_upload_already_completed') throw error;
    // CompleteMultipartUpload may have committed before the application stored
    // its transaction. The adapter will replay safely and verify via HeadObject.
    providerParts = null;
  }
  const persistedParts = parseCompletedParts(upload.uploadedPartsJson);
  const byNumber = new Map(persistedParts.map(part => [part.partNumber, part]));
  for (const part of parts) byNumber.set(part.partNumber, part);
  const ordered = providerParts ?? [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber);
  const expectedPartCount = partCountForUpload(upload);
  if (ordered.length !== expectedPartCount || ordered.some((part, index) => part.partNumber !== index + 1)) {
    throw new AppError(400, 'Список частей загрузки неполон', undefined, 'media_upload_parts_invalid');
  }
  let completion: Awaited<ReturnType<PrivateMediaStorageAdapter['completeMultipartUpload']>>;
  try {
    completion = await storage.completeMultipartUpload({
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.asset.storageKey,
      parts: ordered,
      expectedMimeType: upload.asset.mimeType,
      expectedSizeBytes: upload.asset.sizeBytes,
    });
  } catch (error) {
    throw new AppError(
      503,
      'Не удалось завершить загрузку',
      undefined,
      providerErrorCode(error, 'media_upload_complete_failed'),
    );
  }
  const valid = completion.mimeType === upload.asset.mimeType && completion.sizeBytes === upload.asset.sizeBytes;
  if (!valid) {
    await db.$transaction(async tx => {
      await tx.mediaUpload.update({
        where: { id: upload.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          uploadedPartsJson: ordered,
          ...(providerParts ? { lastReconciledAt: new Date() } : {}),
        },
      });
      await tx.mediaAsset.update({
        where: { id: upload.assetId },
        data: { status: 'FAILED', failureCode: 'media_validation_failed', progressPercent: null },
      });
      await tx.webinar.updateMany({
        where: {
          id: upload.asset.webinarId,
          OR: [{ currentMediaAssetId: null }, { currentMediaAssetId: upload.assetId }],
        },
        data: { mediaStatus: 'FAILED' },
      });
    });
    throw new AppError(422, 'Видео не прошло проверку', undefined, 'media_validation_failed');
  }
  const result = await db.$transaction(async tx => {
    await tx.mediaUpload.update({
      where: { id: upload.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        uploadedPartsJson: ordered,
        ...(providerParts ? { lastReconciledAt: new Date() } : {}),
      },
    });
    const asset = await tx.mediaAsset.update({
      where: { id: upload.assetId },
      data: {
        status: 'VALIDATING',
        progressPercent: 20,
      },
    });
    const job = await tx.mediaJob.upsert({
      where: { dedupKey: `media_process:${asset.id}:v1` },
      update: {},
      create: {
        organizationId: context.organizationId,
        assetId: asset.id,
        type: 'PROCESS_VIDEO',
        dedupKey: `media_process:${asset.id}:v1`,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'media.upload.completed',
        entityType: 'MediaAsset',
        entityId: asset.id,
        afterJson: { version: asset.version, status: asset.status, partCount: ordered.length },
      },
    });
    return { asset, job };
  });
  return { asset: publicAsset(result.asset), jobId: result.job.id, idempotent: false };
}

export async function getMediaAssetStatus(db: MediaDb, context: TenantContext, assetId: string) {
  const asset = await scopedAsset(db, context, assetId);
  const job = await db.mediaJob.findFirst({
    where: { assetId, organizationId: context.organizationId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, attempts: true, maxAttempts: true, nextAttemptAt: true },
  });
  return { asset: publicAsset(asset), job };
}

async function scopedAsset(db: MediaDb, context: TenantContext, assetId: string) {
  const role = await requireCreator(db, context);
  const asset = await db.mediaAsset.findFirst({
    where: {
      id: assetId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!asset) unavailable();
  return asset;
}

export async function retryMediaAsset(db: MediaDb, context: TenantContext, assetId: string) {
  const asset = await scopedAsset(db, context, assetId);
  if (asset.status !== 'FAILED')
    throw new AppError(409, 'Повтор доступен только после ошибки', undefined, 'media_retry_not_allowed');
  const job = await db.mediaJob.findFirst({
    where: { assetId, organizationId: context.organizationId },
    orderBy: { createdAt: 'desc' },
  });
  if (!job || job.attempts >= job.maxAttempts)
    throw new AppError(409, 'Лимит повторов исчерпан', undefined, 'media_retry_exhausted');
  return db.$transaction(async tx => {
    const updated = await tx.mediaJob.update({
      where: { id: job.id },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        lastErrorCode: null,
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      },
    });
    await tx.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'VALIDATING', progressPercent: 20, failureCode: null },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'media.processing.retried',
        entityType: 'MediaAsset',
        entityId: assetId,
      },
    });
    return { jobId: updated.id, status: updated.status };
  });
}

export async function cancelMediaAsset(
  db: MediaDb,
  context: TenantContext,
  assetId: string,
  storage = getPrivateMediaStorageAdapter(),
) {
  const asset = await scopedAsset(db, context, assetId);
  if (!['CREATED', 'UPLOADING', 'VALIDATING'].includes(asset.status))
    throw new AppError(409, 'Обработку уже нельзя отменить', undefined, 'media_cancel_not_allowed');
  const upload = await db.mediaUpload.findFirst({
    where: { assetId, organizationId: context.organizationId, status: { in: ['CREATED', 'UPLOADING'] } },
  });
  if (upload) {
    try {
      await storage.abortMultipartUpload({ providerUploadKey: upload.providerUploadKey, storageKey: asset.storageKey });
    } catch (error) {
      throw new AppError(
        503,
        'Не удалось отменить загрузку',
        undefined,
        providerErrorCode(error, 'media_upload_abort_failed'),
      );
    }
  }
  await db.$transaction(async tx => {
    await tx.mediaUpload.updateMany({ where: { assetId }, data: { status: 'CANCELLED' } });
    await tx.mediaJob.updateMany({
      where: { assetId, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    await tx.mediaAsset.update({ where: { id: assetId }, data: { status: 'CANCELLED', progressPercent: null } });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'media.processing.cancelled',
        entityType: 'MediaAsset',
        entityId: assetId,
      },
    });
  });
  return { status: 'CANCELLED' as const };
}

export async function activateMediaAsset(db: MediaDb, context: TenantContext, assetId: string) {
  const asset = await scopedAsset(db, context, assetId);
  if (asset.status !== 'READY')
    throw new AppError(409, 'Можно включить только готовое видео', undefined, 'media_asset_not_ready');
  await db.$transaction(async tx => {
    await tx.webinar.update({
      where: { id: asset.webinarId },
      data: {
        currentMediaAssetId: asset.id,
        mediaStatus: 'READY',
        durationMinutes: Math.ceil((asset.durationSeconds ?? 0) / 60),
      },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'media.asset.activated',
        entityType: 'MediaAsset',
        entityId: asset.id,
        afterJson: { webinarId: asset.webinarId, version: asset.version },
      },
    });
  });
  return { assetId: asset.id, version: asset.version, status: 'ACTIVE' as const };
}

export async function runMediaJobOnce(
  db: PrismaClient,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
  reportProgress?: () => void,
) {
  const now = new Date();
  const legacyClaimCutoff = new Date(
    now.getTime() - env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1000 - MEDIA_JOB_LEASE_GRACE_MS,
  );
  const expiredClaims = await db.mediaJob.findMany({
    where: {
      status: 'RUNNING',
      OR: [{ claimExpiresAt: { lte: now } }, { claimExpiresAt: null, claimedAt: { lte: legacyClaimCutoff } }],
    },
    orderBy: { claimedAt: 'asc' },
    take: 20,
    include: { asset: true },
  });
  for (const expired of expiredClaims) {
    const dead = expired.attempts >= expired.maxAttempts;
    await db.$transaction(async tx => {
      const recovered = await tx.mediaJob.updateMany({
        where: {
          id: expired.id,
          status: 'RUNNING',
          claimToken: expired.claimToken,
          OR: [{ claimExpiresAt: { lte: now } }, { claimExpiresAt: null, claimedAt: { lte: legacyClaimCutoff } }],
        },
        data: {
          status: dead ? 'DEAD_LETTER' : 'PENDING',
          nextAttemptAt: now,
          lastErrorCode: 'media_worker_lease_expired',
          completedAt: dead ? now : null,
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
        },
      });
      if (recovered.count !== 1) return;
      await tx.mediaAsset.updateMany({
        where: { id: expired.assetId, status: { in: ['TRANSCODING', 'TRANSCRIBING', 'ENRICHING'] } },
        data: dead
          ? { status: 'FAILED', progressPercent: null, failureCode: 'media_worker_lease_expired' }
          : { status: 'VALIDATING', progressPercent: 20, failureCode: 'media_worker_lease_expired' },
      });
      await tx.auditLog.create({
        data: {
          organizationId: expired.organizationId,
          action: dead ? 'media.provider.dead_lettered' : 'media.provider.lease_recovered',
          entityType: 'MediaJob',
          entityId: expired.id,
          afterJson: {
            assetId: expired.assetId,
            attempt: expired.attempts,
            maxAttempts: expired.maxAttempts,
            failureCode: 'media_worker_lease_expired',
          },
        },
      });
    });
  }

  const job = await db.mediaJob.findFirst({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    include: { asset: true },
  });
  if (!job) return { checked: 0, ready: 0, failed: 0 };
  const claimToken = crypto.randomUUID();
  const leaseDurationMs = env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1000 + MEDIA_JOB_LEASE_GRACE_MS;
  const claimed = await db.mediaJob.updateMany({
    where: { id: job.id, status: 'PENDING' },
    data: {
      status: 'RUNNING',
      attempts: { increment: 1 },
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + leaseDurationMs),
      claimToken,
    },
  });
  if (claimed.count !== 1) return { checked: 1, ready: 0, failed: 0 };

  let renewalInFlight: Promise<void> | null = null;
  let claimLost = false;
  const renewLease = () => {
    reportProgress?.();
    if (renewalInFlight || claimLost) return;
    renewalInFlight = db.mediaJob
      .updateMany({
        where: { id: job.id, status: 'RUNNING', claimToken },
        data: { claimExpiresAt: new Date(Date.now() + leaseDurationMs) },
      })
      .then(result => {
        if (result.count !== 1) claimLost = true;
      })
      .catch(() => {
        // A temporary database failure must not produce an overlapping claim. The
        // long initial lease remains authoritative until a later renewal succeeds.
      })
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const leaseTimer = setInterval(renewLease, MEDIA_JOB_LEASE_RENEW_INTERVAL_MS);
  leaseTimer.unref();

  try {
    await db.mediaAsset.update({ where: { id: job.assetId }, data: { status: 'TRANSCODING', progressPercent: 55 } });
    const output = await storage.processVideo({
      storageKey: job.asset.storageKey,
      expectedMimeType: job.asset.mimeType,
      expectedSizeBytes: job.asset.sizeBytes,
      expectedChecksumSha256: job.asset.expectedChecksumSha256,
    });
    if (
      !output.signatureValid ||
      !output.integrityValid ||
      !output.manifestValid ||
      output.durationSeconds > env.MEDIA_MAX_DURATION_SECONDS
    )
      throw new Error('media_processing_invalid_output');
    if (renewalInFlight) await renewalInFlight;
    if (claimLost) throw new MediaJobClaimLostError();
    await db.mediaAsset.update({ where: { id: job.assetId }, data: { status: 'TRANSCRIBING', progressPercent: 75 } });
    await db.mediaAsset.update({ where: { id: job.assetId }, data: { status: 'ENRICHING', progressPercent: 90 } });
    await db.$transaction(async tx => {
      const ownership = await tx.mediaJob.updateMany({
        where: { id: job.id, status: 'RUNNING', claimToken },
        data: { status: 'SUCCEEDED', completedAt: new Date(), claimedAt: null, claimExpiresAt: null, claimToken: null },
      });
      if (ownership.count !== 1) throw new MediaJobClaimLostError();
      await tx.mediaAsset.update({
        where: { id: job.assetId },
        data: {
          status: 'READY',
          progressPercent: 100,
          checksumSha256: output.checksumSha256,
          durationSeconds: output.durationSeconds,
          manifestStorageKey: output.manifestStorageKey,
          posterStorageKey: output.posterStorageKey,
          audioStorageKey: output.audioStorageKey,
          containerFormat: output.containerFormat,
          videoCodec: output.videoCodec,
          audioCodec: output.audioCodec,
          width: output.width,
          height: output.height,
          integrityVerifiedAt: new Date(),
          readyAt: new Date(),
          failureCode: null,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          action: 'media.provider.processing_succeeded',
          entityType: 'MediaJob',
          entityId: job.id,
          afterJson: { assetId: job.assetId, attempt: job.attempts + 1, outputVersion: 1 },
        },
      });
    });
    return { checked: 1, ready: 1, failed: 0 };
  } catch (error) {
    if (error instanceof MediaJobClaimLostError) {
      return { checked: 1, ready: 0, failed: 1 };
    }
    const current = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    if (current.status !== 'RUNNING' || current.claimToken !== claimToken) {
      return { checked: 1, ready: 0, failed: 1 };
    }
    const dead = current.attempts >= current.maxAttempts;
    const failureCode = providerErrorCode(error, 'media_processing_failed');
    await db.$transaction(async tx => {
      const ownership = await tx.mediaJob.updateMany({
        where: { id: job.id, status: 'RUNNING', claimToken },
        data: {
          status: dead ? 'DEAD_LETTER' : 'PENDING',
          lastErrorCode: failureCode,
          nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** current.attempts) * 60_000),
          completedAt: dead ? new Date() : null,
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
        },
      });
      if (ownership.count !== 1) throw new MediaJobClaimLostError();
      await tx.mediaAsset.update({
        where: { id: job.assetId },
        data: { status: 'FAILED', progressPercent: null, failureCode },
      });
      await tx.webinar.updateMany({
        where: {
          id: job.asset.webinarId,
          OR: [{ currentMediaAssetId: null }, { currentMediaAssetId: job.assetId }],
        },
        data: { mediaStatus: 'FAILED' },
      });
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          action: dead ? 'media.provider.dead_lettered' : 'media.provider.retry_scheduled',
          entityType: 'MediaJob',
          entityId: job.id,
          afterJson: { assetId: job.assetId, attempt: current.attempts, maxAttempts: current.maxAttempts, failureCode },
        },
      });
    });
    return { checked: 1, ready: 0, failed: 1 };
  } finally {
    clearInterval(leaseTimer);
    if (renewalInFlight) await renewalInFlight;
  }
}

export async function cleanupExpiredMediaUploads(
  db: PrismaClient,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
  now = new Date(),
) {
  const expired = await db.mediaUpload.findMany({
    where: { status: 'UPLOADING', expiresAt: { lte: now }, provider: storage.name },
    orderBy: { expiresAt: 'asc' },
    take: 50,
    include: { asset: true },
  });
  let cancelled = 0;
  let failed = 0;
  for (const upload of expired) {
    try {
      await db.mediaUpload.update({ where: { id: upload.id }, data: { abortAttemptedAt: now } });
      await storage.abortMultipartUpload({
        providerUploadKey: upload.providerUploadKey,
        storageKey: upload.asset.storageKey,
      });
      await db.$transaction(async tx => {
        const updated = await tx.mediaUpload.updateMany({
          where: { id: upload.id, status: 'UPLOADING', expiresAt: { lte: now } },
          data: { status: 'CANCELLED' },
        });
        if (updated.count !== 1) return;
        await tx.mediaAsset.updateMany({
          where: { id: upload.assetId, status: { in: ['CREATED', 'UPLOADING', 'VALIDATING'] } },
          data: { status: 'CANCELLED', progressPercent: null, failureCode: 'media_upload_expired' },
        });
        await tx.mediaJob.updateMany({
          where: { assetId: upload.assetId, status: 'PENDING' },
          data: { status: 'CANCELLED', completedAt: now },
        });
        await tx.auditLog.create({
          data: {
            organizationId: upload.organizationId,
            action: 'media.upload.expired_cleanup',
            entityType: 'MediaUpload',
            entityId: upload.id,
            afterJson: { assetId: upload.assetId, expiredAt: upload.expiresAt.toISOString() },
          },
        });
        cancelled += 1;
      });
    } catch {
      failed += 1;
    }
  }
  return { checked: expired.length, cancelled, failed };
}
