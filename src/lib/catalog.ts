import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from './http.js';

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Invalid calendar date');

export const catalogListSchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    practiceArea: slugSchema.optional(),
    specialization: slugSchema.optional(),
    jurisdiction: z.string().trim().min(2).max(32).optional(),
    level: z.enum(['INTRODUCTORY', 'PRACTITIONER', 'ADVANCED', 'ALL_LEVELS']).optional(),
    format: z.enum(['RECORDED', 'PREMIERE', 'ON_DEMAND']).optional(),
    availability: z.enum(['ALL', 'UPCOMING', 'RECORDING']).default('ALL'),
    dateFrom: dateOnlySchema.optional(),
    dateTo: dateOnlySchema.optional(),
    sort: z.enum(['RELEVANCE', 'UPCOMING', 'NEWEST', 'UPDATED']).default('UPCOMING'),
    page: z.coerce.number().int().min(1).max(100).default(1),
    pageSize: z.coerce.number().int().min(1).max(24).default(12),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      context.addIssue({ code: 'custom', path: ['dateTo'], message: 'dateTo must not precede dateFrom' });
    }
  });

export const catalogDetailParamsSchema = z.object({ slug: slugSchema }).strict();
export const catalogDetailQuerySchema = z.object({ organization: slugSchema }).strict();

type CatalogIdRow = { id: string; next_session_at: Date | null };
type CatalogCountRow = { count: bigint };
type CatalogSitemapRow = { organization_slug: string; webinar_slug: string; updated_at: Date };
type CatalogTranscriptMatchRow = { webinar_id: string; start_ms: number; end_ms: number; snippet: string };

const catalogInclude = {
  organization: { select: { slug: true, name: true } },
  authorProfile: {
    select: {
      slug: true,
      publicName: true,
      bio: true,
      specializations: true,
      professionalOrganization: true,
      region: true,
      experience: true,
      userId: true,
    },
  },
  jurisdiction: { select: { code: true, name: true } },
  practiceAreas: {
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
    include: { practiceArea: { select: { slug: true, name: true, parentId: true } } },
  },
  sources: {
    orderBy: [{ orderIndex: 'asc' as const }, { createdAt: 'asc' as const }],
    select: { type: true, title: true, url: true, accessedAt: true, note: true },
  },
  sessions: {
    where: { lifecycleStatus: { not: 'CANCELLED' } },
    orderBy: [{ scheduledAt: 'asc' as const }],
    take: 12,
    select: {
      scheduledAt: true,
      timezone: true,
      lifecycleStatus: true,
      durationMinutes: true,
      replayEnabled: true,
    },
  },
  supersededBy: {
    include: {
      organization: { select: { slug: true } },
      authorProfile: { select: { verificationStatus: true, userId: true } },
    },
  },
} satisfies Prisma.WebinarInclude;

type CatalogWebinar = Prisma.WebinarGetPayload<{ include: typeof catalogInclude }>;

function catalogUnavailable(): never {
  throw new AppError(404, 'Вебинар не найден', undefined, 'catalog_webinar_not_found');
}

