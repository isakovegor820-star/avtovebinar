import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from './http.js';

const idSchema = z.string().trim().min(1).max(191);
const reasonSchema = z.string().trim().min(3).max(500);
const baseMutationSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: reasonSchema,
  confirmation: z.literal('CONFIRM_PLATFORM_CHANGE'),
});
const organizationMutationSchema = baseMutationSchema
  .extend({
    name: z.string().trim().min(2).max(191).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine(
    value => value.name !== undefined || value.status !== undefined,
    'At least one organization field is required',
  );
const taxonomyMutationSchema = baseMutationSchema
  .extend({
    name: z.string().trim().min(2).max(191).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    orderIndex: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine(
    value => value.name !== undefined || value.status !== undefined || value.orderIndex !== undefined,
    'At least one taxonomy field is required',
  );
const flagMutationSchema = baseMutationSchema.extend({ enabled: z.boolean() }).strict();
const rollbackSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: reasonSchema,
    confirmation: z.literal('CONFIRM_PLATFORM_ROLLBACK'),
  })
  .strict();

function unavailable(): never {
  throw new AppError(404, 'Platform configuration target was not found', undefined, 'platform_configuration_not_found');
}

function conflict(): never {
  throw new AppError(
    409,
    'Platform configuration changed. Reload and retry.',
    undefined,
    'platform_configuration_conflict',
  );
}

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

async function recordChange(
  tx: Prisma.TransactionClient,
  input: {
    targetType: string;
    targetId: string;
    operation?: 'update' | 'rollback';
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    revision: number;
    adminUserId: string;
    reason: string;
    correlationId: string;
    rollsBackChangeId?: string;
  },
) {
  const change = await tx.platformConfigChange.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      operation: input.operation ?? 'update',
      beforeJson: json(input.before),
      afterJson: json(input.after),
      targetRevision: input.revision,
      actorAdminUserId: input.adminUserId,
      reason: input.reason,
      correlationId: input.correlationId,
      rollsBackChangeId: input.rollsBackChangeId,
    },
  });
  await tx.auditLog.create({
    data: {
      adminUserId: input.adminUserId,
      correlationId: input.correlationId,
      action: `platform.${input.targetType}.${input.operation ?? 'update'}`,
      entityType: input.targetType,
      entityId: input.targetId,
      beforeJson: json(input.before),
      afterJson: json({ ...input.after, reason: input.reason, changeId: change.id }),
    },
  });
  return change;
}

export async function updatePlatformOrganization(
  db: PrismaClient,
  organizationId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = organizationMutationSchema.parse(raw);
  return db.$transaction(async tx => {
    const current = await tx.organization.findUnique({ where: { id: organizationId } });
    if (!current) unavailable();
    if (current.platformRevision !== data.expectedRevision) conflict();
    const before = { name: current.name, status: current.status, platformRevision: current.platformRevision };
    const changed = await tx.organization.updateMany({
      where: { id: organizationId, platformRevision: data.expectedRevision },
      data: { name: data.name, status: data.status, platformRevision: { increment: 1 } },
    });
    if (changed.count !== 1) conflict();
    const after = {
      name: data.name ?? current.name,
      status: data.status ?? current.status,
      platformRevision: current.platformRevision + 1,
    };
    await recordChange(tx, {
      targetType: 'organization',
      targetId: organizationId,
      before,
      after,
      revision: current.platformRevision + 1,
      adminUserId,
      reason: data.reason,
      correlationId,
    });
    return after;
  });
}

export async function updatePlatformTaxonomy(
  db: PrismaClient,
  kind: unknown,
  targetId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const targetType = z.enum(['practice_area', 'jurisdiction']).parse(kind);
  const data = taxonomyMutationSchema.parse(raw);
  return db.$transaction(async tx => {
    if (targetType === 'practice_area') {
      const current = await tx.legalPracticeArea.findUnique({ where: { id: targetId } });
      if (!current) unavailable();
      if (current.platformRevision !== data.expectedRevision) conflict();
      const before = {
        name: current.name,
        status: current.status,
        orderIndex: current.orderIndex,
        platformRevision: current.platformRevision,
      };
      const changed = await tx.legalPracticeArea.updateMany({
        where: { id: targetId, platformRevision: data.expectedRevision },
        data: { name: data.name, status: data.status, orderIndex: data.orderIndex, platformRevision: { increment: 1 } },
      });
      if (changed.count !== 1) conflict();
      const after = {
        name: data.name ?? current.name,
        status: data.status ?? current.status,
        orderIndex: data.orderIndex ?? current.orderIndex,
        platformRevision: current.platformRevision + 1,
      };
      await recordChange(tx, {
        targetType,
        targetId,
        before,
        after,
        revision: current.platformRevision + 1,
        adminUserId,
        reason: data.reason,
        correlationId,
      });
      return after;
    }
    const current = await tx.jurisdiction.findUnique({ where: { id: targetId } });
    if (!current) unavailable();
    if (current.platformRevision !== data.expectedRevision) conflict();
    const before = { name: current.name, status: current.status, platformRevision: current.platformRevision };
    const changed = await tx.jurisdiction.updateMany({
      where: { id: targetId, platformRevision: data.expectedRevision },
      data: { name: data.name, status: data.status, platformRevision: { increment: 1 } },
    });
    if (changed.count !== 1) conflict();
    const after = {
      name: data.name ?? current.name,
      status: data.status ?? current.status,
      platformRevision: current.platformRevision + 1,
    };
    await recordChange(tx, {
      targetType,
      targetId,
      before,
      after,
      revision: current.platformRevision + 1,
      adminUserId,
      reason: data.reason,
      correlationId,
    });
    return after;
  });
}

