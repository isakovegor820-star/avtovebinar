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
import { formatMoscowDate, sendTelegramMessageToChat } from '../lib/telegram.js';
import {
  createTelegramBroadcastJob,
  getActiveTelegramBroadcastJob,
  TELEGRAM_BROADCAST_MAX_TEXT_LENGTH,
} from '../lib/telegramBroadcastWorker.js';
import { setContextIdentity } from '../lib/requestContext.js';
import { getAdminHtml } from '../responses/adminPage.js';
import { createRoomExchangeUrl, getRoomTokenExpiresAt } from '../lib/roomLinks.js';
import { MODERATOR_NAME, MODERATOR_ROLE, MODERATOR_CHAT_KIND } from '../lib/moderator.js';

export const adminRouter = Router();

const ADMIN_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];
type AnalyticsGroupBy = 'source' | 'utmSource' | 'utmMedium' | 'utmCampaign';
const strongAdminPasswordSchema = z
  .string()
  .max(200)
  .refine(isStrongPassword, 'Пароль должен быть не короче 12 символов и содержать буквы и цифры');

function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole);
}

const leadAnalyticsColumns: Record<AnalyticsGroupBy, Prisma.Sql> = {
  source: Prisma.raw('l."source"'),
  utmSource: Prisma.raw('l."utm_source"'),
  utmMedium: Prisma.raw('l."utm_medium"'),
  utmCampaign: Prisma.raw('l."utm_campaign"'),
};