function publicPath(webinar: { organization: { slug: string }; slug: string }) {
  const query = new URLSearchParams({ organization: webinar.organization.slug, webinar: webinar.slug });
  return `/crisis_premium/catalog-webinar.html?${query.toString()}`;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function baseCatalogConditions() {
  return [
    Prisma.sql`w."content_status" = 'published'::"webinar_content_status"`,
    Prisma.sql`w."archived_at" IS NULL`,
    Prisma.sql`o."status" = 'active'::"OrganizationStatus"`,
    Prisma.sql`ap."verification_status" = 'verified'::"author_verification_status"`,
    Prisma.sql`u."kind" = 'human'::"UserKind"`,
    Prisma.sql`u."status" = 'active'::"UserStatus"`,
    Prisma.sql`m."status" = 'active'::"OrganizationMembershipStatus"`,
    Prisma.sql`m."role" IN ('owner'::"OrganizationMembershipRole", 'author'::"OrganizationMembershipRole")`,
  ];
}

function listConditions(input: z.infer<typeof catalogListSchema>) {
  const conditions = [...baseCatalogConditions(), Prisma.sql`w."visibility" = 'public'::"webinar_visibility"`];
  if (input.q) {
    const pattern = `%${escapeLike(input.q)}%`;
    conditions.push(
      Prisma.sql`(
        w."title" ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(w."description", '') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(ap."public_name", '') ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM "webinar_tags" wt
          WHERE wt."webinar_id" = w."id"
            AND wt."organization_id" = w."organization_id"
            AND wt."name" ILIKE ${pattern} ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1
          FROM "transcripts" transcript
          JOIN "transcript_segments" segment ON segment."transcript_id" = transcript."id"
            AND segment."organization_id" = transcript."organization_id"
          WHERE transcript."webinar_id" = w."id"
            AND transcript."organization_id" = w."organization_id"
            AND transcript."status" = 'published'::"webinar_transcript_status"
            AND (
              segment."search_vector" @@ websearch_to_tsquery('russian', ${input.q})
              OR segment."text" ILIKE ${pattern} ESCAPE '\\'
            )
        )
      )`,
    );
  }
  for (const areaSlug of [input.practiceArea, input.specialization]) {
    if (!areaSlug) continue;
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "webinar_practice_areas" wpa
      JOIN "legal_practice_areas" lpa ON lpa."id" = wpa."practice_area_id"
      WHERE wpa."webinar_id" = w."id"
        AND wpa."organization_id" = w."organization_id"
        AND lpa."slug" = ${areaSlug}
        AND lpa."status" = 'active'::"taxonomy_status"
    )`);
  }
  if (input.jurisdiction) {
    conditions.push(Prisma.sql`j."code" = ${input.jurisdiction}`);
  }
  if (input.level) {
    conditions.push(Prisma.sql`w."audience_level"::text = ${input.level.toLowerCase()}`);
  }
  if (input.format) {
    conditions.push(Prisma.sql`w."format"::text = ${input.format.toLowerCase()}`);
  }
  if (input.availability === 'UPCOMING') {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "webinar_sessions" ws
      WHERE ws."webinar_id" = w."id"
        AND ws."organization_id" = w."organization_id"
        AND ws."cancelled_at" IS NULL
        AND ws."lifecycle_status" <> 'cancelled'::"webinar_session_lifecycle_status"
        AND ws."scheduled_at" >= CURRENT_TIMESTAMP
    )`);
  }
  if (input.availability === 'RECORDING') {
    conditions.push(
      Prisma.sql`(w."format" IN ('recorded'::"webinar_format", 'on_demand'::"webinar_format") OR w."media_status" = 'ready'::"webinar_media_status")`,
    );
  }
  if (input.dateFrom || input.dateTo) {
    const start = input.dateFrom ? new Date(`${input.dateFrom}T00:00:00.000Z`) : null;
    const exclusiveEnd = input.dateTo ? new Date(`${input.dateTo}T00:00:00.000Z`) : null;
    if (exclusiveEnd) exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "webinar_sessions" ws
      WHERE ws."webinar_id" = w."id"
        AND ws."organization_id" = w."organization_id"
        AND ws."cancelled_at" IS NULL
        ${start ? Prisma.sql`AND ws."scheduled_at" >= ${start}` : Prisma.empty}
        ${exclusiveEnd ? Prisma.sql`AND ws."scheduled_at" < ${exclusiveEnd}` : Prisma.empty}
    )`);
  }
  return conditions;
}

function listOrder(input: z.infer<typeof catalogListSchema>) {
  if (input.sort === 'NEWEST') return Prisma.sql`w."published_at" DESC NULLS LAST, w."id" DESC`;
  if (input.sort === 'UPDATED') return Prisma.sql`w."updated_at" DESC, w."id" DESC`;
  if (input.sort === 'RELEVANCE' && input.q) {
    const pattern = `%${escapeLike(input.q)}%`;
    return Prisma.sql`CASE WHEN w."title" ILIKE ${pattern} ESCAPE '\\' THEN 0 ELSE 1 END, w."updated_at" DESC, w."id" DESC`;
  }
  return Prisma.sql`next_session."scheduled_at" ASC NULLS LAST, w."published_at" DESC NULLS LAST, w."id" DESC`;
}

function nextSession(webinar: CatalogWebinar, now = new Date()) {
  return webinar.sessions.find(session => session.scheduledAt >= now) ?? null;
}

function publicBaseProjection(webinar: CatalogWebinar) {
  const primary = webinar.practiceAreas.find(item => item.isPrimary)?.practiceArea ?? null;
  const specialization = webinar.practiceAreas.find(item => !item.isPrimary)?.practiceArea ?? null;
  const next = nextSession(webinar);
  return {
    slug: webinar.slug,
    canonicalPath: publicPath(webinar),
    title: webinar.title,
    description: webinar.description,
    outcomeDescription: webinar.outcomeDescription,
    visibility: webinar.visibility,
    freshnessStatus: webinar.freshnessStatus,
    audienceLevel: webinar.audienceLevel,
    targetAudience: webinar.targetAudience,
    format: webinar.format,
    durationMinutes: webinar.durationMinutes,
    language: webinar.language,
    currentAsOf: webinar.currentAsOf?.toISOString().slice(0, 10) ?? null,
    author: webinar.authorProfile
      ? { slug: webinar.authorProfile.slug, publicName: webinar.authorProfile.publicName }
      : null,
    organization: webinar.organization,
    jurisdiction: webinar.jurisdiction,
    practiceArea: primary ? { slug: primary.slug, name: primary.name } : null,
    specialization: specialization ? { slug: specialization.slug, name: specialization.name } : null,
    nextSession: next
      ? {
          scheduledAt: next.scheduledAt,
          timezone: next.timezone,
          lifecycleStatus: next.lifecycleStatus,
          durationMinutes: next.durationMinutes,
        }
      : null,
    publishedAt: webinar.publishedAt,
    updatedAt: webinar.updatedAt,
  };
}

export async function listCatalogWebinars(db: PrismaClient, queryInput: unknown) {
  const input = catalogListSchema.parse(queryInput);
  const conditions = listConditions(input);
  const where = Prisma.join(conditions, ' AND ');
  const offset = (input.page - 1) * input.pageSize;
  const [idRows, countRows] = await Promise.all([
    db.$queryRaw<CatalogIdRow[]>(Prisma.sql`
      SELECT w."id", next_session."scheduled_at" AS "next_session_at"
      FROM "webinars" w
      JOIN "organizations" o ON o."id" = w."organization_id"
      JOIN "author_profiles" ap ON ap."id" = w."author_profile_id" AND ap."organization_id" = w."organization_id"
      JOIN "users" u ON u."id" = ap."user_id"
      JOIN "organization_memberships" m ON m."organization_id" = w."organization_id" AND m."user_id" = ap."user_id"
      LEFT JOIN "jurisdictions" j ON j."id" = w."jurisdiction_id"
      LEFT JOIN LATERAL (
        SELECT ws."scheduled_at"
        FROM "webinar_sessions" ws
        WHERE ws."webinar_id" = w."id"
          AND ws."organization_id" = w."organization_id"
          AND ws."cancelled_at" IS NULL
          AND ws."lifecycle_status" <> 'cancelled'::"webinar_session_lifecycle_status"
          AND ws."scheduled_at" >= CURRENT_TIMESTAMP
        ORDER BY ws."scheduled_at" ASC
        LIMIT 1
      ) next_session ON TRUE
      WHERE ${where}
      ORDER BY ${listOrder(input)}
      LIMIT ${input.pageSize} OFFSET ${offset}
    `),
    db.$queryRaw<CatalogCountRow[]>(Prisma.sql`
      SELECT COUNT(DISTINCT w."id")::bigint AS "count"
      FROM "webinars" w
      JOIN "organizations" o ON o."id" = w."organization_id"
      JOIN "author_profiles" ap ON ap."id" = w."author_profile_id" AND ap."organization_id" = w."organization_id"
      JOIN "users" u ON u."id" = ap."user_id"
      JOIN "organization_memberships" m ON m."organization_id" = w."organization_id" AND m."user_id" = ap."user_id"
      LEFT JOIN "jurisdictions" j ON j."id" = w."jurisdiction_id"
      WHERE ${where}
    `),
  ]);
  const ids = idRows.map(row => row.id);
  const webinars = ids.length
    ? await db.webinar.findMany({
        where: { id: { in: ids } },
        include: {
          ...catalogInclude,
          sessions: {
            ...catalogInclude.sessions,
            where: {
              lifecycleStatus: { not: 'CANCELLED' },
              cancelledAt: null,
              scheduledAt: { gte: new Date() },
            },
          },
        },
      })
    : [];
  const byId = new Map(webinars.map(webinar => [webinar.id, webinar]));
  const transcriptMatches = new Map<string, CatalogTranscriptMatchRow>();
  if (input.q && ids.length) {
    const pattern = `%${escapeLike(input.q)}%`;
    const matches = await db.$queryRaw<CatalogTranscriptMatchRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transcript."webinar_id")
        transcript."webinar_id",
        segment."start_ms",
        segment."end_ms",
        substring(segment."text" from 1 for 240) AS "snippet"
      FROM "transcripts" transcript
      JOIN "transcript_segments" segment ON segment."transcript_id" = transcript."id"
        AND segment."organization_id" = transcript."organization_id"
      WHERE transcript."webinar_id" IN (${Prisma.join(ids)})
        AND transcript."status" = 'published'::"webinar_transcript_status"
        AND (
          segment."search_vector" @@ websearch_to_tsquery('russian', ${input.q})
          OR segment."text" ILIKE ${pattern} ESCAPE '\\'
        )
      ORDER BY transcript."webinar_id",
        ts_rank_cd(segment."search_vector", websearch_to_tsquery('russian', ${input.q})) DESC,
        segment."start_ms" ASC
    `);
    for (const match of matches) transcriptMatches.set(match.webinar_id, match);
  }
  const items = ids.flatMap(id => {
    const webinar = byId.get(id);
    if (!webinar) return [];
    const match = transcriptMatches.get(id);
    return [
      {
        ...publicBaseProjection(webinar),
        ...(match ? { transcriptMatch: { startMs: match.start_ms, endMs: match.end_ms, snippet: match.snippet } } : {}),
      },
    ];
  });
  const total = Number(countRows[0]?.count ?? 0n);
  return {
    items,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    },
    applied: input,
  };
}