export async function updatePlatformFeatureFlag(
  db: PrismaClient,
  key: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = flagMutationSchema.parse(raw);
  return db.$transaction(async tx => {
    const current = await tx.platformFeatureFlag.findUnique({ where: { key } });
    if (!current) unavailable();
    if (current.revision !== data.expectedRevision) conflict();
    const before = { enabled: current.enabled, revision: current.revision };
    const changed = await tx.platformFeatureFlag.updateMany({
      where: { key, revision: data.expectedRevision },
      data: { enabled: data.enabled, revision: { increment: 1 }, updatedByAdminUserId: adminUserId },
    });
    if (changed.count !== 1) conflict();
    const after = { enabled: data.enabled, revision: current.revision + 1 };
    await recordChange(tx, {
      targetType: 'feature_flag',
      targetId: key,
      before,
      after,
      revision: current.revision + 1,
      adminUserId,
      reason: data.reason,
      correlationId,
    });
    return { key, ...after };
  });
}

export async function rollbackPlatformChange(
  db: PrismaClient,
  changeId: string,
  raw: unknown,
  adminUserId: string,
  correlationId: string,
) {
  const data = rollbackSchema.parse(raw);
  return db.$transaction(async tx => {
    const change = await tx.platformConfigChange.findUnique({
      where: { id: changeId },
      include: { rolledBackBy: { select: { id: true }, take: 1 } },
    });
    if (!change) unavailable();
    if (change.rolledBackBy.length)
      throw new AppError(409, 'This change was already rolled back', undefined, 'platform_change_already_rolled_back');
    const previous = change.beforeJson as Record<string, unknown>;
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    if (change.targetType === 'feature_flag') {
      const current = await tx.platformFeatureFlag.findUnique({ where: { key: change.targetId } });
      if (!current) unavailable();
      if (current.revision !== data.expectedRevision) conflict();
      before = { enabled: current.enabled, revision: current.revision };
      after = { enabled: Boolean(previous.enabled), revision: current.revision + 1 };
      await tx.platformFeatureFlag.update({
        where: { key: current.key },
        data: { enabled: Boolean(previous.enabled), revision: { increment: 1 }, updatedByAdminUserId: adminUserId },
      });
    } else if (change.targetType === 'organization') {
      const current = await tx.organization.findUnique({ where: { id: change.targetId } });
      if (!current) unavailable();
      if (current.platformRevision !== data.expectedRevision) conflict();
      before = { name: current.name, status: current.status, platformRevision: current.platformRevision };
      after = { name: String(previous.name), status: previous.status, platformRevision: current.platformRevision + 1 };
      await tx.organization.update({
        where: { id: current.id },
        data: { name: String(previous.name), status: previous.status as never, platformRevision: { increment: 1 } },
      });
    } else if (change.targetType === 'practice_area') {
      const current = await tx.legalPracticeArea.findUnique({ where: { id: change.targetId } });
      if (!current) unavailable();
      if (current.platformRevision !== data.expectedRevision) conflict();
      before = {
        name: current.name,
        status: current.status,
        orderIndex: current.orderIndex,
        platformRevision: current.platformRevision,
      };
      after = {
        name: String(previous.name),
        status: previous.status,
        orderIndex: Number(previous.orderIndex),
        platformRevision: current.platformRevision + 1,
      };
      await tx.legalPracticeArea.update({
        where: { id: current.id },
        data: {
          name: String(previous.name),
          status: previous.status as never,
          orderIndex: Number(previous.orderIndex),
          platformRevision: { increment: 1 },
        },
      });
    } else if (change.targetType === 'jurisdiction') {
      const current = await tx.jurisdiction.findUnique({ where: { id: change.targetId } });
      if (!current) unavailable();
      if (current.platformRevision !== data.expectedRevision) conflict();
      before = { name: current.name, status: current.status, platformRevision: current.platformRevision };
      after = { name: String(previous.name), status: previous.status, platformRevision: current.platformRevision + 1 };
      await tx.jurisdiction.update({
        where: { id: current.id },
        data: { name: String(previous.name), status: previous.status as never, platformRevision: { increment: 1 } },
      });
    } else {
      unavailable();
    }
    const revision = Number(after.platformRevision ?? after.revision);
    const rollback = await recordChange(tx, {
      targetType: change.targetType,
      targetId: change.targetId,
      operation: 'rollback',
      before,
      after,
      revision,
      adminUserId,
      reason: data.reason,
      correlationId,
      rollsBackChangeId: change.id,
    });
    return { changeId: rollback.id, targetType: change.targetType, targetId: change.targetId, state: after };
  });
}

export function parsePlatformId(value: unknown) {
  return idSchema.parse(value);
}
