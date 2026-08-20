import crypto from 'node:crypto';
import type { AuthorEvidenceKind, AuthorVerificationStatus, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';
import { requireTenantRole } from './context.js';

const AUTHOR_PROFILE_LOCK_NAMESPACE = 7_106_009_017n;
export const AUTHOR_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
const AUTHOR_ROLES = ['OWNER', 'AUTHOR'] as const;
const EDITABLE_PROFILE_STATUSES: AuthorVerificationStatus[] = ['DRAFT', 'NEEDS_INFO', 'REJECTED'];
const AUTHOR_EVIDENCE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

type AuthorTransaction = Prisma.TransactionClient;

const nullableText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).nullable();

const specializationsSchema = z
  .array(z.string().trim().min(2).max(120))
  .max(30)
  .refine(values => new Set(values.map(value => value.toLocaleLowerCase('ru-RU'))).size === values.length, {
    message: 'Specializations must be unique',
  });

export const authorProfileDraftSchema = z
  .object({
    publicName: nullableText(2, 160).optional(),
    bio: nullableText(1, 5000).optional(),
    specializations: specializationsSchema.optional(),
    professionalOrganization: nullableText(2, 240).optional(),
    region: nullableText(2, 160).optional(),
    experience: nullableText(1, 5000).optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'At least one profile field is required' });

const authorProfileSubmissionSchema = z.object({
  publicName: z.string().trim().min(2).max(160),
  bio: z.string().trim().min(50).max(5000),
  specializations: specializationsSchema.min(1),
  professionalOrganization: z.string().trim().min(2).max(240),
  region: z.string().trim().min(2).max(160),
  experience: z.string().trim().min(20).max(5000),
});

export const authorEvidenceMetadataSchema = z
  .object({
    kind: z.enum(['LICENSE', 'DIPLOMA', 'BAR_MEMBERSHIP', 'OTHER']),
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
        'Filename contains control characters',
      ),
    mimeType: z.enum(AUTHOR_EVIDENCE_MIME_TYPES),
  })
  .strict();

export const adminVerificationReviewSchema = z
  .object({
    status: z.enum(['NEEDS_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED']),
    publicComment: z.string().trim().min(1).max(2000).nullable().optional(),
    internalReason: z.string().trim().min(1).max(4000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'NEEDS_INFO' && !value.publicComment) {
      context.addIssue({ code: 'custom', path: ['publicComment'], message: 'Author-facing comment is required' });
    }
    if (['NEEDS_INFO', 'REJECTED', 'SUSPENDED'].includes(value.status) && !value.internalReason) {
      context.addIssue({ code: 'custom', path: ['internalReason'], message: 'Internal reason is required' });
    }
  });

