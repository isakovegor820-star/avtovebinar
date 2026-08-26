import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env.js';
import { AppError } from '../http.js';
import {
  getMediaUploadBrowserContract,
  getPrivateMediaStorageAdapter,
  type CompletedUploadPart,
  type PrivateMediaStorageAdapter,
} from '../mediaStorage.js';
import { requireTenantRole, type TenantContext } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];
const MATERIAL_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const idSchema = z.string().trim().min(1).max(191);
const checksumSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/);
const partSchema = z
  .object({ partNumber: z.number().int().positive().max(1_000), etag: z.string().trim().min(1).max(256) })
  .strict();
const partListSchema = z.array(partSchema).min(1).max(1_000);
const storedPartListSchema = z.array(
  partSchema
    .extend({ sizeBytes: z.number().int().positive().optional(), checksumSha256: z.string().optional() })
    .strict(),
);

const MIME_BY_EXTENSION = new Map<string, ReadonlySet<string>>([
  ['pdf', new Set(['application/pdf'])],
  ['docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])],
  ['zip', new Set(['application/zip'])],
  ['txt', new Set(['text/plain'])],
  ['csv', new Set(['text/csv', 'text/plain'])],
  ['png', new Set(['image/png'])],
  ['jpg', new Set(['image/jpeg'])],
  ['jpeg', new Set(['image/jpeg'])],
]);

export const materialUploadCreateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(240),
    fileName: z.string().trim().min(5).max(240),
    mimeType: z.string().trim().toLowerCase().min(3).max(160),
    sizeBytes: z
      .union([z.string().regex(/^\d{1,12}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
      .transform(value => BigInt(value)),
    checksumSha256: checksumSchema.optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export const materialDeleteSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

function unavailable(entity = 'material'): never {
  throw new AppError(404, 'Материал не найден', undefined, `${entity}_not_found`);
}

function normalizeEtag(value: string) {
  return value.trim().replace(/^"|"$/g, '');
}

function parseParts(value: Prisma.JsonValue | null) {
  const parsed = storedPartListSchema.safeParse(value ?? []);
  return parsed.success
    ? parsed.data.map(part => ({ ...part, etag: normalizeEtag(part.etag) }))
    : ([] as CompletedUploadPart[]);
}

function partCount(sizeBytes: bigint, partSizeBytes: number) {
  return Math.ceil(Number(sizeBytes) / partSizeBytes);
}

function partsMatch(left: CompletedUploadPart, right: CompletedUploadPart) {
  return left.partNumber === right.partNumber && normalizeEtag(left.etag) === normalizeEtag(right.etag);
}

function browserParts(
  storage: PrivateMediaStorageAdapter,
  parts: Array<{ partNumber: number; url: string; expiresAt: Date; expectedSizeBytes?: number }>,
) {
  if (storage.name !== 'local_fs') return parts;
  return parts.map(part => ({
    ...part,
    url: part.url.replace('/creator/uploads/', '/creator/material-uploads/'),
  }));
}

async function requireCreator(db: PrismaClient, context: TenantContext) {
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

function webinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

async function assertScopedWebinar(
  db: PrismaClient,
  context: TenantContext,
  webinarId: string,
  requireEditable = false,
) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({
    where: webinarWhere(context, role, webinarId),
    select: { id: true, contentStatus: true },
  });
  if (!webinar) unavailable('webinar');
  if (requireEditable && !['DRAFT', 'NEEDS_REVIEW'].includes(webinar.contentStatus)) {
    throw new AppError(409, 'Верните вебинар в редактируемый статус', undefined, 'material_webinar_not_editable');
  }
  return role;
}

function publicMaterial(material: {
  id: string;
  displayName: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: bigint;
  status: string;
  revision: number;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: material.id,
    displayName: material.displayName,
    originalFileName: material.originalFileName,
    mimeType: material.mimeType,
    sizeBytes: material.sizeBytes.toString(),
    status: material.status,
    revision: material.revision,
    readyAt: material.readyAt,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    downloadPath: `/api/v1/creator/materials/${encodeURIComponent(material.id)}/content`,
  };
}

function validateFileContract(fileName: string, mimeType: string, sizeBytes: bigint) {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!extension || !MIME_BY_EXTENSION.get(extension)?.has(mimeType)) {
    throw new AppError(415, 'Тип файла или расширение не поддерживается', undefined, 'material_type_not_supported');
  }
  if (sizeBytes <= 0n || sizeBytes > BigInt(env.MATERIAL_MAX_UPLOAD_BYTES)) {
    throw new AppError(413, 'Размер файла превышает допустимый лимит', undefined, 'material_size_limit_exceeded');
  }
}

function requestHash(context: TenantContext, webinarId: string, input: z.infer<typeof materialUploadCreateSchema>) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        organizationId: context.organizationId,
        webinarId,
        displayName: input.displayName,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes.toString(),
        checksumSha256: input.checksumSha256 ?? null,
      }),
    )
    .digest('hex');
}

