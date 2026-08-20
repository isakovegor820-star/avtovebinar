import type { Request } from 'express';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, AppError, getClientIp } from '../lib/http.js';
import { createAdminSession, hashIp, parseAdminSession } from '../lib/tokens.js';
import { env, isStrongPassword } from '../lib/env.js';
import { CRM_STATUS_LABELS, CRM_STATUSES, isCrmStatus } from '../lib/crm.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { formatMoscowDate, sendTelegramMessage, sendTelegramMessageToChat } from '../lib/telegram.js';
import {
  createTelegramBroadcastJob,
  previewTelegramBroadcastRecipients,
  previewTelegramBroadcastRecipientsForSnapshot,
  TELEGRAM_BROADCAST_CREATE_LOCK_KEY,
  TELEGRAM_BROADCAST_MAX_TEXT_LENGTH,
} from '../lib/telegramBroadcastWorker.js';
import { getRequestContext, setContextIdentity } from '../lib/requestContext.js';
import { getAdminHtml } from '../responses/adminPage.js';
import {
  buildFrontendUrl,
  createRoomExchangeUrl,
  getRoomTokenExpiresAt,
  TELEGRAM_BINDING_VERSION,
} from '../lib/roomLinks.js';
import { MODERATOR_NAME, MODERATOR_ROLE, MODERATOR_CHAT_KIND, buildModeratorIntroMessage } from '../lib/moderator.js';
import { findOrCreateWebinarSession } from '../lib/webinarSessions.js';
import { getDailyBroadcastDate } from '../lib/time.js';
import { getWebinarLiveState } from '../lib/webinarLive.js';
import { getScriptedChatMessagesUntil } from '../lib/scriptedChat.js';
import { createMfaEnrollment, decryptMfaSecret, verifyTotp } from '../lib/mfa.js';
import { anonymizeLeadInTransaction, LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS } from '../lib/anonymizeLead.js';
import { acquireLeadSecurityLock, isParticipantRegistrationActive } from '../lib/leadSecurity.js';
import {
  getAdminAuthorEvidenceContent,
  getAdminAuthorVerification,
  listAdminAuthorVerifications,
  reviewAuthorVerification,
} from '../lib/tenancy/authorVerification.js';

export const adminRouter = Router();

const ADMIN_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];
type AnalyticsGroupBy = 'source' | 'utmSource' | 'utmMedium' | 'utmCampaign';
const ADMIN_OWNER_MUTATION_LOCK_KEY = BigInt('48192731001');
const LEAD_ANONYMIZATION_LOCK_KEY = BigInt('48192731003');
const strongAdminPasswordSchema = z
  .string()
  .max(200)
  .refine(isStrongPassword, 'Пароль должен быть не короче 12 символов и содержать буквы и цифры');

function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole);
}

function adminSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: (env.NODE_ENV === 'production' ? 'strict' : 'lax') as 'strict' | 'lax',
    secure: env.NODE_ENV === 'production',
    partitioned: env.NODE_ENV === 'production' ? true : undefined,
    path: '/',
  };
}

