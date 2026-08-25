import { raw, Router, type Response } from 'express';
import { z } from 'zod';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import {
  deleteAuthorEvidence,
  getAuthorEvidenceContent,
  getAuthorProfile,
  getPublicAuthorProfile,
  saveAuthorProfileDraft,
  submitAuthorVerification,
  uploadAuthorEvidence,
} from '../lib/tenancy/authorVerification.js';
import { resolveTenantContext } from '../lib/tenancy/context.js';
import { requireAuthenticatedUserSession } from '../lib/tenancy/userAuth.js';
import { getPlatformOverview } from '../lib/tenancy/platformOverview.js';
import { requireTenantRollout } from '../lib/tenancy/rolloutPolicy.js';

export const authorPlatformRouter = Router();

const evidenceParamsSchema = z.object({ evidenceId: z.string().trim().min(1).max(191) }).strict();
const publicAuthorParamsSchema = z.object({ slug: z.string().trim().min(1).max(191) }).strict();
const emptyBodySchema = z.object({}).strict();

function requirePlatformAccounts() {
  if (!getPlatformFeatureFlags().platformAccounts) {
    throw new AppError(404, 'Аккаунты платформы ещё не включены', undefined, 'platform_accounts_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function tenantContextFromRequest(req: Parameters<typeof requireAuthenticatedUserSession>[1]) {
  const session = await requireAuthenticatedUserSession(prisma, req);
  return resolveTenantContext(prisma, {
    userId: session.userId,
    activeOrganizationId: session.activeOrganizationId,
    correlationId: correlationId(),
  });
}

function decodedEvidenceFilename(value: string | undefined) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, 'Имя файла имеет неверный формат', undefined, 'author_evidence_filename_invalid');
  }
}

function sendPrivateEvidence(res: Response, evidence: { id: string; mimeType: string; content: Uint8Array }) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="evidence-${evidence.id}"`);
  res.type(evidence.mimeType).send(Buffer.from(evidence.content));
}

authorPlatformRouter.get(
  '/platform/overview',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromRequest(req);
    await requireTenantRollout(prisma, 'CREATOR_DASHBOARD', context.organizationId);
    const overview = await getPlatformOverview(prisma, context, req.query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...overview, correlationId: correlationId() });
  }),
);

authorPlatformRouter.get(
  '/author-profile',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromRequest(req);
    const result = await getAuthorProfile(prisma, context);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

authorPlatformRouter.patch(
  '/author-profile',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromRequest(req);
    const profile = await saveAuthorProfileDraft(prisma, context, req.body);
    res.json({ ok: true, profile, correlationId: correlationId() });
  }),
);

authorPlatformRouter.post(
  '/author-verification',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromRequest(req);
    const verification = await submitAuthorVerification(prisma, context);
    res.status(201).json({ ok: true, verification, correlationId: correlationId() });
  }),
);

authorPlatformRouter.post(
  '/author-verification/evidence',
  raw({ type: () => true, limit: '5mb' }),
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const context = await tenantContextFromRequest(req);
    const mimeType = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const evidence = await uploadAuthorEvidence(
      prisma,
      context,
      {
        kind: req.get('x-evidence-kind'),
        originalName: decodedEvidenceFilename(req.get('x-evidence-filename')),
        mimeType,
      },
      req.body,
    );
    res.status(201).json({ ok: true, evidence, correlationId: correlationId() });
  }),
);

authorPlatformRouter.get(
  '/author-verification/evidence/:evidenceId',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = evidenceParamsSchema.parse(req.params);
    const context = await tenantContextFromRequest(req);
    const evidence = await getAuthorEvidenceContent(prisma, context, params.evidenceId);
    await prisma.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'author_verification.evidence_accessed',
        entityType: 'author_verification_evidence',
        entityId: evidence.id,
      },
    });
    sendPrivateEvidence(res, evidence);
  }),
);

authorPlatformRouter.delete(
  '/author-verification/evidence/:evidenceId',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = evidenceParamsSchema.parse(req.params);
    emptyBodySchema.parse(req.body ?? {});
    const context = await tenantContextFromRequest(req);
    const evidence = await deleteAuthorEvidence(prisma, context, params.evidenceId);
    res.json({ ok: true, evidence, correlationId: correlationId() });
  }),
);

authorPlatformRouter.get(
  '/catalog/authors/:slug',
  asyncHandler(async (req, res) => {
    requirePlatformAccounts();
    const params = publicAuthorParamsSchema.parse(req.params);
    const author = await getPublicAuthorProfile(prisma, params.slug);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, author, correlationId: correlationId() });
  }),
);