export const adminVerificationListSchema = z
  .object({
    status: z.enum(['PENDING', 'NEEDS_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional(),
    cursor: z.string().trim().min(1).max(191).optional(),
  })
  .strict();

function profileUnavailable(): never {
  throw new AppError(404, 'Профиль автора не найден', undefined, 'author_profile_not_found');
}

function evidenceUnavailable(): never {
  throw new AppError(404, 'Документ проверки не найден', undefined, 'author_evidence_not_found');
}

function verificationUnavailable(): never {
  throw new AppError(404, 'Заявка на проверку не найдена', undefined, 'author_verification_not_found');
}

async function lockAuthorProfileScope(tx: AuthorTransaction, organizationId: string, userId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${organizationId}:${userId}`}, ${AUTHOR_PROFILE_LOCK_NAMESPACE})
    )
  `;
}

async function requireCurrentAuthorMembership(tx: AuthorTransaction, context: TenantContext) {
  requireTenantRole(context, AUTHOR_ROLES);
  const membership = await tx.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: [...AUTHOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new AppError(403, 'Требуются права автора или владельца', undefined, 'author_profile_permission_denied');
  }
}

function profileProjection(profile: {
  id: string;
  slug: string;
  publicName: string | null;
  bio: string | null;
  specializations: string[];
  professionalOrganization: string | null;
  region: string | null;
  experience: string | null;
  verificationStatus: AuthorVerificationStatus;
  updatedAt: Date;
}) {
  return {
    id: profile.id,
    slug: profile.slug,
    publicName: profile.publicName,
    bio: profile.bio,
    specializations: profile.specializations,
    professionalOrganization: profile.professionalOrganization,
    region: profile.region,
    experience: profile.experience,
    verificationStatus: profile.verificationStatus,
    updatedAt: profile.updatedAt,
  };
}

function evidenceProjection(evidence: {
  id: string;
  kind: AuthorEvidenceKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  verificationId: string | null;
  createdAt: Date;
}) {
  return {
    id: evidence.id,
    kind: evidence.kind,
    originalName: evidence.originalName,
    mimeType: evidence.mimeType,
    sizeBytes: evidence.sizeBytes,
    checksumSha256: evidence.checksumSha256,
    submitted: Boolean(evidence.verificationId),
    createdAt: evidence.createdAt,
  };
}

function authorVerificationProjection(verification: {
  id: string;
  status: AuthorVerificationStatus;
  publicComment: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
}) {
  return {
    id: verification.id,
    status: verification.status,
    publicComment: verification.publicComment,
    submittedAt: verification.submittedAt,
    reviewedAt: verification.reviewedAt,
  };
}

async function authorProfileSummary(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, AUTHOR_ROLES);
  const profile = await db.authorProfile.findFirst({
    where: { organizationId: context.organizationId, userId: context.userId },
    include: {
      evidence: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      verifications: { orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 1 },
    },
  });
  if (!profile) return { profile: null, evidence: [], latestVerification: null };
  return {
    profile: profileProjection(profile),
    evidence: profile.evidence.map(evidenceProjection),
    latestVerification: profile.verifications[0] ? authorVerificationProjection(profile.verifications[0]) : null,
  };
}

export async function getAuthorProfile(db: PrismaClient, context: TenantContext) {
  return authorProfileSummary(db, context);
}

export async function saveAuthorProfileDraft(db: PrismaClient, context: TenantContext, input: unknown) {
  const data = authorProfileDraftSchema.parse(input);
  return db.$transaction(async tx => {
    await lockAuthorProfileScope(tx, context.organizationId, context.userId);
    await requireCurrentAuthorMembership(tx, context);
    const before = await tx.authorProfile.findUnique({
      where: { organizationId_userId: { organizationId: context.organizationId, userId: context.userId } },
    });
    if (before && !EDITABLE_PROFILE_STATUSES.includes(before.verificationStatus)) {
      throw new AppError(
        409,
        'Профиль нельзя изменить в текущем статусе проверки',
        undefined,
        'author_profile_not_editable',
      );
    }
    const profile = before
      ? await tx.authorProfile.update({ where: { id: before.id }, data })
      : await tx.authorProfile.create({
          data: {
            organizationId: context.organizationId,
            userId: context.userId,
            slug: `author-${crypto.randomBytes(12).toString('hex')}`,
            ...data,
          },
        });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'author_profile.draft_saved',
        entityType: 'author_profile',
        entityId: profile.id,
        beforeJson: before
          ? { status: before.verificationStatus, updatedAt: before.updatedAt.toISOString() }
          : undefined,
        afterJson: {
          status: profile.verificationStatus,
          changedFields: Object.keys(data),
          updatedAt: profile.updatedAt.toISOString(),
        },
      },
    });
    return profileProjection(profile);
  });
}

export interface AuthorEvidenceStorage {
  create(
    tx: AuthorTransaction,
    input: {
      profileId: string;
      organizationId: string;
      kind: AuthorEvidenceKind;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      checksumSha256: string;
      content: Uint8Array<ArrayBuffer>;
    },
  ): Promise<{
    id: string;
    kind: AuthorEvidenceKind;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256: string;
    verificationId: string | null;
    createdAt: Date;
  }>;
}

export const prismaAuthorEvidenceStorage: AuthorEvidenceStorage = {
  create: (tx, input) =>
    tx.authorVerificationEvidence.create({
      data: input,
      select: {
        id: true,
        kind: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        checksumSha256: true,
        verificationId: true,
        createdAt: true,
      },
    }),
};

function normalizedFilename(value: string) {
  return value.split(/[\\/]/).at(-1)?.trim() ?? '';
}

