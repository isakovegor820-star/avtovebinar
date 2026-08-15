import { Prisma } from '@prisma/client';

export const ANONYMIZED_LEAD_EMAIL_SUFFIX = '@deleted.invalid';

export function isLeadIdentityActive(lead: { email: string; personalDataConsentRevokedAt?: Date | null }) {
  return !lead.email.toLowerCase().endsWith(ANONYMIZED_LEAD_EMAIL_SUFFIX) && !lead.personalDataConsentRevokedAt;
}

export function isParticipantRegistrationActive(registration: {
  status: string;
  emailVerifiedAt?: Date | null;
  lead: {
    email: string;
    personalDataConsentRevokedAt?: Date | null;
  };
}) {
  return (
    registration.status === 'registered' &&
    Boolean(registration.emailVerifiedAt) &&
    isLeadIdentityActive(registration.lead)
  );
}

// Shared transaction fence for operations that can grant/revoke access or
// restore/remove Lead data. The first key is this application's namespace; the
// second is a stable PostgreSQL hash. Collisions only serialize unrelated leads.
export async function acquireLeadSecurityLock(tx: Prisma.TransactionClient, leadId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(48192731, hashtext(${leadId}))`);
}

// External providers use independent per-Lead namespaces. A slow SMTP or
// Telegram request must not head-of-line block ordinary registration, room,
// partner or admin transactions that need only the short Lead data fence.
export async function acquireEmailDeliveryLock(tx: Prisma.TransactionClient, leadId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(48192733, hashtext(${leadId}))`);
}

export async function acquireTelegramDeliveryLock(tx: Prisma.TransactionClient, leadId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(48192734, hashtext(${leadId}))`);
}
