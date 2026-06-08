import type { Request } from 'express';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, AppError, getClientIp } from '../lib/http.js';
import { createAdminSession, hashIp, parseAdminSession } from '../lib/tokens.js';
import { env } from '../lib/env.js';
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

export const adminRouter = Router();

const ADMIN_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];

function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole);
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
    if (env.NODE_ENV === 'development' && env.ADMIN_DEV_BYPASS === 'true') {
      req.admin = {
        id: 'dev',
        login: session.login ?? env.ADMIN_LOGIN,
        email: session.email ?? null,
        role: session.role ?? 'owner',
      };
      setContextIdentity({ adminId: req.admin.id });
      return next();
    }

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

  return next(new AppError(401, 'Admin authorization required'));
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
        password: z.string().min(8).max(200),
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
        password: z.string().min(8).max(200).optional().or(z.literal('')),
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

    const registrations = await prisma.registration.findMany({
      where,
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
        lead: {
          id: item.lead.id,
          name: item.lead.name,
          phone: item.lead.phone,
          email: item.lead.email,
          city: item.lead.city,
          professionalStatus: item.lead.professionalStatus,
          source: item.lead.source,
          utmSource: item.lead.utmSource,
          utmMedium: item.lead.utmMedium,
          utmCampaign: item.lead.utmCampaign,
          telegramChatId: item.lead.telegramChatId,
          telegramUsername: item.lead.telegramUsername,
          telegramFirstName: item.lead.telegramFirstName,
          telegramSubscribedAt: item.lead.telegramSubscribedAt,
        },
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
  asyncHandler(async (_req, res) => {
    const registrations = await prisma.registration.findMany({
      where: {
        OR: [
          { isHot: true },
          { partnerApplications: { some: {} } },
          { questions: { some: {} } },
          { roomEnteredAt: { not: null } },
        ],
      },
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
        lead: {
          name: item.lead.name,
          phone: item.lead.phone,
          email: item.lead.email,
          professionalStatus: item.lead.professionalStatus,
          telegramChatId: item.lead.telegramChatId,
          telegramUsername: item.lead.telegramUsername,
          telegramFirstName: item.lead.telegramFirstName,
          telegramSubscribedAt: item.lead.telegramSubscribedAt,
        },
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
    const registration = await prisma.registration.findUnique({
      where: { id },
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

    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'registration', entityId: id },
      include: { adminUser: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    res.json({ ok: true, registration, auditLogs });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/status',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ crmStatus: z.string() }).parse(req.body);

    if (!isCrmStatus(data.crmStatus)) {
      throw new AppError(400, 'Invalid CRM status');
    }

    const before = await prisma.registration.findUnique({ where: { id }, select: { crmStatus: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { crmStatus: data.crmStatus },
    });

    await audit(req as AdminRequest, {
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
    const data = z.object({ isHot: z.boolean() }).parse(req.body);
    const before = await prisma.registration.findUnique({ where: { id }, select: { isHot: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { isHot: data.isHot },
    });

    await audit(req as AdminRequest, {
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
    const data = z
      .object({
        assignedManagerId: z.string().optional().nullable(),
        nextContactAt: z.string().optional().nullable(),
      })
      .parse(req.body);
    const before = await prisma.registration.findUnique({
      where: { id },
      select: { assignedManagerId: true, nextContactAt: true },
    });

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

    await audit(req as AdminRequest, {
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
    const data = z.object({ text: z.string().trim().max(1200).optional().or(z.literal('')) }).parse(req.body);
    const registration = await prisma.registration.findUnique({
      where: { id },
      include: { lead: true, webinarSession: true },
    });

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    if (!registration.lead.telegramChatId) {
      throw new AppError(400, 'У участника не подключен Telegram');
    }

    const roomUrl = new URL('/crisis_premium/webinar.html', env.PUBLIC_SITE_URL);
    const defaultText = [
      `${registration.lead.name}, напоминаем про вебинар АСПБ.`,
      '',
      `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      '',
      `Ваша персональная комната: ${roomUrl.toString()}`,
    ].join('\n');
    const text = data.text
      ? [data.text, '', `Ваша персональная комната: ${roomUrl.toString()}`].join('\n')
      : defaultText;

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

    await audit(req as AdminRequest, {
      action: 'registration.telegram_reminder.send',
      entityType: 'registration',
      entityId: registration.id,
      after: { chatId: registration.lead.telegramChatId, textLength: text.length },
    });

    res.json({ ok: true, sent: true });
  }),
);

adminRouter.patch(
  '/api/admin/registrations/:id/note',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ managerNote: z.string().max(5000).optional().or(z.literal('')) }).parse(req.body);
    const before = await prisma.registration.findUnique({ where: { id }, select: { managerNote: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { managerNote: data.managerNote || null },
    });

    await audit(req as AdminRequest, {
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
  asyncHandler(async (_req, res) => {
    const applications = await prisma.partnerApplication.findMany({
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
      applications: applications.map(application => ({
        id: application.id,
        registrationId: application.registrationId,
        sphere: application.sphere,
        city: application.city,
        clientFlow: application.clientFlow,
        experience: application.experience,
        comment: application.comment,
        preferredFormat: application.preferredFormat,
        status: application.status,
        createdAt: application.createdAt,
        lead: {
          name: application.lead.name,
          email: application.lead.email,
          phone: application.lead.phone,
        },
        webinar: application.webinarSession
          ? {
              scheduledAt: application.webinarSession.scheduledAt,
            }
          : null,
      })),
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
  asyncHandler(async (_req, res) => {
    const questions = await prisma.question.findMany({
      include: {
        lead: true,
        webinarSession: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({
      ok: true,
      questions: questions.map(question => ({
        id: question.id,
        text: question.text,
        isAnswered: question.isAnswered,
        adminNote: question.adminNote,
        createdAt: question.createdAt,
        lead: {
          name: question.lead.name,
          email: question.lead.email,
          phone: question.lead.phone,
        },
        webinar: {
          scheduledAt: question.webinarSession.scheduledAt,
        },
      })),
    });
  }),
);

adminRouter.patch(
  '/api/admin/questions/:id',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ isAnswered: z.boolean(), adminNote: z.string().optional() }).parse(req.body);
    const before = await prisma.question.findUnique({ where: { id }, select: { isAnswered: true, adminNote: true } });
    const question = await prisma.question.update({
      where: { id },
      data: {
        isAnswered: data.isAnswered,
        adminNote: data.adminNote,
      },
    });

    await audit(req as AdminRequest, {
      action: 'question.update',
      entityType: 'question',
      entityId: id,
      before,
      after: { isAnswered: question.isAnswered, adminNote: question.adminNote },
    });

    res.json({ ok: true, question });
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
      prisma.event.findMany({
        where: { eventName: 'page_view', createdAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true },
      }),
      prisma.event.findMany({
        where: { eventName: 'telegram_click', createdAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true },
      }),
      prisma.registration.findMany({
        where: { registeredAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } },
      }),
      prisma.lead.findMany({
        where: { telegramSubscribedAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true },
      }),
      prisma.registration.findMany({
        where: { roomEnteredAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } },
      }),
      prisma.question.findMany({
        where: { createdAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } },
      }),
      prisma.partnerApplication.findMany({
        where: { createdAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } },
      }),
      prisma.partnerApplication.findMany({
        where: {
          OR: [{ contractSignedAt: dateRange }, { status: { in: ['contract_signed', 'paid'] }, updatedAt: dateRange }],
        },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } },
      }),
    ]);

    visitorEvents.forEach(item => {
      groupFor(item[groupField]).visitors += 1;
    });
    telegramClickEvents.forEach(item => {
      groupFor(item[groupField]).telegramClicks += 1;
    });
    registrations.forEach(item => {
      groupFor(item.lead[groupField]).registrations += 1;
    });
    telegramSubscribers.forEach(item => {
      groupFor(item[groupField]).telegramSubscribers += 1;
    });
    roomEntries.forEach(item => {
      groupFor(item.lead[groupField]).roomEntries += 1;
    });
    questions.forEach(item => {
      groupFor(item.lead[groupField]).questions += 1;
    });
    applications.forEach(item => {
      groupFor(item.lead[groupField]).applications += 1;
    });
    contracts.forEach(item => {
      groupFor(item.lead[groupField]).contracts += 1;
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
