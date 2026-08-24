import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import type { TenantContext } from './context.js';

export const ANALYTICS_ACTIVE_WINDOW_SECONDS = 45;
export const ANALYTICS_REFRESH_DELAY_SECONDS = 10;
export const ANALYTICS_PRIVACY_THRESHOLD = 3;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Invalid UTC date');
const idSchema = z.string().trim().min(1).max(191);
const analyticsFilterSchema = z
  .object({
    webinarId: idSchema.optional(),
    sessionId: idSchema.optional(),
    source: z
      .enum(['web', 'room', 'replay', 'registration', 'crm', 'email', 'telegram', 'worker', 'system', 'admin'])
      .optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    organizationId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'to must not precede from' });
    }
  });

export type AnalyticsFilters = {
  webinarId?: string;
  sessionId?: string;
  source?: string;
  from: Date;
  toExclusive: Date;
  timezone: 'UTC';
  authorWebinarIds?: string[];
};

type CountRow = { count: number | bigint };
type OverviewRow = {
  uniqueEntries: number | bigint;
  liveViews: number | bigint;
  replayViews: number | bigint;
  completedViewers: number | bigint;
  viewingViewers: number | bigint;
};
type WatchRow = { totalSeconds: number | bigint | null; viewers: number | bigint };

function numberValue(value: number | bigint | null | undefined) {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

function zeroSafeRate(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

export const ANALYTICS_FORMULAS = Object.freeze({
  registrations:
    'COUNT trusted Registration rows with status=registered and verified email in the UTC period; denominator: none.',
  uniqueEntries:
    'COUNT DISTINCT stable identity (User, otherwise Registration, otherwise visitor ID) across v1 room/replay entry events.',
  liveViews: 'COUNT DISTINCT stable identity across v1 room events in the UTC period.',
  replayViews: 'COUNT DISTINCT stable identity across v1 replay events in the UTC period.',
  averageWatchSeconds:
    'SUM one visible+playing v1 heartbeat interval per identity/session/source/intervalNumber, capped at 30 seconds, divided by viewers with accepted intervals.',
  completionRate:
    'DISTINCT identities with a trusted live/replay finish event divided by DISTINCT identities with any accepted live/replay viewing event.',
  questions: 'COUNT trusted Question rows created in the UTC period.',
  ctaActions:
    'COUNT trusted PartnerApplication rows plus deduplicated v1 recording_cta_click events in the UTC period.',
});

function analyticsUnavailable(): never {
  throw new AppError(404, 'Analytics scope was not found', undefined, 'analytics_scope_not_found');
}

async function resolveFilters(db: PrismaClient, context: TenantContext, raw: unknown, now = new Date()) {
  if (!['OWNER', 'AUTHOR', 'ANALYST', 'AUDITOR'].includes(context.role)) {
    throw new AppError(403, 'Analytics permission is required', undefined, 'analytics_permission_denied');
  }
  const input = analyticsFilterSchema.parse(raw);
  // organizationId is an explicitly tolerated compatibility hint. It never
  // changes the server-derived tenant in context.
  const from = input.from
    ? new Date(`${input.from}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  const toExclusive = input.to
    ? new Date(new Date(`${input.to}T00:00:00.000Z`).getTime() + 86_400_000)
    : new Date(now.getTime() + 1);

  let authorWebinarIds: string[] | undefined;
  if (context.role === 'AUTHOR') {
    const owned = await db.webinar.findMany({
      where: { organizationId: context.organizationId, authorProfile: { userId: context.userId } },
      select: { id: true },
    });
    authorWebinarIds = owned.map(item => item.id);
  }

  if (input.webinarId) {
    const webinar = await db.webinar.findFirst({
      where: {
        id: input.webinarId,
        organizationId: context.organizationId,
        ...(context.role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
      },
      select: { id: true },
    });
    if (!webinar) analyticsUnavailable();
  }
  if (input.sessionId) {
    const session = await db.webinarSession.findFirst({
      where: {
        id: input.sessionId,
        organizationId: context.organizationId,
        ...(input.webinarId ? { webinarId: input.webinarId } : {}),
        ...(context.role === 'AUTHOR' ? { webinar: { authorProfile: { userId: context.userId } } } : {}),
      },
      select: { id: true },
    });
    if (!session) analyticsUnavailable();
  }
  return {
    webinarId: input.webinarId,
    sessionId: input.sessionId,
    source: input.source,
    from,
    toExclusive,
    timezone: 'UTC' as const,
    authorWebinarIds,
  } satisfies AnalyticsFilters;
}

function scopeSql(context: TenantContext, filters: AnalyticsFilters, alias: string) {
  const field = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const values: Prisma.Sql[] = [
    Prisma.sql`${field('organization_id')} = ${context.organizationId}`,
    Prisma.sql`${field('occurred_at')} >= ${filters.from}`,
    Prisma.sql`${field('occurred_at')} < ${filters.toExclusive}`,
  ];
  if (filters.webinarId) values.push(Prisma.sql`${field('webinar_id')} = ${filters.webinarId}`);
  if (filters.sessionId) values.push(Prisma.sql`${field('webinar_session_id')} = ${filters.sessionId}`);
  if (filters.source) values.push(Prisma.sql`${field('source')} = ${filters.source}`);
  if (filters.authorWebinarIds) {
    values.push(
      filters.authorWebinarIds.length
        ? Prisma.sql`${field('webinar_id')} IN (${Prisma.join(filters.authorWebinarIds)})`
        : Prisma.sql`FALSE`,
    );
  }
  return Prisma.join(values, ' AND ');
}

function businessScope(context: TenantContext, filters: AnalyticsFilters, alias: string, timeField: string) {
  const field = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const values: Prisma.Sql[] = [
    Prisma.sql`${field('organization_id')} = ${context.organizationId}`,
    Prisma.sql`${field(timeField)} >= ${filters.from}`,
    Prisma.sql`${field(timeField)} < ${filters.toExclusive}`,
  ];
  if (filters.webinarId) values.push(Prisma.sql`${field('webinar_id')} = ${filters.webinarId}`);
  if (filters.sessionId) values.push(Prisma.sql`${field('webinar_session_id')} = ${filters.sessionId}`);
  if (filters.authorWebinarIds) {
    values.push(
      filters.authorWebinarIds.length
        ? Prisma.sql`${field('webinar_id')} IN (${Prisma.join(filters.authorWebinarIds)})`
        : Prisma.sql`FALSE`,
    );
  }
  return Prisma.join(values, ' AND ');
}

export async function getTenantAnalyticsOverview(
  db: PrismaClient,
  context: TenantContext,
  rawFilters: unknown,
  now = new Date(),
) {
  const filters = await resolveFilters(db, context, rawFilters, now);
  const eventWhere = scopeSql(context, filters, 'e');
  const registrationWhere = businessScope(context, filters, 'r', 'registered_at');
  const questionWhere = businessScope(context, filters, 'q', 'created_at');
  const [overviewRows, watchRows, registrationRows, questionRows, applicationRows] = await Promise.all([
    db.$queryRaw<OverviewRow[]>(Prisma.sql`
      WITH accepted AS (
        SELECT e.*, COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id") AS identity
        FROM "events" e
        WHERE e."schema_version" = 1 AND ${eventWhere}
      )
      SELECT
        COUNT(DISTINCT identity) FILTER (WHERE "event_name" IN ('webinar_room_open', 'recording_open', 'recording_play'))::int AS "uniqueEntries",
        COUNT(DISTINCT identity) FILTER (WHERE "source" = 'room' AND "event_name" IN ('webinar_room_open', 'video_start', 'viewer_heartbeat', 'video_finish'))::int AS "liveViews",
        COUNT(DISTINCT identity) FILTER (WHERE "source" = 'replay' AND "event_name" IN ('recording_open', 'recording_play', 'viewer_heartbeat', 'recording_finish'))::int AS "replayViews",
        COUNT(DISTINCT identity) FILTER (WHERE "event_name" IN ('video_finish', 'recording_finish'))::int AS "completedViewers",
        COUNT(DISTINCT identity) FILTER (WHERE "event_name" IN ('webinar_room_open', 'video_start', 'viewer_heartbeat', 'recording_open', 'recording_play'))::int AS "viewingViewers"
      FROM accepted WHERE identity IS NOT NULL
    `),
    db.$queryRaw<WatchRow[]>(Prisma.sql`
      WITH heartbeat AS (
        SELECT DISTINCT ON (identity, e."webinar_session_id", e."source", e."metadata_json"->>'intervalNumber')
          identity,
          LEAST(COALESCE((e."metadata_json"->>'intervalSeconds')::numeric, 10), 30) AS seconds
        FROM "events" e
        CROSS JOIN LATERAL (SELECT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id") AS identity) actor
        WHERE e."schema_version" = 1 AND e."event_name" = 'viewer_heartbeat'
          AND e."metadata_json"->>'visibilityState' = 'visible'
          AND e."metadata_json"->>'playbackState' = 'playing'
          AND actor.identity IS NOT NULL AND ${eventWhere}
        ORDER BY identity, e."webinar_session_id", e."source", e."metadata_json"->>'intervalNumber', e."occurred_at" ASC
      )
      SELECT COALESCE(SUM(seconds), 0)::int AS "totalSeconds", COUNT(DISTINCT identity)::int AS viewers FROM heartbeat
    `),
    filters.source && filters.source !== 'registration'
      ? Promise.resolve([{ count: 0 }])
      : db.$queryRaw<CountRow[]>(Prisma.sql`
          SELECT COUNT(*)::int AS count FROM "registrations" r
          WHERE r."status" = 'registered' AND r."email_verified_at" IS NOT NULL AND ${registrationWhere}
        `),
    filters.source && filters.source !== 'room'
      ? Promise.resolve([{ count: 0 }])
      : db.$queryRaw<CountRow[]>(Prisma.sql`SELECT COUNT(*)::int AS count FROM "questions" q WHERE ${questionWhere}`),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM "partner_applications" p
      JOIN "registrations" r ON r."id" = p."registration_id"
      WHERE ${businessScope(context, filters, 'r', 'registered_at')}
        AND p."created_at" >= ${filters.from} AND p."created_at" < ${filters.toExclusive}
        AND (${filters.source ?? null}::text IS NULL OR ${filters.source ?? null} = 'room')
    `),
  ]);
  const overview = overviewRows[0];
  const watch = watchRows[0];
  const completedViewers = numberValue(overview?.completedViewers);
  const viewingViewers = numberValue(overview?.viewingViewers);
  const ctaEventRows = await db.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT COUNT(*)::int AS count FROM "events" e
    WHERE e."schema_version" = 1 AND e."event_name" = 'recording_cta_click' AND ${eventWhere}
  `);
  return {
    period: { from: filters.from.toISOString(), toExclusive: filters.toExclusive.toISOString(), timezone: 'UTC' },
    applied: {
      webinarId: filters.webinarId ?? null,
      sessionId: filters.sessionId ?? null,
      source: filters.source ?? null,
    },
    metrics: {
      registrations: numberValue(registrationRows[0]?.count),
      uniqueEntries: numberValue(overview?.uniqueEntries),
      liveViews: numberValue(overview?.liveViews),
      replayViews: numberValue(overview?.replayViews),
      averageWatchSeconds: numberValue(watch?.viewers)
        ? Math.round(numberValue(watch?.totalSeconds) / numberValue(watch?.viewers))
        : 0,
      completion: {
        numerator: completedViewers,
        denominator: viewingViewers,
        rate: zeroSafeRate(completedViewers, viewingViewers),
      },
      questions: numberValue(questionRows[0]?.count),
      ctaActions: numberValue(applicationRows[0]?.count) + numberValue(ctaEventRows[0]?.count),
    },
    formulas: ANALYTICS_FORMULAS,
    dataQuality: {
      schemaVersion: 1,
      legacyExcluded: true,
      backgroundHeartbeatsExcluded: true,
      deduplicatedRetriesExcluded: true,
    },
  };
}

export async function getTenantRetention(
  db: PrismaClient,
  context: TenantContext,
  rawFilters: unknown,
  playback: unknown,
  now = new Date(),
) {
  const mode = z.enum(['LIVE', 'REPLAY']).parse(playback);
  const filters = await resolveFilters(db, context, rawFilters, now);
  const requestedSource = mode === 'LIVE' ? 'room' : 'replay';
  if (filters.source && filters.source !== requestedSource) {
    throw new AppError(400, 'Playback and source filters conflict', undefined, 'analytics_filter_conflict');
  }
  filters.source = requestedSource;
  const rows = await db.$queryRaw<Array<{ bucket: number; viewers: number | bigint }>>(Prisma.sql`
    WITH accepted AS (
      SELECT DISTINCT
        COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id") AS identity,
        LEAST((e."metadata_json"->>'positionSeconds')::numeric, COALESCE(ws."video_duration_seconds", (e."metadata_json"->>'durationSeconds')::numeric)) AS position,
        COALESCE(ws."video_duration_seconds", (e."metadata_json"->>'durationSeconds')::numeric) AS duration
      FROM "events" e
      LEFT JOIN "webinar_sessions" ws ON ws."id" = e."webinar_session_id" AND ws."organization_id" = e."organization_id"
      WHERE e."schema_version" = 1 AND e."event_name" = 'viewer_heartbeat'
        AND e."metadata_json"->>'visibilityState' = 'visible'
        AND e."metadata_json"->>'playbackState' = 'playing'
        AND e."metadata_json" ? 'positionSeconds'
        AND COALESCE(ws."video_duration_seconds", (e."metadata_json"->>'durationSeconds')::numeric) > 0
        AND ${scopeSql(context, filters, 'e')}
    ), buckets AS (SELECT generate_series(0, 90, 10) AS bucket)
    SELECT buckets.bucket,
      COUNT(DISTINCT accepted.identity) FILTER (
        WHERE accepted.identity IS NOT NULL AND accepted.position >= accepted.duration * buckets.bucket / 100.0
      )::int AS viewers
    FROM buckets LEFT JOIN accepted ON TRUE
    GROUP BY buckets.bucket ORDER BY buckets.bucket
  `);
  return {
    period: { from: filters.from.toISOString(), toExclusive: filters.toExclusive.toISOString(), timezone: 'UTC' },
    playback: mode,
    intervalPercent: 10,
    privacyThreshold: ANALYTICS_PRIVACY_THRESHOLD,
    intervals: rows.map(row => {
      const viewers = numberValue(row.viewers);
      return {
        fromPercent: row.bucket,
        viewers: viewers >= ANALYTICS_PRIVACY_THRESHOLD ? viewers : null,
        suppressed: viewers > 0 && viewers < ANALYTICS_PRIVACY_THRESHOLD,
      };
    }),
  };
}

export async function getTenantLiveAnalytics(
  db: PrismaClient,
  context: TenantContext,
  rawFilters: unknown,
  now = new Date(),
) {
  const filters = await resolveFilters(db, context, rawFilters, now);
  filters.source = 'room';
  filters.from = new Date(now.getTime() - ANALYTICS_ACTIVE_WINDOW_SECONDS * 1000);
  filters.toExclusive = new Date(now.getTime() + 1);
  const rows = await db.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT COUNT(DISTINCT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id"))::int AS count
    FROM "events" e
    WHERE e."schema_version" = 1 AND e."event_name" = 'viewer_heartbeat'
      AND e."metadata_json"->>'visibilityState' = 'visible'
      AND e."metadata_json"->>'playbackState' = 'playing'
      AND ${scopeSql(context, filters, 'e')}
  `);
  return {
    activeViewers: numberValue(rows[0]?.count),
    activeWindowSeconds: ANALYTICS_ACTIVE_WINDOW_SECONDS,
    refreshDelaySeconds: ANALYTICS_REFRESH_DELAY_SECONDS,
    asOf: now.toISOString(),
    algorithm:
      'Distinct stable identities with a visible, playing room heartbeat accepted by the server during the previous 45 seconds.',
    syntheticViewersIncluded: false,
  };
}

