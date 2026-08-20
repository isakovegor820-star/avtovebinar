import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createMfaEnrollment, decryptMfaSecret, verifyTotp } from '../mfa.js';
import { AppError } from '../http.js';
import { getRequestContext } from '../requestContext.js';
import type { AuthenticatedUserSession } from './userAuth.js';

export const USER_MFA_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

type MfaTransaction = Prisma.TransactionClient;

export const userMfaOtpSchema = z
  .object({
    otp: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();

function mfaSecretUnavailable(): never {
  throw new AppError(409, 'Сначала начните настройку MFA', undefined, 'user_mfa_enrollment_required');
}

function invalidMfaCode(): never {
  throw new AppError(401, 'Введите актуальный одноразовый код', undefined, 'user_mfa_code_invalid');
}

async function lockUser(tx: MfaTransaction, userId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.kind !== 'HUMAN' || user.status !== 'ACTIVE') {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
  return user;
}

async function requireActiveOwner(tx: MfaTransaction, session: AuthenticatedUserSession) {
  if (!session.activeOrganizationId) {
    throw new AppError(403, 'Выберите организацию, которой вы владеете', undefined, 'tenant_owner_required');
  }
  const membership = await tx.organizationMembership.findFirst({
    where: {
      userId: session.userId,
      organizationId: session.activeOrganizationId,
      role: 'OWNER',
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new AppError(403, 'Требуются права владельца организации', undefined, 'tenant_owner_required');
  }
  return membership;
}

function decryptUserMfaSecret(encryptedSecret: string) {
  try {
    return decryptMfaSecret(encryptedSecret);
  } catch {
    throw new AppError(503, 'Настройку MFA нужно повторить', undefined, 'user_mfa_secret_unavailable');
  }
}

async function rotateSessionVersion(
  tx: MfaTransaction,
  session: AuthenticatedUserSession,
  nextVersion: number,
  mfaVerifiedAt: Date | null,
  now: Date,
) {
  await tx.userSession.updateMany({
    where: { userId: session.userId, id: { not: session.id }, revokedAt: null },
    data: { revokedAt: now },
  });
  const current = await tx.userSession.updateMany({
    where: {
      id: session.id,
      userId: session.userId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { sessionVersion: nextVersion, mfaVerifiedAt },
  });
  if (current.count !== 1) {
    throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
  }
}

export async function startOwnerMfaEnrollment(db: PrismaClient, session: AuthenticatedUserSession, now = new Date()) {
  return db.$transaction(async tx => {
    const user = await lockUser(tx, session.userId);
    await requireActiveOwner(tx, session);
    if (user.mfaEnabledAt) {
      throw new AppError(409, 'MFA уже включена', undefined, 'user_mfa_already_enabled');
    }

    const enrollment = createMfaEnrollment(user.emailNormalized);
    const expiresAt = new Date(now.getTime() + USER_MFA_ENROLLMENT_TTL_MS);
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaSecretEncrypted: enrollment.encryptedSecret,
        mfaEnrollmentExpiresAt: expiresAt,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        organizationId: session.activeOrganizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_mfa.enrollment_started',
        entityType: 'user',
        entityId: user.id,
        afterJson: { expiresAt: expiresAt.toISOString() },
      },
    });
    return { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl, expiresAt };
  });
}

export async function confirmOwnerMfaEnrollment(
  db: PrismaClient,
  session: AuthenticatedUserSession,
  input: unknown,
  now = new Date(),
) {
  const { otp } = userMfaOtpSchema.parse(input);
  return db.$transaction(async tx => {
    const user = await lockUser(tx, session.userId);
    await requireActiveOwner(tx, session);
    if (user.mfaEnabledAt) {
      throw new AppError(409, 'MFA уже включена', undefined, 'user_mfa_already_enabled');
    }
    if (!user.mfaSecretEncrypted || !user.mfaEnrollmentExpiresAt || user.mfaEnrollmentExpiresAt <= now) {
      mfaSecretUnavailable();
    }
    const secret = decryptUserMfaSecret(user.mfaSecretEncrypted);
    if (!verifyTotp(secret, otp, now)) invalidMfaCode();

    const nextVersion = user.sessionVersion + 1;
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabledAt: now,
        mfaEnrollmentExpiresAt: null,
        sessionVersion: nextVersion,
      },
    });
    await rotateSessionVersion(tx, session, nextVersion, now, now);
    await tx.auditLog.create({
      data: {
        userId: user.id,
        organizationId: session.activeOrganizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_mfa.enabled',
        entityType: 'user',
        entityId: user.id,
        afterJson: { enabled: true },
      },
    });
    return { enabled: true, verified: true };
  });
}

export async function verifyUserMfa(
  db: PrismaClient,
  session: AuthenticatedUserSession,
  input: unknown,
  now = new Date(),
) {
  const { otp } = userMfaOtpSchema.parse(input);
  return db.$transaction(async tx => {
    const user = await lockUser(tx, session.userId);
    if (!user.mfaEnabledAt || !user.mfaSecretEncrypted) mfaSecretUnavailable();
    const secret = decryptUserMfaSecret(user.mfaSecretEncrypted);
    if (!verifyTotp(secret, otp, now)) invalidMfaCode();

    const updated = await tx.userSession.updateMany({
      where: {
        id: session.id,
        userId: session.userId,
        sessionVersion: user.sessionVersion,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { mfaVerifiedAt: now },
    });
    if (updated.count !== 1) {
      throw new AppError(401, 'Войдите в аккаунт', undefined, 'user_authentication_required');
    }
    await tx.auditLog.create({
      data: {
        userId: user.id,
        organizationId: session.activeOrganizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_mfa.verified',
        entityType: 'user_session',
        entityId: session.id,
        afterJson: { verified: true },
      },
    });
    return { enabled: true, verified: true };
  });
}

export async function disableOwnerMfa(
  db: PrismaClient,
  session: AuthenticatedUserSession,
  input: unknown,
  now = new Date(),
) {
  const { otp } = userMfaOtpSchema.parse(input);
  return db.$transaction(async tx => {
    const user = await lockUser(tx, session.userId);
    await requireActiveOwner(tx, session);
    if (!user.mfaEnabledAt || !user.mfaSecretEncrypted) {
      throw new AppError(409, 'MFA уже выключена', undefined, 'user_mfa_not_enabled');
    }
    const secret = decryptUserMfaSecret(user.mfaSecretEncrypted);
    if (!verifyTotp(secret, otp, now)) invalidMfaCode();

    const nextVersion = user.sessionVersion + 1;
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaSecretEncrypted: null,
        mfaEnabledAt: null,
        mfaEnrollmentExpiresAt: null,
        sessionVersion: nextVersion,
      },
    });
    await rotateSessionVersion(tx, session, nextVersion, null, now);
    await tx.auditLog.create({
      data: {
        userId: user.id,
        organizationId: session.activeOrganizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'user_mfa.disabled',
        entityType: 'user',
        entityId: user.id,
        beforeJson: { enabled: true },
        afterJson: { enabled: false },
      },
    });
    return { enabled: false, verified: true };
  });
}
