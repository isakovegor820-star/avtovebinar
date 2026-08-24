import type { CookieOptions, Request, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env.js';
import { AppError, getClientIp } from '../http.js';
import { getRequestContext, setContextIdentity } from '../requestContext.js';
import { createAccessToken, hashIp, hashToken } from '../tokens.js';

export const USER_SESSION_COOKIE_NAME = 'aspb_user_session';
export const PASSWORDLESS_LOGIN_TOKEN_PURPOSE = 'PASSWORDLESS_LOGIN' as const;
export const PASSWORDLESS_LOGIN_TOKEN_TTL_MS = 20 * 60 * 1000;
export const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_SESSION_LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type PartitionedCookieOptions = CookieOptions & { partitioned?: boolean };
type AuthDb = PrismaClient;

export const passwordlessLoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
  })
  .strict();

export const passwordlessLoginConsumeSchema = z
  .object({
    token: z.string().trim().regex(OPAQUE_TOKEN_PATTERN),
  })
  .strict();

export const activeOrganizationSelectionSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(191),
  })
  .strict();

export type AuthenticatedUserSession = {
  id: string;
  userId: string;
  activeOrganizationId: string | null;
  mfaVerifiedAt: Date | null;
  mfaRequired: boolean;
  expiresAt: Date;
};

