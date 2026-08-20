import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';

const membershipIdSchema = z.string().trim().min(1).max(191);
const membershipRoleSchema = z.enum(['OWNER', 'AUTHOR', 'MODERATOR', 'CRM_MANAGER', 'ANALYST', 'AUDITOR']);
const updateMembershipRoleSchema = z
  .object({
    membershipId: membershipIdSchema,
    role: membershipRoleSchema,
  })
  .strict();
const removeMembershipSchema = z.object({ membershipId: membershipIdSchema }).strict();

const MEMBERSHIP_LOCK_NAMESPACE = 7_106_002_017n;

type MembershipTransaction = Prisma.TransactionClient;

function membershipNotFound(): never {
  throw new AppError(404, 'Organization member was not found', undefined, 'organization_membership_not_found');
}

async function lockMembershipMutations(tx: MembershipTransaction, organizationId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, ${MEMBERSHIP_LOCK_NAMESPACE}))
  `;
}

async function requireCurrentOwner(tx: MembershipTransaction, context: TenantContext) {
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
    throw new AppError(403, 'Organization owner permission is required', undefined, 'tenant_owner_required');
  }
}

async function findScopedMembership(tx: MembershipTransaction, context: TenantContext, membershipId: string) {
  const membership = await tx.organizationMembership.findFirst({
    where: {
      id: membershipId,
      organizationId: context.organizationId,
      status: { not: 'REMOVED' },
    },
    select: {
      id: true,
      userId: true,
      role: true,
      status: true,
      removedAt: true,
    },
  });
  if (!membership) membershipNotFound();
  return membership;
}

async function assertAvailableHumanOwnerRemains(
  tx: MembershipTransaction,
  context: TenantContext,
  membership: { id: string; role: OrganizationMembershipRole; status: string },
) {
  if (membership.role !== 'OWNER' || membership.status !== 'ACTIVE') return;

  const availableHumanOwnerCount = await tx.organizationMembership.count({
    where: {
      id: { not: membership.id },
      organizationId: context.organizationId,
      role: 'OWNER',
      status: 'ACTIVE',
      user: {
        kind: 'HUMAN',
        status: 'ACTIVE',
      },
    },
  });
  if (availableHumanOwnerCount === 0) {
    throw new AppError(
      409,
      'Organization must keep at least one available human owner',
      undefined,
      'last_organization_owner',
    );
  }
}

function auditMembershipState(membership: {
  id: string;
  userId: string;
  role: OrganizationMembershipRole;
  status: string;
  removedAt: Date | null;
}) {
  return {
    id: membership.id,
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    removedAt: membership.removedAt?.toISOString() ?? null,
  };
}

export async function updateOrganizationMembershipRole(db: PrismaClient, context: TenantContext, input: unknown) {
  const data = updateMembershipRoleSchema.parse(input);
  return db.$transaction(
    async tx => {
      await lockMembershipMutations(tx, context.organizationId);
      await requireCurrentOwner(tx, context);
      const before = await findScopedMembership(tx, context, data.membershipId);

      if (before.role === data.role) return before;
      if (data.role !== 'OWNER') await assertAvailableHumanOwnerRemains(tx, context, before);

      const after = await tx.organizationMembership.update({
        where: { id: before.id },
        data: { role: data.role },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          removedAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'organization_membership.role_changed',
          entityType: 'organization_membership',
          entityId: before.id,
          beforeJson: auditMembershipState(before),
          afterJson: auditMembershipState(after),
        },
      });
      return after;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export async function removeOrganizationMembership(db: PrismaClient, context: TenantContext, input: unknown) {
  const data = removeMembershipSchema.parse(input);
  return db.$transaction(
    async tx => {
      await lockMembershipMutations(tx, context.organizationId);
      await requireCurrentOwner(tx, context);
      const before = await findScopedMembership(tx, context, data.membershipId);
      await assertAvailableHumanOwnerRemains(tx, context, before);

      const removedAt = new Date();
      const after = await tx.organizationMembership.update({
        where: { id: before.id },
        data: {
          status: 'REMOVED',
          removedAt,
        },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          removedAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'organization_membership.removed',
          entityType: 'organization_membership',
          entityId: before.id,
          beforeJson: auditMembershipState(before),
          afterJson: auditMembershipState(after),
        },
      });
      return after;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}