async function acquireTransactionLock(tx: Prisma.TransactionClient, key: bigint) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${key})`);
}

const eventAnalyticsColumns: Record<AnalyticsGroupBy, Prisma.Sql> = {
  source: Prisma.raw('e."source"'),
  utmSource: Prisma.raw('e."utm_source"'),
  utmMedium: Prisma.raw('e."utm_medium"'),
  utmCampaign: Prisma.raw('e."utm_campaign"'),
};

type FunnelCohortRow = {
  key: string;
  visitors: number | bigint;
  legacyVisitors: number | bigint;
  registrations: number | bigint;
  telegramClicks: number | bigint;
  telegramSubscribers: number | bigint;
  roomEntries: number | bigint;
  questions: number | bigint;
  applications: number | bigint;
  contracts: number | bigint;
};

function toCount(value: number | bigint) {
  return typeof value === 'bigint' ? Number(value) : value;
}

type AdminRequest = Request & {
  admin?: {
    id: string | null;
    login: string;
    email: string | null;
    role: string;
  };
};

async function requireAdmin(req: AdminRequest, _res: any, next: any) {
  const session = parseAdminSession(req.cookies?.aspb_admin_session);
  if (!session) {
    return next(new AppError(401, 'Admin authorization required'));
  }

  if (!session.adminId) {
    // Сессии без adminId больше не принимаются. Dev-bypass (ADMIN_DEV_BYPASS) удалён:
    // при ошибочном NODE_ENV=development на проде он давал owner-доступ кому угодно.
    // Для локальной разработки используйте реального администратора из БД (seed).
    return next(new AppError(401, 'Admin authorization required'));
  }

  if (session.adminId) {
    const adminUser = await prisma.adminUser.findUnique({ where: { id: session.adminId } });
    if (
      !adminUser ||
      !adminUser.isActive ||
      session.sessionVersion !== adminUser.sessionVersion ||
      !adminUser.mfaEnabledAt
    ) {
      return next(new AppError(401, 'Admin authorization required'));
    }

    req.admin = {
      id: adminUser.id,
      login: adminUser.name,
      email: adminUser.email,
      role: adminUser.role,
    };
    setContextIdentity({ adminId: adminUser.id });
    return next();
  }

  req.admin = {
    id: null,
    login: session.login ?? env.ADMIN_LOGIN,
    email: session.email ?? null,
    role: session.role ?? 'owner',
  };
  setContextIdentity({ adminId: req.admin.id ?? req.admin.login });
  return next();
}

function requireRole(roles: AdminRole[]) {
  return (req: AdminRequest, _res: any, next: any) => {
    if (!req.admin || !roles.includes(req.admin.role as AdminRole)) {
      return next(new AppError(403, 'Недостаточно прав'));
    }

    return next();
  };
}

async function ensureDefaultAdminUser() {
  const existingCount = await prisma.adminUser.count();
  if (existingCount > 0) {
    return null;
  }

  return prisma.adminUser.create({
    data: {
      name: env.ADMIN_LOGIN,
      email: env.ADMIN_LOGIN.includes('@') ? env.ADMIN_LOGIN.toLowerCase() : `${env.ADMIN_LOGIN}@local.admin`,
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      role: 'owner',
    },
  });
}

async function audit(
  req: AdminRequest,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
  db: Pick<Prisma.TransactionClient, 'auditLog'> | typeof prisma = prisma,
) {
  await db.auditLog.create({
    data: {
      adminUserId: req.admin?.id ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeJson: input.before === undefined ? Prisma.JsonNull : (input.before as Prisma.InputJsonValue),
      afterJson: input.after === undefined ? Prisma.JsonNull : (input.after as Prisma.InputJsonValue),
      ipHash: hashIp(getClientIp(req)),
      userAgent: req.headers['user-agent'] ?? null,
    },
  });
}

function getAdminRole(req: AdminRequest): AdminRole {
  const role = req.admin?.role;
  return typeof role === 'string' && isAdminRole(role) ? role : 'viewer';
}

function canSeeAllRegistrations(req: AdminRequest) {
  const role = getAdminRole(req);
  return role === 'owner' || role === 'admin';
}

function shouldMaskRegistrationPii(req: AdminRequest) {
  return getAdminRole(req) === 'viewer';
}

function managerWorkQueueWhere(now = new Date()): Prisma.RegistrationWhereInput {
  return {
    OR: [{ isHot: true }, { roomEnteredAt: { not: null } }, { nextContactAt: { lte: now } }],
  };
}

const VERIFIED_REGISTRATION_WHERE: Prisma.RegistrationWhereInput = {
  status: 'registered',
  emailVerifiedAt: { not: null },
};

function getRegistrationAccessWhere(req: AdminRequest, where: Prisma.RegistrationWhereInput = {}) {
  const verifiedWhere: Prisma.RegistrationWhereInput = {
    AND: [VERIFIED_REGISTRATION_WHERE, where],
  };
  if (canSeeAllRegistrations(req) || getAdminRole(req) === 'viewer') {
    return verifiedWhere;
  }

  const managerId = req.admin?.id;
  if (!managerId) {
    throw new AppError(403, 'Недостаточно прав');
  }

  return {
    AND: [
      verifiedWhere,
      {
        OR: [
          { assignedManagerId: managerId },
          {
            AND: [{ assignedManagerId: null }, managerWorkQueueWhere()],
          },
        ],
      },
    ],
  } satisfies Prisma.RegistrationWhereInput;
}

function getQuestionAccessWhere(req: AdminRequest, where: Prisma.QuestionWhereInput = {}) {
  if (canSeeAllRegistrations(req) || getAdminRole(req) === 'viewer') {
    return where;
  }

  return {
    AND: [where, { registration: getRegistrationAccessWhere(req) }],
  } satisfies Prisma.QuestionWhereInput;
}

function getPartnerApplicationAccessWhere(req: AdminRequest, where: Prisma.PartnerApplicationWhereInput = {}) {
  if (canSeeAllRegistrations(req) || getAdminRole(req) === 'viewer') {
    return where;
  }

  return {
    AND: [where, { registration: { is: getRegistrationAccessWhere(req) } }],
  } satisfies Prisma.PartnerApplicationWhereInput;
}

function maskName(value: string | null | undefined) {
  if (!value) return value ?? null;
  const trimmed = value.trim();
  return trimmed ? `${trimmed.slice(0, 1)}***` : trimmed;
}

function maskEmail(value: string | null | undefined) {
  if (!value) return value ?? null;
  const [local, domain] = value.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskPhone(value: string | null | undefined) {
  if (!value) return value ?? null;
  const digits = value.replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : '***';
}

function maskNullable(value: string | null | undefined) {
  return value ? '[hidden]' : (value ?? null);
}

function serializeAssignedManagerForAdmin(manager: any, maskPii: boolean) {
  if (!manager || !maskPii) return manager;
  return { id: manager.id, name: manager.name, role: manager.role };
}

function serializeLeadForAdmin(lead: any, maskPii: boolean, includeExtendedFields: boolean) {
  if (maskPii) {
    const viewerLead = {
      id: lead.id,
      name: maskName(lead.name),
      phone: maskPhone(lead.phone),
      email: maskEmail(lead.email),
      city: null,
      professionalStatus: null,
      telegramChatId: maskNullable(lead.telegramChatId),
      telegramUsername: maskNullable(lead.telegramUsername),
      telegramFirstName: maskName(lead.telegramFirstName),
      telegramSubscribedAt: null,
    };
    return includeExtendedFields
      ? {
          ...viewerLead,
          source: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
        }
      : viewerLead;
  }

  const base = {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    city: lead.city,
    professionalStatus: lead.professionalStatus,
    telegramChatId: lead.telegramChatId,
    telegramUsername: lead.telegramUsername,
    telegramFirstName: lead.telegramFirstName,
    telegramSubscribedAt: lead.telegramSubscribedAt,
  };

  if (!includeExtendedFields) {
    return base;
  }

  return {
    ...base,
    source: lead.source,
    utmSource: lead.utmSource,
    utmMedium: lead.utmMedium,
    utmCampaign: lead.utmCampaign,
  };
}

function serializeRegistrationDetailForAdmin(registration: any, maskPii: boolean) {
  if (!maskPii) {
    return registration;
  }

  return {
    id: registration.id,
    status: registration.status,
    crmStatus: registration.crmStatus,
    isHot: registration.isHot,
    managerNote: null,
    assignedManagerId: registration.assignedManagerId,
    assignedManager: serializeAssignedManagerForAdmin(registration.assignedManager, true),
    nextContactAt: registration.nextContactAt,
    registeredAt: registration.registeredAt,
    successViewedAt: registration.successViewedAt,
    roomEnteredAt: registration.roomEnteredAt,
    telegramClickedAt: registration.telegramClickedAt,
    chatBannedAt: registration.chatBannedAt,
    lead: serializeLeadForAdmin(registration.lead, true, true),
    webinarSession: registration.webinarSession
      ? {
          id: registration.webinarSession.id,
          title: registration.webinarSession.title,
          scheduledAt: registration.webinarSession.scheduledAt,
          durationMinutes: registration.webinarSession.durationMinutes,
          status: registration.webinarSession.status,
        }
      : null,
    questions: registration.questions?.map((question: any) => ({
      id: question.id,
      registrationId: question.registrationId,
      text: '[hidden]',
      publishedName: null,
      adminNote: null,
      isAnswered: question.isAnswered,
      forwardedAt: question.forwardedAt,
      createdAt: question.createdAt,
    })),
    partnerApplications: registration.partnerApplications?.map((application: any) => ({
      id: application.id,
      registrationId: application.registrationId,
      sphere: null,
      city: null,
      clientFlow: null,
      experience: null,
      comment: null,
      preferredFormat: null,
      status: application.status,
      assignedManagerId: application.assignedManagerId,
      nextContactAt: application.nextContactAt,
      contractSentAt: application.contractSentAt,
      contractSignedAt: application.contractSignedAt,
      createdAt: application.createdAt,
    })),
    events: registration.events?.map((event: any) => ({
      id: event.id,
      eventName: event.eventName,
      webinarSessionId: event.webinarSessionId,
      page: event.page,
      source: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      visitorId: null,
      userAgent: null,
      ipHash: null,
      metadataJson: null,
      createdAt: event.createdAt,
    })),
  };
}

function serializePartnerApplicationForAdmin(application: any, maskPii: boolean) {
  return {
    id: application.id,
    registrationId: application.registrationId,
    sphere: maskPii ? null : application.sphere,
    city: maskPii ? null : application.city,
    clientFlow: maskPii ? null : application.clientFlow,
    experience: maskPii ? null : application.experience,
    comment: maskPii ? maskNullable(application.comment) : application.comment,
    preferredFormat: maskPii ? null : application.preferredFormat,
    status: application.status,
    createdAt: application.createdAt,
    lead: serializeLeadForAdmin(application.lead, maskPii, false),
    webinar: application.webinarSession
      ? {
          scheduledAt: application.webinarSession.scheduledAt,
        }
      : null,
  };
}

function serializeQuestionForAdmin(question: any, maskPii: boolean) {
  return {
    id: question.id,
    registrationId: question.registrationId,
    text: maskPii && question.text ? '[hidden]' : question.text,
    isAnswered: question.isAnswered,
    forwardedAt: question.forwardedAt ?? null,
    chatBanned: Boolean(question.registration?.chatBannedAt),
    adminNote: maskPii && question.adminNote ? '[hidden]' : question.adminNote,
    createdAt: question.createdAt,
    lead: serializeLeadForAdmin(question.lead, maskPii, false),
    webinar: {
      scheduledAt: question.webinarSession.scheduledAt,
    },
  };
}

adminRouter.get('/admin', (_req, res) => {
  res.type('html').send(getAdminHtml());
});

adminRouter.post(
  '/api/admin/login',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        login: z.string().trim(),
        password: z.string(),
        otp: z
          .string()
          .trim()
          .regex(/^\d{6}$/)
          .optional()
          .or(z.literal('')),
      })
      .parse(req.body);
    await ensureDefaultAdminUser();

    const login = data.login.toLowerCase();
    const adminUser = await prisma.adminUser.findFirst({
      where: {
        isActive: true,
        OR: [{ email: login }, { name: data.login }],
      },
    });

    const passwordMatches = adminUser ? await verifyPassword(data.password, adminUser.passwordHash) : false;
    if (!adminUser || !passwordMatches) {
      await prisma.auditLog.create({
        data: {
          adminUserId: adminUser?.id ?? null,
          action: 'admin.login.failed',
          entityType: 'admin_session',
          entityId: adminUser?.id ?? null,
          ipHash: hashIp(getClientIp(req)),
          userAgent: req.headers['user-agent'] ?? null,
          afterJson: { reason: 'invalid_credentials' },
        },
      });
      throw new AppError(401, 'Неверный логин или пароль');
    }

    if (!adminUser.mfaSecretEncrypted) {
      const enrollment = createMfaEnrollment(adminUser.email);
      await prisma.adminUser.update({
        where: { id: adminUser.id },
        data: {
          mfaSecretEncrypted: enrollment.encryptedSecret,
          mfaEnabledAt: null,
          sessionVersion: { increment: 1 },
        },
      });
      await prisma.auditLog.create({
        data: {
          adminUserId: adminUser.id,
          action: 'admin.mfa.enrollment_started',
          entityType: 'admin_user',
          entityId: adminUser.id,
          ipHash: hashIp(getClientIp(req)),
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
      res.json({
        ok: true,
        authenticated: false,
        mfaSetupRequired: true,
        secret: enrollment.secret,
        otpauthUrl: enrollment.otpauthUrl,
      });
      return;
    }

    if (!data.otp) {
      res.json({ ok: true, authenticated: false, mfaRequired: true });
      return;
    }
    let mfaSecret: string;
    try {
      mfaSecret = decryptMfaSecret(adminUser.mfaSecretEncrypted);
    } catch {
      throw new AppError(503, 'MFA требует сброса администратором');
    }
    if (!verifyTotp(mfaSecret, data.otp)) {
      await prisma.auditLog.create({
        data: {
          adminUserId: adminUser.id,
          action: 'admin.login.failed',
          entityType: 'admin_session',
          entityId: adminUser.id,
          ipHash: hashIp(getClientIp(req)),
          userAgent: req.headers['user-agent'] ?? null,
          afterJson: { reason: 'invalid_mfa' },
        },
      });
      throw new AppError(401, 'Неверный одноразовый код');
    }

    const authenticatedAdmin = await prisma.adminUser.update({
      where: { id: adminUser.id },
      data: {
        lastLoginAt: new Date(),
        mfaEnabledAt: adminUser.mfaEnabledAt ?? new Date(),
      },
    });
    const sessionAdmin = {
      id: authenticatedAdmin.id,
      email: authenticatedAdmin.email,
      role: authenticatedAdmin.role,
      sessionVersion: authenticatedAdmin.sessionVersion,
    };

    await prisma.auditLog.create({
      data: {
        adminUserId: authenticatedAdmin.id,
        action: 'admin.login.succeeded',
        entityType: 'admin_session',
        entityId: authenticatedAdmin.id,
        ipHash: hashIp(getClientIp(req)),
        userAgent: req.headers['user-agent'] ?? null,
        afterJson: { mfa: true },
      },
    });

    res.cookie('aspb_admin_session', createAdminSession(sessionAdmin), {
      ...adminSessionCookieOptions(),
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, authenticated: true });
  }),
);

adminRouter.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('aspb_admin_session', adminSessionCookieOptions());
  res.json({ ok: true });
});

adminRouter.post(
  '/api/admin/sessions/revoke-all',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const actor = (req as AdminRequest).admin;
    if (!actor?.id) throw new AppError(401, 'Admin authorization required');
    await prisma.adminUser.update({
      where: { id: actor.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await audit(req as AdminRequest, {
      action: 'admin.sessions.revoke_all',
      entityType: 'admin_user',
      entityId: actor.id,
      after: { revoked: true },
    });
    res.clearCookie('aspb_admin_session', adminSessionCookieOptions());
    res.json({ ok: true, revoked: true });
  }),
);

adminRouter.get(
  '/api/admin/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, admin: (req as AdminRequest).admin });
  }),
);

adminRouter.get(
  '/api/v1/platform/author-verifications',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const result = await listAdminAuthorVerifications(prisma, req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

adminRouter.get(
  '/api/v1/platform/author-verifications/evidence/:evidenceId',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const params = z
      .object({ evidenceId: z.string().trim().min(1).max(191) })
      .strict()
      .parse(req.params);
    const actor = (req as AdminRequest).admin;
    if (!actor?.id) throw new AppError(401, 'Admin authorization required');
    const evidence = await getAdminAuthorEvidenceContent(prisma, params.evidenceId);
    await prisma.auditLog.create({
      data: {
        adminUserId: actor.id,
        organizationId: evidence.organizationId,
        correlationId: getRequestContext()?.correlationId,
        action: 'author_verification.evidence_accessed_by_admin',
        entityType: 'author_verification_evidence',
        entityId: evidence.id,
        ipHash: hashIp(getClientIp(req)),
        userAgent: req.headers['user-agent'] ?? null,
      },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-${evidence.id}"`);
    res.type(evidence.mimeType).send(Buffer.from(evidence.content));
  }),
);