function contentMatchesMime(content: Buffer, mimeType: (typeof AUTHOR_EVIDENCE_MIME_TYPES)[number]) {
  if (mimeType === 'application/pdf') return content.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg')
    return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  return (
    content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

export async function uploadAuthorEvidence(
  db: PrismaClient,
  context: TenantContext,
  metadataInput: unknown,
  content: unknown,
  storage: AuthorEvidenceStorage = prismaAuthorEvidenceStorage,
) {
  const metadata = authorEvidenceMetadataSchema.parse({
    ...(metadataInput as Record<string, unknown>),
    originalName: normalizedFilename(String((metadataInput as Record<string, unknown>)?.originalName ?? '')),
  });
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > AUTHOR_EVIDENCE_MAX_BYTES) {
    throw new AppError(
      413,
      'Размер документа должен быть от 1 байта до 5 МБ',
      undefined,
      'author_evidence_size_invalid',
    );
  }
  if (!contentMatchesMime(content, metadata.mimeType)) {
    throw new AppError(
      400,
      'Содержимое документа не соответствует его типу',
      undefined,
      'author_evidence_content_invalid',
    );
  }

  return db.$transaction(async tx => {
    await lockAuthorProfileScope(tx, context.organizationId, context.userId);
    await requireCurrentAuthorMembership(tx, context);
    const profile = await tx.authorProfile.findUnique({
      where: { organizationId_userId: { organizationId: context.organizationId, userId: context.userId } },
    });
    if (!profile) profileUnavailable();
    if (!EDITABLE_PROFILE_STATUSES.includes(profile.verificationStatus)) {
      throw new AppError(409, 'Документы нельзя изменить в текущем статусе', undefined, 'author_evidence_not_editable');
    }
    const evidence = await storage.create(tx, {
      profileId: profile.id,
      organizationId: context.organizationId,
      kind: metadata.kind,
      originalName: metadata.originalName,
      mimeType: metadata.mimeType,
      sizeBytes: content.length,
      checksumSha256: crypto.createHash('sha256').update(content).digest('hex'),
      content: Uint8Array.from(content),
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'author_verification.evidence_uploaded',
        entityType: 'author_verification_evidence',
        entityId: evidence.id,
        afterJson: {
          profileId: profile.id,
          kind: evidence.kind,
          mimeType: evidence.mimeType,
          sizeBytes: evidence.sizeBytes,
          checksumSha256: evidence.checksumSha256,
        },
      },
    });
    return evidenceProjection(evidence);
  });
}

export async function deleteAuthorEvidence(db: PrismaClient, context: TenantContext, evidenceIdInput: unknown) {
  const evidenceId = z.string().trim().min(1).max(191).parse(evidenceIdInput);
  return db.$transaction(async tx => {
    await lockAuthorProfileScope(tx, context.organizationId, context.userId);
    await requireCurrentAuthorMembership(tx, context);
    const evidence = await tx.authorVerificationEvidence.findFirst({
      where: {
        id: evidenceId,
        organizationId: context.organizationId,
        profile: { userId: context.userId },
      },
    });
    if (!evidence) evidenceUnavailable();
    if (evidence.verificationId) {
      throw new AppError(409, 'Отправленный документ нельзя удалить', undefined, 'author_evidence_submitted');
    }
    await tx.authorVerificationEvidence.delete({ where: { id: evidence.id } });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'author_verification.evidence_deleted',
        entityType: 'author_verification_evidence',
        entityId: evidence.id,
        beforeJson: {
          profileId: evidence.profileId,
          kind: evidence.kind,
          mimeType: evidence.mimeType,
          sizeBytes: evidence.sizeBytes,
          checksumSha256: evidence.checksumSha256,
        },
      },
    });
    return { id: evidence.id, deleted: true };
  });
}

export async function getAuthorEvidenceContent(db: PrismaClient, context: TenantContext, evidenceIdInput: unknown) {
  requireTenantRole(context, AUTHOR_ROLES);
  const evidenceId = z.string().trim().min(1).max(191).parse(evidenceIdInput);
  const evidence = await db.authorVerificationEvidence.findFirst({
    where: {
      id: evidenceId,
      organizationId: context.organizationId,
      profile: { userId: context.userId },
    },
  });
  if (!evidence) evidenceUnavailable();
  return evidence;
}