function publicAuthorMembershipWhere(webinar: CatalogWebinar) {
  return webinar.authorProfile
    ? {
        organizationId: webinar.organizationId,
        userId: webinar.authorProfile.userId,
        status: 'ACTIVE' as const,
        role: { in: ['OWNER', 'AUTHOR'] as Array<'OWNER' | 'AUTHOR'> },
      }
    : null;
}

export async function getCatalogWebinar(db: PrismaClient, paramsInput: unknown, queryInput: unknown) {
  const params = catalogDetailParamsSchema.parse(paramsInput);
  const query = catalogDetailQuerySchema.parse(queryInput);
  const webinar = await db.webinar.findFirst({
    where: {
      organization: { slug: query.organization, status: 'ACTIVE' },
      contentStatus: 'PUBLISHED',
      archivedAt: null,
      visibility: { in: ['PUBLIC', 'UNLISTED'] },
      authorProfile: {
        verificationStatus: 'VERIFIED',
        user: { kind: 'HUMAN', status: 'ACTIVE' },
      },
      OR: [{ slug: params.slug }, { slugAliases: { some: { slug: params.slug } } }],
    },
    include: catalogInclude,
  });
  if (!webinar) catalogUnavailable();
  const membership = publicAuthorMembershipWhere(webinar);
  if (!membership || !(await db.organizationMembership.findFirst({ where: membership, select: { id: true } }))) {
    catalogUnavailable();
  }
  const successor = webinar.supersededBy;
  let supersededBy: { title: string; canonicalPath: string } | null = null;
  if (
    webinar.freshnessStatus === 'SUPERSEDED' &&
    successor?.contentStatus === 'PUBLISHED' &&
    !successor.archivedAt &&
    ['PUBLIC', 'UNLISTED'].includes(successor.visibility) &&
    successor.authorProfile?.verificationStatus === 'VERIFIED'
  ) {
    const successorMembership = await db.organizationMembership.findFirst({
      where: {
        organizationId: successor.organizationId,
        userId: successor.authorProfile.userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'AUTHOR'] },
      },
      select: { id: true },
    });
    if (successorMembership) {
      supersededBy = { title: successor.title, canonicalPath: publicPath(successor) };
    }
  }
  return {
    webinar: {
      ...publicBaseProjection(webinar),
      canonicalSlug: webinar.slug,
      requestedSlug: params.slug,
      wasAlias: webinar.slug !== params.slug,
      disclaimer: webinar.disclaimer,
      syntheticDisclosure: webinar.syntheticDisclosure,
      sources: webinar.sources.map(source => ({
        type: source.type,
        title: source.title,
        url: source.url,
        accessedAt: source.accessedAt?.toISOString().slice(0, 10) ?? null,
        note: source.note,
      })),
      sessions: webinar.sessions.map(session => ({
        scheduledAt: session.scheduledAt,
        timezone: session.timezone,
        lifecycleStatus: session.lifecycleStatus,
        durationMinutes: session.durationMinutes,
        replayEnabled: session.replayEnabled,
      })),
      author: webinar.authorProfile
        ? {
            slug: webinar.authorProfile.slug,
            publicName: webinar.authorProfile.publicName,
            bio: webinar.authorProfile.bio,
            specializations: webinar.authorProfile.specializations,
            professionalOrganization: webinar.authorProfile.professionalOrganization,
            region: webinar.authorProfile.region,
            experience: webinar.authorProfile.experience,
          }
        : null,
      supersededBy,
    },
  };
}