export async function getTenantContentAnalytics(
  db: PrismaClient,
  context: TenantContext,
  rawFilters: unknown,
  now = new Date(),
) {
  const filters = await resolveFilters(db, context, rawFilters, now);
  const eventWhere = scopeSql(context, filters, 'e');
  const [chapters, searches] = await Promise.all([
    db.$queryRaw<Array<{ chapterId: string; title: string; count: number | bigint }>>(Prisma.sql`
      SELECT chapter."id" AS "chapterId", chapter."title",
        COUNT(DISTINCT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id"))::int AS count
      FROM "events" e
      JOIN "webinar_chapters" chapter
        ON chapter."id" = e."metadata_json"->>'chapterId'
       AND chapter."organization_id" = e."organization_id"
       AND chapter."webinar_id" = e."webinar_id"
      JOIN "transcripts" transcript
        ON transcript."id" = chapter."transcript_id"
       AND transcript."organization_id" = chapter."organization_id"
       AND transcript."status" = 'published'::"webinar_transcript_status"
      WHERE e."schema_version" = 1 AND e."event_name" = 'chapter_open' AND ${eventWhere}
      GROUP BY chapter."id", chapter."title"
      HAVING COUNT(DISTINCT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id")) >= ${ANALYTICS_PRIVACY_THRESHOLD}
      ORDER BY count DESC, chapter."id" ASC LIMIT 20
    `),
    db.$queryRaw<Array<{ query: string; count: number | bigint }>>(Prisma.sql`
      SELECT lower(btrim(e."metadata_json"->>'query')) AS query,
        COUNT(DISTINCT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id"))::int AS count
      FROM "events" e
      WHERE e."schema_version" = 1 AND e."event_name" = 'transcript_search' AND ${eventWhere}
        AND EXISTS (
          SELECT 1 FROM "transcripts" transcript
          WHERE transcript."organization_id" = e."organization_id"
            AND transcript."webinar_id" = e."webinar_id"
            AND transcript."status" = 'published'::"webinar_transcript_status"
        )
      GROUP BY lower(btrim(e."metadata_json"->>'query'))
      HAVING COUNT(DISTINCT COALESCE('user:' || e."user_id", 'registration:' || e."registration_id", 'visitor:' || e."visitor_id")) >= ${ANALYTICS_PRIVACY_THRESHOLD}
      ORDER BY count DESC, query ASC LIMIT 20
    `),
  ]);
  return {
    privacyThreshold: ANALYTICS_PRIVACY_THRESHOLD,
    publishedTranscriptsOnly: true,
    popularChapters: chapters.map(item => ({ ...item, count: numberValue(item.count) })),
    transcriptSearches: searches.map(item => ({ ...item, count: numberValue(item.count) })),
  };
}

