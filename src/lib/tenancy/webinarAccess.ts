import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env.js';
import { AppError } from '../http.js';
import { getRequestContext } from '../requestContext.js';
import { hashToken } from '../tokens.js';
import type { TenantContext } from './context.js';

const ACCESS_LOCK_NAMESPACE = 7_106_010_001n;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WEBINAR_ACCESS_TOKEN_RETENTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const WEBINAR_ACCESS_EMAIL_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const idSchema = z.string().trim().min(1).max(191);
const normalizedEmailSchema = z.string().trim().toLowerCase().email().max(320);

type AccessTransaction = Prisma.TransactionClient;
type AccessPolicyDb = Pick<PrismaClient, 'webinar' | 'webinarAccessGrant'>;

export const createWebinarAccessGrantSchema = z
  .object({
    email: normalizedEmailSchema,
    purpose: z.literal('VIEW').optional(),
    expiresInDays: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export const acceptWebinarAccessInvitationSchema = z
  .object({ token: z.string().trim().regex(OPAQUE_TOKEN_PATTERN) })
  .strict();

function grantUnavailable(): never {
  throw new AppError(404, 'Приглашение недоступно', undefined, 'webinar_access_invitation_invalid');
}

function webinarUnavailable(): never {
  throw new AppError(404, 'Вебинар не найден', undefined, 'webinar_not_found');
}

function accessGrantNotFound(): never {
  throw new AppError(404, 'Доступ не найден', undefined, 'webinar_access_grant_not_found');
}

export function hashWebinarAccessEmail(email: string) {
  const normalized = normalizedEmailSchema.parse(email);
  return crypto
    .createHmac('sha256', env.WEBINAR_ACCESS_HASH_SECRET ?? env.ADMIN_COOKIE_SECRET)
    .update(`webinar-access-email:v1:${normalized}`)
    .digest('hex');
}

async function lockAccessScope(tx: AccessTransaction, value: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${value}, ${ACCESS_LOCK_NAMESPACE}))`;
}

async function lockScopedWebinar(tx: AccessTransaction, organizationId: string, webinarId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "webinars"
    WHERE "id" = ${webinarId} AND "organization_id" = ${organizationId}
    FOR UPDATE
  `;
  if (rows.length !== 1) webinarUnavailable();
}

async function requireCurrentOwner(tx: AccessTransaction, context: TenantContext) {
  const owner = await tx.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!owner) {
    throw new AppError(403, 'Требуются права владельца организации', undefined, 'tenant_owner_required');
  }
}

function grantProjection(
  grant: {
    id: string;
    purpose: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    userId: string | null;
    emailJob?: { status: string; attempts: number; sentAt: Date | null } | null;
  },
  now = new Date(),
) {
  const status = grant.revokedAt
    ? 'REVOKED'
    : grant.expiresAt <= now
      ? 'EXPIRED'
      : grant.acceptedAt
        ? 'ACCEPTED'
        : 'PENDING';
  return {
    id: grant.id,
    purpose: grant.purpose,
    status,
    recipientType: grant.userId ? 'USER' : 'EMAIL',
    expiresAt: grant.expiresAt,
    acceptedAt: grant.acceptedAt,
    revokedAt: grant.revokedAt,
    createdAt: grant.createdAt,
    delivery: grant.emailJob ?? null,
  };
}

export async function canAccessWebinarByIdentity(
  db: AccessPolicyDb,
  input: {
    organizationId: string;
    webinarId: string;
    userId?: string | null;
    email?: string | null;
    now?: Date;
  },
) {
  const webinar = await db.webinar.findFirst({
    where: { id: input.webinarId, organizationId: input.organizationId },
    select: { visibility: true },
  });
  if (!webinar) return false;
  if (webinar.visibility !== 'PRIVATE') return true;
  const identity: Prisma.WebinarAccessGrantWhereInput[] = [];
  if (input.userId) identity.push({ userId: input.userId });
  if (input.email) identity.push({ emailHash: hashWebinarAccessEmail(input.email) });
  if (identity.length === 0) return false;
  const grant = await db.webinarAccessGrant.findFirst({
    where: {
      organizationId: input.organizationId,
      webinarId: input.webinarId,
      purpose: 'VIEW',
      revokedAt: null,
      expiresAt: { gt: input.now ?? new Date() },
      OR: identity,
    },
    select: { id: true },
  });
  return Boolean(grant);
}

