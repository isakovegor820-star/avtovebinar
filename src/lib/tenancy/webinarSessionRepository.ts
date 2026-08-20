import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';

const tenantEntityIdSchema = z.string().trim().min(1).max(191);
const updateSessionTitleSchema = z
  .object({
    webinarSessionId: tenantEntityIdSchema,
    title: z.string().trim().min(3).max(240),
  })
  .strict();

type TenantSessionDb = Pick<PrismaClient, 'webinarSession'>;

function tenantObjectNotFound(): never {
  throw new AppError(404, 'Organization resource was not found', undefined, 'tenant_resource_not_found');
}

export async function getTenantWebinarSession(
  db: TenantSessionDb,
  context: TenantContext,
  webinarSessionIdInput: unknown,
) {
  const webinarSessionId = tenantEntityIdSchema.parse(webinarSessionIdInput);
  const webinarSession = await db.webinarSession.findFirst({
    where: {
      id: webinarSessionId,
      organizationId: context.organizationId,
    },
  });

  if (!webinarSession) tenantObjectNotFound();
  return webinarSession;
}

export async function updateTenantWebinarSessionTitle(db: TenantSessionDb, context: TenantContext, input: unknown) {
  const data = updateSessionTitleSchema.parse(input);
  const result = await db.webinarSession.updateMany({
    where: {
      id: data.webinarSessionId,
      organizationId: context.organizationId,
    },
    data: { title: data.title },
  });

  if (result.count !== 1) tenantObjectNotFound();
  return getTenantWebinarSession(db, context, data.webinarSessionId);
}