export async function submitAuthorVerification(db: PrismaClient, context: TenantContext) {
  return db.$transaction(async tx => {
    await lockAuthorProfileScope(tx, context.organizationId, context.userId);
    await requireCurrentAuthorMembership(tx, context);
    const profile = await tx.authorProfile.findUnique({
      where: { organizationId_userId: { organizationId: context.organizationId, userId: context.userId } },
    });
    if (!profile) profileUnavailable();
    if (!EDITABLE_PROFILE_STATUSES.includes(profile.verificationStatus)) {
      throw new AppError(
        409,
        'Заявка уже отправлена или профиль недоступен',
        undefined,
        'author_verification_not_submittable',
      );
    }
    authorProfileSubmissionSchema.parse(profile);
    const evidence = await tx.authorVerificationEvidence.findMany({
      where: { profileId: profile.id, organizationId: context.organizationId },
      select: { id: true },
    });
    if (evidence.length === 0) {
      throw new AppError(400, 'Добавьте подтверждающий документ', undefined, 'author_verification_evidence_required');
    }

    const verification = await tx.authorVerification.create({
      data: {
        profileId: profile.id,
        organizationId: context.organizationId,
        submittedByUserId: context.userId,
      },
    });
    await tx.authorVerificationEvidence.updateMany({
      where: { profileId: profile.id, organizationId: context.organizationId, verificationId: null },
      data: { verificationId: verification.id },
    });
    await tx.authorProfile.update({ where: { id: profile.id }, data: { verificationStatus: 'PENDING' } });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'author_verification.submitted',
        entityType: 'author_verification',
        entityId: verification.id,
        beforeJson: { profileStatus: profile.verificationStatus },
        afterJson: { profileStatus: 'PENDING', evidenceCount: evidence.length },
      },
    });
    return authorVerificationProjection(verification);
  });
}

const ADMIN_TRANSITIONS: Record<AuthorVerificationStatus, readonly AuthorVerificationStatus[]> = {
  DRAFT: [],
  PENDING: ['NEEDS_INFO', 'VERIFIED', 'REJECTED'],
  NEEDS_INFO: [],
  VERIFIED: ['SUSPENDED'],
  REJECTED: [],
  SUSPENDED: ['VERIFIED'],
};

function adminVerificationProjection(
  verification: Prisma.AuthorVerificationGetPayload<{
    include: {
      profile: { include: { organization: true; user: true; evidence: true } };
      reviewedBy: true;
    };
  }>,
) {
  return {
    id: verification.id,
    organizationId: verification.organizationId,
    status: verification.status,
    submittedAt: verification.submittedAt,
    reviewedAt: verification.reviewedAt,
    publicComment: verification.publicComment,
    internalReason: verification.internalReason,
    reviewedBy: verification.reviewedBy ? { id: verification.reviewedBy.id, name: verification.reviewedBy.name } : null,
    profile: {
      ...profileProjection(verification.profile),
      organization: {
        id: verification.profile.organization.id,
        name: verification.profile.organization.name,
        slug: verification.profile.organization.slug,
      },
      user: { id: verification.profile.user.id },
    },
    evidence: verification.profile.evidence.map(evidenceProjection),
  };
}

const adminVerificationInclude = {
  profile: { include: { organization: true, user: true, evidence: { orderBy: { createdAt: 'asc' as const } } } },
  reviewedBy: true,
} as const;

