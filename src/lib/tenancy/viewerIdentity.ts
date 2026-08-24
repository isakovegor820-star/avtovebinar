import type { Prisma } from '@prisma/client';

type ViewerIdentityTx = Pick<Prisma.TransactionClient, 'user'>;

export function normalizeViewerEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function ensureViewerUser(
  tx: ViewerIdentityTx,
  input: { email: string; displayName?: string | null; verifiedAt?: Date | null },
) {
  const emailNormalized = normalizeViewerEmail(input.email);
  return tx.user.upsert({
    where: { emailNormalized },
    update: {},
    create: {
      emailNormalized,
      displayName: input.displayName?.trim() || null,
      kind: 'HUMAN',
      status: input.verifiedAt ? 'ACTIVE' : 'PENDING',
      emailVerifiedAt: input.verifiedAt ?? null,
    },
  });
}

export async function activateViewerUser(
  tx: ViewerIdentityTx,
  input: { userId: string | null; email: string; displayName?: string | null; verifiedAt: Date },
) {
  if (!input.userId) return;
  const emailNormalized = normalizeViewerEmail(input.email);
  await tx.user.updateMany({
    where: {
      id: input.userId,
      emailNormalized,
      kind: 'HUMAN',
      status: 'PENDING',
    },
    data: {
      status: 'ACTIVE',
      emailVerifiedAt: input.verifiedAt,
      displayName: input.displayName?.trim() || undefined,
    },
  });
}