adminRouter.get(
  '/api/v1/platform/author-verifications/:verificationId',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const params = z
      .object({ verificationId: z.string().trim().min(1).max(191) })
      .strict()
      .parse(req.params);
    const verification = await getAdminAuthorVerification(prisma, params.verificationId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, verification, correlationId: getRequestContext()?.correlationId });
  }),
);

adminRouter.patch(
  '/api/v1/platform/author-verifications/:verificationId',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const params = z
      .object({ verificationId: z.string().trim().min(1).max(191) })
      .strict()
      .parse(req.params);
    const actor = (req as AdminRequest).admin;
    if (!actor?.id) throw new AppError(401, 'Admin authorization required');
    const verification = await reviewAuthorVerification(
      prisma,
      actor.id,
      params.verificationId,
      req.body,
      getRequestContext()?.correlationId,
    );
    res.json({ ok: true, verification, correlationId: getRequestContext()?.correlationId });
  }),
);

adminRouter.get(
  '/api/admin/managers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const maskPii = shouldMaskRegistrationPii(req as AdminRequest);
    const managers = await prisma.adminUser.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    res.json({
      ok: true,
      managers: managers.map(manager => serializeAssignedManagerForAdmin(manager, maskPii)),
    });
  }),
);

adminRouter.get('/api/admin/crm-statuses', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    statuses: CRM_STATUSES.map(status => ({ value: status, label: CRM_STATUS_LABELS[status] })),
  });
});

adminRouter.get(
  '/api/admin/users',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (_req, res) => {
    const users = await prisma.adminUser.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });

    res.json({ ok: true, roles: ADMIN_ROLES, users });
  }),
);

adminRouter.post(
  '/api/admin/users',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(160),
        password: strongAdminPasswordSchema,
        role: z.string().default('manager'),
      })
      .parse(req.body);

    if (!isAdminRole(data.role)) {
      throw new AppError(400, 'Invalid admin role');
    }

    if (data.role === 'owner' && (req as AdminRequest).admin?.role !== 'owner') {
      throw new AppError(403, 'Недостаточно прав для создания владельца');
    }

    const user = await prisma.adminUser.create({
      data: {
        name: data.name,
        email: data.email.toLowerCase(),
        passwordHash: await hashPassword(data.password),
        role: data.role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit(req as AdminRequest, {
      action: 'admin_user.create',
      entityType: 'admin_user',
      entityId: user.id,
      after: user,
    });

    res.status(201).json({ ok: true, user });
  }),
);

adminRouter.patch(
  '/api/admin/users/:id',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.string().optional(),
        isActive: z.boolean().optional(),
        password: strongAdminPasswordSchema.optional().or(z.literal('')),
        resetMfa: z.boolean().optional(),
      })
      .parse(req.body);
    if (data.role && !isAdminRole(data.role)) {
      throw new AppError(400, 'Invalid admin role');
    }

    const actorRole = (req as AdminRequest).admin?.role;
    const passwordHash = data.password ? await hashPassword(data.password) : undefined;
    const { before, user } = await prisma.$transaction(async tx => {
      // Every owner-affecting PATCH takes the same transaction-scoped lock. The owner count and
      // mutation therefore cannot both pass concurrently and leave the system without an owner.
      await acquireTransactionLock(tx, ADMIN_OWNER_MUTATION_LOCK_KEY);
      const before = await tx.adminUser.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, role: true, isActive: true },
      });

      if (!before) {
        throw new AppError(404, 'Admin user not found');
      }

      if (actorRole !== 'owner') {
        if (before.role === 'owner') {
          throw new AppError(403, 'Недостаточно прав для изменения владельца');
        }
        if (data.role === 'owner') {
          throw new AppError(403, 'Недостаточно прав для назначения роли владельца');
        }
      }

      const removesActiveOwner =
        before.role === 'owner' &&
        before.isActive &&
        ((data.role !== undefined && data.role !== 'owner') || data.isActive === false);
      if (removesActiveOwner) {
        const activeOwnerCount = await tx.adminUser.count({
          where: { role: 'owner', isActive: true },
        });
        if (activeOwnerCount <= 1) {
          throw new AppError(409, 'Нельзя отключить или понизить последнего активного владельца');
        }
      }

      const user = await tx.adminUser.update({
        where: { id },
        data: {
          name: data.name,
          role: data.role,
          isActive: data.isActive,
          passwordHash,
          mfaSecretEncrypted: data.resetMfa ? null : undefined,
          mfaEnabledAt: data.resetMfa ? null : undefined,
          sessionVersion:
            data.password || data.resetMfa || data.role !== undefined || data.isActive !== undefined
              ? { increment: 1 }
              : undefined,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { before, user };
    });

    await audit(req as AdminRequest, {
      action: 'admin_user.update',
      entityType: 'admin_user',
      entityId: user.id,
      before,
      after: user,
    });

    res.json({ ok: true, user });
  }),
);