export async function listAdminAuthorVerifications(db: PrismaClient, queryInput: unknown) {
  const query = adminVerificationListSchema.parse(queryInput);
  const rows = await db.authorVerification.findMany({
    where: query.status ? { status: query.status } : undefined,
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    take: 51,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: adminVerificationInclude,
  });
  const hasMore = rows.length > 50;
  const page = rows.slice(0, 50);
  return {
    items: page.map(adminVerificationProjection),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getAdminAuthorVerification(db: PrismaClient, verificationIdInput: unknown) {
  const verificationId = z.string().trim().min(1).max(191).parse(verificationIdInput);
  const verification = await db.authorVerification.findUnique({
    where: { id: verificationId },
    include: adminVerificationInclude,
  });
  if (!verification) verificationUnavailable();
  return adminVerificationProjection(verification);
}

export async function reviewAuthorVerification(
  db: PrismaClient,
  adminUserId: string,
  verificationIdInput: unknown,
  input: unknown,
  correlationId?: string,
  now = new Date(),
) {
  const verificationId = z.string().trim().min(1).max(191).parse(verificationIdInput);
  const data = adminVerificationReviewSchema.parse(input);
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "author_verifications" WHERE "id" = ${verificationId} FOR UPDATE
    `;
    if (locked.length !== 1) verificationUnavailable();
    const verification = await tx.authorVerification.findUnique({
      where: { id: verificationId },
      include: { profile: true },
    });
    if (!verification) verificationUnavailable();
    if (!ADMIN_TRANSITIONS[verification.status].includes(data.status)) {
      throw new AppError(
        409,
        'Недопустимый переход статуса проверки',
        undefined,
        'author_verification_transition_invalid',
      );
    }
    if (verification.profile.verificationStatus !== verification.status) {
      throw new AppError(409, 'Статус профиля уже изменился', undefined, 'author_verification_state_conflict');
    }

    const reviewed = await tx.authorVerification.update({
      where: { id: verification.id },
      data: {
        status: data.status,
        reviewedByAdminUserId: adminUserId,
        reviewedAt: now,
        publicComment: data.publicComment ?? null,
        internalReason: data.internalReason ?? null,
      },
    });
    await tx.authorProfile.update({
      where: { id: verification.profileId },
      data: { verificationStatus: data.status },
    });
    await tx.auditLog.create({
      data: {
        adminUserId,
        organizationId: verification.organizationId,
        correlationId,
        action: 'author_verification.reviewed',
        entityType: 'author_verification',
        entityId: verification.id,
        beforeJson: { status: verification.status },
        afterJson: {
          status: data.status,
          hasPublicComment: Boolean(data.publicComment),
          hasInternalReason: Boolean(data.internalReason),
        },
      },
    });
    return getAdminAuthorVerification(tx as unknown as PrismaClient, reviewed.id);
  });
}

export async function getAdminAuthorEvidenceContent(db: PrismaClient, evidenceIdInput: unknown) {
  const evidenceId = z.string().trim().min(1).max(191).parse(evidenceIdInput);
  const evidence = await db.authorVerificationEvidence.findUnique({ where: { id: evidenceId } });
  if (!evidence) evidenceUnavailable();
  return evidence;
}

export async function getPublicAuthorProfile(db: PrismaClient, slugInput: unknown) {
  const slug = z
    .string()
    .trim()
    .regex(/^author-[0-9a-f]{24}$/)
    .parse(slugInput);
  return db.$transaction(async tx => {
    const profile = await tx.authorProfile.findFirst({
      where: {
        slug,
        verificationStatus: 'VERIFIED',
        organization: { status: 'ACTIVE' },
        user: { kind: 'HUMAN', status: 'ACTIVE' },
      },
      include: { organization: { select: { name: true, slug: true } } },
    });
    if (!profile) profileUnavailable();
    const membership = await tx.organizationMembership.findFirst({
      where: {
        organizationId: profile.organizationId,
        userId: profile.userId,
        role: { in: [...AUTHOR_ROLES] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!membership) profileUnavailable();
    return {
      slug: profile.slug,
      publicName: profile.publicName,
      bio: profile.bio,
      specializations: profile.specializations,
      professionalOrganization: profile.professionalOrganization,
      region: profile.region,
      experience: profile.experience,
      verificationStatus: profile.verificationStatus,
      organization: profile.organization,
      updatedAt: profile.updatedAt,
    };
  });
}

export async function assertAuthorCanPublish(db: PrismaClient, context: TenantContext, profileIdInput?: unknown) {
  requireTenantRole(context, AUTHOR_ROLES);
  const profileId = profileIdInput === undefined ? undefined : z.string().trim().min(1).max(191).parse(profileIdInput);
  const profile = await db.authorProfile.findFirst({
    where: {
      id: profileId,
      organizationId: context.organizationId,
      userId: context.userId,
      verificationStatus: 'VERIFIED',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!profile) {
    throw new AppError(
      403,
      'Публикация доступна только проверенному активному автору',
      undefined,
      'author_verification_required',
    );
  }
  return profile;
}