const platformAggregateSchema = z
  .object({
    organizationId: idSchema.optional(),
    webinarId: idSchema.optional(),
    sessionId: idSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'to must not precede from' });
    }
  });

export async function getPlatformAnalyticsAggregates(db: PrismaClient, raw: unknown, now = new Date()) {
  const query = platformAggregateSchema.parse(raw);
  const from = query.from
    ? new Date(`${query.from}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  const toExclusive = query.to
    ? new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000)
    : new Date(now.getTime() + 1);
  if (
    query.organizationId &&
    !(await db.organization.findUnique({ where: { id: query.organizationId }, select: { id: true } }))
  ) {
    analyticsUnavailable();
  }
  if (query.webinarId) {
    const webinar = await db.webinar.findFirst({
      where: { id: query.webinarId, ...(query.organizationId ? { organizationId: query.organizationId } : {}) },
      select: { id: true, organizationId: true },
    });
    if (!webinar) analyticsUnavailable();
  }
  if (query.sessionId) {
    const session = await db.webinarSession.findFirst({
      where: {
        id: query.sessionId,
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.webinarId ? { webinarId: query.webinarId } : {}),
      },
      select: { id: true },
    });
    if (!session) analyticsUnavailable();
  }
  const rows = await db.$queryRaw<
    Array<{
      organizationId: string;
      organizationName: string;
      webinarId: string | null;
      sessionId: string | null;
      registrations: number | bigint;
      activeIdentities: number | bigint;
      questions: number | bigint;
      ctaActions: number | bigint;
    }>
  >(Prisma.sql`
    WITH scopes AS (
      SELECT organization."id" AS "organizationId", organization."name" AS "organizationName",
        webinar."id" AS "webinarId", session."id" AS "sessionId"
      FROM "organizations" organization
      LEFT JOIN "webinars" webinar ON webinar."organization_id" = organization."id"
      LEFT JOIN "webinar_sessions" session ON session."organization_id" = organization."id" AND session."webinar_id" = webinar."id"
      WHERE (${query.organizationId ?? null}::text IS NULL OR organization."id" = ${query.organizationId ?? null})
        AND (${query.webinarId ?? null}::text IS NULL OR webinar."id" = ${query.webinarId ?? null})
        AND (${query.sessionId ?? null}::text IS NULL OR session."id" = ${query.sessionId ?? null})
    )
    SELECT scope."organizationId", scope."organizationName", scope."webinarId", scope."sessionId",
      (SELECT COUNT(*)::int FROM "registrations" registration
        WHERE registration."organization_id" = scope."organizationId"
          AND registration."webinar_id" IS NOT DISTINCT FROM scope."webinarId"
          AND registration."webinar_session_id" IS NOT DISTINCT FROM scope."sessionId"
          AND registration."status" = 'registered' AND registration."email_verified_at" IS NOT NULL
          AND registration."registered_at" >= ${from} AND registration."registered_at" < ${toExclusive}) AS registrations,
      (SELECT COUNT(DISTINCT COALESCE('user:' || event."user_id", 'registration:' || event."registration_id", 'visitor:' || event."visitor_id"))::int
        FROM "events" event
        WHERE event."schema_version" = 1 AND event."organization_id" = scope."organizationId"
          AND event."webinar_id" IS NOT DISTINCT FROM scope."webinarId"
          AND event."webinar_session_id" IS NOT DISTINCT FROM scope."sessionId"
          AND event."occurred_at" >= ${from} AND event."occurred_at" < ${toExclusive}) AS "activeIdentities",
      (SELECT COUNT(*)::int FROM "questions" question
        WHERE question."organization_id" = scope."organizationId"
          AND question."webinar_id" IS NOT DISTINCT FROM scope."webinarId"
          AND question."webinar_session_id" IS NOT DISTINCT FROM scope."sessionId"
          AND question."created_at" >= ${from} AND question."created_at" < ${toExclusive}) AS questions,
      (SELECT COUNT(*)::int FROM "partner_applications" application
        JOIN "registrations" registration ON registration."id" = application."registration_id"
        WHERE registration."organization_id" = scope."organizationId"
          AND registration."webinar_id" IS NOT DISTINCT FROM scope."webinarId"
          AND registration."webinar_session_id" IS NOT DISTINCT FROM scope."sessionId"
          AND application."created_at" >= ${from} AND application."created_at" < ${toExclusive}) AS "ctaActions"
    FROM scopes scope
    ORDER BY scope."organizationId", scope."webinarId" NULLS FIRST, scope."sessionId" NULLS FIRST
    LIMIT 1000
  `);
  const suppress = (value: number | bigint) => {
    const numeric = numberValue(value);
    return numeric >= ANALYTICS_PRIVACY_THRESHOLD ? numeric : null;
  };
  return {
    period: { from: from.toISOString(), toExclusive: toExclusive.toISOString(), timezone: 'UTC' },
    privacyThreshold: ANALYTICS_PRIVACY_THRESHOLD,
    rows: rows.map(row => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      webinarId: row.webinarId,
      sessionId: row.sessionId,
      registrations: suppress(row.registrations),
      activeIdentities: suppress(row.activeIdentities),
      questions: suppress(row.questions),
      ctaActions: suppress(row.ctaActions),
      suppressed: [row.registrations, row.activeIdentities, row.questions, row.ctaActions].some(
        value => numberValue(value) > 0 && numberValue(value) < ANALYTICS_PRIVACY_THRESHOLD,
      ),
    })),
    excludedFields: ['chat', 'notes', 'email', 'phone', 'telegramIdentifiers'],
  };
}
