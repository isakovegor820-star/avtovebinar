import { type Prisma } from '@prisma/client';
import { env } from './env.js';
import { getReplayExpiresAt } from './time.js';
import { getEffectiveVideoDurationMinutes } from './webinarLive.js';
import { createAccessToken, hashToken } from './tokens.js';

export const ROOM_SESSION_TOKEN_PURPOSE = 'room_session';
export const ROOM_EXCHANGE_TOKEN_PURPOSE = 'registration';

type RoomTokenTx = Prisma.TransactionClient;

type WebinarTiming = {
  scheduledAt: Date;
  durationMinutes: number;
  videoDurationSeconds?: number | null;
  replayAvailableHours: number;
};

export function buildFrontendUrl(pathname: string) {
  const url = new URL(pathname, env.PUBLIC_SITE_URL);
  return url.toString();
}

export function buildTokenizedFrontendUrl(pathname: string, token: string, hash?: string) {
  const url = new URL(pathname, env.PUBLIC_SITE_URL);
  url.searchParams.set('token', token);
  if (hash) {
    url.hash = hash.replace(/^#/, '');
  }
  return url.toString();
}

export function getRoomTokenExpiresAt(session: WebinarTiming) {
  return getReplayExpiresAt(
    session.scheduledAt,
    getEffectiveVideoDurationMinutes(session),
    session.replayAvailableHours,
  );
}

export async function createRoomExchangeToken(
  tx: RoomTokenTx,
  input: {
    registrationId: string;
    expiresAt: Date;
  },
) {
  const token = createAccessToken();
  await tx.registrationToken.create({
    data: {
      registrationId: input.registrationId,
      tokenHash: hashToken(token),
      purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
      expiresAt: input.expiresAt,
    },
  });
  return token;
}

export async function createRoomExchangeUrl(
  tx: RoomTokenTx,
  input: {
    registrationId: string;
    expiresAt: Date;
    hash?: string;
  },
) {
  const token = await createRoomExchangeToken(tx, input);
  return buildTokenizedFrontendUrl('/crisis_premium/webinar.html', token, input.hash);
}
