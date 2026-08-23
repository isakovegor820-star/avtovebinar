import { Router } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import {
  activateCrmScoringVersion,
  assignCrmContactTag,
  createCrmTag,
  createCrmStage,
  createCrmTask,
  executeCrmBulkAction,
  exportCrmContacts,
  getCrmContact,
  getCrmQueues,
  getCrmReferenceData,
  getCrmScoringConfiguration,
  listCrmTags,
  listCrmContacts,
  previewCrmBulkAction,
  removeCrmContactTag,
  setCrmContactManualHot,
  transitionCrmContactStage,
  updateCrmTag,
  updateCrmTask,
  updateCrmStage,
} from '../lib/tenancy/crm.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { enqueueCrmDelivery, retryCrmDelivery } from '../lib/tenancy/crmDelivery.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';

export const tenantCrmRouter = Router();

const contactParamsSchema = z.object({ contactId: z.string().trim().min(1).max(191) }).strict();
const stageParamsSchema = z.object({ stageId: z.string().trim().min(1).max(191) }).strict();
const taskParamsSchema = z.object({ taskId: z.string().trim().min(1).max(191) }).strict();
const tagParamsSchema = z.object({ tagId: z.string().trim().min(1).max(191) }).strict();
const deliveryParamsSchema = z.object({ deliveryId: z.string().trim().min(1).max(191) }).strict();
const contactTagParamsSchema = z
  .object({
    contactId: z.string().trim().min(1).max(191),
    tagId: z.string().trim().min(1).max(191),
  })
  .strict();

function requireTenantCrm() {
  const flags = getPlatformFeatureFlags();
  if (!flags.platformAccounts || !flags.tenantCrm) {
    throw new AppError(404, 'CRM организации ещё не включена', undefined, 'tenant_crm_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function contextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: correlationId(),
  });
}

tenantCrmRouter.get(
  '/crm/reference-data',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await getCrmReferenceData(prisma, context);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/bulk-actions',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result =
      req.body?.mode === 'EXECUTE'
        ? await executeCrmBulkAction(prisma, context, req.body)
        : await previewCrmBulkAction(prisma, context, req.body);
    res.status(req.body?.mode === 'PREVIEW' && !result.replayed ? 201 : 200).json({
      ok: true,
      ...result,
      correlationId: correlationId(),
    });
  }),
);

tenantCrmRouter.post(
  '/crm/exports',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await exportCrmContacts(prisma, context, req.body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('x-crm-export-row-count', String(result.rowCount));
    res.setHeader('x-crm-export-audit-id', result.auditId);
    res.send(result.csv);
  }),
);

tenantCrmRouter.get(
  '/crm/queues',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await getCrmQueues(prisma, context);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.get(
  '/crm/scoring',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await getCrmScoringConfiguration(prisma, context);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/scoring/versions',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await activateCrmScoringVersion(prisma, context, req.body);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.get(
  '/crm/tags',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await listCrmTags(prisma, context, req.query.includeArchived);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/tags',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const tag = await createCrmTag(prisma, context, req.body);
    res.status(201).json({ ok: true, tag, correlationId: correlationId() });
  }),
);

tenantCrmRouter.patch(
  '/crm/tags/:tagId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { tagId } = tagParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const tag = await updateCrmTag(prisma, context, tagId, req.body);
    res.json({ ok: true, tag, correlationId: correlationId() });
  }),
);

tenantCrmRouter.get(
  '/crm/contacts',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const result = await listCrmContacts(prisma, context, req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/contacts/:contactId/tasks',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId } = contactParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const task = await createCrmTask(prisma, context, contactId, req.body);
    res.status(201).json({ ok: true, task, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/contacts/:contactId/deliveries',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId } = contactParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await enqueueCrmDelivery(prisma, context, contactId, req.body);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/deliveries/:deliveryId/retry',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { deliveryId } = deliveryParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await retryCrmDelivery(prisma, context, deliveryId, req.body);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.patch(
  '/crm/contacts/:contactId/hot',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId } = contactParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await setCrmContactManualHot(prisma, context, contactId, req.body);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/contacts/:contactId/tags/:tagId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId, tagId } = contactTagParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await assignCrmContactTag(prisma, context, contactId, tagId);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.delete(
  '/crm/contacts/:contactId/tags/:tagId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId, tagId } = contactTagParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await removeCrmContactTag(prisma, context, contactId, tagId);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.patch(
  '/crm/tasks/:taskId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { taskId } = taskParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const task = await updateCrmTask(prisma, context, taskId, req.body);
    res.json({ ok: true, task, correlationId: correlationId() });
  }),
);

tenantCrmRouter.get(
  '/crm/contacts/:contactId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId } = contactParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await getCrmContact(prisma, context, contactId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.patch(
  '/crm/contacts/:contactId/stage',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { contactId } = contactParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const result = await transitionCrmContactStage(prisma, context, contactId, req.body);
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

tenantCrmRouter.post(
  '/crm/stages',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const context = await contextFromRequest(req);
    const stage = await createCrmStage(prisma, context, req.body);
    res.status(201).json({ ok: true, stage, correlationId: correlationId() });
  }),
);

tenantCrmRouter.patch(
  '/crm/stages/:stageId',
  asyncHandler(async (req, res) => {
    requireTenantCrm();
    const { stageId } = stageParamsSchema.parse(req.params);
    const context = await contextFromRequest(req);
    const stage = await updateCrmStage(prisma, context, stageId, req.body);
    res.json({ ok: true, stage, correlationId: correlationId() });
  }),
);
