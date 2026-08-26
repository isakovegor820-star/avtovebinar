import { Router, type Response } from 'express';
import { z } from 'zod';
import { getCatalogReferenceData, getCatalogWebinar, listCatalogWebinars } from '../lib/catalog.js';
import { getPlatformFeatureFlags } from '../lib/featureFlags.js';
import { AppError, asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';

export const catalogRouter = Router();

const emptyQuerySchema = z.object({}).strict();

function requirePublicCatalog() {
  if (!getPlatformFeatureFlags().publicCatalog) {
    throw new AppError(404, 'Каталог ещё не включён', undefined, 'public_catalog_disabled');
  }
}

function correlationId() {
  return getRequestContext()?.correlationId;
}

async function sendCatalogList(query: unknown, res: Response) {
  const result = await listCatalogWebinars(prisma, query);
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  res.json({ ok: true, ...result, correlationId: correlationId() });
}

catalogRouter.get(
  '/catalog/webinars',
  asyncHandler(async (req, res) => {
    requirePublicCatalog();
    await sendCatalogList(req.query, res);
  }),
);

catalogRouter.get(
  '/catalog/search',
  asyncHandler(async (req, res) => {
    requirePublicCatalog();
    await sendCatalogList(req.query, res);
  }),
);

catalogRouter.get(
  '/catalog/webinars/:slug',
  asyncHandler(async (req, res) => {
    requirePublicCatalog();
    const result = await getCatalogWebinar(prisma, req.params, req.query);
    if (result.webinar.visibility === 'UNLISTED') {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    }
    res.json({ ok: true, ...result, correlationId: correlationId() });
  }),
);

catalogRouter.get(
  '/catalog/practice-areas',
  asyncHandler(async (req, res) => {
    requirePublicCatalog();
    emptyQuerySchema.parse(req.query);
    const data = await getCatalogReferenceData(prisma);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, practiceAreas: data.practiceAreas, correlationId: correlationId() });
  }),
);

catalogRouter.get(
  '/catalog/jurisdictions',
  asyncHandler(async (req, res) => {
    requirePublicCatalog();
    emptyQuerySchema.parse(req.query);
    const data = await getCatalogReferenceData(prisma);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, jurisdictions: data.jurisdictions, correlationId: correlationId() });
  }),
);
