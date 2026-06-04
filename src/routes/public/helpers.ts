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
  getNextWebinarDate,
  getReplayExpiresAt,
  getWebinarAccess,
  parseFirstSeenCookie,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
} from '../../lib/time.js';
import { getEffectiveVideoDurationMinutes } from '../../lib/webinarLive.js';
import { prisma } from '../../lib/prisma.js';

export const ROOM_SESSION_TOKEN_PURPOSE = 'room_session';
export const ROOM_EXCHANGE_TOKEN_PURPOSE = 'registration';

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
  const fallbackMaxAge = 1000 * 60 * 60 * (WEBINAR_REPLAY_HOURS + 48);
  const maxAge = replayExpiresAt ? Math.max(60 * 1000, replayExpiresAt.getTime() - Date.now()) : fallbackMaxAge;
  res.cookie('aspb_room_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge,
  });
}

export function getRoomTokenExpiresAt(session: {
  scheduledAt: Date;
  durationMinutes: number;
  videoDurationSeconds?: number | null;
  replayAvailableHours: number;
}) {
  return getReplayExpiresAt(
    session.scheduledAt,
    getEffectiveVideoDurationMinutes(session),
    session.replayAvailableHours,
  );
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
  return findRegistrationBySessionToken(cookieToken);
}

export function buildAccessPayload(
  registration: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>,
  now: Date,
) {
  const access = getWebinarAccess(
    now,
    registration.webinarSession.scheduledAt,
    getEffectiveVideoDurationMinutes(registration.webinarSession),
    registration.webinarSession.replayAvailableHours,
    registration.webinarSession.roomOpenBeforeMinutes,
    registration.webinarSession.replayEnabled,
  );

  if (env.NODE_ENV !== 'production' && env.WEBINAR_TEST_ROOM_MODE === 'on') {
    return {
      accessStatus: 'replay' as const,
      webinarStatus: 'test',
      roomOpensAt: now,
      replayExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      canEnterRoom: true,
      canViewRoom: true,
      countdown: getCountdown(now, now),
      testMode: true,
    };
  }

  return {
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    roomOpensAt: access.roomOpensAt,
    replayExpiresAt: access.replayExpiresAt,
    canEnterRoom: access.canEnterRoom,
    canViewRoom: access.canEnterRoom || access.accessStatus === 'pre_live',
    countdown: getCountdown(now, registration.webinarSession.scheduledAt),
    testMode: false,
  };
}

export function buildFrontendUrl(pathname: string) {
  const url = new URL(pathname, env.PUBLIC_SITE_URL);
  return url.toString();
}

export function notifySafely(task: Promise<unknown>) {
  task.catch(error => {
    console.error('[ASPБ telegram notify]', error);
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
