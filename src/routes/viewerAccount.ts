import { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { MARKETING_EMAIL_CONSENT, MARKETING_TELEGRAM_CONSENT, consentEvidenceData } from '../lib/consentDocuments.js';
import { AppError, asyncHandler } from '../lib/http.js';
import {
  acquireEmailDeliveryLock,
  acquireTelegramDeliveryLock,
  isParticipantRegistrationActive,
} from '../lib/leadSecurity.js';
import { prisma } from '../lib/prisma.js';
import { getRequestContext } from '../lib/requestContext.js';
import { createAccessToken, hashToken } from '../lib/tokens.js';
import { recordCrmScoreSignalForRegistration } from '../lib/tenancy/crm.js';
import {
  ROOM_SESSION_TOKEN_PURPOSE,
  buildFrontendUrl,
  findRegistrationForRequest,
  getParticipantSessionExpiresAt,
  setRoomTokenCookie,
} from './public/helpers.js';

export const viewerAccountRouter = Router();

const entityIdSchema = z.string().trim().min(8).max(64);
const sessionParamsSchema = z.object({ sessionId: entityIdSchema }).strict();
const webinarParamsSchema = z.object({ webinarId: entityIdSchema }).strict();
const registrationParamsSchema = z.object({ registrationId: entityIdSchema }).strict();
const noteParamsSchema = z.object({ noteId: entityIdSchema }).strict();
const notesQuerySchema = z.object({ sessionId: entityIdSchema }).strict();
const progressSchema = z
  .object({
    positionSeconds: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60),
    durationSeconds: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60),
    eventId: z
      .string()
      .trim()
      .min(16)
      .max(100)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
const noteSchema = z
  .object({
    sessionId: entityIdSchema,
    timestampSeconds: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
const notificationSchema = z
  .object({
    marketingEmailEnabled: z.boolean().optional(),
    marketingTelegramEnabled: z.boolean().optional(),
    serviceEmailEnabled: z.boolean().optional(),
    serviceTelegramEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'At least one preference is required');

function safeNotFound(): never {
  throw new AppError(404, 'Объект кабинета не найден', undefined, 'viewer_object_not_found');
}

async function requireViewerContext(req: Request) {
  const registration = await findRegistrationForRequest(req);
  if (!registration?.userId || !registration.organizationId || !registration.webinarId) {
    safeNotFound();
  }
  return {
    registration,
    userId: registration.userId,
    organizationId: registration.organizationId,
    webinarId: registration.webinarId,
  };
}

function accessProjection(
  registration: {
    status: string;
    emailVerifiedAt: Date | null;
    lead: { email: string; personalDataConsentRevokedAt: Date | null };
    webinarSession: {
      scheduledAt: Date;
      durationMinutes: number;
      replayAvailableHours: number;
      replayEnabled: boolean;
      lifecycleStatus: string;
      timezone: string;
    };
    webinar: {
      legacyCompatibility: boolean;
      currentMediaAsset: { status: string } | null;
    } | null;
  },
  now: Date,
) {
  if (!isParticipantRegistrationActive(registration)) return { state: 'revoked' as const, expiresAt: null };
  if (registration.webinarSession.lifecycleStatus === 'CANCELLED') {
    return { state: 'unavailable' as const, expiresAt: null };
  }
  const startsAt = registration.webinarSession.scheduledAt;
  const endsAt = new Date(startsAt.getTime() + registration.webinarSession.durationMinutes * 60 * 1000);
  const expiresAt = new Date(endsAt.getTime() + registration.webinarSession.replayAvailableHours * 60 * 60 * 1000);
  if (startsAt > now) return { state: 'upcoming' as const, expiresAt };
  if (endsAt > now) return { state: 'available' as const, expiresAt };
  const mediaReady =
    registration.webinar?.legacyCompatibility || registration.webinar?.currentMediaAsset?.status === 'READY';
  if (registration.webinarSession.replayEnabled && expiresAt > now && mediaReady) {
    return { state: 'available' as const, expiresAt };
  }
  return { state: 'expired' as const, expiresAt };
}

async function findOwnedSession(context: Awaited<ReturnType<typeof requireViewerContext>>, sessionId: string) {
  const registration = await prisma.registration.findFirst({
    where: {
      userId: context.userId,
      organizationId: context.organizationId,
      webinarSessionId: sessionId,
    },
    include: { lead: true, webinarSession: true, webinar: true },
  });
  if (!registration || !registration.webinarId || !isParticipantRegistrationActive(registration)) safeNotFound();
  return registration;
}

function accountCorrelationId() {
  return getRequestContext()?.correlationId;
}

viewerAccountRouter.get(
  '/viewer/dashboard',
  asyncHandler(async (req, res) => {
    const context = await requireViewerContext(req);
    const now = new Date();
    const [organization, registrations, favorites, notesCount] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: context.organizationId },
        select: { id: true, name: true, slug: true },
      }),
      prisma.registration.findMany({
        where: { userId: context.userId, organizationId: context.organizationId },
        include: {
          lead: true,
          webinarSession: true,
          webinar: { include: { currentMediaAsset: { select: { status: true } } } },
        },
        orderBy: { webinarSession: { scheduledAt: 'desc' } },
      }),
      prisma.viewerWebinarFavorite.findMany({
        where: { userId: context.userId, organizationId: context.organizationId },
        include: { webinar: { select: { id: true, title: true, visibility: true, contentStatus: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.viewerWebinarNote.groupBy({
        by: ['webinarSessionId'],
        where: { userId: context.userId, organizationId: context.organizationId },
        _count: { _all: true },
      }),
    ]);
    const sessionIds = registrations.map(item => item.webinarSessionId);
    const progressRows = sessionIds.length
      ? await prisma.viewerWebinarProgress.findMany({
          where: {
            userId: context.userId,
            organizationId: context.organizationId,
            webinarSessionId: { in: sessionIds },
          },
        })
      : [];
    const progressBySession = new Map(progressRows.map(row => [row.webinarSessionId, row]));
    const noteCountBySession = new Map(notesCount.map(row => [row.webinarSessionId, row._count._all]));

    const items = registrations.flatMap(registration => {
      if (!registration.webinar || !registration.webinarId) return [];
      const access = accessProjection(registration, now);
      const progress = progressBySession.get(registration.webinarSessionId);
      const durationMs = progress?.durationMs ?? registration.webinarSession.durationMinutes * 60 * 1000;
      const progressPercent = durationMs
        ? Math.min(100, Math.round(((progress?.positionMs ?? 0) / durationMs) * 100))
        : 0;
      return [
        {
          registrationId: registration.id,
          webinarId: registration.webinarId,
          webinarSessionId: registration.webinarSessionId,
          title: registration.webinar.title,
          scheduledAt: registration.webinarSession.scheduledAt.toISOString(),
          timezone: registration.webinarSession.timezone,
          accessState: access.state,
          accessExpiresAt: access.expiresAt?.toISOString() ?? null,
          progress: {
            positionSeconds: Math.round((progress?.positionMs ?? 0) / 1000),
            durationSeconds: Math.round(durationMs / 1000),
            percent: progressPercent,
            completed: Boolean(progress?.completedAt),
            updatedAt: progress?.updatedAt.toISOString() ?? null,
          },
          noteCount: noteCountBySession.get(registration.webinarSessionId) ?? 0,
          isCurrent: registration.id === context.registration.id,
        },
      ];
    });

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      organization: organization ?? { id: context.organizationId, name: 'Организация', slug: null },
      sections: {
        upcoming: items.filter(item => item.accessState === 'upcoming'),
        recordings: items.filter(item => item.accessState === 'available' && new Date(item.scheduledAt) <= now),
        watched: items.filter(item => item.progress.positionSeconds > 0),
        saved: favorites.map(favorite => ({
          webinarId: favorite.webinarId,
          title: favorite.webinar.title,
          savedAt: favorite.createdAt.toISOString(),
          accessGranted: items.some(
            item =>
              item.webinarId === favorite.webinarId &&
              (item.accessState === 'upcoming' || item.accessState === 'available'),
          ),
        })),
        unavailable: items.filter(item => ['expired', 'revoked', 'unavailable'].includes(item.accessState)),
      },
      all: items,
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.post(
  '/viewer/registrations/:registrationId/activate',
  asyncHandler(async (req, res) => {
    const { registrationId } = registrationParamsSchema.parse(req.params);
    const context = await requireViewerContext(req);
    const registration = await prisma.registration.findFirst({
      where: { id: registrationId, userId: context.userId, organizationId: context.organizationId },
      include: {
        lead: true,
        webinarSession: true,
        webinar: { include: { currentMediaAsset: { select: { status: true } } } },
      },
    });
    if (!registration || !isParticipantRegistrationActive(registration)) safeNotFound();
    const access = accessProjection(registration, new Date());
    if (access.state === 'expired' || access.state === 'revoked' || access.state === 'unavailable') safeNotFound();

    const token = createAccessToken();
    const expiresAt = getParticipantSessionExpiresAt();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(token),
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt,
      },
    });
    setRoomTokenCookie(res, token, expiresAt);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      roomUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.put(
  '/viewer/favorites/:webinarId',
  asyncHandler(async (req, res) => {
    const { webinarId } = webinarParamsSchema.parse(req.params);
    const context = await requireViewerContext(req);
    const webinar = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        organizationId: context.organizationId,
        contentStatus: 'PUBLISHED',
        archivedAt: null,
        OR: [
          { visibility: { in: ['PUBLIC', 'UNLISTED'] } },
          {
            registrations: {
              some: {
                userId: context.userId,
                organizationId: context.organizationId,
                status: 'registered',
                emailVerifiedAt: { not: null },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (!webinar) safeNotFound();
    const favorite = await prisma.viewerWebinarFavorite.upsert({
      where: {
        userId_organizationId_webinarId: {
          userId: context.userId,
          organizationId: context.organizationId,
          webinarId,
        },
      },
      update: {},
      create: { userId: context.userId, organizationId: context.organizationId, webinarId },
    });
    res
      .status(200)
      .json({ ok: true, savedAt: favorite.createdAt.toISOString(), correlationId: accountCorrelationId() });
  }),
);

viewerAccountRouter.delete(
  '/viewer/favorites/:webinarId',
  asyncHandler(async (req, res) => {
    const { webinarId } = webinarParamsSchema.parse(req.params);
    const context = await requireViewerContext(req);
    const webinar = await prisma.webinar.findFirst({
      where: { id: webinarId, organizationId: context.organizationId },
      select: { id: true },
    });
    if (!webinar) safeNotFound();
    await prisma.viewerWebinarFavorite.deleteMany({
      where: { userId: context.userId, organizationId: context.organizationId, webinarId },
    });
    res.json({ ok: true, correlationId: accountCorrelationId() });
  }),
);

viewerAccountRouter.get(
  '/viewer/progress/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = sessionParamsSchema.parse(req.params);
    const context = await requireViewerContext(req);
    await findOwnedSession(context, sessionId);
    const progress = await prisma.viewerWebinarProgress.findUnique({
      where: {
        userId_organizationId_webinarSessionId: {
          userId: context.userId,
          organizationId: context.organizationId,
          webinarSessionId: sessionId,
        },
      },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      progress: progress
        ? {
            positionSeconds: Math.round(progress.positionMs / 1000),
            durationSeconds: progress.durationMs ? Math.round(progress.durationMs / 1000) : null,
            completed: Boolean(progress.completedAt),
            updatedAt: progress.updatedAt.toISOString(),
          }
        : null,
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.put(
  '/viewer/progress/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = sessionParamsSchema.parse(req.params);
    const input = progressSchema.parse(req.body);
    const context = await requireViewerContext(req);
    const registration = await findOwnedSession(context, sessionId);
    const positionMs = Math.min(Math.round(input.positionSeconds * 1000), Math.round(input.durationSeconds * 1000));
    const durationMs = Math.round(input.durationSeconds * 1000);
    const now = new Date();
    const complete = positionMs / durationMs >= 0.9 || durationMs - positionMs <= 30_000;

    const result = await prisma.$transaction(async tx => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(48192736, hashtext(${`${context.userId}:${sessionId}`}))`,
      );
      const existing = await tx.viewerWebinarProgress.findUnique({
        where: {
          userId_organizationId_webinarSessionId: {
            userId: context.userId,
            organizationId: context.organizationId,
            webinarSessionId: sessionId,
          },
        },
      });
      if (existing?.lastDedupKey === input.eventId) {
        return { progress: existing, accepted: true, duplicate: true, retryAfterMs: 0 };
      }
      const elapsedMs = existing ? now.getTime() - existing.updatedAt.getTime() : Number.POSITIVE_INFINITY;
      const materialAdvance = existing ? Math.abs(positionMs - existing.positionMs) >= 30_000 : true;
      if (existing && elapsedMs < 10_000 && !materialAdvance && !complete) {
        return {
          progress: existing,
          accepted: false,
          duplicate: false,
          retryAfterMs: Math.max(1, 10_000 - elapsedMs),
        };
      }
      const progress = await tx.viewerWebinarProgress.upsert({
        where: {
          userId_organizationId_webinarSessionId: {
            userId: context.userId,
            organizationId: context.organizationId,
            webinarSessionId: sessionId,
          },
        },
        update: {
          positionMs,
          durationMs,
          lastDedupKey: input.eventId,
          lastObservedAt: now,
          completedAt: complete ? (existing?.completedAt ?? now) : existing?.completedAt,
        },
        create: {
          organizationId: context.organizationId,
          webinarId: registration.webinarId!,
          webinarSessionId: sessionId,
          userId: context.userId,
          positionMs,
          durationMs,
          lastDedupKey: input.eventId,
          lastObservedAt: now,
          completedAt: complete ? now : null,
        },
      });
      if (positionMs * 2 >= durationMs) {
        await recordCrmScoreSignalForRegistration(
          tx,
          registration.id,
          'viewed_50_percent',
          'viewer_progress',
          progress.id,
          now,
        );
      }
      return { progress, accepted: true, duplicate: false, retryAfterMs: 0 };
    });
    res.status(result.accepted ? 200 : 202).json({
      ok: true,
      writeAccepted: result.accepted,
      duplicate: result.duplicate,
      retryAfterMs: result.retryAfterMs,
      progress: {
        positionSeconds: Math.round(result.progress.positionMs / 1000),
        completed: Boolean(result.progress.completedAt),
        updatedAt: result.progress.updatedAt.toISOString(),
      },
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.get(
  '/viewer/notes',
  asyncHandler(async (req, res) => {
    const { sessionId } = notesQuerySchema.parse(req.query);
    const context = await requireViewerContext(req);
    await findOwnedSession(context, sessionId);
    const notes = await prisma.viewerWebinarNote.findMany({
      where: {
        userId: context.userId,
        organizationId: context.organizationId,
        webinarSessionId: sessionId,
      },
      orderBy: [{ timestampMs: 'asc' }, { createdAt: 'asc' }],
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      notes: notes.map(note => ({
        id: note.id,
        timestampSeconds: Math.round(note.timestampMs / 1000),
        body: note.body,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
      })),
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.post(
  '/viewer/notes',
  asyncHandler(async (req, res) => {
    const input = noteSchema.parse(req.body);
    const context = await requireViewerContext(req);
    const registration = await findOwnedSession(context, input.sessionId);
    const note = await prisma.viewerWebinarNote.create({
      data: {
        organizationId: context.organizationId,
        webinarId: registration.webinarId!,
        webinarSessionId: input.sessionId,
        userId: context.userId,
        timestampMs: Math.round(input.timestampSeconds * 1000),
        body: input.body,
      },
    });
    res.status(201).json({
      ok: true,
      note: {
        id: note.id,
        timestampSeconds: Math.round(note.timestampMs / 1000),
        body: note.body,
        createdAt: note.createdAt.toISOString(),
      },
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.delete(
  '/viewer/notes/:noteId',
  asyncHandler(async (req, res) => {
    const { noteId } = noteParamsSchema.parse(req.params);
    const context = await requireViewerContext(req);
    const deleted = await prisma.viewerWebinarNote.deleteMany({
      where: { id: noteId, userId: context.userId, organizationId: context.organizationId },
    });
    if (deleted.count !== 1) safeNotFound();
    res.json({ ok: true, correlationId: accountCorrelationId() });
  }),
);

async function getNotificationPreferences(context: Awaited<ReturnType<typeof requireViewerContext>>) {
  const stored = await prisma.viewerNotificationPreference.findUnique({
    where: {
      userId_organizationId: { userId: context.userId, organizationId: context.organizationId },
    },
  });
  if (stored) return stored;
  return {
    marketingEmailEnabled: context.registration.lead.marketingEmailConsent,
    marketingTelegramEnabled: context.registration.lead.marketingTelegramConsent,
    serviceEmailEnabled: true,
    serviceTelegramEnabled: true,
  };
}

viewerAccountRouter.get(
  '/viewer/notifications',
  asyncHandler(async (req, res) => {
    const context = await requireViewerContext(req);
    const preferences = await getNotificationPreferences(context);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      preferences: {
        marketingEmailEnabled: preferences.marketingEmailEnabled,
        marketingTelegramEnabled: preferences.marketingTelegramEnabled,
        serviceEmailEnabled: preferences.serviceEmailEnabled,
        serviceTelegramEnabled: preferences.serviceTelegramEnabled,
      },
      serviceNotice:
        'Сервисные сообщения о доступе и безопасности имеют отдельное назначение и не зависят от маркетинга.',
      correlationId: accountCorrelationId(),
    });
  }),
);

viewerAccountRouter.patch(
  '/viewer/notifications',
  asyncHandler(async (req, res) => {
    const input = notificationSchema.parse(req.body);
    const context = await requireViewerContext(req);
    const now = new Date();
    const preferences = await prisma.$transaction(async tx => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(48192737, hashtext(${`${context.userId}:${context.organizationId}`}))`,
      );
      if (input.marketingEmailEnabled !== undefined) {
        await acquireEmailDeliveryLock(tx, context.registration.leadId);
      }
      if (input.marketingTelegramEnabled !== undefined) {
        await acquireTelegramDeliveryLock(tx, context.registration.leadId);
      }
      const stored = await tx.viewerNotificationPreference.findUnique({
        where: {
          userId_organizationId: { userId: context.userId, organizationId: context.organizationId },
        },
      });
      const previous = stored ?? {
        marketingEmailEnabled: context.registration.lead.marketingEmailConsent,
        marketingTelegramEnabled: context.registration.lead.marketingTelegramConsent,
        serviceEmailEnabled: true,
        serviceTelegramEnabled: true,
      };
      const next = {
        marketingEmailEnabled: input.marketingEmailEnabled ?? previous.marketingEmailEnabled,
        marketingTelegramEnabled: input.marketingTelegramEnabled ?? previous.marketingTelegramEnabled,
        serviceEmailEnabled: input.serviceEmailEnabled ?? previous.serviceEmailEnabled,
        serviceTelegramEnabled: input.serviceTelegramEnabled ?? previous.serviceTelegramEnabled,
      };
      const marketingEmailChanged = next.marketingEmailEnabled !== previous.marketingEmailEnabled;
      const marketingTelegramChanged = next.marketingTelegramEnabled !== previous.marketingTelegramEnabled;
      const updated = await tx.viewerNotificationPreference.upsert({
        where: {
          userId_organizationId: { userId: context.userId, organizationId: context.organizationId },
        },
        update: next,
        create: {
          userId: context.userId,
          organizationId: context.organizationId,
          ...next,
        },
      });
      const marketingChanges = [
        {
          kind: 'marketing_email',
          document: MARKETING_EMAIL_CONSENT,
          changed: marketingEmailChanged,
          enabled: next.marketingEmailEnabled,
        },
        {
          kind: 'marketing_telegram',
          document: MARKETING_TELEGRAM_CONSENT,
          changed: marketingTelegramChanged,
          enabled: next.marketingTelegramEnabled,
        },
      ] as const;
      for (const change of marketingChanges) {
        if (!change.changed) continue;
        const latestGrant = !change.enabled
          ? await tx.consentRecord.findFirst({
              where: {
                leadId: context.registration.leadId,
                kind: change.kind,
                action: 'grant',
                documentId: change.document.id,
              },
              orderBy: { occurredAt: 'desc' },
              select: { id: true },
            })
          : null;
        await tx.consentRecord.create({
          data: {
            ...consentEvidenceData(change.document, {
              leadId: context.registration.leadId,
              registrationId: context.registration.id,
              email: context.registration.lead.email,
              kind: change.kind,
              sourceForm: '/crisis_premium/account.html',
              req,
              occurredAt: now,
            }),
            action: change.enabled ? 'grant' : 'revoke',
            revokedConsentId: change.enabled ? null : (latestGrant?.id ?? null),
            revocationChannel: change.enabled ? null : 'viewer_account',
            revocationReason: change.enabled ? null : 'user_preference',
          },
        });
      }
      if (marketingEmailChanged || marketingTelegramChanged) {
        const previousMarketingEnabled = previous.marketingEmailEnabled || previous.marketingTelegramEnabled;
        const nextMarketingEnabled = next.marketingEmailEnabled || next.marketingTelegramEnabled;
        await tx.lead.update({
          where: { id: context.registration.leadId },
          data: {
            ...(marketingEmailChanged
              ? {
                  marketingEmailConsent: next.marketingEmailEnabled,
                  marketingEmailConsentAt: next.marketingEmailEnabled ? now : null,
                  marketingEmailRevokedAt: next.marketingEmailEnabled ? null : now,
                  marketingEmailRevocationChannel: next.marketingEmailEnabled ? null : 'viewer_account',
                  marketingEmailRevocationReason: next.marketingEmailEnabled ? null : 'user_preference',
                }
              : {}),
            ...(marketingTelegramChanged
              ? {
                  marketingTelegramConsent: next.marketingTelegramEnabled,
                  marketingTelegramConsentAt: next.marketingTelegramEnabled ? now : null,
                  marketingTelegramRevokedAt: next.marketingTelegramEnabled ? null : now,
                  marketingTelegramRevocationChannel: next.marketingTelegramEnabled ? null : 'viewer_account',
                  marketingTelegramRevocationReason: next.marketingTelegramEnabled ? null : 'user_preference',
                }
              : {}),
            marketingConsent: nextMarketingEnabled,
            marketingConsentAt: nextMarketingEnabled ? (previousMarketingEnabled ? undefined : now) : null,
          },
        });
      }
      return updated;
    });
    res.json({
      ok: true,
      preferences: {
        marketingEmailEnabled: preferences.marketingEmailEnabled,
        marketingTelegramEnabled: preferences.marketingTelegramEnabled,
        serviceEmailEnabled: preferences.serviceEmailEnabled,
        serviceTelegramEnabled: preferences.serviceTelegramEnabled,
      },
      correlationId: accountCorrelationId(),
    });
  }),
);