// #16 (152-ФЗ, право субъекта на удаление/отзыв): обезличивание лида по запросу.
// Персональные поля затираются; строка и обезличенная статистика сохраняются; факт — в AuditLog.
adminRouter.post(
  '/api/admin/leads/:id/anonymize',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const id = z.string().min(1).parse(req.params.id);
    const anonymizedAt = new Date();
    const result = await prisma.$transaction(
      async tx => {
        await acquireTransactionLock(tx, LEAD_ANONYMIZATION_LOCK_KEY);
        const anonymization = await anonymizeLeadInTransaction(tx, {
          leadId: id,
          anonymizedAt,
          revocationChannel: 'admin',
          revocationReason: 'manual_admin_anonymization',
        });
        if (!anonymization.anonymized) {
          throw new AppError(404, 'Лид не найден');
        }

        // The erasure and its audit evidence are one atomic commit. A process crash must not leave
        // irreversible deletion without the required operator trail.
        await audit(
          req as AdminRequest,
          {
            action: 'lead.anonymize',
            entityType: 'lead',
            entityId: id,
            before: { id, hadPersonalData: true },
            after: { anonymized: true, anonymizedAt: anonymizedAt.toISOString() },
          },
          tx,
        );

        return {
          registrationCount: anonymization.registrationCount,
          questionCount: anonymization.questionCount,
          partnerApplicationCount: anonymization.partnerApplicationCount,
          broadcastRecipientCount: anonymization.broadcastRecipientCount,
        };
      },
      { maxWait: 5_000, timeout: LEAD_ANONYMIZATION_TRANSACTION_TIMEOUT_MS },
    );
    res.json({ ok: true, anonymized: true, ...result });
  }),
);

adminRouter.get(
  '/api/admin/registrations',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        query: z.string().optional(),
        date: z.string().optional(),
        status: z.string().optional(),
        queue: z.string().optional(),
        managerId: z.string().optional(),
        telegram: z.string().optional(),
        room: z.string().optional(),
        hasQuestion: z.string().optional(),
        hasApplication: z.string().optional(),
      })
      .parse(req.query);

    const dateFilter = query.date
      ? {
          gte: new Date(`${query.date}T00:00:00.000Z`),
          lt: new Date(`${query.date}T23:59:59.999Z`),
        }
      : undefined;

    const queueWhere: Prisma.RegistrationWhereInput =
      query.queue === 'hot'
        ? {
            OR: [
              { isHot: true },
              { questions: { some: {} } },
              { partnerApplications: { some: {} } },
              { roomEnteredAt: { not: null } },
            ],
          }
        : query.queue === 'questions'
          ? { questions: { some: {} } }
          : query.queue === 'applications'
            ? { partnerApplications: { some: {} } }
            : query.queue === 'contracts'
              ? { crmStatus: { in: ['contract_pending', 'contract_signed', 'payout_due', 'paid'] } }
              : query.queue === 'today'
                ? { nextContactAt: { lte: new Date() } }
                : query.queue === 'new'
                  ? { crmStatus: 'new' }
                  : {};

    const leadFilters: Prisma.LeadWhereInput[] = [];
    if (query.telegram === 'yes') {
      leadFilters.push({
        telegramChatId: { not: null },
        telegramBindingVersion: TELEGRAM_BINDING_VERSION,
      });
    }
    if (query.telegram === 'no') {
      leadFilters.push({
        OR: [
          { telegramChatId: null },
          { telegramBindingVersion: null },
          { telegramBindingVersion: { not: TELEGRAM_BINDING_VERSION } },
        ],
      });
    }
    if (query.query) {
      leadFilters.push({
        OR: [
          { name: { contains: query.query, mode: 'insensitive' } },
          { email: { contains: query.query, mode: 'insensitive' } },
          { phone: { contains: query.query, mode: 'insensitive' } },
        ],
      });
    }
    const leadWhere: Prisma.LeadWhereInput | undefined = leadFilters.length ? { AND: leadFilters } : undefined;

    // Явные фильтры держим отдельно и склеиваем с queueWhere через AND. Иначе spread
    // одноимённых ключей (crmStatus/questions/partnerApplications) затирал условие вкладки
    // значением `undefined` → вкладки «Новые»/«Вопросы»/«Заявки»/«Договоры» не фильтровали.
    const explicitWhere: Prisma.RegistrationWhereInput = {
      crmStatus: query.status || undefined,
      assignedManagerId: query.managerId || undefined,
      roomEnteredAt: query.room === 'yes' ? { not: null } : query.room === 'no' ? null : undefined,
      questions: query.hasQuestion === 'yes' ? { some: {} } : undefined,
      partnerApplications: query.hasApplication === 'yes' ? { some: {} } : undefined,
      webinarSession: dateFilter ? { scheduledAt: dateFilter } : undefined,
      lead: leadWhere,
    };
    const where: Prisma.RegistrationWhereInput = { AND: [queueWhere, explicitWhere] };

    const adminReq = req as AdminRequest;
    const maskPii = shouldMaskRegistrationPii(adminReq);
    const registrations = await prisma.registration.findMany({
      where: getRegistrationAccessWhere(adminReq, where),
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        _count: { select: { questions: true, partnerApplications: true } },
      },
      orderBy: { registeredAt: 'desc' },
      take: 200,
    });

    res.json({
      ok: true,
      registrations: registrations.map(item => ({
        id: item.id,
        status: item.status,
        crmStatus: item.crmStatus,
        managerNote: maskPii ? null : item.managerNote,
        isHot: item.isHot,
        assignedManagerId: item.assignedManagerId,
        assignedManager: serializeAssignedManagerForAdmin(item.assignedManager, maskPii),
        nextContactAt: item.nextContactAt,
        registeredAt: item.registeredAt,
        roomEnteredAt: item.roomEnteredAt,
        telegramClickedAt: item.telegramClickedAt,
        questionCount: item._count.questions,
        partnerApplicationCount: item._count.partnerApplications,
        lead: serializeLeadForAdmin(item.lead, maskPii, true),
        webinar: {
          id: item.webinarSession.id,
          scheduledAt: item.webinarSession.scheduledAt,
          status: item.webinarSession.status,
        },
      })),
    });
  }),
);

adminRouter.get(
  '/api/admin/hot-leads',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const adminReq = req as AdminRequest;
    const maskPii = shouldMaskRegistrationPii(adminReq);
    const hotQueueWhere: Prisma.RegistrationWhereInput = {
      OR: [
        { isHot: true },
        { partnerApplications: { some: {} } },
        { questions: { some: {} } },
        { roomEnteredAt: { not: null } },
      ],
    };
    const registrations = await prisma.registration.findMany({
      where: getRegistrationAccessWhere(adminReq, hotQueueWhere),
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        _count: { select: { questions: true, partnerApplications: true } },
      },
      orderBy: [{ isHot: 'desc' }, { updatedAt: 'desc' }],
      take: 12,
    });

    res.json({
      ok: true,
      registrations: registrations.map(item => ({
        id: item.id,
        crmStatus: item.crmStatus,
        isHot: item.isHot,
        assignedManagerId: item.assignedManagerId,
        assignedManager: serializeAssignedManagerForAdmin(item.assignedManager, maskPii),
        nextContactAt: item.nextContactAt,
        roomEnteredAt: item.roomEnteredAt,
        telegramClickedAt: item.telegramClickedAt,
        questionCount: item._count.questions,
        partnerApplicationCount: item._count.partnerApplications,
        lead: serializeLeadForAdmin(item.lead, maskPii, false),
        webinar: {
          scheduledAt: item.webinarSession.scheduledAt,
        },
      })),
    });
  }),
);