function uploadResponse(
  storage: PrivateMediaStorageAdapter,
  material: Parameters<typeof publicMaterial>[0],
  upload: { id: string; expiresAt: Date; partSizeBytes: number },
  parts: Array<{ partNumber: number; url: string; expiresAt: Date; expectedSizeBytes?: number }>,
  idempotent: boolean,
) {
  return {
    material: publicMaterial(material),
    uploadId: upload.id,
    expiresAt: upload.expiresAt,
    limits: { maxBytes: String(env.MATERIAL_MAX_UPLOAD_BYTES), partSizeBytes: upload.partSizeBytes },
    parts: browserParts(storage, parts),
    uploadContract: getMediaUploadBrowserContract(storage.name),
    idempotent,
  };
}

export async function listCreatorWebinarMaterials(db: PrismaClient, context: TenantContext, webinarIdInput: unknown) {
  const webinarId = idSchema.parse(webinarIdInput);
  await assertScopedWebinar(db, context, webinarId);
  const materials = await db.webinarMaterial.findMany({
    where: { webinarId, organizationId: context.organizationId, status: { not: 'DELETED' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return materials.map(publicMaterial);
}

export async function createWebinarMaterialUpload(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const data = materialUploadCreateSchema.parse(input);
  await assertScopedWebinar(db, context, webinarId, true);
  validateFileContract(data.fileName, data.mimeType, data.sizeBytes);
  const hash = requestHash(context, webinarId, data);
  const existing = await db.webinarMaterialUpload.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: context.organizationId, idempotencyKey: data.idempotencyKey },
    },
    include: { material: true },
  });
  if (existing) {
    if (existing.requestHash !== hash || existing.material.webinarId !== webinarId) {
      throw new AppError(
        409,
        'Ключ идемпотентности уже использован',
        undefined,
        'material_upload_idempotency_conflict',
      );
    }
    if (existing.status === 'COMPLETED') return uploadResponse(storage, existing.material, existing, [], true);
    return { ...(await resumeWebinarMaterialUpload(db, context, existing.id, storage)), idempotent: true };
  }

  const materialId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const storageKey = `organizations/${context.organizationId}/webinars/${webinarId}/materials/${materialId}/source`;
  const expiresAt = new Date(Date.now() + MATERIAL_UPLOAD_TTL_MS);
  const operationExpiresAt =
    storage.name === 'local_fs' ? expiresAt : new Date(Date.now() + env.MEDIA_SIGNED_OPERATION_TTL_SECONDS * 1_000);
  const count = partCount(data.sizeBytes, env.MEDIA_PART_SIZE_BYTES);
  let signed;
  try {
    signed = await storage.createMultipartUpload({
      applicationUploadId: uploadId,
      storageKey,
      mimeType: data.mimeType,
      partCount: count,
      expiresAt: operationExpiresAt,
      expectedSizeBytes: data.sizeBytes,
      partSizeBytes: env.MEDIA_PART_SIZE_BYTES,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'Не удалось начать загрузку материала', undefined, 'material_upload_init_failed');
  }
  try {
    const created = await db.$transaction(async tx => {
      const material = await tx.webinarMaterial.create({
        data: {
          id: materialId,
          organizationId: context.organizationId,
          webinarId,
          createdByUserId: context.userId,
          displayName: data.displayName,
          originalFileName: data.fileName,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          expectedChecksumSha256: data.checksumSha256 ?? null,
          storageKey,
        },
      });
      const upload = await tx.webinarMaterialUpload.create({
        data: {
          id: uploadId,
          organizationId: context.organizationId,
          materialId,
          provider: storage.name,
          providerUploadKey: signed.providerUploadKey,
          partSizeBytes: env.MEDIA_PART_SIZE_BYTES,
          expiresAt,
          idempotencyKey: data.idempotencyKey,
          requestHash: hash,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'webinar_material.upload_created',
          entityType: 'WebinarMaterial',
          entityId: material.id,
          afterJson: { webinarId, mimeType: data.mimeType, sizeBytes: data.sizeBytes.toString() },
        },
      });
      return { material, upload };
    });
    return uploadResponse(storage, created.material, created.upload, signed.partUrls, false);
  } catch (error) {
    try {
      await storage.abortMultipartUpload({ providerUploadKey: signed.providerUploadKey, storageKey });
    } catch {
      // Provider lifecycle cleanup remains a final safety net.
    }
    throw error;
  }
}

async function scopedUpload(db: PrismaClient, context: TenantContext, uploadId: string) {
  const role = await requireCreator(db, context);
  const upload = await db.webinarMaterialUpload.findFirst({
    where: {
      id: uploadId,
      organizationId: context.organizationId,
      ...(role === 'AUTHOR' ? { material: { webinar: { authorProfile: { userId: context.userId } } } } : {}),
    },
    include: { material: true },
  });
  if (!upload) unavailable('material_upload');
  return upload;
}

function assertUploadActive(upload: { status: string; expiresAt: Date }) {
  if (upload.status !== 'UPLOADING' || upload.expiresAt <= new Date()) {
    throw new AppError(409, 'Загрузка материала больше не активна', undefined, 'material_upload_inactive');
  }
}

async function savePart(db: PrismaClient, uploadId: string, part: CompletedUploadPart) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uploadId}, 91827420))`;
    const upload = await tx.webinarMaterialUpload.findUniqueOrThrow({
      where: { id: uploadId },
      include: { material: true },
    });
    assertUploadActive(upload);
    const count = partCount(upload.material.sizeBytes, upload.partSizeBytes);
    if (part.partNumber > count)
      throw new AppError(400, 'Номер части недопустим', undefined, 'material_upload_part_invalid');
    const byNumber = new Map(parseParts(upload.uploadedPartsJson).map(item => [item.partNumber, item]));
    const previous = byNumber.get(part.partNumber);
    if (previous && !partsMatch(previous, part)) {
      throw new AppError(409, 'Checkpoint части уже отличается', undefined, 'material_upload_checkpoint_conflict');
    }
    byNumber.set(part.partNumber, { ...part, etag: normalizeEtag(part.etag) });
    const completedParts = [...byNumber.values()].sort((left, right) => left.partNumber - right.partNumber);
    await tx.webinarMaterialUpload.update({ where: { id: upload.id }, data: { uploadedPartsJson: completedParts } });
    return { uploadId, completedParts, partCount: count, idempotent: Boolean(previous) };
  });
}

export async function recordWebinarMaterialUploadPart(
  db: PrismaClient,
  context: TenantContext,
  uploadIdInput: unknown,
  input: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const uploadId = idSchema.parse(uploadIdInput);
  const part = partSchema.parse(input);
  const upload = await scopedUpload(db, context, uploadId);
  assertUploadActive(upload);
  if (upload.provider !== storage.name) unavailable('material_upload');
  let trusted: CompletedUploadPart = { ...part, etag: normalizeEtag(part.etag) };
  if (storage.listMultipartUploadParts) {
    const providerParts = await storage.listMultipartUploadParts({
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.material.storageKey,
    });
    const providerPart = providerParts.find(item => item.partNumber === part.partNumber);
    if (!providerPart || !partsMatch(providerPart, part)) {
      throw new AppError(409, 'Часть ещё не подтверждена хранилищем', undefined, 'material_upload_part_unconfirmed');
    }
    trusted = providerPart;
  }
  return savePart(db, uploadId, trusted);
}

export async function writeWebinarMaterialUploadPart(
  db: PrismaClient,
  context: TenantContext,
  uploadIdInput: unknown,
  partNumber: number,
  contentLength: number,
  contentType: string,
  body: Readable,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const uploadId = idSchema.parse(uploadIdInput);
  const upload = await scopedUpload(db, context, uploadId);
  assertUploadActive(upload);
  if (upload.provider !== storage.name || !storage.writeMultipartUploadPart) unavailable('material_upload');
  const count = partCount(upload.material.sizeBytes, upload.partSizeBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new AppError(400, 'Номер части недопустим', undefined, 'material_upload_part_invalid');
  }
  const expectedSizeBytes =
    partNumber === count
      ? Number(upload.material.sizeBytes) - upload.partSizeBytes * (count - 1)
      : upload.partSizeBytes;
  if (contentLength !== expectedSizeBytes) {
    throw new AppError(400, 'Размер части не совпадает с ожидаемым', undefined, 'material_upload_part_size_mismatch');
  }
  if (contentType.toLowerCase() !== upload.material.mimeType.toLowerCase()) {
    throw new AppError(
      400,
      'MIME-тип части не совпадает с материалом',
      undefined,
      'material_upload_part_mime_mismatch',
    );
  }
  const written = await storage.writeMultipartUploadPart({
    applicationUploadId: upload.id,
    providerUploadKey: upload.providerUploadKey,
    storageKey: upload.material.storageKey,
    partNumber,
    expectedSizeBytes,
    body,
  });
  const checkpoint = await savePart(db, upload.id, {
    partNumber,
    etag: normalizeEtag(written.etag),
    sizeBytes: written.sizeBytes,
  });
  return { ...checkpoint, etag: normalizeEtag(written.etag) };
}

export async function resumeWebinarMaterialUpload(
  db: PrismaClient,
  context: TenantContext,
  uploadIdInput: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const uploadId = idSchema.parse(uploadIdInput);
  const upload = await scopedUpload(db, context, uploadId);
  assertUploadActive(upload);
  if (upload.provider !== storage.name) unavailable('material_upload');
  let completedParts = parseParts(upload.uploadedPartsJson);
  if (storage.listMultipartUploadParts) {
    completedParts = await storage.listMultipartUploadParts({
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.material.storageKey,
    });
    await db.webinarMaterialUpload.update({ where: { id: upload.id }, data: { uploadedPartsJson: completedParts } });
  }
  const count = partCount(upload.material.sizeBytes, upload.partSizeBytes);
  const completedNumbers = new Set(completedParts.map(part => part.partNumber));
  const missing = Array.from({ length: count }, (_, index) => index + 1).filter(
    number => !completedNumbers.has(number),
  );
  const operationExpiresAt =
    storage.name === 'local_fs'
      ? upload.expiresAt
      : new Date(Date.now() + env.MEDIA_SIGNED_OPERATION_TTL_SECONDS * 1_000);
  const parts = await storage.signMultipartUploadParts({
    applicationUploadId: upload.id,
    providerUploadKey: upload.providerUploadKey,
    storageKey: upload.material.storageKey,
    partNumbers: missing,
    expiresAt: operationExpiresAt,
    expectedSizeBytes: upload.material.sizeBytes,
    partSizeBytes: upload.partSizeBytes,
  });
  return {
    ...uploadResponse(storage, upload.material, upload, parts, true),
    completedParts,
  };
}

function signatureValid(mimeType: string, firstBytes: Buffer) {
  if (mimeType === 'application/pdf') return firstBytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/png') return firstBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/jpeg') return firstBytes[0] === 0xff && firstBytes[1] === 0xd8 && firstBytes[2] === 0xff;
  if (mimeType === 'application/zip' || mimeType.includes('openxmlformats-officedocument')) {
    return firstBytes[0] === 0x50 && firstBytes[1] === 0x4b;
  }
  return !firstBytes.includes(0);
}

async function inspectStoredObject(
  storage: PrivateMediaStorageAdapter,
  storageKey: string,
  expectedSize: bigint,
  mimeType: string,
) {
  if (storage.name === 'test_fake' && env.NODE_ENV === 'test') {
    return {
      sizeBytes: expectedSize,
      checksumSha256: crypto.createHash('sha256').update(`${storageKey}:test`).digest('hex'),
    };
  }
  if (!storage.readObject)
    throw new AppError(
      503,
      'Хранилище не поддерживает проверку файлов',
      undefined,
      'material_storage_read_unavailable',
    );
  const response = await storage.readObject({ storageKey });
  const hash = crypto.createHash('sha256');
  let size = 0n;
  let firstBytes = Buffer.alloc(0);
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += BigInt(buffer.length);
    if (size > BigInt(env.MATERIAL_MAX_UPLOAD_BYTES)) {
      throw new AppError(422, 'Файл превышает допустимый лимит', undefined, 'material_size_limit_exceeded');
    }
    if (firstBytes.length < 512) firstBytes = Buffer.concat([firstBytes, buffer]).subarray(0, 512);
    hash.update(buffer);
  }
  if (size !== expectedSize || !signatureValid(mimeType, firstBytes)) {
    throw new AppError(422, 'Файл не прошёл проверку типа и размера', undefined, 'material_integrity_invalid');
  }
  return { sizeBytes: size, checksumSha256: hash.digest('hex') };
}

export async function completeWebinarMaterialUpload(
  db: PrismaClient,
  context: TenantContext,
  uploadIdInput: unknown,
  input: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const uploadId = idSchema.parse(uploadIdInput);
  const clientParts = partListSchema.parse(input).map(part => ({ ...part, etag: normalizeEtag(part.etag) }));
  const upload = await scopedUpload(db, context, uploadId);
  if (upload.provider !== storage.name) unavailable('material_upload');
  if (upload.status === 'COMPLETED' && upload.material.status === 'READY') {
    return { material: publicMaterial(upload.material), idempotent: true };
  }
  assertUploadActive(upload);
  const count = partCount(upload.material.sizeBytes, upload.partSizeBytes);
  const ordered = [...clientParts].sort((left, right) => left.partNumber - right.partNumber);
  const persisted = parseParts(upload.uploadedPartsJson);
  if (
    ordered.length !== count ||
    persisted.length !== count ||
    ordered.some((part, index) => part.partNumber !== index + 1 || !partsMatch(part, persisted[index]))
  ) {
    throw new AppError(409, 'Подтверждённый список частей неполон', undefined, 'material_upload_checkpoint_incomplete');
  }
  try {
    const completed = await storage.completeMultipartUpload({
      providerUploadKey: upload.providerUploadKey,
      storageKey: upload.material.storageKey,
      parts: persisted,
      expectedMimeType: upload.material.mimeType,
      expectedSizeBytes: upload.material.sizeBytes,
    });
    if (completed.mimeType !== upload.material.mimeType || completed.sizeBytes !== upload.material.sizeBytes) {
      throw new AppError(422, 'Файл не прошёл проверку типа и размера', undefined, 'material_integrity_invalid');
    }
    const inspected = await inspectStoredObject(
      storage,
      upload.material.storageKey,
      upload.material.sizeBytes,
      upload.material.mimeType,
    );
    if (upload.material.expectedChecksumSha256 && upload.material.expectedChecksumSha256 !== inspected.checksumSha256) {
      throw new AppError(422, 'Контрольная сумма файла не совпадает', undefined, 'material_checksum_mismatch');
    }
    const material = await db.$transaction(async tx => {
      const ready = await tx.webinarMaterial.update({
        where: { id: upload.material.id },
        data: {
          status: 'READY',
          checksumSha256: inspected.checksumSha256,
          readyAt: new Date(),
          revision: { increment: 1 },
        },
      });
      await tx.webinarMaterialUpload.update({
        where: { id: upload.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'webinar_material.ready',
          entityType: 'WebinarMaterial',
          entityId: ready.id,
          afterJson: { webinarId: ready.webinarId, sizeBytes: ready.sizeBytes.toString(), checksumVerified: true },
        },
      });
      return ready;
    });
    return { material: publicMaterial(material), idempotent: false };
  } catch (error) {
    // Only a deterministic integrity verdict is terminal. Provider/network/DB
    // failures keep the upload resumable and safe to finalize again.
    if (error instanceof AppError && error.statusCode === 422) {
      await db.webinarMaterial.updateMany({
        where: { id: upload.material.id, organizationId: context.organizationId, status: 'UPLOADING' },
        data: { status: 'FAILED', revision: { increment: 1 } },
      });
    }
    throw error;
  }
}

export async function deleteCreatorWebinarMaterial(
  db: PrismaClient,
  context: TenantContext,
  materialIdInput: unknown,
  input: unknown,
) {
  const materialId = idSchema.parse(materialIdInput);
  const data = materialDeleteSchema.parse(input);
  const role = await requireCreator(db, context);
  const material = await db.webinarMaterial.findFirst({
    where: {
      id: materialId,
      organizationId: context.organizationId,
      status: { not: 'DELETED' },
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!material) unavailable();
  await assertScopedWebinar(db, context, material.webinarId, true);
  if (material.revision !== data.expectedRevision) {
    throw new AppError(409, 'Материал уже изменился', undefined, 'material_revision_conflict');
  }
  const removed = await db.$transaction(async tx => {
    const changed = await tx.webinarMaterial.updateMany({
      where: { id: material.id, organizationId: context.organizationId, revision: data.expectedRevision },
      data: { status: 'DELETED', deletedAt: new Date(), revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError(409, 'Материал уже изменился', undefined, 'material_revision_conflict');
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_material.removed',
        entityType: 'WebinarMaterial',
        entityId: material.id,
        beforeJson: { webinarId: material.webinarId, status: material.status, revision: material.revision },
        afterJson: { status: 'DELETED' },
      },
    });
    return tx.webinarMaterial.findUniqueOrThrow({ where: { id: material.id } });
  });
  return { id: removed.id, status: removed.status, revision: removed.revision };
}

export async function getCreatorWebinarMaterialContent(
  db: PrismaClient,
  context: TenantContext,
  materialIdInput: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const materialId = idSchema.parse(materialIdInput);
  const role = await requireCreator(db, context);
  const material = await db.webinarMaterial.findFirst({
    where: {
      id: materialId,
      organizationId: context.organizationId,
      status: 'READY',
      deletedAt: null,
      ...(role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
    },
  });
  if (!material || !storage.readObject) unavailable();
  return { material: publicMaterial(material), object: await storage.readObject({ storageKey: material.storageKey }) };
}

export async function getParticipantWebinarMaterialContent(
  db: PrismaClient,
  organizationId: string,
  webinarId: string,
  materialIdInput: unknown,
  storage: PrivateMediaStorageAdapter = getPrivateMediaStorageAdapter(),
) {
  const materialId = idSchema.parse(materialIdInput);
  const material = await db.webinarMaterial.findFirst({
    where: { id: materialId, organizationId, webinarId, status: 'READY', deletedAt: null },
  });
  if (!material || !storage.readObject) unavailable();
  return { material: publicMaterial(material), object: await storage.readObject({ storageKey: material.storageKey }) };
}
