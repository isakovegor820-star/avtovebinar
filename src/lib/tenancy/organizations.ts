import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { getRequestContext } from '../requestContext.js';
import type { AuthenticatedUserSession } from './userAuth.js';
import type { TenantContext } from './context.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ORGANIZATION_MUTATION_LOCK_NAMESPACE = 7_106_101_017n;
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'catalog',
  'health',
  'metrics',
  'platform',
  'support',
  'www',
]);

const transliteration: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const organizationNameSchema = z.string().trim().min(2).max(160);
const organizationSettingsSchema = z
  .object({
    defaultTimezone: z.string().trim().min(3).max(64).refine(validTimeZone, 'Unknown IANA timezone').optional(),
    locale: z.enum(['ru-RU']).optional(),
  })
  .strict();

export const createOrganizationSchema = z
  .object({
    name: organizationNameSchema,
    slug: z.string().trim().min(2).max(63).optional(),
    settings: organizationSettingsSchema.optional(),
  })
  .strict();

export const updateOrganizationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: organizationNameSchema.optional(),
    settings: organizationSettingsSchema.optional(),
  })
  .strict()
  .refine(value => value.name !== undefined || value.settings !== undefined, {
    message: 'At least one organization setting is required',
  });

export const organizationPageSchema = z
  .object({
    cursor: z.string().trim().min(1).max(191).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

export function parseOrganizationIdempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value.trim())) {
    throw new AppError(400, 'Добавьте ключ повтора запроса', undefined, 'idempotency_key_required');
  }
  return value.trim();
}