adminRouter.get(
  '/api/admin/registrations/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const maskPii = shouldMaskRegistrationPii(adminReq);
    const registration = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        questions: { orderBy: { createdAt: 'desc' } },
        partnerApplications: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    const auditLogs = maskPii
      ? []
      : await prisma.auditLog.findMany({
          where: { entityType: 'registration', entityId: id },
          include: { adminUser: { select: { name: true, email: true, role: true } } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        });

    res.json({ ok: true, registration: serializeRegistrationDetailForAdmin(registration, maskPii), auditLogs });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/status',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z.object({ crmStatus: z.string() }).parse(req.body);

    if (!isCrmStatus(data.crmStatus)) {
      throw new AppError(400, 'Invalid CRM status');
    }

    const before = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      select: { crmStatus: true },
    });
    if (!before) {
      throw new AppError(404, 'Registration not found');
    }

    const registration = await prisma.registration.update({
      where: { id },
      data: { crmStatus: data.crmStatus },
    });

    await audit(adminReq, {
      action: 'registration.crm_status.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { crmStatus: registration.crmStatus },
    });

    res.json({ ok: true, registration });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/hot',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z.object({ isHot: z.boolean() }).parse(req.body);
    const before = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      select: { isHot: true },
    });
    if (!before) {
      throw new AppError(404, 'Registration not found');
    }

    const registration = await prisma.registration.update({
      where: { id },
      data: { isHot: data.isHot },
    });

    await audit(adminReq, {
      action: 'registration.hot.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { isHot: registration.isHot },
    });

    res.json({ ok: true, registration });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/manager',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z
      .object({
        assignedManagerId: z.string().optional().nullable(),
        nextContactAt: z.string().optional().nullable(),
      })
      .parse(req.body);
    const before = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      select: { assignedManagerId: true, nextContactAt: true },
    });
    if (!before) {
      throw new AppError(404, 'Registration not found');
    }

    if (data.assignedManagerId) {
      const manager = await prisma.adminUser.findUnique({ where: { id: data.assignedManagerId } });
      if (!manager || !manager.isActive) {
        throw new AppError(400, 'Manager not found or inactive');
      }
    }

    const registration = await prisma.registration.update({
      where: { id },
      data: {
        assignedManagerId: data.assignedManagerId || null,
        nextContactAt: data.nextContactAt ? new Date(data.nextContactAt) : null,
      },
    });

    await audit(adminReq, {
      action: 'registration.manager.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { assignedManagerId: registration.assignedManagerId, nextContactAt: registration.nextContactAt },
    });

    res.json({ ok: true, registration });
  }),
);

adminRouter.post(
  '/api/admin/registrations/:id/telegram-reminder',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z.object({ text: z.string().trim().max(1200).optional().or(z.literal('')) }).parse(req.body);
    const registration = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      include: { lead: true, webinarSession: true },
    });

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    if (!registration.lead.telegramChatId || registration.lead.telegramBindingVersion !== TELEGRAM_BINDING_VERSION) {
      throw new AppError(400, 'У участника не подключен Telegram');
    }

    const secured = await prisma.$transaction(async tx => {
      await acquireLeadSecurityLock(tx, registration.leadId);
      const activeRegistration = await tx.registration.findFirst({
        where: getRegistrationAccessWhere(adminReq, { id: registration.id }),
        include: { lead: true, webinarSession: true },
      });
      if (!activeRegistration || !isParticipantRegistrationActive(activeRegistration)) {
        throw new AppError(409, 'Регистрация больше не активна');
      }
      if (
        !activeRegistration.lead.telegramChatId ||
        activeRegistration.lead.telegramBindingVersion !== TELEGRAM_BINDING_VERSION
      ) {
        throw new AppError(400, 'У участника не подключен Telegram');
      }
      const roomUrl = await createRoomExchangeUrl(tx, {
        registrationId: activeRegistration.id,
        expiresAt: getRoomTokenExpiresAt(activeRegistration.webinarSession),
      });
      return { registration: activeRegistration, roomUrl };
    });
    const activeRegistration = secured.registration;
    const roomUrl = secured.roomUrl;
    const defaultText = [
      `${activeRegistration.lead.name}, напоминаем про вебинар АСПБ.`,
      '',
      `Начало: ${formatMoscowDate(activeRegistration.webinarSession.scheduledAt)} МСК`,
      '',
      `Ваша персональная комната: ${roomUrl}`,
    ].join('\n');
    const text = data.text ? [data.text, '', `Ваша персональная комната: ${roomUrl}`].join('\n') : defaultText;

    await sendTelegramMessageToChat(activeRegistration.lead.telegramChatId!, text);

    await prisma.$transaction(async tx => {
      await acquireLeadSecurityLock(tx, activeRegistration.leadId);
      const stillActive = await tx.registration.findUnique({
        where: { id: activeRegistration.id },
        include: { lead: true },
      });
      if (!stillActive || !isParticipantRegistrationActive(stillActive)) return;
      await tx.event.create({
        data: {
          eventName: 'admin_manual_telegram_reminder',
          leadId: stillActive.leadId,
          registrationId: stillActive.id,
          webinarSessionId: stillActive.webinarSessionId,
          source: 'admin',
          page: 'admin',
        },
      });
      await audit(
        adminReq,
        {
          action: 'registration.telegram_reminder.send',
          entityType: 'registration',
          entityId: stillActive.id,
          after: { chatId: stillActive.lead.telegramChatId, textLength: text.length },
        },
        tx,
      );
    });

    res.json({ ok: true, sent: true, webinarUrl: roomUrl });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/note',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z.object({ managerNote: z.string().max(5000).optional().or(z.literal('')) }).parse(req.body);
    const registration = await prisma.$transaction(async tx => {
      const registrationRef = await tx.registration.findFirst({
        where: getRegistrationAccessWhere(adminReq, { id }),
        select: { leadId: true },
      });
      if (!registrationRef) {
        throw new AppError(404, 'Registration not found');
      }
      await acquireLeadSecurityLock(tx, registrationRef.leadId);
      const activeRegistration = await tx.registration.findFirst({
        where: getRegistrationAccessWhere(adminReq, { id }),
        include: { lead: true },
      });
      if (!activeRegistration || !isParticipantRegistrationActive(activeRegistration)) {
        throw new AppError(409, 'Регистрация больше не активна');
      }
      const registration = await tx.registration.update({
        where: { id },
        data: { managerNote: data.managerNote || null },
      });
      await audit(
        adminReq,
        {
          action: 'registration.note.update',
          entityType: 'registration',
          entityId: id,
          before: { managerNote: activeRegistration.managerNote },
          after: { managerNote: registration.managerNote },
        },
        tx,
      );
      return registration;
    });

    res.json({ ok: true, registration });
  }),
);

adminRouter.get(
  '/api/admin/partner-applications',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const adminReq = req as AdminRequest;
    const maskPii = shouldMaskRegistrationPii(adminReq);
    const applications = await prisma.partnerApplication.findMany({
      where: getPartnerApplicationAccessWhere(adminReq),
      include: {
        lead: true,
        registration: true,
        webinarSession: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({
      ok: true,
      applications: applications.map(application => serializePartnerApplicationForAdmin(application, maskPii)),
    });
  }),
);

adminRouter.post(
  '/api/admin/telegram/broadcast/preview',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    z.object({ text: z.string().trim().min(3).max(TELEGRAM_BROADCAST_MAX_TEXT_LENGTH) }).parse(req.body);
    const preview = await previewTelegramBroadcastRecipients();
    res.json({
      ok: true,
      enabled: preview.enabled,
      total: preview.total,
      consentDocumentId: preview.consentDocumentId,
      consentDocumentVersion: preview.consentDocumentVersion,
      sampleLimit: preview.sampleLimit,
      sampleTruncated: preview.sampleTruncated,
      recipients: preview.recipients.map(recipient => ({
        leadId: recipient.leadId,
        chatId: `***${recipient.chatId.slice(-4)}`,
        consentRecordId: recipient.consentRecordId,
        consentAt: recipient.consentAt,
        inclusionReason: recipient.inclusionReason,
      })),
    });
  }),
);

