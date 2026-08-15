import { type Prisma } from '@prisma/client';
import { env } from './env.js';
import { getReplayExpiresAt } from './time.js';
import { getEffectiveVideoDurationMinutes } from './webinarLive.js';
import { createAccessToken, hashToken } from './tokens.js';

// Credential-purpose versions are an incident-response boundary. The previous
// registration flow could issue a participant session and Telegram start token
// to anyone who knew an existing email. New code must never accept those
// pre-remediation credentials, even if their database expiry is still rolling.
export const ROOM_SESSION_TOKEN_PURPOSE = 'room_session_v2_20260804';
export const ROOM_EXCHANGE_TOKEN_PURPOSE = 'registration';
export const PARTICIPANT_LOGIN_TOKEN_PURPOSE = 'participant_login';
export const TELEGRAM_START_TOKEN_PURPOSE = 'telegram_start_v2_20260804';
export const TELEGRAM_BINDING_VERSION = 'v2_20260804';
// Срок совпадает с опубликованной политикой и окном replay. Доступ можно безопасно
// восстановить одноразовой ссылкой на email, поэтому длинная session-cookie не нужна.
export const PARTICIPANT_SESSION_TTL_DAYS = 7;

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

export function getParticipantSessionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + PARTICIPANT_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// SECURITY: the helpers below are raw persistence primitives. For an existing
// Lead, callers must already hold acquireLeadSecurityLock and must re-read an
// active registration inside this same transaction. Keeping `tx` mandatory
// prevents accidental standalone writes, but the identity fence is a caller
// invariant because new-registration creation has no pre-existing Lead to lock.
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