export function normalizeOrganizationSlug(value: string) {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .split('')
    .map(character => transliteration[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (normalized.length < 2 || RESERVED_SLUGS.has(normalized)) {
    throw new AppError(
      400,
      'Выберите другой короткий адрес организации',
      { fieldErrors: { slug: ['Используйте буквы, цифры и дефисы; минимум 2 знака.'] } },
      'organization_slug_invalid',
    );
  }
  return normalized;
}

function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function organizationProjection(organization: {
  id: string;
  name: string;
  slug: string;
  status: string;
  settingsJson: Prisma.JsonValue | null;
  settingsRevision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    settings: organization.settingsJson ?? {},
    revision: organization.settingsRevision,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

const storedCreateResponseSchema = z.object({
  organization: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    settings: z.unknown(),
    revision: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  membership: z.object({
    id: z.string(),
    organizationId: z.string(),
    role: z.literal('OWNER'),
    status: z.literal('ACTIVE'),
  }),
});

const storedUpdateResponseSchema = z.object({
  organization: storedCreateResponseSchema.shape.organization,
});

function idempotencyConflict(): never {
  throw new AppError(
    409,
    'Ключ повтора уже использован для другого запроса',
    undefined,
    'idempotency_payload_conflict',
  );
}

function createConflict(): never {
  throw new AppError(409, 'Не удалось создать организацию с этими данными', undefined, 'organization_create_conflict');
}

export async function createOrganization(
  db: PrismaClient,
  session: AuthenticatedUserSession,
  input: unknown,
  idempotencyKeyInput: unknown,
) {
  const parsed = createOrganizationSchema.parse(input);
  const normalized = {
    name: parsed.name,
    slug: normalizeOrganizationSlug(parsed.slug ?? parsed.name),
    settings: parsed.settings ?? {},
  };
  const idempotencyKey = parseOrganizationIdempotencyKey(idempotencyKeyInput);
  const hash = requestHash(normalized);

  try {
    return await db.$transaction(
      async tx => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${session.userId}:organization.create:${idempotencyKey}`}, ${ORGANIZATION_MUTATION_LOCK_NAMESPACE}))
        `;
        const replay = await tx.organizationIdempotencyRecord.findUnique({
          where: {
            userId_scope_idempotencyKey: { userId: session.userId, scope: 'organization.create', idempotencyKey },
          },
          select: { requestHash: true, responseJson: true },
        });
        if (replay) {
          if (replay.requestHash !== hash) idempotencyConflict();
          return { ...storedCreateResponseSchema.parse(replay.responseJson), idempotentReplay: true };
        }

        const lockedUser = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users" WHERE "id" = ${session.userId} FOR UPDATE
        `;
        if (lockedUser.length !== 1) createConflict();
        const user = await tx.user.findFirst({
          where: { id: session.userId, kind: 'HUMAN', status: 'ACTIVE', emailVerifiedAt: { not: null } },
          select: { id: true },
        });
        if (!user) createConflict();
        const membershipCount = await tx.organizationMembership.count({
          where: { userId: session.userId, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
        });
        if (membershipCount !== 0) createConflict();

        const organization = await tx.organization.create({
          data: { name: normalized.name, slug: normalized.slug, settingsJson: normalized.settings },
        });
        const membership = await tx.organizationMembership.create({
          data: { organizationId: organization.id, userId: session.userId, role: 'OWNER', status: 'ACTIVE' },
          select: { id: true, organizationId: true, role: true, status: true },
        });
        const activated = await tx.userSession.updateMany({
          where: { id: session.id, userId: session.userId, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { activeOrganizationId: organization.id },
        });
        if (activated.count !== 1) {
          throw new AppError(401, 'Войдите в аккаунт заново', undefined, 'user_authentication_required');
        }

        const response = { organization: organizationProjection(organization), membership };
        await tx.organizationIdempotencyRecord.create({
          data: {
            userId: session.userId,
            organizationId: organization.id,
            scope: 'organization.create',
            idempotencyKey,
            requestHash: hash,
            responseJson: response,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: session.userId,
            organizationId: organization.id,
            correlationId: getRequestContext()?.correlationId,
            action: 'organization.created_self_service',
            entityType: 'organization',
            entityId: organization.id,
            afterJson: { id: organization.id, slug: organization.slug, ownerMembershipId: membership.id },
          },
        });
        return { ...response, idempotentReplay: false };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') createConflict();
    throw error;
  }
}

async function requireOwner(db: Prisma.TransactionClient | PrismaClient, context: TenantContext) {
  const owner = await db.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: 'OWNER',
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!owner) throw new AppError(403, 'Требуются права владельца организации', undefined, 'tenant_owner_required');
}

function organizationNotFound(): never {
  throw new AppError(404, 'Организация недоступна', undefined, 'organization_not_found');
}

export async function getOrganization(db: PrismaClient, context: TenantContext, organizationId: string) {
  if (organizationId !== context.organizationId) organizationNotFound();
  await requireOwner(db, context);
  const organization = await db.organization.findFirst({
    where: { id: context.organizationId, status: 'ACTIVE' },
  });
  if (!organization) organizationNotFound();
  return organizationProjection(organization);
}

export async function updateOrganization(
  db: PrismaClient,
  context: TenantContext,
  organizationId: string,
  input: unknown,
  idempotencyKeyInput: unknown,
) {
  if (organizationId !== context.organizationId) organizationNotFound();
  const data = updateOrganizationSchema.parse(input);
  const idempotencyKey = parseOrganizationIdempotencyKey(idempotencyKeyInput);
  const hash = requestHash(data);
  return db.$transaction(
    async tx => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${context.organizationId}, ${ORGANIZATION_MUTATION_LOCK_NAMESPACE}))
      `;
      await requireOwner(tx, context);
      const replay = await tx.organizationIdempotencyRecord.findUnique({
        where: {
          userId_scope_idempotencyKey: {
            userId: context.userId,
            scope: 'organization.settings.update',
            idempotencyKey,
          },
        },
        select: { requestHash: true, responseJson: true },
      });
      if (replay) {
        if (replay.requestHash !== hash) idempotencyConflict();
        return { ...storedUpdateResponseSchema.parse(replay.responseJson), idempotentReplay: true };
      }

      const current = await tx.organization.findFirst({ where: { id: context.organizationId, status: 'ACTIVE' } });
      if (!current) organizationNotFound();
      if (current.settingsRevision !== data.expectedRevision) {
        throw new AppError(
          409,
          'Настройки уже изменились. Обновите страницу и повторите',
          { currentRevision: current.settingsRevision },
          'organization_revision_conflict',
        );
      }
      const previousSettings =
        current.settingsJson && typeof current.settingsJson === 'object' && !Array.isArray(current.settingsJson)
          ? current.settingsJson
          : {};
      const next = await tx.organization.update({
        where: { id: current.id },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.settings === undefined ? {} : { settingsJson: { ...previousSettings, ...data.settings } }),
          settingsRevision: { increment: 1 },
        },
      });
      const response = { organization: organizationProjection(next) };
      await tx.organizationIdempotencyRecord.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          scope: 'organization.settings.update',
          idempotencyKey,
          requestHash: hash,
          responseJson: response,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'organization.settings_updated',
          entityType: 'organization',
          entityId: context.organizationId,
          beforeJson: { name: current.name, settings: current.settingsJson ?? {}, revision: current.settingsRevision },
          afterJson: { name: next.name, settings: next.settingsJson ?? {}, revision: next.settingsRevision },
        },
      });
      return { ...response, idempotentReplay: false };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

export async function listOrganizationMembers(db: PrismaClient, context: TenantContext, input: unknown) {
  const page = organizationPageSchema.parse(input);
  await requireOwner(db, context);
  const rows = await db.organizationMembership.findMany({
    where: { organizationId: context.organizationId, status: { not: 'REMOVED' } },
    orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    take: page.limit + 1,
    select: {
      id: true,
      role: true,
      status: true,
      joinedAt: true,
      user: { select: { displayName: true, emailNormalized: true } },
    },
  });
  const hasMore = rows.length > page.limit;
  const items = rows.slice(0, page.limit).map(row => ({
    id: row.id,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt.toISOString(),
    displayName: row.user.displayName,
    email: row.user.emailNormalized,
  }));
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}