export async function getCatalogReferenceData(db: PrismaClient) {
  const [practiceAreas, jurisdictions] = await Promise.all([
    db.legalPracticeArea.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
      select: { slug: true, name: true, parent: { select: { slug: true } } },
    }),
    db.jurisdiction.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }],
      select: { code: true, name: true, parentId: true },
    }),
  ]);
  return {
    practiceAreas: practiceAreas.map(area => ({
      slug: area.slug,
      name: area.name,
      parentSlug: area.parent?.slug ?? null,
    })),
    jurisdictions,
  };
}

export async function listCatalogSitemapEntries(db: PrismaClient) {
  return db.$queryRaw<CatalogSitemapRow[]>(Prisma.sql`
    SELECT
      o."slug" AS "organization_slug",
      w."slug" AS "webinar_slug",
      w."updated_at" AS "updated_at"
    FROM "webinars" w
    JOIN "organizations" o ON o."id" = w."organization_id"
    JOIN "author_profiles" ap ON ap."id" = w."author_profile_id" AND ap."organization_id" = w."organization_id"
    JOIN "users" u ON u."id" = ap."user_id"
    JOIN "organization_memberships" m ON m."organization_id" = w."organization_id" AND m."user_id" = ap."user_id"
    WHERE ${Prisma.join(
      [...baseCatalogConditions(), Prisma.sql`w."visibility" = 'public'::"webinar_visibility"`],
      ' AND ',
    )}
    ORDER BY w."updated_at" DESC, w."id" DESC
    LIMIT 50000
  `);
}
