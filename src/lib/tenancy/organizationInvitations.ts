import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { getRequestContext } from '../requestContext.js';
import { hashToken } from '../tokens.js';
import type { TenantContext } from './context.js';
import { issueUserSession } from './userAuth.js';

export const ORGANIZATION_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_LOCK_NAMESPACE = 7_106_005_017n;
const INVITATION_EMAIL_LOCK_NAMESPACE = 7_106_005_018n;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type InvitationTransaction = Prisma.TransactionClient;

export const createOrganizationInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    role: z.enum(['OWNER', 'AUTHOR', 'MODERATOR', 'CRM_MANAGER', 'ANALYST', 'AUDITOR']),
  })
  .strict();

export const acceptOrganizationInvitationSchema = z
  .object({ token: z.string().trim().regex(OPAQUE_TOKEN_PATTERN) })
  .strict();

const invitationPageSchema = z
  .object({
    cursor: z.string().trim().min(1).max(191).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

function invitationUnavailable(): never {
  throw new AppError(
    401,
    'Приглашение истекло, отозвано или уже использовано',
    undefined,
    'organization_invitation_invalid',
  );
}

function invitationNotFound(): never {
  throw new AppError(404, 'Приглашение не найдено', undefined, 'organization_invitation_not_found');
}

async function lockInvitationScope(tx: InvitationTransaction, value: string, namespace = INVITATION_LOCK_NAMESPACE) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${value}, ${namespace}))`;
}

async function requireCurrentOwner(tx: InvitationTransaction, context: TenantContext) {
  const actor = await tx.organizationMembership.findFirst({
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
  if (!actor) {
    throw new AppError(403, 'Требуются права владельца организации', undefined, 'tenant_owner_required');
  }
}

async function expirePendingInvitations(tx: InvitationTransaction, organizationId: string, now: Date) {
  const expired = await tx.organizationInvitation.findMany({
    where: { organizationId, status: 'PENDING', expiresAt: { lte: now } },
    select: { id: true },
  });
  if (expired.length === 0) return;
  const ids = expired.map(invitation => invitation.id);
  await tx.organizationInvitation.updateMany({
    where: { id: { in: ids }, status: 'PENDING' },
    data: { status: 'EXPIRED' },
  });
  await tx.organizationInvitationToken.updateMany({
    where: { invitationId: { in: ids }, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now },
  });
  await tx.organizationInvitationEmailJob.updateMany({
    where: { invitationId: { in: ids }, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'invitation_expired' },
  });
}

function invitationAuditState(input: {
  id: string;
  role: string;
  status: string;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
}) {
  return {
    id: input.id,
    role: input.role,
    status: input.status,
    expiresAt: input.expiresAt.toISOString(),
    acceptedAt: input.acceptedAt?.toISOString() ?? null,
    revokedAt: input.revokedAt?.toISOString() ?? null,
  };
}

export async function createOrganizationInvitation(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  const data = createOrganizationInvitationSchema.parse(input);
  return db.$transaction(
    async tx => {
      await lockInvitationScope(tx, context.organizationId);
      await requireCurrentOwner(tx, context);
      await expirePendingInvitations(tx, context.organizationId, now);

      const existingUser = await tx.user.findUnique({
        where: { emailNormalized: data.email },
        select: { id: true },
      });
      if (existingUser) {
        const activeMembership = await tx.organizationMembership.findFirst({
          where: {
            organizationId: context.organizationId,
            userId: existingUser.id,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (activeMembership) {
          throw new AppError(
            409,
            'Пользователь уже состоит в организации',
            undefined,
            'organization_membership_already_active',
          );
        }
      }

      const replaced = await tx.organizationInvitation.findFirst({
        where: { organizationId: context.organizationId, emailNormalized: data.email, status: 'PENDING' },
        select: { id: true },
      });
      if (replaced) {
        await tx.organizationInvitation.update({
          where: { id: replaced.id },
          data: { status: 'REVOKED', revokedAt: now },
        });
        await tx.organizationInvitationToken.updateMany({
          where: { invitationId: replaced.id, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: now },
        });
        await tx.organizationInvitationEmailJob.updateMany({
          where: { invitationId: replaced.id, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'invitation_replaced' },
        });
      }

      const invitation = await tx.organizationInvitation.create({
        data: {
          organizationId: context.organizationId,
          emailNormalized: data.email,
          role: data.role,
          expiresAt: new Date(now.getTime() + ORGANIZATION_INVITATION_TTL_MS),
          invitedByUserId: context.userId,
          emailJob: { create: {} },
        },
        select: {
          id: true,
          emailNormalized: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'organization_invitation.created',
          entityType: 'organization_invitation',
          entityId: invitation.id,
          afterJson: {
            ...invitationAuditState(invitation),
            replacedInvitationId: replaced?.id ?? null,
          },
        },
      });
      return invitation;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export async function listOrganizationInvitations(db: PrismaClient, context: TenantContext, now = new Date()) {
  const page = await listOrganizationInvitationsPage(db, context, {}, now);
  return page.items;
}

export async function listOrganizationInvitationsPage(
  db: PrismaClient,
  context: TenantContext,
  input: unknown,
  now = new Date(),
) {
  const page = invitationPageSchema.parse(input);
  return db.$transaction(async tx => {
    await lockInvitationScope(tx, context.organizationId);
    await requireCurrentOwner(tx, context);
    await expirePendingInvitations(tx, context.organizationId, now);
    const rows = await tx.organizationInvitation.findMany({
      where: { organizationId: context.organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      take: page.limit + 1,
      select: {
        id: true,
        emailNormalized: true,
        role: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        createdAt: true,
        emailJob: { select: { status: true, attempts: true, sentAt: true } },
      },
    });
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit);
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  });
}

export async function revokeOrganizationInvitation(
  db: PrismaClient,
  context: TenantContext,
  invitationId: unknown,
  now = new Date(),
) {
  const id = z.string().trim().min(1).max(191).parse(invitationId);
  return db.$transaction(
    async tx => {
      await lockInvitationScope(tx, context.organizationId);
      await requireCurrentOwner(tx, context);
      await expirePendingInvitations(tx, context.organizationId, now);
      const before = await tx.organizationInvitation.findFirst({
        where: { id, organizationId: context.organizationId, status: 'PENDING', expiresAt: { gt: now } },
        select: { id: true, role: true, status: true, expiresAt: true, acceptedAt: true, revokedAt: true },
      });
      if (!before) invitationNotFound();

      const after = await tx.organizationInvitation.update({
        where: { id: before.id },
        data: { status: 'REVOKED', revokedAt: now },
        select: { id: true, role: true, status: true, expiresAt: true, acceptedAt: true, revokedAt: true },
      });
      await tx.organizationInvitationToken.updateMany({
        where: { invitationId: before.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.organizationInvitationEmailJob.updateMany({
        where: { invitationId: before.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'invitation_revoked' },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'organization_invitation.revoked',
          entityType: 'organization_invitation',
          entityId: before.id,
          beforeJson: invitationAuditState(before),
          afterJson: invitationAuditState(after),
        },
      });
      return after;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export async function acceptOrganizationInvitation(
  db: PrismaClient,
  input: unknown,
  metadata: { ip?: string; userAgent?: string; now?: Date } = {},
) {
  const { token } = acceptOrganizationInvitationSchema.parse(input);
  const now = metadata.now ?? new Date();
  const tokenHash = hashToken(token);
  const correlationId = getRequestContext()?.correlationId;

  return db.$transaction(
    async tx => {
      const candidate = await tx.organizationInvitationToken.findUnique({
        where: { tokenHash },
        select: { invitation: { select: { organizationId: true } } },
      });
      if (!candidate) invitationUnavailable();

      // Invitation mutations always acquire the organization advisory lock before
      // locking token rows. Keeping one lock order prevents accept/revoke deadlocks.
      await lockInvitationScope(tx, candidate.invitation.organizationId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "organization_invitation_tokens"
        WHERE "token_hash" = ${tokenHash}
        FOR UPDATE
      `;
      if (locked.length !== 1) invitationUnavailable();
      const invitationToken = await tx.organizationInvitationToken.findUnique({
        where: { id: locked[0].id },
        include: { invitation: { include: { organization: true } } },
      });
      if (
        !invitationToken ||
        invitationToken.consumedAt ||
        invitationToken.invalidatedAt ||
        invitationToken.expiresAt <= now ||
        invitationToken.invitation.status !== 'PENDING' ||
        invitationToken.invitation.expiresAt <= now ||
        invitationToken.invitation.organization.status !== 'ACTIVE'
      ) {
        invitationUnavailable();
      }

      const invitation = invitationToken.invitation;
      await lockInvitationScope(tx, invitation.emailNormalized, INVITATION_EMAIL_LOCK_NAMESPACE);

      let user = await tx.user.findUnique({ where: { emailNormalized: invitation.emailNormalized } });
      if (user && (user.kind !== 'HUMAN' || !['PENDING', 'ACTIVE'].includes(user.status))) {
        invitationUnavailable();
      }
      if (!user) {
        user = await tx.user.create({
          data: {
            emailNormalized: invitation.emailNormalized,
            kind: 'HUMAN',
            status: 'ACTIVE',
            emailVerifiedAt: now,
          },
        });
      } else if (user.status === 'PENDING' || !user.emailVerifiedAt) {
        user = await tx.user.update({
          where: { id: user.id },
          data: { status: 'ACTIVE', emailVerifiedAt: user.emailVerifiedAt ?? now },
        });
      }

      const existingMembership = await tx.organizationMembership.findUnique({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
        },
      });
      if (existingMembership?.status === 'ACTIVE') invitationUnavailable();

      const membership = existingMembership
        ? await tx.organizationMembership.update({
            where: { id: existingMembership.id },
            data: { role: invitation.role, status: 'ACTIVE', joinedAt: now, removedAt: null },
          })
        : await tx.organizationMembership.create({
            data: {
              organizationId: invitation.organizationId,
              userId: user.id,
              role: invitation.role,
              status: 'ACTIVE',
              joinedAt: now,
            },
          });

      const accepted = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
        data: {
          status: 'ACCEPTED',
          acceptedAt: now,
          acceptedByUserId: user.id,
          membershipId: membership.id,
        },
      });
      if (accepted.count !== 1) invitationUnavailable();
      const consumed = await tx.organizationInvitationToken.updateMany({
        where: {
          id: invitationToken.id,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) invitationUnavailable();
      await tx.organizationInvitationToken.updateMany({
        where: {
          invitationId: invitation.id,
          id: { not: invitationToken.id },
          consumedAt: null,
          invalidatedAt: null,
        },
        data: { invalidatedAt: now },
      });

      const membershipState = {
        id: membership.id,
        userId: membership.userId,
        role: membership.role,
        status: membership.status,
        removedAt: membership.removedAt?.toISOString() ?? null,
      };
      await tx.auditLog.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          correlationId,
          action: existingMembership
            ? 'organization_membership.reactivated_from_invitation'
            : 'organization_membership.created_from_invitation',
          entityType: 'organization_membership',
          entityId: membership.id,
          beforeJson: existingMembership
            ? {
                id: existingMembership.id,
                userId: existingMembership.userId,
                role: existingMembership.role,
                status: existingMembership.status,
                removedAt: existingMembership.removedAt?.toISOString() ?? null,
              }
            : undefined,
          afterJson: membershipState,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          correlationId,
          action: 'organization_invitation.accepted',
          entityType: 'organization_invitation',
          entityId: invitation.id,
          afterJson: {
            id: invitation.id,
            role: invitation.role,
            status: 'ACCEPTED',
            membershipId: membership.id,
          },
        },
      });

      const session = await issueUserSession(tx, {
        userId: user.id,
        sessionVersion: user.sessionVersion,
        activeOrganizationId: invitation.organizationId,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
        now,
      });
      const memberships = await tx.organizationMembership.findMany({
        where: { userId: user.id, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          organizationId: true,
          role: true,
          organization: { select: { name: true, slug: true } },
        },
      });
      return {
        user: { id: user.id, displayName: user.displayName },
        activeOrganizationId: invitation.organizationId,
        memberships,
        mfaRequired: Boolean(user.mfaEnabledAt),
        ...session,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export async function cleanupOrganizationInvitations(db: PrismaClient, now = new Date()) {
  const expiredTokenCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const terminalEmailCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return db.$transaction(async tx => {
    const expired = await tx.organizationInvitation.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      select: { id: true },
      take: 1000,
    });
    const ids = expired.map(invitation => invitation.id);
    if (ids.length > 0) {
      await tx.organizationInvitation.updateMany({
        where: { id: { in: ids }, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      await tx.organizationInvitationToken.updateMany({
        where: { invitationId: { in: ids }, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await tx.organizationInvitationEmailJob.updateMany({
        where: { invitationId: { in: ids }, status: { in: ['PENDING', 'FAILED', 'SENDING'] } },
        data: { status: 'CANCELLED', claimedAt: null, claimToken: null, lastError: 'invitation_expired' },
      });
    }
    const tokens = await tx.organizationInvitationToken.deleteMany({
      where: { expiresAt: { lt: expiredTokenCutoff } },
    });
    const emailJobs = await tx.organizationInvitationEmailJob.deleteMany({
      where: {
        status: { in: ['SENT', 'CANCELLED', 'DEAD_LETTER'] },
        updatedAt: { lt: terminalEmailCutoff },
      },
    });
    return { expired: ids.length, tokens: tokens.count, emailJobs: emailJobs.count };
  });
}

export type OrganizationInvitationTransaction = Prisma.TransactionClient;
