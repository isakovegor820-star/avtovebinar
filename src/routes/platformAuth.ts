import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { removeOrganizationMembership, updateOrganizationMembershipRole } from '../lib/tenancy/membershipService.js';
import {
  acceptOrganizationInvitation,
  createOrganizationInvitation,
  listOrganizationInvitations,
  revokeOrganizationInvitation,
} from '../lib/tenancy/organizationInvitations.js';
import {
  authenticateUserSession,
  clearUserSessionCookie,
  consumePasswordlessLogin,
  enqueuePasswordlessLogin,
  getUserSessionSummary,
  requireAuthenticatedUserSession,
  requireMfaChallengeUserSession,
  revokeAllUserSessions,
  revokeUserSession,
  selectActiveOrganization,
  setUserSessionCookie,
  userSessionMetadata,
} from '../lib/tenancy/userAuth.js';
import {
  confirmOwnerMfaEnrollment,
  disableOwnerMfa,
  startOwnerMfaEnrollment,
  verifyUserMfa,
} from '../lib/tenancy/userMfa.js';
import { acceptWebinarAccessInvitation } from '../lib/tenancy/webinarAccess.js';

export const platformAuthRouter = Router();

const membershipParamsSchema = z.object({ membershipId: z.string().trim().min(1).max(191) }).strict();
const invitationParamsSchema = z.object({ invitationId: z.string().trim().min(1).max(191) }).strict();
const membershipRoleBodySchema = z
  .object({
    role: z.enum(['OWNER', 'AUTHOR', 'MODERATOR', 'CRM_MANAGER', 'ANALYST', 'AUDITOR']),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();

function requirePlatformAccounts() {
  if (!getPlatformFeatureFlags().platformAccounts) {
    throw new AppError(404, 'Аккаунты платформы ещё не включены', undefined, 'platform_accounts_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function tenantContextFromSession(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: correlationId(),
  });
}

platformAuthRouter.post(
  '/auth/passwordless/request',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const result = await enqueuePasswordlessLogin(prisma, req.body);
    res.status(202).json({ ...result, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/passwordless/consume',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const consumed = await consumePasswordlessLogin(prisma, req.body, userSessionMetadata(req));
    setUserSessionCookie(res, consumed.sessionToken, consumed.sessionExpiresAt);
    if (consumed.mfaRequired) {
      res.json({
        ok: true,
        authenticated: false,
        mfaRequired: true,
        expiresAt: consumed.sessionExpiresAt.toISOString(),
        correlationId: correlationId(),
      });
      return;
    }
    res.json({
      ok: true,
      authenticated: true,
      mfaRequired: false,
      user: consumed.user,
      activeOrganizationId: consumed.activeOrganizationId,
      memberships: consumed.memberships,
      expiresAt: consumed.sessionExpiresAt.toISOString(),
      correlationId: correlationId(),
    });
  }),
);

platformAuthRouter.get(
  '/auth/session',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireMfaChallengeUserSession(prisma, req);
    if (session.mfaRequired) {
      res.json({
        ok: true,
        authenticated: false,
        mfaRequired: true,
        expiresAt: session.expiresAt.toISOString(),
        correlationId: correlationId(),
      });
      return;
    }
    const summary = await getUserSessionSummary(prisma, session);
    res.json({ ok: true, authenticated: true, mfaRequired: false, ...summary, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/active-organization',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireAuthenticatedUserSession(prisma, req);
    const selected = await selectActiveOrganization(prisma, session, req.body);
    res.json({ ok: true, ...selected, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    emptyBodySchema.parse(req.body ?? {});
    const session = await authenticateUserSession(prisma, req, new Date(), { allowUnverifiedMfa: true });
    if (session) await revokeUserSession(prisma, session);
    clearUserSessionCookie(res);
    res.status(204).send();
  }),
);

platformAuthRouter.post(
  '/auth/sessions/revoke-all',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    emptyBodySchema.parse(req.body ?? {});
    const session = await requireAuthenticatedUserSession(prisma, req);
    await revokeAllUserSessions(prisma, session);
    clearUserSessionCookie(res);
    res.status(204).send();
  }),
);

platformAuthRouter.post(
  '/organization/invitations/accept',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const accepted = await acceptOrganizationInvitation(prisma, req.body, userSessionMetadata(req));
    setUserSessionCookie(res, accepted.sessionToken, accepted.sessionExpiresAt);
    if (accepted.mfaRequired) {
      res.json({
        ok: true,
        authenticated: false,
        mfaRequired: true,
        expiresAt: accepted.sessionExpiresAt.toISOString(),
        correlationId: correlationId(),
      });
      return;
    }
    res.json({
      ok: true,
      authenticated: true,
      mfaRequired: false,
      user: accepted.user,
      activeOrganizationId: accepted.activeOrganizationId,
      memberships: accepted.memberships,
      expiresAt: accepted.sessionExpiresAt.toISOString(),
      correlationId: correlationId(),
    });
  }),
);