type AnalyticsCountRow = {
  key: string | null;
  count: number | bigint;
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
    if (!adminUser || !adminUser.isActive) {
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
) {
  await prisma.auditLog.create({
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

function getRegistrationAccessWhere(req: AdminRequest, where: Prisma.RegistrationWhereInput = {}) {
  if (canSeeAllRegistrations(req) || getAdminRole(req) === 'viewer') {
    return where;
  }

  const managerId = req.admin?.id;
  if (!managerId) {
    throw new AppError(403, 'Недостаточно прав');
  }

  return {
    AND: [
      where,
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

function serializeLeadForAdmin(lead: any, maskPii: boolean, includeExtendedFields: boolean) {
  const base = {
    id: lead.id,
    name: maskPii ? maskName(lead.name) : lead.name,
    phone: maskPii ? maskPhone(lead.phone) : lead.phone,
    email: maskPii ? maskEmail(lead.email) : lead.email,
    city: lead.city,
    professionalStatus: lead.professionalStatus,
    telegramChatId: maskPii ? maskNullable(lead.telegramChatId) : lead.telegramChatId,
    telegramUsername: maskPii ? maskNullable(lead.telegramUsername) : lead.telegramUsername,
    telegramFirstName: maskPii ? maskName(lead.telegramFirstName) : lead.telegramFirstName,
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
    ...registration,
    lead: serializeLeadForAdmin(registration.lead, true, true),
    questions: registration.questions?.map((question: any) => ({
      ...question,
      text: '[hidden]',
      adminNote: question.adminNote ? '[hidden]' : question.adminNote,
    })),
    partnerApplications: registration.partnerApplications?.map((application: any) => ({
      ...application,
      comment: application.comment ? '[hidden]' : application.comment,
    })),
    events: registration.events?.map((event: any) => ({
      ...event,
      userAgent: null,
      ipHash: null,
      metadataJson: event.metadataJson ? null : event.metadataJson,
    })),
  };
}

function serializePartnerApplicationForAdmin(application: any, maskPii: boolean) {
  return {
    id: application.id,
    registrationId: application.registrationId,
    sphere: application.sphere,
    city: application.city,
    clientFlow: application.clientFlow,
    experience: application.experience,
    comment: maskPii && application.comment ? '[hidden]' : application.comment,
    preferredFormat: application.preferredFormat,
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
    const data = z.object({ login: z.string().trim(), password: z.string() }).parse(req.body);
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
      throw new AppError(401, 'Неверный логин или пароль');
    }

    const sessionAdmin = { id: adminUser.id, email: adminUser.email, role: adminUser.role };

    await prisma.adminUser.update({
      where: { id: adminUser.id },
      data: { lastLoginAt: new Date() },
    });

    res.cookie('aspb_admin_session', createAdminSession(sessionAdmin), {
      httpOnly: true,
      sameSite: env.NODE_ENV === 'production' ? 'strict' : 'lax',
      secure: env.NODE_ENV === 'production',
      partitioned: env.NODE_ENV === 'production' ? true : undefined,
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  }),
);

adminRouter.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('aspb_admin_session');
  res.json({ ok: true });
});

adminRouter.get(
  '/api/admin/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, admin: (req as AdminRequest).admin });
  }),
);

adminRouter.get(
  '/api/admin/managers',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const managers = await prisma.adminUser.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    res.json({ ok: true, managers });
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
      })
      .parse(req.body);
    const before = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    if (!before) {
      throw new AppError(404, 'Admin user not found');
    }

    if (data.role && !isAdminRole(data.role)) {
      throw new AppError(400, 'Invalid admin role');
    }

    const actorRole = (req as AdminRequest).admin?.role;
    if (actorRole !== 'owner') {
      if (before.role === 'owner') {
        throw new AppError(403, 'Недостаточно прав для изменения владельца');
      }
      if (data.role === 'owner') {
        throw new AppError(403, 'Недостаточно прав для назначения роли владельца');
      }
    }

    const user = await prisma.adminUser.update({
      where: { id },
      data: {
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        passwordHash: data.password ? await hashPassword(data.password) : undefined,
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
      action: 'admin_user.update',
      entityType: 'admin_user',
      entityId: user.id,
      before,
      after: user,
    });

    res.json({ ok: true, user });
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
      leadFilters.push({ telegramChatId: { not: null } });
    }
    if (query.telegram === 'no') {
      leadFilters.push({ telegramChatId: null });
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

    const where: Prisma.RegistrationWhereInput = {
      ...queueWhere,
      crmStatus: query.status || undefined,
      assignedManagerId: query.managerId || undefined,
      roomEnteredAt: query.room === 'yes' ? { not: null } : query.room === 'no' ? null : undefined,
      questions: query.hasQuestion === 'yes' ? { some: {} } : undefined,
      partnerApplications: query.hasApplication === 'yes' ? { some: {} } : undefined,
      webinarSession: dateFilter ? { scheduledAt: dateFilter } : undefined,
      lead: leadWhere,
    };

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
        managerNote: item.managerNote,
        isHot: item.isHot,
        assignedManagerId: item.assignedManagerId,
        assignedManager: item.assignedManager,
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
        assignedManager: item.assignedManager,
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

    if (!registration.lead.telegramChatId) {
      throw new AppError(400, 'У участника не подключен Telegram');
    }

    const roomUrl = await prisma.$transaction(tx =>
      createRoomExchangeUrl(tx, {
        registrationId: registration.id,
        expiresAt: getRoomTokenExpiresAt(registration.webinarSession),
      }),
    );
    const defaultText = [
      `${registration.lead.name}, напоминаем про вебинар АСПБ.`,
      '',
      `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      '',
      `Ваша персональная комната: ${roomUrl}`,
    ].join('\n');
    const text = data.text ? [data.text, '', `Ваша персональная комната: ${roomUrl}`].join('\n') : defaultText;

    await sendTelegramMessageToChat(registration.lead.telegramChatId, text);

    await prisma.event.create({
      data: {
        eventName: 'admin_manual_telegram_reminder',
        leadId: registration.leadId,
        registrationId: registration.id,
        webinarSessionId: registration.webinarSessionId,
        source: 'admin',
        page: 'admin',
      },
    });

    await audit(adminReq, {
      action: 'registration.telegram_reminder.send',
      entityType: 'registration',
      entityId: registration.id,
      after: { chatId: registration.lead.telegramChatId, textLength: text.length },
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
    const before = await prisma.registration.findFirst({
      where: getRegistrationAccessWhere(adminReq, { id }),
      select: { managerNote: true },
    });
    if (!before) {
      throw new AppError(404, 'Registration not found');
    }

    const registration = await prisma.registration.update({
      where: { id },
      data: { managerNote: data.managerNote || null },
    });

    await audit(adminReq, {
      action: 'registration.note.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { managerNote: registration.managerNote },
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
  '/api/admin/telegram/broadcast',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const data = z.object({ text: z.string().trim().min(3).max(TELEGRAM_BROADCAST_MAX_TEXT_LENGTH) }).parse(req.body);

    const activeJob = await getActiveTelegramBroadcastJob();
    if (activeJob) {
      throw new AppError(409, 'Telegram-рассылка уже выполняется');
    }

    const job = await createTelegramBroadcastJob(data.text);

    await prisma.event.create({
      data: {
        eventName: 'telegram_broadcast',
        source: 'admin',
        metadataJson: {
          status: 'queued',
          jobId: job.jobId,
          total: job.total,
          textLength: data.text.length,
        },
      },
    });

    await audit(req as AdminRequest, {
      action: 'telegram.broadcast.queue',
      entityType: 'telegram_broadcast',
      entityId: job.jobId,
      after: { total: job.total, textLength: data.text.length },
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
  asyncHandler(async (_req, res) => {
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
            lastError: job.lastError,
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
    const before = await prisma.question.findFirst({
      where: getQuestionAccessWhere(adminReq, { id }),
      select: { isAnswered: true, adminNote: true },
    });
    if (!before) {
      throw new AppError(404, 'Question not found');
    }

    const question = await prisma.question.update({
      where: { id },
      data: {
        isAnswered: data.isAnswered,
        adminNote: data.adminNote,
      },
    });

    await audit(adminReq, {
      action: 'question.update',
      entityType: 'question',
      entityId: id,
      before,
      after: { isAnswered: question.isAnswered, adminNote: question.adminNote },
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
      select: { id: true, webinarSessionId: true, registrationId: true, isAnswered: true },
    });
    if (!question) {
      throw new AppError(404, 'Question not found');
    }

    const result = await prisma.$transaction(async tx => {
      const chatMessage = await tx.webinarChatMessage.create({
        data: {
          webinarSessionId: question.webinarSessionId,
          registrationId: question.registrationId,
          kind: MODERATOR_CHAT_KIND,
          authorName: MODERATOR_NAME,
          authorRole: MODERATOR_ROLE,
          message: text,
          isSynthetic: false,
          visibleAt: new Date(),
          metadataJson: { replyToQuestionId: question.id, viaAdmin: true },
        },
      });
      const updated = await tx.question.update({
        where: { id: question.id },
        data: { isAnswered: true },
      });
      return { chatMessage, updated };
    });

    await audit(adminReq, {
      action: 'question.reply',
      entityType: 'question',
      entityId: id,
      before: { isAnswered: question.isAnswered },
      after: { isAnswered: true, chatMessageId: result.chatMessage.id, length: text.length },
    });

    res.status(201).json({ ok: true, chatMessageId: result.chatMessage.id, question: result.updated });
  }),
);

adminRouter.get(
  '/api/admin/analytics/summary',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [
      pageViews,
      registrations,
      roomEntries,
      telegramClicks,
      telegramSubscribers,
      hotLeads,
      questions,
      partnerApplications,
    ] = await Promise.all([
      prisma.event.count({ where: { eventName: 'page_view' } }),
      prisma.registration.count(),
      prisma.registration.count({ where: { roomEnteredAt: { not: null } } }),
      prisma.registration.count({ where: { telegramClickedAt: { not: null } } }),
      prisma.lead.count({ where: { telegramChatId: { not: null } } }),
      prisma.registration.count({
        where: {
          OR: [
            { isHot: true },
            { partnerApplications: { some: {} } },
            { questions: { some: {} } },
            { roomEnteredAt: { not: null } },
          ],
        },
      }),
      prisma.question.count(),
      prisma.partnerApplication.count(),
    ]);

    res.json({
      ok: true,
      summary: {
        pageViews,
        registrations,
        roomEntries,
        telegramClicks,
        telegramSubscribers,
        hotLeads,
        questions,
        partnerApplications,
        registrationRate: pageViews ? Number((registrations / pageViews).toFixed(3)) : 0,
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
      })
      .parse(req.query);
    const now = new Date();
    const from = query.from
      ? new Date(`${query.from}T00:00:00.000Z`)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
    const dateRange = { gte: from, lte: to };
    const groupField = query.groupBy;
    const emptyGroup = () => ({
      visitors: 0,
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

    const leadColumn = leadAnalyticsColumns[groupField];
    const [
      visitorEvents,
      telegramClickEvents,
      registrations,
      telegramSubscribers,
      roomEntries,
      questions,
      applications,
      contracts,
    ] = await Promise.all([
      prisma.event.groupBy({
        by: [groupField],
        where: { eventName: 'page_view', createdAt: dateRange },
        _count: { _all: true },
      } as any),
      prisma.event.groupBy({
        by: [groupField],
        where: { eventName: 'telegram_click', createdAt: dateRange },
        _count: { _all: true },
      } as any),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "registrations" r
        JOIN "leads" l ON l."id" = r."lead_id"
        WHERE r."registered_at" >= ${from} AND r."registered_at" <= ${to}
        GROUP BY ${leadColumn}
      `),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "leads" l
        WHERE l."telegram_subscribed_at" >= ${from} AND l."telegram_subscribed_at" <= ${to}
        GROUP BY ${leadColumn}
      `),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "registrations" r
        JOIN "leads" l ON l."id" = r."lead_id"
        WHERE r."room_entered_at" >= ${from} AND r."room_entered_at" <= ${to}
        GROUP BY ${leadColumn}
      `),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "questions" q
        JOIN "leads" l ON l."id" = q."lead_id"
        WHERE q."created_at" >= ${from} AND q."created_at" <= ${to}
        GROUP BY ${leadColumn}
      `),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "partner_applications" p
        JOIN "leads" l ON l."id" = p."lead_id"
        WHERE p."created_at" >= ${from} AND p."created_at" <= ${to}
        GROUP BY ${leadColumn}
      `),
      prisma.$queryRaw<AnalyticsCountRow[]>(Prisma.sql`
        SELECT ${leadColumn} AS key, COUNT(*)::int AS count
        FROM "partner_applications" p
        JOIN "leads" l ON l."id" = p."lead_id"
        WHERE (
          (p."contract_signed_at" >= ${from} AND p."contract_signed_at" <= ${to})
          OR (p."status" IN ('contract_signed', 'paid') AND p."updated_at" >= ${from} AND p."updated_at" <= ${to})
        )
        GROUP BY ${leadColumn}
      `),
    ]);

    (visitorEvents as Array<Record<string, unknown> & { _count: { _all: number } }>).forEach(item => {
      groupFor(item[groupField]).visitors += item._count._all;
    });
    (telegramClickEvents as Array<Record<string, unknown> & { _count: { _all: number } }>).forEach(item => {
      groupFor(item[groupField]).telegramClicks += item._count._all;
    });
    registrations.forEach(item => {
      groupFor(item.key).registrations += toCount(item.count);
    });
    telegramSubscribers.forEach(item => {
      groupFor(item.key).telegramSubscribers += toCount(item.count);
    });
    roomEntries.forEach(item => {
      groupFor(item.key).roomEntries += toCount(item.count);
    });
    questions.forEach(item => {
      groupFor(item.key).questions += toCount(item.count);
    });
    applications.forEach(item => {
      groupFor(item.key).applications += toCount(item.count);
    });
    contracts.forEach(item => {
      groupFor(item.key).contracts += toCount(item.count);
    });

    const summary = emptyGroup();
    for (const group of groups.values()) {
      summary.visitors += group.visitors;
      summary.registrations += group.registrations;
      summary.telegramClicks += group.telegramClicks;
      summary.telegramSubscribers += group.telegramSubscribers;
      summary.roomEntries += group.roomEntries;
      summary.questions += group.questions;
      summary.applications += group.applications;
      summary.contracts += group.contracts;
    }
    const rate = (part: number, total: number) => (total ? Number((part / total).toFixed(3)) : 0);
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
      summary,
      rates: {
        registrationRate: rate(summary.registrations, summary.visitors),
        telegramClickRate: rate(summary.telegramClicks, summary.registrations),
        telegramSubscribeRate: rate(summary.telegramSubscribers, summary.registrations),
        roomEntryRate: rate(summary.roomEntries, summary.registrations),
        questionRate: rate(summary.questions, summary.roomEntries),
        applicationRate: rate(summary.applications, summary.registrations),
        contractRate: rate(summary.contracts, summary.applications),
      },
      groups: rows,
    });
  }),
);

adminRouter.get(
  '/api/admin/analytics/events',
  requireAdmin,
  asyncHandler(async (req, res) => {
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
      events,
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
