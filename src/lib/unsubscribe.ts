import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { isLeadIdentityActive } from './leadSecurity.js';
import { hashToken } from './tokens.js';

export const UNSUBSCRIBE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const UNSUBSCRIBE_TOKEN_PURPOSE = 'email-marketing-unsubscribe';
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type VerifiedUnsubscribeToken = {
  id: string;
  leadId: string;
  email: string;
  issuedAt: Date;
  expiresAt: Date;
};

type UnsubscribeTokenReader = Pick<Prisma.TransactionClient, 'unsubscribeToken'>;
type UnsubscribeTokenIssuer = Pick<Prisma.TransactionClient, 'lead' | 'unsubscribeToken'>;

export function generateUnsubscribeTokenValue() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

function normalizeRawToken(token: string | undefined) {
  if (!token || !RAW_TOKEN_PATTERN.test(token)) return null;
  return token;
}

async function findValidToken(client: UnsubscribeTokenReader, token: string | undefined, now: Date) {
  const rawToken = normalizeRawToken(token);
  if (!rawToken) return null;
  const record = await client.unsubscribeToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { lead: true },
  });
  if (
    !record ||
    record.purpose !== UNSUBSCRIBE_TOKEN_PURPOSE ||
    record.usedAt ||
    record.revokedAt ||
    record.expiresAt <= now ||
    record.createdAt > now ||
    !isLeadIdentityActive(record.lead)
  ) {
    return null;
  }
  return record;
}

function verifiedToken(record: NonNullable<Awaited<ReturnType<typeof findValidToken>>>): VerifiedUnsubscribeToken {
  return {
    id: record.id,
    leadId: record.leadId,
    email: record.lead.email.toLowerCase(),
    issuedAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export async function createUnsubscribeToken(
  email: string,
  now = new Date(),
  client: UnsubscribeTokenIssuer = prisma,
) {
  const normalizedEmail = email.trim().toLowerCase();
  const lead = await client.lead.findUnique({ where: { email: normalizedEmail } });
  if (!lead || !isLeadIdentityActive(lead)) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = generateUnsubscribeTokenValue();
    try {
      await client.unsubscribeToken.create({
        data: {
          tokenHash: generated.tokenHash,
          purpose: UNSUBSCRIBE_TOKEN_PURPOSE,
          leadId: lead.id,
          expiresAt: new Date(now.getTime() + UNSUBSCRIBE_TOKEN_TTL_MS),
          createdAt: now,
        },
      });
      return generated.token;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002' || attempt === 2) throw error;
    }
  }
  return null;
}

// Unlike the retired stateless token, this name now persists a DB hash before
// returning the raw capability to the mail/test call site.
export const buildUnsubscribeToken = createUnsubscribeToken;

export async function verifyUnsubscribeToken(
  token: string | undefined,
  now = new Date(),
  client: UnsubscribeTokenReader = prisma,
): Promise<VerifiedUnsubscribeToken | null> {
  const record = await findValidToken(client, token, now);
  return record ? verifiedToken(record) : null;
}

export async function consumeUnsubscribeToken(
  client: UnsubscribeTokenReader,
  token: string | undefined,
  now = new Date(),
): Promise<VerifiedUnsubscribeToken | null> {
  const record = await findValidToken(client, token, now);
  if (!record) return null;
  const consumed = await client.unsubscribeToken.updateMany({
    where: {
      id: record.id,
      tokenHash: record.tokenHash,
      purpose: UNSUBSCRIBE_TOKEN_PURPOSE,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  return consumed.count === 1 ? verifiedToken(record) : null;
}

export async function buildUnsubscribeUrl(email: string, now = new Date()) {
  const token = await createUnsubscribeToken(email, now);
  if (!token) return null;
  const base = env.PUBLIC_SITE_URL.replace(/\/$/u, '');
  return `${base}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}