platformAuthRouter.post(
  '/webinar-invitations/accept',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireAuthenticatedUserSession(prisma, req);
    const accepted = await acceptWebinarAccessInvitation(prisma, session.userId, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...accepted, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/mfa/verify',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireMfaChallengeUserSession(prisma, req);
    await verifyUserMfa(prisma, session, req.body);
    const verifiedSession = await requireAuthenticatedUserSession(prisma, req);
    const summary = await getUserSessionSummary(prisma, verifiedSession);
    res.json({ ok: true, authenticated: true, mfaRequired: false, ...summary, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/mfa/enrollment/start',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    emptyBodySchema.parse(req.body ?? {});
    const session = await requireAuthenticatedUserSession(prisma, req);
    const enrollment = await startOwnerMfaEnrollment(prisma, session);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      secret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
      expiresAt: enrollment.expiresAt.toISOString(),
      correlationId: correlationId(),
    });
  }),
);

platformAuthRouter.post(
  '/auth/mfa/enrollment/confirm',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireAuthenticatedUserSession(prisma, req);
    await confirmOwnerMfaEnrollment(prisma, session, req.body);
    const verifiedSession = await requireAuthenticatedUserSession(prisma, req);
    const summary = await getUserSessionSummary(prisma, verifiedSession);
    res.json({ ok: true, authenticated: true, mfaRequired: false, ...summary, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/auth/mfa/disable',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const session = await requireAuthenticatedUserSession(prisma, req);
    await disableOwnerMfa(prisma, session, req.body);
    const currentSession = await requireAuthenticatedUserSession(prisma, req);
    const summary = await getUserSessionSummary(prisma, currentSession);
    res.json({ ok: true, authenticated: true, mfaRequired: false, ...summary, correlationId: correlationId() });
  }),
);

platformAuthRouter.post(
  '/organization/invitations',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromSession(req);
    const invitation = await createOrganizationInvitation(prisma, context, req.body);
    res.status(201).json({ ok: true, invitation, deliveryStatus: 'queued', correlationId: correlationId() });
  }),
);

platformAuthRouter.get(
  '/organization/invitations',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromSession(req);
    const invitations = await listOrganizationInvitations(prisma, context);
    res.json({ ok: true, invitations, correlationId: correlationId() });
  }),
);

platformAuthRouter.delete(
  '/organization/invitations/:invitationId',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = invitationParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromSession(req);
    const invitation = await revokeOrganizationInvitation(prisma, context, params.invitationId);
    res.json({ ok: true, invitation, correlationId: correlationId() });
  }),
);

platformAuthRouter.patch(
  '/organization/memberships/:membershipId/role',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = membershipParamsSchema.parse(req.params);
    const body = membershipRoleBodySchema.parse(req.body);
    const context = await tenantContextFromSession(req);
    const membership = await updateOrganizationMembershipRole(prisma, context, {
      membershipId: params.membershipId,
      role: body.role,
    });
    res.json({ ok: true, membership, correlationId: correlationId() });
  }),
);

platformAuthRouter.delete(
  '/organization/memberships/:membershipId',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = membershipParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromSession(req);
    const membership = await removeOrganizationMembership(prisma, context, {
      membershipId: params.membershipId,
    });
    res.json({ ok: true, membership, correlationId: correlationId() });
  }),
);