function sessionCookieOptions(expiresAt?: Date): PartitionedCookieOptions {
  const maxAge = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : undefined;
  return {
    httpOnly: true,
    sameSite: env.NODE_ENV === 'production' ? 'strict' : 'lax',
    secure: env.NODE_ENV === 'production',
    partitioned: env.NODE_ENV === 'production' ? true : undefined,
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

export function setUserSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(USER_SESSION_COOKIE_NAME, token, sessionCookieOptions(expiresAt));
}

export function clearUserSessionCookie(res: Response) {
  res.clearCookie(USER_SESSION_COOKIE_NAME, sessionCookieOptions());
}

export function passwordlessRequestAccepted() {
  return {
    ok: true,
    message: 'Если аккаунт доступен, мы отправим одноразовую ссылку для входа.',
  };
}

export async function enqueuePasswordlessLogin(db: AuthDb, input: unknown) {
  const { email } = passwordlessLoginRequestSchema.parse(input);
  await db.$transaction(async tx => {
    // Self-service onboarding deliberately allows a verified human to exist
    // before their first membership. The email lock prevents duplicate rows;
    // the route-level limiter bounds account creation abuse.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${email}, 7106004017))
    `;
    let user = await tx.user.findUnique({
      where: { emailNormalized: email },
      select: { id: true, kind: true, status: true },
    });
    if (user && (user.kind !== 'HUMAN' || !['PENDING', 'ACTIVE'].includes(user.status))) {
      return;
    }
    if (!user) {
      user = await tx.user.create({
        data: { emailNormalized: email, kind: 'HUMAN', status: 'PENDING' },
        select: { id: true, kind: true, status: true },
      });
    }
    await tx.userAuthEmailJob.updateMany({
      where: {
        userId: user.id,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        status: 'CANCELLED',
        claimToken: null,
        claimedAt: null,
      },
    });
    await tx.userAuthEmailJob.create({ data: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_auth.passwordless_requested',
        entityType: 'user',
        entityId: user.id,
      },
    });
  });

  return passwordlessRequestAccepted();
}

function invalidPasswordlessToken(): never {
  throw new AppError(401, 'Ссылка для входа истекла или уже использована', undefined, 'passwordless_token_invalid');
}

export async function issueUserSession(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sessionVersion: number;
    activeOrganizationId: string | null;
    ip?: string;
    userAgent?: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const sessionToken = createAccessToken();
  const sessionExpiresAt = new Date(now.getTime() + USER_SESSION_TTL_MS);
  const session = await tx.userSession.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(sessionToken),
      sessionVersion: input.sessionVersion,
      activeOrganizationId: input.activeOrganizationId,
      expiresAt: sessionExpiresAt,
      ipHash: hashIp(input.ip),
      userAgent: input.userAgent?.slice(0, 512),
    },
    select: { id: true },
  });
  return { sessionId: session.id, sessionToken, sessionExpiresAt };
}

export async function consumePasswordlessLogin(
  db: AuthDb,
  input: unknown,
  metadata: { ip?: string; userAgent?: string; now?: Date } = {},
) {
  const { token } = passwordlessLoginConsumeSchema.parse(input);
  const now = metadata.now ?? new Date();
  const tokenHash = hashToken(token);
  const correlationId = getRequestContext()?.correlationId;

  const consumed = await db.$transaction(
    async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "user_auth_tokens"
        WHERE "token_hash" = ${tokenHash}
        FOR UPDATE
      `;
      if (locked.length !== 1) invalidPasswordlessToken();

      const authToken = await tx.userAuthToken.findUnique({
        where: { id: locked[0].id },
        include: { user: true },
      });
      if (
        !authToken ||
        authToken.purpose !== PASSWORDLESS_LOGIN_TOKEN_PURPOSE ||
        authToken.consumedAt ||
        authToken.expiresAt <= now ||
        authToken.user.kind !== 'HUMAN' ||
        !['PENDING', 'ACTIVE'].includes(authToken.user.status)
      ) {
        invalidPasswordlessToken();
      }

      const memberships = await tx.organizationMembership.findMany({
        where: {
          userId: authToken.userId,
          status: 'ACTIVE',
          organization: { status: 'ACTIVE' },
        },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          organizationId: true,
          role: true,
          organization: { select: { name: true, slug: true } },
        },
      });
      const claimed = await tx.userAuthToken.updateMany({
        where: {
          id: authToken.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) invalidPasswordlessToken();

      const user = await tx.user.update({
        where: { id: authToken.userId },
        data: {
          status: authToken.user.status === 'PENDING' ? 'ACTIVE' : undefined,
          emailVerifiedAt: authToken.user.emailVerifiedAt ?? now,
        },
        select: {
          id: true,
          displayName: true,
          sessionVersion: true,
          mfaEnabledAt: true,
        },
      });
      const activeOrganizationId = memberships.length === 1 ? memberships[0].organizationId : null;
      const session = await issueUserSession(tx, {
        userId: user.id,
        sessionVersion: user.sessionVersion,
        activeOrganizationId,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
        now,
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          organizationId: activeOrganizationId,
          correlationId,
          action: 'user_auth.passwordless_consumed',
          entityType: 'user_session',
          entityId: session.sessionId,
          afterJson: {
            activeOrganizationSelected: Boolean(activeOrganizationId),
            membershipCount: memberships.length,
          },
        },
      });

      return { user, memberships, activeOrganizationId, mfaRequired: Boolean(user.mfaEnabledAt), ...session };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  return consumed;
}

function rawSessionToken(req: Request) {
  const value = req.cookies?.[USER_SESSION_COOKIE_NAME];
  return typeof value === 'string' && OPAQUE_TOKEN_PATTERN.test(value) ? value : null;
}

export async function authenticateUserSession(
  db: AuthDb,
  req: Request,
  now = new Date(),
  options: { allowUnverifiedMfa?: boolean } = {},
): Promise<AuthenticatedUserSession | null> {
  const token = rawSessionToken(req);
  if (!token) return null;

  const session = await db.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    session.user.kind !== 'HUMAN' ||
    session.user.status !== 'ACTIVE' ||
    session.sessionVersion !== session.user.sessionVersion
  ) {
    return null;
  }

  const mfaRequired = Boolean(session.user.mfaEnabledAt && !session.mfaVerifiedAt);
  if (mfaRequired && !options.allowUnverifiedMfa) return null;

  let activeOrganizationId = session.activeOrganizationId;
  if (activeOrganizationId) {
    const membership = await db.organizationMembership.findFirst({
      where: {
        userId: session.userId,
        organizationId: activeOrganizationId,
        status: 'ACTIVE',
        organization: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership) {
      activeOrganizationId = null;
      await db.userSession.updateMany({
        where: { id: session.id, activeOrganizationId: session.activeOrganizationId },
        data: { activeOrganizationId: null },
      });
    }
  }

  if (session.lastSeenAt <= new Date(now.getTime() - USER_SESSION_LAST_SEEN_INTERVAL_MS)) {
    await db.userSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    });
  }

  setContextIdentity({ userId: session.userId, organizationId: activeOrganizationId });
  return {
    id: session.id,
    userId: session.userId,
    activeOrganizationId,
    mfaVerifiedAt: session.mfaVerifiedAt,
    mfaRequired,
    expiresAt: session.expiresAt,
  };
}

export async function requireAuthenticatedUserSession(db: AuthDb, req: Request, now = new Date()) {
  const session = await authenticateUserSession(db, req, now);
  if (!session) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  return session;
}

export async function requireMfaChallengeUserSession(db: AuthDb, req: Request, now = new Date()) {
  const session = await authenticateUserSession(db, req, now, { allowUnverifiedMfa: true });
  if (!session) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  return session;
}

export async function getUserSessionSummary(db: AuthDb, session: AuthenticatedUserSession) {
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, displayName: true, mfaEnabledAt: true },
  });
  if (!user) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  const memberships = await db.organizationMembership.findMany({
    where: {
      userId: session.userId,
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
    },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      role: true,
      organizationId: true,
      organization: { select: { name: true, slug: true } },
    },
  });
  return {
    user,
    activeOrganizationId: session.activeOrganizationId,
    expiresAt: session.expiresAt,
    mfa: {
      enabled: Boolean(user.mfaEnabledAt),
      verified: !user.mfaEnabledAt || Boolean(session.mfaVerifiedAt),
    },
    memberships,
  };
}

