import type { OrganizationMembershipRole, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { createCorrelationId, getRequestContext, setContextIdentity } from '../requestContext.js';

const trustedTenantPrincipalSchema = z.object({
  userId: z.string().trim().min(1).max(191),
  activeOrganizationId: z.string().trim().min(1).max(191),
  correlationId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/)
    .optional(),
});

export type TrustedTenantPrincipalInput = {
  userId?: unknown;
  activeOrganizationId?: unknown;
  correlationId?: unknown;
};

export type TenantContext = {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: OrganizationMembershipRole;
  permissions: unknown;
  correlationId: string;
};

type TenantContextDb = Pick<PrismaClient, 'organizationMembership'>;

export async function resolveTenantContext(
  db: TenantContextDb,
  principalInput: TrustedTenantPrincipalInput,
): Promise<TenantContext> {
  if (!principalInput.userId) {
    throw new AppError(401, 'User authentication is required', undefined, 'user_authentication_required');
  }
  if (!principalInput.activeOrganizationId) {
    throw new AppError(401, 'Active organization is required', undefined, 'tenant_context_required');
  }

  const principal = trustedTenantPrincipalSchema.parse(principalInput);
  const membership = await db.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: principal.activeOrganizationId,
        userId: principal.userId,
      },
    },
    include: {
      organization: { select: { status: true } },
      user: { select: { status: true } },
    },
  });

  if (
    !membership ||
    membership.status !== 'ACTIVE' ||
    membership.organization.status !== 'ACTIVE' ||
    membership.user.status !== 'ACTIVE'
  ) {
    // A missing, suspended, or foreign tenant is intentionally indistinguishable.
    throw new AppError(404, 'Organization context is unavailable', undefined, 'tenant_context_unavailable');
  }

  const correlationId = principal.correlationId ?? getRequestContext()?.correlationId ?? createCorrelationId('tenant');
  setContextIdentity({
    userId: principal.userId,
    organizationId: principal.activeOrganizationId,
  });

  return {
    userId: principal.userId,
    organizationId: principal.activeOrganizationId,
    membershipId: membership.id,
    role: membership.role,
    permissions: membership.permissionsJson,
    correlationId,
  };
}

export function requireTenantRole(context: TenantContext, allowedRoles: readonly OrganizationMembershipRole[]) {
  if (!allowedRoles.includes(context.role)) {
    throw new AppError(403, 'Organization permission is required', undefined, 'tenant_permission_denied');
  }
}
