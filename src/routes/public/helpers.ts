/**
 * Shared helpers for public route sub-modules.
 */
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { hashIp, hashToken } from '../../lib/tokens.js';
import { getClientIp } from '../../lib/http.js';
import {
  getCountdown,
  getDailyBroadcastDate,
  getNextWebinarDate,
  getReplayExpiresAt,
  getTodayWebinarDate,
  getWebinarAccess,
  parseFirstSeenCookie,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
} from '../../lib/time.js';
import { getEffectiveVideoDurationMinutes } from '../../lib/webinarLive.js';
import { prisma } from '../../lib/prisma.js';
import { setContextIdentity } from '../../lib/requestContext.js';
import {
  buildFrontendUrl,
  getParticipantSessionExpiresAt,
  getRoomTokenExpiresAt,
  PARTICIPANT_SESSION_TTL_DAYS,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_START_TOKEN_PURPOSE,
} from '../../lib/roomLinks.js';
import { logger } from '../../lib/logger.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';

export {
  buildFrontendUrl,
  getParticipantSessionExpiresAt,
  getRoomTokenExpiresAt,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  PARTICIPANT_SESSION_TTL_DAYS,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
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
  const firstSeenAt = parseFirstSeenCookie(value) ?? now;
  const scheduledAt = getNextWebinarDate(firstSeenAt);
  const replayExpiresAt = getReplayExpiresAt(scheduledAt, WEBINAR_DURATION_MINUTES, WEBINAR_REPLAY_HOURS);

  return replayExpiresAt < now ? now : firstSeenAt;
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

  return tokenRecord.registration;
}

export async function findRegistrationForRequest(req: Request) {
  const cookieToken = clean(req.cookies?.aspb_room_token);
  if (!cookieToken) {
    return null;
  }
  const registration = await findRegistrationBySessionToken(cookieToken);
  if (registration) {
    setContextIdentity({ userId: registration.leadId });
  }
  return registration;
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

  if (env.NODE_ENV !== 'production' && env.WEBINAR_TEST_ROOM_MODE === 'on' && access.accessStatus !== 'replay') {
    return {
      accessStatus: 'replay' as const,
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
  const scheduledAt = getDailyBroadcastDate(now);
  const webinarSession = await findOrCreateWebinarSession(scheduledAt, now);
  return buildAccessPayload(registration, now, { webinarSession });
}

export async function buildTodayBroadcastAccessPayload(
  registration: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>,
  now: Date,
) {
  const scheduledAt = getTodayWebinarDate(now);
  const webinarSession = await findOrCreateWebinarSession(scheduledAt, now);
  return buildAccessPayload(registration, now, { webinarSession });
}

export function canOpenRecordings(access: ReturnType<typeof buildAccessPayload>) {
  return access.testMode || access.accessStatus === 'replay' || access.accessStatus === 'closed';
}

export function notifySafely(task: Promise<unknown>) {
  task.catch(error => {
    logger.error({ err: error }, '[ASPБ telegram notify]');
  });
}

export async function saveEvent(input: {
  eventName: string;
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
}) {
  const registration =
    input.registration === undefined ? await findRegistrationForRequest(input.req) : input.registration;

  await prisma.event.create({
    data: {
      eventName: input.eventName,
      leadId: registration?.leadId ?? null,
      registrationId: registration?.id ?? null,
      webinarSessionId: registration?.webinarSessionId ?? null,
      page: input.page ?? null,
      source: input.source ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      userAgent: input.req.headers['user-agent'] ?? null,
      ipHash: hashIp(getClientIp(input.req)),
      metadataJson: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  return registration;
}