adminRouter.post(
  '/api/admin/telegram/broadcast',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        text: z.string().trim().min(3).max(TELEGRAM_BROADCAST_MAX_TEXT_LENGTH),
        idempotencyKey: z.string().uuid(),
        confirmRecipientCount: z.number().int().nonnegative(),
      })
      .parse(req.body);
    if (env.TELEGRAM_MANUAL_BROADCAST !== 'on') {
      throw new AppError(503, 'Ручная Telegram-рассылка временно отключена');
    }

    const actor = (req as AdminRequest).admin;
    const actorId = actor?.id;
    if (!actorId) throw new AppError(401, 'Admin authorization required');
    const queueResult = await prisma.$transaction(
      async tx => {
        // The active-job check and job creation are one serialized critical section. A second
        // request blocks here, then observes either the same idempotency key or the active job.
        await acquireTransactionLock(tx, TELEGRAM_BROADCAST_CREATE_LOCK_KEY);
        const duplicate = await tx.telegramBroadcastJob.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
        });
        if (duplicate) {
          return { duplicate: true as const, duplicateJob: duplicate };
        }

        const activeJob = await tx.telegramBroadcastJob.findFirst({
          where: {
            status: { in: ['pending', 'sending', 'failed'] },
            completedAt: null,
          },
          orderBy: { createdAt: 'asc' },
        });
        if (activeJob) {
          throw new AppError(409, 'Telegram-рассылка уже выполняется');
        }

        const preview = await previewTelegramBroadcastRecipientsForSnapshot(tx);
        if (preview.total !== data.confirmRecipientCount) {
          throw new AppError(409, 'Список получателей изменился. Выполните preview повторно.');
        }
        const job = await createTelegramBroadcastJob(
          {
            text: data.text,
            initiatedById: actorId,
            idempotencyKey: data.idempotencyKey,
          },
          { preview, tx },
        );
        return { duplicate: false as const, job, preview };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 60_000,
      },
    );

    if (queueResult.duplicate) {
      const duplicate = queueResult.duplicateJob;
      res.status(200).json({
        ok: true,
        queued: duplicate.status !== 'completed',
        duplicate: true,
        jobId: duplicate.id,
        total: duplicate.total,
      });
      return;
    }
    const { job, preview } = queueResult;

    await prisma.event.create({
      data: {
        eventName: 'telegram_broadcast',
        source: 'admin',
        metadataJson: {
          status: 'queued',
          jobId: job.jobId,
          total: job.total,
          textLength: data.text.length,
          consentDocumentVersion: preview.consentDocumentVersion,
          initiatedById: actor.id,
        },
      },
    });

    await audit(req as AdminRequest, {
      action: 'telegram.broadcast.queue',
      entityType: 'telegram_broadcast',
      entityId: job.jobId,
      after: {
        total: job.total,
        textLength: data.text.length,
        consentDocumentVersion: preview.consentDocumentVersion,
        idempotencyKey: data.idempotencyKey,
      },
    });

    res.status(job.queued ? 202 : 200).json({
      ok: true,
      queued: job.queued,
      jobId: job.jobId,
      total: job.total,
      delayMs: job.delayMs,
    });
  }),
);

adminRouter.get(
  '/api/admin/telegram/broadcast/current',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager', 'viewer']),
  asyncHandler(async (req, res) => {
    const maskPii = shouldMaskRegistrationPii(req as AdminRequest);
    const job = await prisma.telegramBroadcastJob.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      ok: true,
      job: job
        ? {
            id: job.id,
            status: job.status,
            total: job.total,
            sent: job.sent,
            failed: job.failed,
            attempts: job.attempts,
            nextIndex: job.nextIndex,
            lastError: maskPii ? null : job.lastError,
            nextAttemptAt: job.nextAttemptAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            createdAt: job.createdAt,
          }
        : null,
    });
  }),
);

adminRouter.get(
  '/api/admin/questions',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const adminReq = req as AdminRequest;
    const maskPii = shouldMaskRegistrationPii(adminReq);
    const questions = await prisma.question.findMany({
      where: getQuestionAccessWhere(adminReq),
      include: {
        lead: true,
        registration: true,
        webinarSession: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({
      ok: true,
      questions: questions.map(question => serializeQuestionForAdmin(question, maskPii)),
    });
  }),
);

adminRouter.patch(
  '/api/admin/questions/:id',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const data = z.object({ isAnswered: z.boolean(), adminNote: z.string().optional() }).parse(req.body);
    const question = await prisma.$transaction(async tx => {
      const questionRef = await tx.question.findFirst({
        where: getQuestionAccessWhere(adminReq, { id }),
        select: { registration: { select: { leadId: true } } },
      });
      if (!questionRef) {
        throw new AppError(404, 'Question not found');
      }
      await acquireLeadSecurityLock(tx, questionRef.registration.leadId);
      const activeQuestion = await tx.question.findFirst({
        where: getQuestionAccessWhere(adminReq, { id }),
        include: { registration: { include: { lead: true } } },
      });
      if (!activeQuestion || !isParticipantRegistrationActive(activeQuestion.registration)) {
        throw new AppError(409, 'Регистрация участника больше не активна');
      }
      const question = await tx.question.update({
        where: { id },
        data: {
          isAnswered: data.isAnswered,
          adminNote: data.adminNote,
        },
      });
      await audit(
        adminReq,
        {
          action: 'question.update',
          entityType: 'question',
          entityId: id,
          before: { isAnswered: activeQuestion.isAnswered, adminNote: activeQuestion.adminNote },
          after: { isAnswered: question.isAnswered, adminNote: question.adminNote },
        },
        tx,
      );
      return question;
    });

    res.json({ ok: true, question });
  }),
);

// Ответ модератора в чат эфира: создаёт видимое сообщение kind='moderator' и помечает
// вопрос обработанным. questionId оставляем null (это поле занято исходным сообщением
// участника, оно @unique), связь с вопросом — через metadataJson.replyToQuestionId,
// по тому же образцу, что и авто-ответ ИИ-менеджера.
adminRouter.post(
  '/api/admin/questions/:id/reply',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const { text } = z.object({ text: z.string().trim().min(2).max(700) }).parse(req.body);

    const question = await prisma.question.findFirst({
      where: getQuestionAccessWhere(adminReq, { id }),
      select: {
        id: true,
        webinarSessionId: true,
        registrationId: true,
        isAnswered: true,
        registration: { select: { leadId: true } },
      },
    });
    if (!question) {
      throw new AppError(404, 'Question not found');
    }

    const result = await prisma.$transaction(async tx => {
      await acquireLeadSecurityLock(tx, question.registration.leadId);
      const activeQuestion = await tx.question.findFirst({
        where: getQuestionAccessWhere(adminReq, { id: question.id }),
        include: { registration: { include: { lead: true } } },
      });
      if (!activeQuestion || !isParticipantRegistrationActive(activeQuestion.registration)) {
        throw new AppError(409, 'Регистрация участника больше не активна');
      }
      const chatMessage = await tx.webinarChatMessage.create({
        data: {
          webinarSessionId: activeQuestion.webinarSessionId,
          registrationId: activeQuestion.registrationId,
          kind: MODERATOR_CHAT_KIND,
          authorName: MODERATOR_NAME,
          authorRole: MODERATOR_ROLE,
          message: text,
          isSynthetic: false,
          visibleAt: new Date(),
          metadataJson: { replyToQuestionId: activeQuestion.id, viaAdmin: true },
        },
      });
      const updated = await tx.question.update({
        where: { id: activeQuestion.id },
        data: { isAnswered: true },
      });
      await audit(
        adminReq,
        {
          action: 'question.reply',
          entityType: 'question',
          entityId: activeQuestion.id,
          before: { isAnswered: activeQuestion.isAnswered },
          after: { isAnswered: true, chatMessageId: chatMessage.id, length: text.length },
        },
        tx,
      );
      return { chatMessage, updated };
    });

    res.status(201).json({ ok: true, chatMessageId: result.chatMessage.id, question: result.updated });
  }),
);

// Переслать вопрос ответственному менеджеру: уходит в Telegram админ-бота (тот же чат,
// что и авто-уведомления о новых вопросах), вопрос помечается forwardedAt. В эфир НЕ публикуется.
adminRouter.post(
  '/api/admin/questions/:id/forward',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;

    const question = await prisma.question.findFirst({
      where: getQuestionAccessWhere(adminReq, { id }),
      include: { lead: true },
    });
    if (!question) {
      throw new AppError(404, 'Question not found');
    }

    const moderatorName = adminReq.admin?.login ?? adminReq.admin?.email ?? 'модератор';
    const result = await sendTelegramMessage({
      text: [
        '🔁 Вопрос переслан менеджеру (из модераторского чата)',
        `Кто переслал: ${moderatorName}`,
        '',
        'Данные участника:',
        `Участник: ${question.lead.name}`,
        `Телефон: ${question.lead.phone}`,
        `Email: ${question.lead.email}`,
        '',
        `Вопрос: ${question.text.trim()}`,
        '',
        `Админка: ${buildFrontendUrl('/admin')}`,
      ].join('\n'),
    });

    const updated = await prisma.question.update({
      where: { id: question.id },
      data: { forwardedAt: new Date() },
    });

    await audit(adminReq, {
      action: 'question.forward',
      entityType: 'question',
      entityId: id,
      before: { forwardedAt: question.forwardedAt },
      after: { forwardedAt: updated.forwardedAt, telegramSent: result.sent },
    });

    res.json({ ok: true, forwardedAt: updated.forwardedAt, telegramSent: result.sent });
  }),
);

