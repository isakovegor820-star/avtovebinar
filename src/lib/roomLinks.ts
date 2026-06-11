import { type Prisma } from '@prisma/client';
import { env } from './env.js';
import { getReplayExpiresAt } from './time.js';
import { getEffectiveVideoDurationMinutes } from './webinarLive.js';
import { createAccessToken, hashToken } from './tokens.js';

export const ROOM_SESSION_TOKEN_PURPOSE = 'room_session';
export const ROOM_EXCHANGE_TOKEN_PURPOSE = 'registration';
export const TELEGRAM_START_TOKEN_PURPOSE = 'telegram_start';

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
  const fragment = new URLSearchParams();
  fragment.set('token', token);
  if (hash) {
    fragment.set('anchor', hash.replace(/^#/, ''));
  }
  url.hash = fragment.toString();
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

export async function createTelegramStartToken(
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
      purpose: TELEGRAM_START_TOKEN_PURPOSE,
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
