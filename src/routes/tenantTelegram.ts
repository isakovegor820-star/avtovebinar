import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import {
  confirmTelegramManagerBinding,
  createTelegramManagerBinding,
  listTelegramManagerBindings,
  revokeTelegramManagerBinding,
} from '../lib/tenancy/telegramBots.js';
import {
  correctTelegramConsultantClassification,
  listTelegramConsultantMessages,
} from '../lib/tenancy/telegramConsultant.js';
import {
  cancelTenantTelegramBroadcast,
  confirmTenantTelegramBroadcast,
  createTenantTelegramBroadcastTemplate,
  listTenantTelegramBroadcastJobs,
  listTenantTelegramBroadcastTemplates,
  pauseTenantTelegramBroadcast,
  previewTenantTelegramBroadcast,
  publishTenantTelegramBroadcastTemplate,
  resumeTenantTelegramBroadcast,
} from '../lib/tenancy/telegramBroadcast.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';

export const tenantTelegramRouter = Router();

const bindingParamsSchema = z.object({ bindingId: z.string().trim().min(1).max(191) }).strict();
const consultantMessageParamsSchema = z.object({ messageId: z.string().trim().min(1).max(191) }).strict();
const templateParamsSchema = z.object({ templateId: z.string().trim().min(1).max(191) }).strict();
const broadcastParamsSchema = z.object({ jobId: z.string().trim().min(1).max(191) }).strict();

function requireTenantTelegramBots() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.tenantCrm || !flags.tenantTelegramBots) {
    throw new AppError(404, 'Telegram организации ещё не включён', undefined, 'tenant_telegram_bots_disabled');
  }
}

async function contextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: getRequestContext()?.correlationId,
  });
}

tenantTelegramRouter.get(
  '/telegram/manager-bindings',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const bindings = await listTelegramManagerBindings(prisma, context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, bindings, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/manager-bindings',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const result = await createTelegramManagerBinding(prisma, context, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/manager-bindings/:bindingId/confirm',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { bindingId } = bindingParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await confirmTelegramManagerBinding(prisma, context, bindingId);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.delete(
  '/telegram/manager-bindings/:bindingId',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const { bindingId } = bindingParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await revokeTelegramManagerBinding(prisma, context, bindingId);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.get(
  '/telegram/consultant/messages',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const messages = await listTelegramConsultantMessages(prisma, context, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, messages, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.patch(
  '/telegram/consultant/messages/:messageId/classification',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const { messageId } = consultantMessageParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const message = await correctTelegramConsultantClassification(prisma, context, messageId, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, message, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.get(
  '/telegram/broadcast-templates',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const templates = await listTenantTelegramBroadcastTemplates(prisma, context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, templates, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcast-templates',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const template = await createTenantTelegramBroadcastTemplate(prisma, context, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, template, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcast-templates/:templateId/publish',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { templateId } = templateParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await publishTenantTelegramBroadcastTemplate(prisma, context, templateId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcasts/preview',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const preview = await previewTenantTelegramBroadcast(prisma, context, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, preview, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcasts/confirm',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const result = await confirmTenantTelegramBroadcast(prisma, context, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res
      .status(result.replayed ? 200 : 202)
      .json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.get(
  '/telegram/broadcasts',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const context = await contextFromRequest(req);
    const jobs = await listTenantTelegramBroadcastJobs(prisma, context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, jobs, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcasts/:jobId/pause',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { jobId } = broadcastParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await pauseTenantTelegramBroadcast(prisma, context, jobId);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcasts/:jobId/resume',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { jobId } = broadcastParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await resumeTenantTelegramBroadcast(prisma, context, jobId);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);

tenantTelegramRouter.post(
  '/telegram/broadcasts/:jobId/cancel',
  asyncHandler(async (req, res) => {
    requireTenantTelegramBots();
    const { jobId } = broadcastParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await cancelTenantTelegramBroadcast(prisma, context, jobId, req.body);
    res.json({ ok: true, ...result, correlationId: getRequestContext()?.correlationId });
  }),
);