// Бан/разбан участника в чате эфира. chatBannedAt != null блокирует отправку новых вопросов
// (POST /questions → 403) и скрывает его сообщения из публичной ленты. Обратимо: разбан снимает метку.
adminRouter.post(
  '/api/admin/registrations/:id/chat-ban',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const adminReq = req as AdminRequest;
    const { banned } = z.object({ banned: z.boolean() }).parse(req.body);

    const registration = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      select: { id: true, chatBannedAt: true },
    });
    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    const updated = await prisma.registration.update({
      where: { id: registration.id },
      data: { chatBannedAt: banned ? new Date() : null },
    });

    await audit(adminReq, {
      action: banned ? 'registration.chat_ban' : 'registration.chat_unban',
      entityType: 'registration',
      entityId: id,
      before: { chatBannedAt: registration.chatBannedAt },
      after: { chatBannedAt: updated.chatBannedAt },
    });

    res.json({ ok: true, chatBannedAt: updated.chatBannedAt });
  }),
);

// Зеркало публичного чата эфира для правой панели админки: показывает ленту ровно так,
// как её видит участник (приветствие модератора + сценарный чат + реальные сообщения),
// с тем же гейтом по статусу эфира. Сообщения забаненных участников отфильтрованы.
adminRouter.get(
  '/api/admin/webinar/chat/live',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const scheduledAt = getDailyBroadcastDate(now);
    const session = await findOrCreateWebinarSession(scheduledAt, now);
    const liveState = getWebinarLiveState(now, session);
    const canExpose = liveState.status === 'live' || liveState.status === 'finished';

    const persistedMessages = canExpose
      ? await prisma.webinarChatMessage.findMany({
          where: {
            webinarSessionId: session.id,
            visibleAt: { lte: now },
            OR: [{ registrationId: null }, { registration: { is: { chatBannedAt: null } } }],
          },
          orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
        })
      : [];

    const scriptedMessages =
      canExpose && liveState.chatStatus === 'live'
        ? getScriptedChatMessagesUntil(liveState.liveOffsetSeconds, {
            durationSeconds: session.videoDurationSeconds,
            validateDuration: false,
          }).map(message => ({
            id: message.id,
            visibleAt: new Date(session.scheduledAt.getTime() + message.offsetSeconds * 1000),
            kind: message.kind,
            authorName: message.authorName,
            authorRole: message.authorRole,
            message: message.message,
          }))
        : [];

    const realMessages = persistedMessages.map(message => ({
      id: message.id,
      visibleAt: message.visibleAt,
      kind: message.kind,
      authorName: message.authorName,
      authorRole: message.authorRole,
      message: message.message,
    }));

    const moderatorIntro = canExpose ? [buildModeratorIntroMessage(session)] : [];

    const messages = [...moderatorIntro, ...scriptedMessages, ...realMessages]
      .sort((left, right) => left.visibleAt.getTime() - right.visibleAt.getTime())
      .map(message => ({
        id: message.id,
        kind: message.kind,
        authorName: message.authorName,
        authorRole: message.authorRole,
        message: message.message,
        visibleAt: message.visibleAt.toISOString(),
      }));

    res.setHeader('Cache-Control', 'private, max-age=4');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      chatStatus: liveState.chatStatus,
      webinarStatus: liveState.status,
      messages,
    });
  }),
);

