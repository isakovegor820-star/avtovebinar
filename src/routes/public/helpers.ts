/**
 * Shared helpers for public route sub-modules.
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { hashIp, hashToken } from '../../lib/tokens.js';
import { getClientIp } from '../../lib/http.js';
import { getCountdown, getDailyBroadcastDate, getWebinarAccess, parseFirstSeenCookie } from '../../lib/time.js';
import { getEffectiveVideoDurationMinutes } from '../../lib/webinarLive.js';
import { prisma } from '../../lib/prisma.js';
import { getRequestContext, setContextIdentity } from '../../lib/requestContext.js';
import {
  buildFrontendUrl,
  getParticipantSessionExpiresAt,
  getRoomTokenExpiresAt,
  PARTICIPANT_SESSION_TTL_DAYS,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_BINDING_VERSION,
  TELEGRAM_START_TOKEN_PURPOSE,
} from '../../lib/roomLinks.js';
import { logger } from '../../lib/logger.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { getVisitorId, hasAnalyticsConsent } from '../../lib/visitor.js';
import { acquireLeadSecurityLock, isParticipantRegistrationActive } from '../../lib/leadSecurity.js';
import { canAccessRegisteredWebinar } from '../../lib/tenancy/webinarAccess.js';
import {
  ANALYTICS_EVENT_REGISTRY,
  buildServerDedupKey,
  type AnalyticsEventName,
  type AnalyticsSource,
  recordAnalyticsEvent,
  safeAnalyticsFailureCode,
  validateAnalyticsAttributes,
} from '../../lib/analyticsEvents.js';

export {
  buildFrontendUrl,
  getParticipantSessionExpiresAt,
  getRoomTokenExpiresAt,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  PARTICIPANT_SESSION_TTL_DAYS,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_BINDING_VERSION,
  TELEGRAM_START_TOKEN_PURPOSE,
};

export function roomAccessError(accessStatus: string) {
  if (accessStatus === 'waiting' || accessStatus === 'pre_live') {
    return new AppError(423, 'Webinar has not started yet');
  }
  return new AppError(403, 'Replay access has expired');
}

export function clean(value: string | undefined | null) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function setFirstSeenCookie(res: Response, firstSeenAt: Date) {
  res.cookie('aspb_first_seen_at', firstSeenAt.toISOString(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

export function resolveFirstSeenAt(value: unknown, now = new Date()) {
  return parseFirstSeenCookie(value) ?? now;
}

export function getFirstSeen(req: Request, res: Response) {
  const firstSeenAt = resolveFirstSeenAt(req.cookies?.aspb_first_seen_at);
  setFirstSeenCookie(res, firstSeenAt);
  return firstSeenAt;
}

export function setRoomTokenCookie(res: Response, token: string, replayExpiresAt?: Date) {
  const sessionExpiresAt = replayExpiresAt ?? getParticipantSessionExpiresAt();
  const maxAge = Math.max(60 * 1000, sessionExpiresAt.getTime() - Date.now());
  res.cookie('aspb_room_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
}

export function clearRoomTokenCookie(res: Response) {
  res.clearCookie('aspb_room_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
  });
}

export async function findRegistrationByToken(token: string) {
  const accessTokenHash = hashToken(token);
  const tokenRecord = await prisma.registrationToken.findUnique({
    where: { tokenHash: accessTokenHash },
    include: {
      registration: {
        include: {
          lead: true,
          webinarSession: true,
        },
      },
    },
  });

  if (!tokenRecord) {
    return null;
  }

  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
    return null;
  }

  if (!isParticipantRegistrationActive(tokenRecord.registration)) {
    return null;
  }

  if (tokenRecord.registration.webinarSession.lifecycleStatus === 'CANCELLED') {
    return null;
  }

  if (!(await canAccessRegisteredWebinar(prisma, tokenRecord.registration))) {
    return null;
  }

  return tokenRecord.registration;
}

export async function findRegistrationBySessionToken(token: string) {
  const accessTokenHash = hashToken(token);
  const tokenRecord = await prisma.registrationToken.findUnique({
    where: { tokenHash: accessTokenHash },
    include: {
      registration: {
        include: {
          lead: true,
          webinarSession: true,
        },
      },
    },
  });

  if (!tokenRecord || tokenRecord.purpose !== ROOM_SESSION_TOKEN_PURPOSE) {
    return null;
  }

  if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
    return null;
  }

  if (!isParticipantRegistrationActive(tokenRecord.registration)) {
    return null;
  }

  if (tokenRecord.registration.webinarSession.lifecycleStatus === 'CANCELLED') {
    return null;
  }

  if (!(await canAccessRegisteredWebinar(prisma, tokenRecord.registration))) {
    return null;
  }

  return tokenRecord.registration;
}

export async function findRegistrationForRequest(req: Request) {
  const cookieToken = clean(req.cookies?.aspb_room_token);
  if (!cookieToken) {
    return null;
  }
  const registration = await findRegistrationBySessionToken(cookieToken);
  if (registration) {
    setContextIdentity({ userId: registration.userId ?? registration.leadId });
  }
  return registration;
}

export async function refreshRoomTokenSession(req: Request, res: Response, registrationId: string, now = new Date()) {
  const token = clean(req.cookies?.aspb_room_token);
  if (!token) return null;

  const expiresAt = getParticipantSessionExpiresAt(now);
  const refreshed = await prisma.registrationToken.updateMany({
    where: {
      registrationId,
      tokenHash: hashToken(token),
      purpose: ROOM_SESSION_TOKEN_PURPOSE,
      expiresAt: { gt: now },
    },
    data: { expiresAt },
  });

  if (refreshed.count !== 1) return null;
  setRoomTokenCookie(res, token, expiresAt);
  return expiresAt;
}

export function buildAccessPayload(
  registration: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>,
  now: Date,
  options: {
    webinarSession?: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>['webinarSession'];
  } = {},
) {
  const webinarSession = options.webinarSession ?? registration.webinarSession;
  const access = getWebinarAccess(
    now,
    webinarSession.scheduledAt,
    getEffectiveVideoDurationMinutes(webinarSession),
    webinarSession.replayAvailableHours,
    webinarSession.roomOpenBeforeMinutes,
    webinarSession.replayEnabled,
  );

  const previewLive =
    (env.NODE_ENV !== 'production' && env.WEBINAR_TEST_ROOM_MODE === 'on') || env.WEBINAR_PREVIEW_MODE === 'on';
  if (previewLive && access.accessStatus !== 'replay') {
    return {
      accessStatus: 'live' as const,
      webinarStatus: 'test',
      roomOpensAt: now,
      replayExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      canEnterRoom: true,
      canViewRoom: true,
      countdown: getCountdown(now, webinarSession.scheduledAt),
      webinarSession,
      testMode: true,
    };
  }

  return {
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    roomOpensAt: access.roomOpensAt,
    replayExpiresAt: access.replayExpiresAt,
    canEnterRoom: access.canEnterRoom,
    canViewRoom: access.accessStatus !== 'closed',
    countdown: getCountdown(now, webinarSession.scheduledAt),
    webinarSession,
    testMode: false,
  };
}

export async function buildDailyRoomAccessPayload(
  registration: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>,
  now: Date,
) {
  const registeredAccess = buildAccessPayload(registration, now);
  if (registeredAccess.accessStatus !== 'closed') {
    return registeredAccess;
  }

  const scheduledAt = getDailyBroadcastDate(now);
  if (scheduledAt.getTime() === registration.webinarSession.scheduledAt.getTime()) {
    return registeredAccess;
  }
  const webinarSession = await findOrCreateWebinarSession(scheduledAt, now);
  return buildAccessPayload(registration, now, { webinarSession });
}

export function notifySafely(task: Promise<unknown>) {
  task.catch(error => {
    logger.error({ err: error }, '[ASPБ telegram notify]');
  });
}

export type SaveEventInput = {
  eventName: AnalyticsEventName;
  req: any;
  registration?: {
    id: string;
    leadId: string;
    webinarSessionId: string;
    telegramClickedAt?: Date | null;
  } | null;
  page?: string;
  metadata?: Record<string, unknown>;
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  analyticsOnly?: boolean;
  webinarSessionId?: string | null;
  dailyRoom?: boolean;
  dedupKey?: string;
  eventSource?: AnalyticsSource;
  clientOccurredAt?: Date | null;
};

function serverEventSource(eventName: AnalyticsEventName): AnalyticsSource {
  if (eventName.startsWith('registration_') || eventName === 'participant_login_request') return 'registration';
  if (eventName === 'telegram_click') return 'registration';
  if (eventName.startsWith('recording') || eventName === 'recordings_open') return 'replay';
  if (
    eventName.startsWith('video_') ||
    eventName.startsWith('webinar_room_') ||
    eventName.startsWith('question_') ||
    eventName.startsWith('partner_') ||
    eventName === 'viewer_heartbeat'
  ) {
    return 'room';
  }
  if (eventName.startsWith('telegram_')) return 'telegram';
  return ANALYTICS_EVENT_REGISTRY[eventName].sources[0];
}

function serverEventAttributes(eventName: AnalyticsEventName, metadata: Record<string, unknown> | undefined) {
  const input = metadata ?? {};
  if (eventName === 'question_submit') {
    return validateAnalyticsAttributes(eventName, {
      questionId: input.questionId,
      showToParticipants: input.showToParticipants,
    });
  }
  if (eventName === 'partner_application_submit') {
    return validateAnalyticsAttributes(eventName, { partnerApplicationId: input.partnerApplicationId });
  }
  if (eventName === 'recording_open') {
    return validateAnalyticsAttributes(eventName, { recordingId: input.recordingId });
  }
  // clientsProblem and any unrecognized legacy metadata are intentionally not
  // copied into the v1 analytics contract.
  return validateAnalyticsAttributes(eventName, {});
}

function logicalEventKey(
  input: SaveEventInput,
  registrationId: string | null,
  effectiveSessionId: string | null,
  attributes: Record<string, unknown>,
) {
  if (input.dedupKey) return input.dedupKey;
  const entityId =
    (typeof attributes.questionId === 'string' && attributes.questionId) ||
    (typeof attributes.partnerApplicationId === 'string' && attributes.partnerApplicationId) ||
    (typeof attributes.recordingId === 'string' && attributes.recordingId);
  if (entityId) return buildServerDedupKey(input.eventName, entityId);
  if (registrationId) {
    return buildServerDedupKey(input.eventName, `${registrationId}:${effectiveSessionId ?? 'no-session'}`);
  }
  const correlationId = getRequestContext()?.correlationId ?? crypto.randomUUID();
  return buildServerDedupKey(input.eventName, correlationId);
}

export async function saveEvent(input: SaveEventInput) {
  const analyticsConsent = hasAnalyticsConsent(input.req);
  const aggregateOnly = Boolean(input.analyticsOnly && !analyticsConsent);
  const registration = aggregateOnly
    ? null
    : input.registration === undefined
      ? await findRegistrationForRequest(input.req)
      : input.registration;

  // Room events belong to the session the participant actually opened, not to
  // the historical session stored on their original Registration. Callers that
  // already built access pass the exact id; generic browser analytics can ask
  // this helper to resolve the same daily-room selection centrally.
  const effectiveWebinarSessionId = registration
    ? input.webinarSessionId !== undefined
      ? input.webinarSessionId
      : input.dailyRoom
        ? await (async () => {
            const currentRegistration = await prisma.registration.findUnique({
              where: { id: registration.id },
              include: { lead: true, webinarSession: true },
            });
            if (!currentRegistration || currentRegistration.leadId !== registration.leadId) {
              return registration.webinarSessionId;
            }
            return (await buildDailyRoomAccessPayload(currentRegistration, new Date())).webinarSession.id;
          })()
        : registration.webinarSessionId
    : null;
  const attributes = serverEventAttributes(input.eventName, input.metadata);
  const dedupKey = logicalEventKey(input, registration?.id ?? null, effectiveWebinarSessionId, attributes);
  const source = input.eventSource ?? serverEventSource(input.eventName);

  if (!registration) {
    await recordAnalyticsEvent(prisma, {
      eventName: input.eventName,
      source,
      dedupKey,
      scope: { kind: 'platform' },
      attributes,
      page: input.page ?? null,
      visitorId: aggregateOnly ? null : getVisitorId(input.req),
      userAgent: aggregateOnly ? null : (input.req.headers['user-agent'] ?? null),
      ipHash: aggregateOnly ? null : hashIp(getClientIp(input.req)),
      utmSource: aggregateOnly ? null : (input.utmSource ?? null),
      utmMedium: aggregateOnly ? null : (input.utmMedium ?? null),
      utmCampaign: aggregateOnly ? null : (input.utmCampaign ?? null),
      clientOccurredAt: input.clientOccurredAt,
    });
    return null;
  }

  // Erasure fence: a request may have resolved its participant session before
  // anonymization started. Serialize every linked event with anonymization and
  // re-read the identity only after acquiring the shared lead lock; otherwise a
  // delayed request could recreate IP/UA/metadata linked to an erased Lead.
  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, registration.leadId);
    const activeRegistration = await tx.registration.findUnique({
      where: { id: registration.id },
      include: { lead: true, webinarSession: true },
    });
    if (
      !activeRegistration ||
      activeRegistration.leadId !== registration.leadId ||
      !isParticipantRegistrationActive(activeRegistration)
    ) {
      return null;
    }

    await recordAnalyticsEvent(tx as unknown as typeof prisma, {
      eventName: input.eventName,
      source,
      dedupKey,
      scope: aggregateOnly
        ? { kind: 'trusted', webinarSessionId: effectiveWebinarSessionId ?? activeRegistration.webinarSessionId }
        : {
            kind: 'participant',
            trustedRegistrationId: activeRegistration.id,
            effectiveWebinarSessionId: effectiveWebinarSessionId ?? activeRegistration.webinarSessionId,
          },
      attributes: aggregateOnly ? {} : attributes,
      page: input.page ?? null,
      visitorId: aggregateOnly ? null : getVisitorId(input.req),
      userAgent: aggregateOnly ? null : (input.req.headers['user-agent'] ?? null),
      ipHash: aggregateOnly ? null : hashIp(getClientIp(input.req)),
      utmSource: aggregateOnly ? null : (input.utmSource ?? null),
      utmMedium: aggregateOnly ? null : (input.utmMedium ?? null),
      utmCampaign: aggregateOnly ? null : (input.utmCampaign ?? null),
      clientOccurredAt: input.clientOccurredAt,
    });
    return activeRegistration;
  });
}

// Explicit schemaVersion=0 compatibility writer. It exists only for old
// browser payloads during rollout and preserves the prior consent behavior.
// New application writers must call saveEvent/recordAnalyticsEvent instead.
export async function saveLegacyEvent(input: Omit<SaveEventInput, 'dedupKey' | 'eventSource' | 'clientOccurredAt'>) {
  const analyticsConsent = hasAnalyticsConsent(input.req);
  const aggregateOnly = Boolean(input.analyticsOnly && !analyticsConsent);
  const registration = aggregateOnly
    ? null
    : input.registration === undefined
      ? await findRegistrationForRequest(input.req)
      : input.registration;
  const effectiveWebinarSessionId = registration
    ? input.webinarSessionId !== undefined
      ? input.webinarSessionId
      : input.dailyRoom
        ? await (async () => {
            const currentRegistration = await prisma.registration.findUnique({
              where: { id: registration.id },
              include: { lead: true, webinarSession: true },
            });
            if (!currentRegistration || currentRegistration.leadId !== registration.leadId) {
              return registration.webinarSessionId;
            }
            return (await buildDailyRoomAccessPayload(currentRegistration, new Date())).webinarSession.id;
          })()
        : registration.webinarSessionId
    : null;
  await prisma.event.create({
    data: {
      schemaVersion: 0,
      scopeKind: 'legacy',
      eventName: input.eventName,
      visitorId: aggregateOnly ? null : getVisitorId(input.req),
      leadId: registration?.leadId ?? null,
      registrationId: registration?.id ?? null,
      webinarSessionId: effectiveWebinarSessionId,
      page: input.page ?? null,
      source: aggregateOnly ? null : (input.source ?? null),
      utmSource: aggregateOnly ? null : (input.utmSource ?? null),
      utmMedium: aggregateOnly ? null : (input.utmMedium ?? null),
      utmCampaign: aggregateOnly ? null : (input.utmCampaign ?? null),
      userAgent: aggregateOnly ? null : (input.req.headers['user-agent'] ?? null),
      ipHash: aggregateOnly ? null : hashIp(getClientIp(input.req)),
      metadataJson: aggregateOnly ? undefined : (input.metadata as Prisma.InputJsonValue | undefined),
    },
  });
  return registration;
}

export async function saveEventSafely(input: SaveEventInput, operation: string) {
  try {
    return await saveEvent(input);
  } catch (error) {
    // Business writes (registration, email enqueue, room entry, questions) have
    // already succeeded before this helper is called. Analytics is observable
    // but best-effort and must not turn that committed success into a client 500.
    logger.error(
      {
        failureCode: safeAnalyticsFailureCode(error),
        operation,
        eventName: input.eventName,
        registrationId: input.registration?.id ?? null,
        leadId: input.registration?.leadId ?? null,
        webinarSessionId: input.webinarSessionId ?? input.registration?.webinarSessionId ?? null,
      },
      '[ASPБ analytics] best-effort event save failed',
    );
    return null;
  }
}