export async function selectActiveOrganization(db: AuthDb, session: AuthenticatedUserSession, input: unknown) {
  const { organizationId } = activeOrganizationSelectionSchema.parse(input);
  const membership = await db.organizationMembership.findFirst({
    where: {
      userId: session.userId,
      organizationId,
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
    },
    select: { id: true, role: true },
  });
  if (!membership) {
    // Unknown and foreign organizations are intentionally indistinguishable.
    throw new AppError(404, 'Организация недоступна', undefined, 'tenant_context_unavailable');
  }

  const updated = await db.userSession.updateMany({
    where: {
      id: session.id,
      userId: session.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { activeOrganizationId: organizationId },
  });
  if (updated.count !== 1) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  setContextIdentity({ userId: session.userId, organizationId });
  return { organizationId, membershipId: membership.id, role: membership.role };
}

export async function revokeUserSession(db: AuthDb, session: AuthenticatedUserSession, now = new Date()) {
  await db.userSession.updateMany({
    where: { id: session.id, userId: session.userId, revokedAt: null },
    data: { revokedAt: now },
  });
}

export async function revokeAllUserSessions(db: AuthDb, session: AuthenticatedUserSession, now = new Date()) {
  await db.$transaction(async tx => {
    await tx.user.update({
      where: { id: session.userId },
      data: { sessionVersion: { increment: 1 } },
    });
    await tx.userSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: {
        userId: session.userId,
        organizationId: session.activeOrganizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_auth.sessions_revoked_all',
        entityType: 'user',
        entityId: session.userId,
      },
    });
  });
}

export async function cleanupExpiredUserAuth(db: AuthDb, now = new Date()) {
  const expiredSessionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const expiredTokenCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const terminalEmailJobCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const [tokens, sessions, emailJobs, mfaEnrollments] = await db.$transaction([
    db.userAuthToken.deleteMany({ where: { expiresAt: { lt: expiredTokenCutoff } } }),
    db.userSession.deleteMany({ where: { expiresAt: { lt: expiredSessionCutoff } } }),
    db.userAuthEmailJob.deleteMany({
      where: {
        status: { in: ['SENT', 'CANCELLED', 'DEAD_LETTER'] },
        updatedAt: { lt: terminalEmailJobCutoff },
      },
    }),
    db.user.updateMany({
      where: {
        mfaEnabledAt: null,
        mfaEnrollmentExpiresAt: { lt: now },
      },
      data: { mfaSecretEncrypted: null, mfaEnrollmentExpiresAt: null },
    }),
  ]);
  return {
    tokens: tokens.count,
    sessions: sessions.count,
    emailJobs: emailJobs.count,
    mfaEnrollments: mfaEnrollments.count,
  };
}

export function userSessionMetadata(req: Request) {
  return {
    ip: getClientIp(req),
    userAgent: req.get('user-agent') ?? undefined,
  };
}

export type UserAuthTransaction = Prisma.TransactionClient;