export async function canAccessRegisteredWebinar(
  db: AccessPolicyDb,
  registration: {
    lead: { email: string };
    webinarSession: { organizationId: string; webinarId: string };
  },
  now = new Date(),
) {
  return canAccessWebinarByIdentity(db, {
    organizationId: registration.webinarSession.organizationId,
    webinarId: registration.webinarSession.webinarId,
    email: registration.lead.email,
    now,
  });
}

export async function createWebinarAccessGrant(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
  now = new Date(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const data = createWebinarAccessGrantSchema.parse(input);
  const emailHash = hashWebinarAccessEmail(data.email);
  const expiresAt = new Date(now.getTime() + (data.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);
  return db.$transaction(async tx => {
    await lockScopedWebinar(tx, context.organizationId, webinarId);
    await requireCurrentOwner(tx, context);
    const webinar = await tx.webinar.findFirst({
      where: { id: webinarId, organizationId: context.organizationId, visibility: 'PRIVATE' },
      select: { id: true },
    });
    if (!webinar) webinarUnavailable();
    await lockAccessScope(tx, `${context.organizationId}:${webinarId}:${emailHash}:view`);
    const replaced = await tx.webinarAccessGrant.findFirst({
      where: { organizationId: context.organizationId, webinarId, emailHash, purpose: 'VIEW', revokedAt: null },
      select: { id: true },
    });
    if (replaced) {
      await tx.webinarAccessGrant.update({ where: { id: replaced.id }, data: { revokedAt: now } });
      await tx.webinarAccessGrantToken.updateMany({
        where: { grantId: replaced.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.webinarAccessInvitationEmailJob.updateMany({
        where: { grantId: replaced.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'grant_replaced' },
      });
    }
    const grant = await tx.webinarAccessGrant.create({
      data: {
        organizationId: context.organizationId,
        webinarId,
        emailHash,
        purpose: data.purpose ?? 'VIEW',
        expiresAt,
        invitedByUserId: context.userId,
        emailJob: { create: { toEmail: data.email } },
      },
      include: { emailJob: { select: { status: true, attempts: true, sentAt: true } } },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_access_grant.created',
        entityType: 'webinar_access_grant',
        entityId: grant.id,
        afterJson: {
          webinarId,
          purpose: grant.purpose,
          expiresAt: grant.expiresAt.toISOString(),
          recipientType: 'EMAIL',
          replacedGrantId: replaced?.id ?? null,
        },
      },
    });
    return grantProjection(grant, now);
  });
}

export async function listWebinarAccessGrants(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  now = new Date(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  return db.$transaction(async tx => {
    await requireCurrentOwner(tx, context);
    const webinar = await tx.webinar.findFirst({
      where: { id: webinarId, organizationId: context.organizationId, visibility: 'PRIVATE' },
      select: { id: true },
    });
    if (!webinar) webinarUnavailable();
    const grants = await tx.webinarAccessGrant.findMany({
      where: { organizationId: context.organizationId, webinarId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: { emailJob: { select: { status: true, attempts: true, sentAt: true } } },
    });
    return grants.map(grant => grantProjection(grant, now));
  });
}

export async function revokeWebinarAccessGrant(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  grantIdInput: unknown,
  now = new Date(),
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const grantId = idSchema.parse(grantIdInput);
  return db.$transaction(async tx => {
    await lockScopedWebinar(tx, context.organizationId, webinarId);
    await requireCurrentOwner(tx, context);
    const before = await tx.webinarAccessGrant.findFirst({
      where: { id: grantId, webinarId, organizationId: context.organizationId, revokedAt: null },
      include: { emailJob: { select: { status: true, attempts: true, sentAt: true } } },
    });
    if (!before) accessGrantNotFound();
    const after = await tx.webinarAccessGrant.update({ where: { id: before.id }, data: { revokedAt: now } });
    await tx.webinarAccessGrantToken.updateMany({
      where: { grantId: before.id, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.webinarAccessInvitationEmailJob.updateMany({
      where: { grantId: before.id, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'grant_revoked' },
    });
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_access_grant.revoked',
        entityType: 'webinar_access_grant',
        entityId: before.id,
        beforeJson: { webinarId, purpose: before.purpose, expiresAt: before.expiresAt.toISOString(), revokedAt: null },
        afterJson: {
          webinarId,
          purpose: before.purpose,
          expiresAt: before.expiresAt.toISOString(),
          revokedAt: now.toISOString(),
        },
      },
    });
    return grantProjection({ ...after, emailJob: before.emailJob }, now);
  });
}

export async function acceptWebinarAccessInvitation(
  db: PrismaClient,
  userId: string,
  input: unknown,
  now = new Date(),
) {
  const { token } = acceptWebinarAccessInvitationSchema.parse(input);
  const tokenHash = hashToken(token);
  return db.$transaction(async tx => {
    const candidate = await tx.webinarAccessGrantToken.findUnique({
      where: { tokenHash },
      select: { grant: { select: { organizationId: true, webinarId: true } } },
    });
    if (!candidate) grantUnavailable();
    await lockAccessScope(tx, `${candidate.grant.organizationId}:${candidate.grant.webinarId}`);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "webinar_access_grant_tokens"
      WHERE "token_hash" = ${tokenHash}
      FOR UPDATE
    `;
    if (locked.length !== 1) grantUnavailable();
    const [invitationToken, user] = await Promise.all([
      tx.webinarAccessGrantToken.findUnique({
        where: { id: locked[0].id },
        include: {
          grant: {
            include: {
              webinar: { select: { id: true, slug: true, title: true, visibility: true } },
              organization: { select: { status: true } },
            },
          },
        },
      }),
      tx.user.findFirst({
        where: { id: userId, kind: 'HUMAN', status: 'ACTIVE', emailVerifiedAt: { not: null } },
        select: { id: true, emailNormalized: true },
      }),
    ]);
    if (
      !invitationToken ||
      !user ||
      invitationToken.consumedAt ||
      invitationToken.invalidatedAt ||
      invitationToken.expiresAt <= now ||
      invitationToken.grant.revokedAt ||
      invitationToken.grant.expiresAt <= now ||
      invitationToken.grant.organization.status !== 'ACTIVE' ||
      invitationToken.grant.webinar.visibility !== 'PRIVATE' ||
      invitationToken.grant.emailHash !== hashWebinarAccessEmail(user.emailNormalized)
    ) {
      grantUnavailable();
    }
    const grant = await tx.webinarAccessGrant.update({
      where: { id: invitationToken.grant.id },
      data: { userId: user.id, acceptedAt: now },
    });
    const consumed = await tx.webinarAccessGrantToken.updateMany({
      where: { id: invitationToken.id, tokenHash, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) grantUnavailable();
    await tx.webinarAccessGrantToken.updateMany({
      where: { grantId: grant.id, id: { not: invitationToken.id }, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        organizationId: grant.organizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'webinar_access_grant.accepted',
        entityType: 'webinar_access_grant',
        entityId: grant.id,
        afterJson: {
          webinarId: grant.webinarId,
          purpose: grant.purpose,
          acceptedAt: now.toISOString(),
          recipientType: 'USER',
        },
      },
    });
    return { webinar: invitationToken.grant.webinar, expiresAt: grant.expiresAt };
  });
}

export async function cleanupExpiredWebinarAccessGrants(db: PrismaClient, now = new Date()) {
  const expired = await db.webinarAccessGrant.findMany({
    where: {
      expiresAt: { lte: now },
      OR: [
        { tokens: { some: { consumedAt: null, invalidatedAt: null } } },
        { emailJob: { status: { in: ['PENDING', 'FAILED'] } } },
      ],
    },
    select: { id: true },
    take: 500,
  });
  const ids = expired.map(item => item.id);
  await db.$transaction(async tx => {
    if (ids.length > 0) {
      await tx.webinarAccessGrantToken.updateMany({
        where: { grantId: { in: ids }, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.webinarAccessInvitationEmailJob.updateMany({
        where: { grantId: { in: ids }, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'grant_expired' },
      });
    }
    await tx.webinarAccessGrantToken.deleteMany({
      where: { expiresAt: { lte: new Date(now.getTime() - WEBINAR_ACCESS_TOKEN_RETENTION_GRACE_MS) } },
    });
    await tx.webinarAccessInvitationEmailJob.deleteMany({
      where: {
        status: { in: ['SENT', 'CANCELLED', 'DEAD_LETTER'] },
        updatedAt: { lte: new Date(now.getTime() - WEBINAR_ACCESS_EMAIL_TERMINAL_RETENTION_MS) },
      },
    });
  });
  return ids.length;
}