adminRouter.get(
  '/api/admin/analytics/summary',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [
      visitorStats,
      registrations,
      roomEntries,
      telegramClicks,
      telegramSubscribers,
      hotLeads,
      questions,
      partnerApplications,
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ pageViews: number | bigint; uniqueVisitors: number | bigint }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "pageViews",
          COUNT(DISTINCT CASE
            WHEN e."visitor_id" IS NOT NULL THEN e."visitor_id"
            WHEN e."ip_hash" IS NOT NULL THEN
              'legacy:' || e."ip_hash" || ':' || md5(COALESCE(e."user_agent", ''))
            ELSE NULL
          END)::int AS "uniqueVisitors"
        FROM "events" e
        WHERE e."event_name" = 'page_view'
      `),
      prisma.registration.count({ where: VERIFIED_REGISTRATION_WHERE }),
      prisma.registration.count({
        where: { AND: [VERIFIED_REGISTRATION_WHERE, { roomEnteredAt: { not: null } }] },
      }),
      prisma.registration.count({
        where: { AND: [VERIFIED_REGISTRATION_WHERE, { telegramClickedAt: { not: null } }] },
      }),
      prisma.lead.count({
        where: {
          telegramChatId: { not: null },
          telegramBindingVersion: TELEGRAM_BINDING_VERSION,
          registrations: { some: VERIFIED_REGISTRATION_WHERE },
        },
      }),
      prisma.registration.count({
        where: {
          AND: [
            VERIFIED_REGISTRATION_WHERE,
            {
              OR: [
                { isHot: true },
                { partnerApplications: { some: {} } },
                { questions: { some: {} } },
                { roomEnteredAt: { not: null } },
              ],
            },
          ],
        },
      }),
      prisma.question.count({ where: { registration: VERIFIED_REGISTRATION_WHERE } }),
      prisma.partnerApplication.count({ where: { registration: { is: VERIFIED_REGISTRATION_WHERE } } }),
    ]);

    const pageViews = toCount(visitorStats[0]?.pageViews ?? 0);
    const uniqueVisitors = toCount(visitorStats[0]?.uniqueVisitors ?? 0);

    res.json({
      ok: true,
      summary: {
        pageViews,
        uniqueVisitors,
        registrations,
        roomEntries,
        telegramClicks,
        telegramSubscribers,
        hotLeads,
        questions,
        partnerApplications,
        registrationRate: uniqueVisitors ? Number((registrations / uniqueVisitors).toFixed(3)) : 0,
      },
    });
  }),
);

adminRouter.get(
  '/api/admin/analytics/funnel',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        groupBy: z.enum(['source', 'utmSource', 'utmMedium', 'utmCampaign']).default('source'),
        attribution: z.enum(['firstTouch', 'lastTouch']).default('firstTouch'),
      })
      .parse(req.query);
    const now = new Date();
    const from = query.from
      ? new Date(`${query.from}T00:00:00.000Z`)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new AppError(400, 'Invalid analytics date range');
    }
    const groupField = query.groupBy;
    const emptyGroup = () => ({
      visitors: 0,
      legacyVisitors: 0,
      registrations: 0,
      telegramClicks: 0,
      telegramSubscribers: 0,
      roomEntries: 0,
      questions: 0,
      applications: 0,
      contracts: 0,
    });
    const groups = new Map<string, ReturnType<typeof emptyGroup>>();
    const keyOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : 'direct/unknown');
    const groupFor = (value: unknown) => {
      const key = keyOf(value);
      if (!groups.has(key)) groups.set(key, emptyGroup());
      return groups.get(key)!;
    };

    const groupColumn = eventAnalyticsColumns[groupField];
    const cohortRows = await prisma.$queryRaw<FunnelCohortRow[]>(Prisma.sql`
      WITH page_events AS (
        SELECT
          COALESCE(
            e."visitor_id",
            'legacy:' || COALESCE(e."ip_hash", 'unknown') || ':' || md5(COALESCE(e."user_agent", ''))
          ) AS visitor_key,
          e."visitor_id" IS NULL AS is_legacy,
          COALESCE(NULLIF(BTRIM(${groupColumn}), ''), 'direct/unknown') AS key,
          e."created_at"
        FROM "events" e
        WHERE e."event_name" = 'page_view'
          AND e."created_at" >= ${from}
          AND e."created_at" <= ${to}
          AND (e."visitor_id" IS NOT NULL OR e."ip_hash" IS NOT NULL)
      ),
      cohort AS (
        SELECT DISTINCT ON (visitor_key)
          visitor_key,
          is_legacy,
          key AS first_key,
          "created_at" AS cohort_started_at
        FROM page_events
        ORDER BY visitor_key, "created_at" ASC
      ),
      registration_links AS (
        SELECT DISTINCT ON (c.visitor_key)
          c.visitor_key,
          e."registration_id",
          e."created_at" AS linked_at
        FROM cohort c
        JOIN "events" e
          ON COALESCE(
            e."visitor_id",
            'legacy:' || COALESCE(e."ip_hash", 'unknown') || ':' || md5(COALESCE(e."user_agent", ''))
          ) = c.visitor_key
         AND e."registration_id" IS NOT NULL
         AND e."created_at" >= c.cohort_started_at
        JOIN "registrations" linked_registration
          ON linked_registration."id" = e."registration_id"
         AND linked_registration."registered_at" >= c.cohort_started_at
         AND linked_registration."status" = 'registered'
         AND linked_registration."email_verified_at" IS NOT NULL
        ORDER BY c.visitor_key, e."created_at" ASC
      ),
      attributed_cohort AS (
        SELECT
          c.visitor_key,
          c.is_legacy,
          CASE
            WHEN ${query.attribution} = 'lastTouch' THEN COALESCE(
              (
                SELECT pe.key
                FROM page_events pe
                WHERE pe.visitor_key = c.visitor_key
                  AND pe."created_at" <= COALESCE(rl.linked_at, ${to})
                ORDER BY pe."created_at" DESC
                LIMIT 1
              ),
              c.first_key
            )
            ELSE c.first_key
          END AS key,
          rl."registration_id",
          rl.linked_at
        FROM cohort c
        LEFT JOIN registration_links rl ON rl.visitor_key = c.visitor_key
      )
      SELECT
        ac.key,
        COUNT(DISTINCT ac.visitor_key)::int AS visitors,
        COUNT(DISTINCT ac.visitor_key) FILTER (WHERE ac.is_legacy)::int AS "legacyVisitors",
        COUNT(DISTINCT ac.visitor_key) FILTER (WHERE ac."registration_id" IS NOT NULL)::int AS registrations,
        COUNT(DISTINCT ac.visitor_key) FILTER (
          WHERE r."telegram_clicked_at" >= ac.linked_at
        )::int AS "telegramClicks",
        COUNT(DISTINCT ac.visitor_key) FILTER (
          WHERE l."telegram_subscribed_at" >= ac.linked_at
        )::int AS "telegramSubscribers",
        COUNT(DISTINCT ac.visitor_key) FILTER (
          WHERE r."room_entered_at" >= ac.linked_at
        )::int AS "roomEntries",
        COUNT(DISTINCT ac.visitor_key) FILTER (WHERE q."id" IS NOT NULL)::int AS questions,
        COUNT(DISTINCT ac.visitor_key) FILTER (WHERE p."id" IS NOT NULL)::int AS applications,
        COUNT(DISTINCT ac.visitor_key) FILTER (
          WHERE p."contract_signed_at" IS NOT NULL OR p."status" IN ('contract_signed', 'paid')
        )::int AS contracts
      FROM attributed_cohort ac
      LEFT JOIN "registrations" r ON r."id" = ac."registration_id"
      LEFT JOIN "leads" l ON l."id" = r."lead_id"
      LEFT JOIN "questions" q
        ON q."lead_id" = r."lead_id"
       AND q."created_at" >= ac.linked_at
      LEFT JOIN "partner_applications" p
        ON p."lead_id" = r."lead_id"
       AND p."created_at" >= ac.linked_at
      GROUP BY ac.key
      ORDER BY applications DESC, registrations DESC, visitors DESC
    `);

    cohortRows.forEach(item => {
      const group = groupFor(item.key);
      group.visitors += toCount(item.visitors);
      group.legacyVisitors += toCount(item.legacyVisitors);
      group.registrations += toCount(item.registrations);
      group.telegramClicks += toCount(item.telegramClicks);
      group.telegramSubscribers += toCount(item.telegramSubscribers);
      group.roomEntries += toCount(item.roomEntries);
      group.questions += toCount(item.questions);
      group.applications += toCount(item.applications);
      group.contracts += toCount(item.contracts);
    });

    const summary = emptyGroup();
    for (const group of groups.values()) {
      summary.visitors += group.visitors;
      summary.legacyVisitors += group.legacyVisitors;
      summary.registrations += group.registrations;
      summary.telegramClicks += group.telegramClicks;
      summary.telegramSubscribers += group.telegramSubscribers;
      summary.roomEntries += group.roomEntries;
      summary.questions += group.questions;
      summary.applications += group.applications;
      summary.contracts += group.contracts;
    }
    const rate = (part: number, total: number) => (total > 0 ? Number((part / total).toFixed(3)) : 0);
    const rows = [...groups.entries()]
      .map(([key, value]) => ({
        key,
        ...value,
        registrationRate: rate(value.registrations, value.visitors),
        telegramSubscribeRate: rate(value.telegramSubscribers, value.registrations),
        roomEntryRate: rate(value.roomEntries, value.registrations),
        applicationRate: rate(value.applications, value.registrations),
        contractRate: rate(value.contracts, value.applications),
      }))
      .sort((a, b) => b.applications - a.applications || b.registrations - a.registrations || b.visitors - a.visitors);

    res.json({
      ok: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      groupBy: groupField,
      attribution: query.attribution,
      cohortDefinition:
        'unique visitors whose first page view is in the period; first registration and downstream lifetime stages are linked by visitor and lead',
      summary,
      rates: {
        registrationRate: rate(summary.registrations, summary.visitors),
        telegramClickRate: rate(summary.telegramClicks, summary.registrations),
        telegramSubscribeRate: rate(summary.telegramSubscribers, summary.registrations),
        roomEntryRate: rate(summary.roomEntries, summary.registrations),
        questionRate: rate(summary.questions, summary.registrations),
        applicationRate: rate(summary.applications, summary.registrations),
        contractRate: rate(summary.contracts, summary.applications),
      },
      groups: rows,
      dataQuality: {
        legacyVisitors: summary.legacyVisitors,
        visitorIdCoverage:
          summary.visitors > 0
            ? Number(((summary.visitors - summary.legacyVisitors) / summary.visitors).toFixed(3))
            : 1,
        warnings:
          summary.legacyVisitors > 0
            ? ['Часть истории рассчитана по legacy fallback (хэш IP + браузер); новые визиты используют visitor ID.']
            : [],
      },
    });
  }),
);

adminRouter.get(
  '/api/admin/analytics/events',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const maskPii = shouldMaskRegistrationPii(req as AdminRequest);
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        eventName: z.string().trim().max(120).optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const now = new Date();
    const from = query.from
      ? new Date(`${query.from}T00:00:00.000Z`)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
    const where = {
      createdAt: { gte: from, lte: to },
      eventName: query.eventName || undefined,
    };
    const [total, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          eventName: true,
          page: true,
          source: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          leadId: true,
          registrationId: true,
          webinarSessionId: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      ok: true,
      page: query.page,
      pageSize: query.pageSize,
      total,
      events: maskPii
        ? events.map(event => ({
            ...event,
            source: null,
            utmSource: null,
            utmMedium: null,
            utmCampaign: null,
            leadId: null,
            registrationId: null,
          }))
        : events,
    });
  }),
);

adminRouter.get(
  '/api/admin/analytics/events/daily',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        eventName: z.string().trim().max(120).optional(),
      })
      .parse(req.query);
    const now = new Date();
    const from = query.from
      ? new Date(`${query.from}T00:00:00.000Z`)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;

    const rows = await prisma.$queryRaw<Array<{ day: Date; eventName: string; count: number | bigint }>>(Prisma.sql`
      SELECT date_trunc('day', "created_at") AS day, "event_name" AS "eventName", COUNT(*)::int AS count
      FROM "events"
      WHERE "created_at" >= ${from}
        AND "created_at" <= ${to}
        AND (${query.eventName ?? null}::text IS NULL OR "event_name" = ${query.eventName ?? null})
      GROUP BY day, "event_name"
      ORDER BY day ASC, "event_name" ASC
    `);

    res.json({
      ok: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      rows: rows.map(row => ({
        day: row.day.toISOString(),
        eventName: row.eventName,
        count: toCount(row.count),
      })),
    });
  }),
);
