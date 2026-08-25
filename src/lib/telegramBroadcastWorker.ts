import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { createCorrelationId, runWithCorrelation } from './requestContext.js';
import { normalizeError, retryDelayMs } from './resilience.js';
import { sendTelegramMessageToChat } from './telegram.js';
import { MARKETING_TELEGRAM_CONSENT } from './consentDocuments.js';
import { TELEGRAM_BINDING_VERSION } from './roomLinks.js';
import { acquireTelegramDeliveryLock } from './leadSecurity.js';
import { ANONYMIZED_LEAD_EMAIL_SUFFIX } from './leadSecurity.js';
import {
  initializeWorkerSubsystemProgress,
  reportWorkerSubsystemProgress,
  stopWorkerSubsystemProgress,
} from './workerHeartbeat.js';

export const TELEGRAM_BROADCAST_MAX_TEXT_LENGTH = 3500;
export const TELEGRAM_BROADCAST_KIND_MARKETING = 'marketing_telegram';
export const TELEGRAM_BROADCAST_KIND_NEWS = 'telegram_news';
export const TELEGRAM_BROADCAST_CREATE_LOCK_KEY = BigInt('48192731002');

const TELEGRAM_BROADCAST_DELAY_MS = 40;
const TELEGRAM_BROADCAST_MAX_ATTEMPTS = 6;
const TELEGRAM_BROADCAST_STALE_SENDING_MS = 10 * 60 * 1000;
const TELEGRAM_RECIPIENT_PAGE_SIZE = 500;
export const TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE = 100;
export const TELEGRAM_DELIVERY_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 25_000,
} as const;

type TelegramBroadcastRecipientOptions = {
  requireActiveRegistration?: boolean;
  onProgress?: () => void;
};

type TelegramBroadcastRecipientCandidate = {
  leadId: string;
  chatId: string;
  consentRecordId: string;
  consentDocumentVersion: string;
  consentAt: Date;
  inclusionReason: string;
};

export async function acquireTelegramBroadcastCreationLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${TELEGRAM_BROADCAST_CREATE_LOCK_KEY})`);
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createBroadcastJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function enabledBroadcastKinds() {
  const kinds: string[] = [];
  if (env.TELEGRAM_MANUAL_BROADCAST === 'on') {
    kinds.push(TELEGRAM_BROADCAST_KIND_MARKETING);
  }
  if (env.TELEGRAM_NEWS_BROADCAST === 'on') {
    kinds.push(TELEGRAM_BROADCAST_KIND_NEWS);
  }
  return kinds;
}

async function syncTelegramNewsPost(jobId: string) {
  const job = await prisma.telegramBroadcastJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== TELEGRAM_BROADCAST_KIND_NEWS) {
    return;
  }

  const [sentRecipients, permanentlyFailedRecipients] = await Promise.all([
    prisma.telegramBroadcastRecipient.count({ where: { jobId: job.id, status: 'sent' } }),
    prisma.telegramBroadcastRecipient.count({ where: { jobId: job.id, status: 'failed_permanent' } }),
  ]);
  const status =
    job.status === 'completed'
      ? permanentlyFailedRecipients > 0
        ? 'partial_failed'
        : 'sent'
      : job.status === 'failed'
        ? 'retry_scheduled'
        : job.status === 'dead_letter'
          ? 'failed'
          : job.status;
  await prisma.telegramNewsPost.updateMany({
    where: { id: job.id },
    data: {
      status,
      recipientCount: sentRecipients,
      // Transient failed attempts are intentionally not counted as failed recipients after a
      // successful retry. They remain observable on the protected durable job details.
      failedCount: permanentlyFailedRecipients,
      lastError: job.lastError,
      completedAt: job.completedAt,
    },
  });
}

async function syncTelegramNewsPostSafely(jobId: string, source: string) {
  try {
    await syncTelegramNewsPost(jobId);
    return true;
  } catch (error) {
    logger.error({ err: error, jobId, source }, 'Failed to synchronize Telegram news post state');
    return false;
  }
}

async function reconcileTelegramNewsPosts(onProgress?: () => void) {
  let posts: Array<{ id: string }>;
  try {
    posts = await prisma.telegramNewsPost.findMany({
      where: { status: { in: ['pending', 'sending', 'retry_scheduled'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to find Telegram news posts requiring reconciliation');
    return;
  }

  for (const post of posts) {
    onProgress?.();
    await syncTelegramNewsPostSafely(post.id, 'worker_reconciliation');
  }
}

function getTelegramRetryAfterMs(error: unknown) {
  if (!(error instanceof Error)) {
    return null;
  }

  const retryAfter = (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds;
  return retryAfter && retryAfter > 0 ? retryAfter * 1000 : null;
}

// Ошибки Telegram, означающие, что КОНКРЕТНЫЙ получатель недоставляем навсегда: заблокировал
// бота, удалён, чат не найден/невалиден, бот выгнан из группы и т.п. Такого получателя нужно
// пропустить и продолжить рассылку остальным, а не топить всю джобу. Текст берётся из
// `payload.description` Telegram API (см. telegram.ts).
const PERMANENT_RECIPIENT_ERROR =
  /blocked|deactivated|kicked|chat not found|user not found|peer_id_invalid|chat_id is empty|initiate conversation|not a member|have no rights|chat was upgraded|group chat was deleted/i;

function isPermanentRecipientError(error: unknown): boolean {
  // 429 (Too Many Requests, retry_after) — временная общая ошибка: ретраим всю джобу, получателя
  // НЕ пропускаем, иначе при троттлинге растеряли бы реальных адресатов.
  if (getTelegramRetryAfterMs(error) !== null) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return PERMANENT_RECIPIENT_ERROR.test(message);
}

function nextBroadcastRetryAt(now: Date, attempts: number, error: unknown) {
  return new Date(
    now.getTime() +
      retryDelayMs(attempts, { baseMs: 2000, maxMs: 10 * 60 * 1000, retryAfterMs: getTelegramRetryAfterMs(error) }),
  );
}

async function moveBroadcastJobToDeadLetter(
  job: {
    id: string;
    status: string;
    text: string;
    total: number;
    sent: number;
    failed: number;
    attempts: number;
    nextIndex: number;
    lastError: string | null;
  },
  reason: string,
  now: Date,
) {
  return prisma.$transaction(async tx => {
    const claimed = await tx.telegramBroadcastJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        completedAt: null,
        claimToken: null,
      },
      data: {
        status: 'dead_letter',
        completedAt: now,
        nextAttemptAt: null,
        lastError: reason,
        claimToken: null,
      },
    });
    if (claimed.count !== 1) {
      return false;
    }

    await tx.telegramBroadcastDeadLetter.upsert({
      where: { jobId: job.id },
      create: {
        jobId: job.id,
        reason,
        payloadJson: {
          textLength: job.text.length,
          total: job.total,
          sent: job.sent,
          failed: job.failed,
          attempts: job.attempts,
          nextIndex: job.nextIndex,
          lastError: job.lastError,
        },
      },
      update: {
        reason,
        payloadJson: {
          textLength: job.text.length,
          total: job.total,
          sent: job.sent,
          failed: job.failed,
          attempts: job.attempts,
          nextIndex: job.nextIndex,
          lastError: job.lastError,
        },
      },
    });
    return true;
  });
}

async function resetStaleBroadcastJobs(now: Date, kinds: string[]) {
  await prisma.telegramBroadcastJob.updateMany({
    where: {
      kind: { in: kinds },
      status: 'sending',
      completedAt: null,
      updatedAt: {
        lt: new Date(now.getTime() - TELEGRAM_BROADCAST_STALE_SENDING_MS),
      },
    },
    data: {
      status: 'failed',
      lastError: 'Job was stuck in sending state and was returned to retry queue',
      nextAttemptAt: now,
      claimToken: null,
    },
  });
}

class BroadcastClaimLostError extends Error {
  constructor(jobId: string) {
    super(`Telegram broadcast claim was lost for job ${jobId}`);
    this.name = 'BroadcastClaimLostError';
  }
}

async function assertBroadcastClaim(jobId: string, claimToken: string) {
  const owner = await prisma.telegramBroadcastJob.findUnique({
    where: { claimToken },
    select: { id: true, status: true, completedAt: true },
  });
  if (!owner || owner.id !== jobId || owner.status !== 'sending' || owner.completedAt) {
    throw new BroadcastClaimLostError(jobId);
  }
}

export async function getActiveTelegramBroadcastJob() {
  return prisma.telegramBroadcastJob.findFirst({
    where: {
      status: { in: ['pending', 'sending', 'failed'] },
      completedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function previewTelegramBroadcastRecipients(
  db: Prisma.TransactionClient | typeof prisma = prisma,
  options: TelegramBroadcastRecipientOptions = {},
) {
  options.onProgress?.();
  const total = await countTelegramBroadcastRecipients(db, options);
  const recipients = total > 0 ? await collectTelegramBroadcastAuditSample(db, options) : [];
  options.onProgress?.();
  return {
    enabled: env.TELEGRAM_MANUAL_BROADCAST === 'on',
    consentDocumentId: MARKETING_TELEGRAM_CONSENT.id,
    consentDocumentVersion: MARKETING_TELEGRAM_CONSENT.version,
    total,
    recipients,
    sampleLimit: TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE,
    sampleTruncated: total > recipients.length,
  };
}

export type TelegramBroadcastPreview = Awaited<ReturnType<typeof previewTelegramBroadcastRecipients>>;

export async function previewTelegramBroadcastRecipientsForSnapshot(
  tx: Prisma.TransactionClient,
  options: TelegramBroadcastRecipientOptions = {},
): Promise<TelegramBroadcastPreview> {
  return previewTelegramBroadcastRecipients(tx, options);
}

function eligibleTelegramLeadWhere(options: TelegramBroadcastRecipientOptions): Prisma.LeadWhereInput {
  return {
    telegramChatId: { not: null },
    telegramBindingVersion: TELEGRAM_BINDING_VERSION,
    marketingTelegramConsent: true,
    marketingTelegramConsentAt: { not: null },
    marketingTelegramRevokedAt: null,
    personalDataConsentRevokedAt: null,
    email: { not: { endsWith: ANONYMIZED_LEAD_EMAIL_SUFFIX } },
    ...(options.requireActiveRegistration === false
      ? {}
      : { registrations: { some: { status: 'registered', emailVerifiedAt: { not: null } } } }),
    consentRecords: {
      some: {
        kind: 'marketing_telegram',
        action: 'grant',
        documentId: MARKETING_TELEGRAM_CONSENT.id,
        documentVersion: MARKETING_TELEGRAM_CONSENT.version,
      },
    },
  };
}

async function findTelegramRecipientCandidatePage(
  db: Prisma.TransactionClient | typeof prisma,
  cursor: string | undefined,
  options: TelegramBroadcastRecipientOptions,
) {
  options.onProgress?.();
  const leads = await db.lead.findMany({
    where: eligibleTelegramLeadWhere(options),
    select: {
      id: true,
      telegramChatId: true,
      consentRecords: {
        where: {
          kind: 'marketing_telegram',
          action: 'grant',
          documentId: MARKETING_TELEGRAM_CONSENT.id,
          documentVersion: MARKETING_TELEGRAM_CONSENT.version,
        },
        select: { id: true, occurredAt: true, documentVersion: true },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
    orderBy: { id: 'asc' },
    take: TELEGRAM_RECIPIENT_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  options.onProgress?.();

  const recipients: TelegramBroadcastRecipientCandidate[] = [];
  for (const lead of leads) {
    const chatId = lead.telegramChatId;
    const consent = lead.consentRecords[0];
    if (!chatId || !consent) continue;
    recipients.push({
      leadId: lead.id,
      chatId,
      consentRecordId: consent.id,
      consentDocumentVersion: consent.documentVersion,
      consentAt: consent.occurredAt,
      inclusionReason:
        `marketingTelegramConsent=true; channel=Telegram; version=${consent.documentVersion}; ` +
        `grantedAt=${consent.occurredAt.toISOString()}; revoked=false`,
    });
  }

  return {
    recipients,
    nextCursor: leads.length === TELEGRAM_RECIPIENT_PAGE_SIZE ? leads.at(-1)?.id : undefined,
  };
}

async function countTelegramBroadcastRecipients(
  db: Prisma.TransactionClient | typeof prisma,
  options: TelegramBroadcastRecipientOptions,
) {
  const activeRegistrationPredicate =
    options.requireActiveRegistration === false
      ? Prisma.sql``
      : Prisma.sql`
          AND EXISTS (
            SELECT 1
            FROM "registrations" r
            WHERE r."lead_id" = l."id"
              AND r."status" = 'registered'
              AND r."email_verified_at" IS NOT NULL
          )
        `;
  const rows = await db.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT l."telegram_chat_id")::bigint AS "total"
    FROM "leads" l
    WHERE l."telegram_chat_id" IS NOT NULL
      AND l."telegram_binding_version" = ${TELEGRAM_BINDING_VERSION}
      AND l."marketing_telegram_consent" = TRUE
      AND l."marketing_telegram_consent_at" IS NOT NULL
      AND l."marketing_telegram_revoked_at" IS NULL
      AND l."personal_data_consent_revoked_at" IS NULL
      AND l."email" NOT LIKE ${`%${ANONYMIZED_LEAD_EMAIL_SUFFIX}`}
      AND EXISTS (
        SELECT 1
        FROM "consent_records" c
        WHERE c."lead_id" = l."id"
          AND c."kind" = 'marketing_telegram'
          AND c."action" = 'grant'
          AND c."document_id" = ${MARKETING_TELEGRAM_CONSENT.id}
          AND c."document_version" = ${MARKETING_TELEGRAM_CONSENT.version}
      )
      ${activeRegistrationPredicate}
  `);
  const total = Number(rows[0]?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('Telegram broadcast recipient count is outside the supported range');
  }
  return total;
}

async function collectTelegramBroadcastAuditSample(
  db: Prisma.TransactionClient | typeof prisma,
  options: TelegramBroadcastRecipientOptions,
) {
  const recipients: TelegramBroadcastRecipientCandidate[] = [];
  const seenChatIds = new Set<string>();
  let cursor: string | undefined;
  while (recipients.length < TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE) {
    const page = await findTelegramRecipientCandidatePage(db, cursor, options);
    for (const recipient of page.recipients) {
      if (seenChatIds.has(recipient.chatId)) continue;
      seenChatIds.add(recipient.chatId);
      recipients.push(recipient);
      if (recipients.length >= TELEGRAM_BROADCAST_PREVIEW_SAMPLE_SIZE) break;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return recipients;
}

export async function snapshotTelegramBroadcastRecipients(
  tx: Prisma.TransactionClient,
  jobId: string,
  options: TelegramBroadcastRecipientOptions = {},
) {
  let cursor: string | undefined;
  while (true) {
    const page = await findTelegramRecipientCandidatePage(tx, cursor, options);
    if (page.recipients.length > 0) {
      await tx.telegramBroadcastRecipient.createMany({
        data: page.recipients.map(recipient => ({
          jobId,
          leadId: recipient.leadId,
          chatId: recipient.chatId,
          consentRecordId: recipient.consentRecordId,
          consentDocumentVersion: recipient.consentDocumentVersion,
          inclusionReason: recipient.inclusionReason,
        })),
        skipDuplicates: true,
      });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  options.onProgress?.();
  return tx.telegramBroadcastRecipient.count({ where: { jobId } });
}

export async function createTelegramBroadcastJob(
  input: {
    text: string;
    initiatedById: string;
    idempotencyKey: string;
  },
  options: {
    preview: TelegramBroadcastPreview;
    tx: Prisma.TransactionClient;
    recipientOptions?: TelegramBroadcastRecipientOptions;
  },
) {
  if (env.TELEGRAM_MANUAL_BROADCAST !== 'on') {
    throw new Error('Manual Telegram broadcast is disabled by feature flag');
  }
  const preview = options.preview;
  const jobId = createBroadcastJobId();

  const create = async (tx: Prisma.TransactionClient) => {
    await tx.telegramBroadcastJob.create({
      data: {
        id: jobId,
        status: preview.total > 0 ? 'pending' : 'completed',
        kind: 'marketing_telegram',
        text: input.text,
        // Legacy columns remain schema-compatible, but the normalized recipient
        // table is the only delivery cursor and consent snapshot.
        chatIds: [],
        recipientSnapshot: Prisma.DbNull,
        consentDocumentId: preview.consentDocumentId,
        consentDocumentVersion: preview.consentDocumentVersion,
        initiatedById: input.initiatedById,
        idempotencyKey: input.idempotencyKey,
        total: preview.total,
        completedAt: preview.total > 0 ? null : new Date(),
        nextAttemptAt: preview.total > 0 ? new Date() : null,
      },
    });
    const snapshotTotal =
      preview.total > 0 ? await snapshotTelegramBroadcastRecipients(tx, jobId, options.recipientOptions) : 0;
    if (snapshotTotal !== preview.total) {
      throw new Error(`Telegram recipient snapshot changed during queueing (${snapshotTotal} != ${preview.total})`);
    }
  };
  await create(options.tx);

  return {
    jobId,
    total: preview.total,
    queued: preview.total > 0,
    delayMs: TELEGRAM_BROADCAST_DELAY_MS,
  };
}

export async function runTelegramBroadcastJobOnce(
  now = new Date(),
  options: { jobId?: string; onProgress?: () => void } = {},
) {
  const { onProgress } = options;
  onProgress?.();
  const kinds = enabledBroadcastKinds();
  if (kinds.length === 0) {
    return { checked: 0, sent: 0, failed: 0, deadLettered: 0, disabled: true };
  }
  await resetStaleBroadcastJobs(now, kinds);
  onProgress?.();
  if (kinds.includes(TELEGRAM_BROADCAST_KIND_NEWS)) {
    await reconcileTelegramNewsPosts(onProgress);
    onProgress?.();
  }

  const job = await prisma.telegramBroadcastJob.findFirst({
    where: {
      ...(options.jobId ? { id: options.jobId } : {}),
      kind: { in: kinds },
      status: { in: ['pending', 'failed'] },
      completedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  onProgress?.();

  if (!job) {
    return { checked: 0, sent: 0, failed: 0, deadLettered: 0 };
  }

  // The normalized snapshot is the only delivery cursor. Falling back to the
  // legacy JSON would bypass the per-recipient consent fence; silently accepting
  // a partial snapshot would lose recipients.
  const durableRecipientCount = await prisma.telegramBroadcastRecipient.count({
    where: { jobId: job.id },
  });
  onProgress?.();
  if (durableRecipientCount !== job.total) {
    const reason =
      `Durable Telegram recipient snapshot is incomplete ` +
      `(${durableRecipientCount} != ${job.total}); recreate the broadcast`;
    const deadLettered = await moveBroadcastJobToDeadLetter(job, reason, now);
    await syncTelegramNewsPostSafely(job.id, 'durable_snapshot_dead_letter');
    return { checked: 1, sent: 0, failed: 0, deadLettered: deadLettered ? 1 : 0 };
  }

  const claimToken = randomUUID();
  const claimed = await prisma.telegramBroadcastJob.updateMany({
    where: { id: job.id, status: job.status, completedAt: null, claimToken: null },
    data: {
      status: 'sending',
      startedAt: job.startedAt ?? now,
      attempts: { increment: 1 },
      nextAttemptAt: null,
      claimToken,
    },
  });
  if (claimed.count !== 1) {
    return { checked: 1, sent: 0, failed: 0, deadLettered: 0 };
  }

  const correlationId = createCorrelationId('telegram_broadcast');
  const result = await runWithCorrelation(correlationId, async () => {
    let sent = 0;
    let failedSkipped = 0;

    try {
      while (true) {
        onProgress?.();
        await assertBroadcastClaim(job.id, claimToken);
        const recipientRef = await prisma.telegramBroadcastRecipient.findFirst({
          where: { jobId: job.id, status: 'pending' },
          select: { id: true, leadId: true, chatId: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (!recipientRef) break;

        const chatId = recipientRef.chatId;
        // Serialize the final consent read and one-shot provider request with the
        // Telegram-only fence. Revocation and erasure acquire this same channel
        // fence first; ordinary Lead transactions never wait for the provider.
        const delivery = await prisma.$transaction(async tx => {
          if (recipientRef.leadId) {
            await acquireTelegramDeliveryLock(tx, recipientRef.leadId);
          }

          const owner = await tx.telegramBroadcastJob.findUnique({
            where: { claimToken },
            select: { id: true, status: true, completedAt: true },
          });
          if (!owner || owner.id !== job.id || owner.status !== 'sending' || owner.completedAt) {
            throw new BroadcastClaimLostError(job.id);
          }

          const recipient = await tx.telegramBroadcastRecipient.findUnique({
            where: { id: recipientRef.id },
            include: { lead: true, consentRecord: true },
          });
          const stillEligible =
            recipient?.status === 'pending' &&
            recipient.jobId === job.id &&
            recipient.chatId === chatId &&
            recipient.lead?.telegramChatId === chatId &&
            recipient.lead.telegramBindingVersion === TELEGRAM_BINDING_VERSION &&
            recipient.lead.marketingTelegramConsent === true &&
            recipient.lead.marketingTelegramConsentAt !== null &&
            recipient.lead.marketingTelegramRevokedAt === null &&
            recipient.lead.personalDataConsentRevokedAt === null &&
            !recipient.lead.email.endsWith(ANONYMIZED_LEAD_EMAIL_SUFFIX) &&
            recipient.consentRecord?.kind === 'marketing_telegram' &&
            recipient.consentRecord.action === 'grant' &&
            recipient.consentRecord.documentId === MARKETING_TELEGRAM_CONSENT.id &&
            recipient.consentRecord.documentVersion === MARKETING_TELEGRAM_CONSENT.version &&
            recipient.consentDocumentVersion === MARKETING_TELEGRAM_CONSENT.version;
          if (!stillEligible) {
            return { recipient, stillEligible: false as const, sendFailure: null };
          }

          try {
            // Every recipient attempt reacquires the lease and consent fence instead of
            // sleeping inside Telegram's generic retry helper.
            await sendTelegramMessageToChat(chatId, job.text, { attempts: 1 });
            return { recipient, stillEligible: true as const, sendFailure: null };
          } catch (error) {
            return { recipient, stillEligible: true as const, sendFailure: { error } };
          }
        }, TELEGRAM_DELIVERY_TRANSACTION_OPTIONS);
        const { recipient, stillEligible, sendFailure } = delivery;
        onProgress?.();
        if (!stillEligible) {
          await prisma.$transaction(async tx => {
            const recipientOwned = recipient
              ? await tx.telegramBroadcastRecipient.updateMany({
                  where: {
                    id: recipient.id,
                    status: 'pending',
                    leadId: recipient.leadId,
                    chatId: recipient.chatId,
                  },
                  data: {
                    status: 'skipped_revoked',
                    unsubscribedBeforeSendAt: new Date(),
                    lastError: 'Recipient no longer has current, unrevoked Telegram marketing consent',
                  },
                })
              : { count: 0 };
            const owned = await tx.telegramBroadcastJob.updateMany({
              where: { id: job.id, status: 'sending', completedAt: null, claimToken },
              data: recipientOwned.count === 1 ? { nextIndex: { increment: 1 }, attempts: 0 } : { attempts: 0 },
            });
            if (owned.count !== 1) throw new BroadcastClaimLostError(job.id);
          });
          await wait(TELEGRAM_BROADCAST_DELAY_MS);
          onProgress?.();
          continue;
        }

        if (!sendFailure) {
          const recorded = await prisma.$transaction(async tx => {
            const recipientOwned = await tx.telegramBroadcastRecipient.updateMany({
              where: {
                id: recipient.id,
                status: 'pending',
                leadId: recipient.leadId,
                chatId: recipient.chatId,
              },
              data: { status: 'sent', attempts: { increment: 1 }, sentAt: new Date(), lastError: null },
            });
            const owned = await tx.telegramBroadcastJob.updateMany({
              where: { id: job.id, status: 'sending', completedAt: null, claimToken },
              data:
                recipientOwned.count === 1
                  ? { sent: { increment: 1 }, nextIndex: { increment: 1 }, attempts: 0, lastError: null }
                  : { attempts: 0 },
            });
            if (owned.count !== 1) throw new BroadcastClaimLostError(job.id);
            return recipientOwned.count === 1;
          });
          if (recorded) sent += 1;
        } else {
          const { error } = sendFailure;
          const lastError = normalizeError(error).slice(0, 2000);
          if (isPermanentRecipientError(error)) {
            // Получатель недоставляем навсегда (заблокировал бота, удалён, чат не найден).
            // Статус получателя и курсор меняются атомарно и только текущим владельцем claim.
            const recorded = await prisma.$transaction(async tx => {
              const recipientOwned = await tx.telegramBroadcastRecipient.updateMany({
                where: {
                  id: recipient.id,
                  status: 'pending',
                  leadId: recipient.leadId,
                  chatId: recipient.chatId,
                },
                data: {
                  attempts: { increment: 1 },
                  lastError,
                  status: 'failed_permanent',
                },
              });
              const owned = await tx.telegramBroadcastJob.updateMany({
                where: { id: job.id, status: 'sending', completedAt: null, claimToken },
                data:
                  recipientOwned.count === 1
                    ? { failed: { increment: 1 }, nextIndex: { increment: 1 }, attempts: 0, lastError }
                    : { attempts: 0 },
              });
              if (owned.count !== 1) throw new BroadcastClaimLostError(job.id);
              return recipientOwned.count === 1;
            });
            if (recorded) failedSkipped += 1;
            logger.warn({ jobId: job.id, chatId, err: error }, 'Telegram broadcast recipient skipped (permanent)');
            await wait(TELEGRAM_BROADCAST_DELAY_MS);
            onProgress?.();
            continue;
          }

          const recipientAttempts = (recipient.attempts ?? 0) + 1;
          const retryAt = nextBroadcastRetryAt(new Date(), recipientAttempts, error);
          const recipientRetryExhausted = recipientAttempts >= TELEGRAM_BROADCAST_MAX_ATTEMPTS;
          const retryRecorded = await prisma.$transaction(async tx => {
            const recipientOwned = await tx.telegramBroadcastRecipient.updateMany({
              where: {
                id: recipient.id,
                status: 'pending',
                leadId: recipient.leadId,
                chatId: recipient.chatId,
              },
              data: {
                attempts: { increment: 1 },
                lastError,
                status: recipientRetryExhausted ? 'failed_permanent' : 'pending',
              },
            });
            const owned = await tx.telegramBroadcastJob.updateMany({
              where: { id: job.id, status: 'sending', completedAt: null, claimToken },
              data:
                recipientOwned.count !== 1
                  ? { attempts: 0 }
                  : recipientRetryExhausted
                    ? {
                        failed: { increment: 1 },
                        nextIndex: { increment: 1 },
                        attempts: 0,
                        lastError,
                      }
                    : {
                        status: 'failed',
                        lastError,
                        nextAttemptAt: retryAt,
                        claimToken: null,
                      },
            });
            if (owned.count !== 1) throw new BroadcastClaimLostError(job.id);
            return recipientOwned.count === 1;
          });
          if (!retryRecorded) {
            onProgress?.();
            continue;
          }
          if (!recipientRetryExhausted) {
            logger.error({ jobId: job.id, chatId, retryAt, err: error }, 'Telegram broadcast recipient failed');
            return { checked: 1, sent, failed: 1, deadLettered: 0 };
          }
          failedSkipped += 1;
          logger.error(
            { jobId: job.id, chatId, recipientAttempts, err: error },
            'Telegram broadcast recipient retry limit reached; continuing with remaining recipients',
          );
          await wait(TELEGRAM_BROADCAST_DELAY_MS);
          onProgress?.();
          continue;
        }

        await wait(TELEGRAM_BROADCAST_DELAY_MS);
        onProgress?.();
      }

      await prisma.$transaction(async tx => {
        const owned = await tx.telegramBroadcastJob.updateMany({
          where: { id: job.id, status: 'sending', completedAt: null, claimToken },
          data: {
            status: 'completed',
            completedAt: new Date(),
            nextAttemptAt: null,
            claimToken: null,
          },
        });
        if (owned.count !== 1) throw new BroadcastClaimLostError(job.id);
      });

      try {
        await prisma.event.create({
          data: {
            eventName:
              job.kind === TELEGRAM_BROADCAST_KIND_NEWS ? 'telegram_news_broadcast' : 'telegram_broadcast_completed',
            source: 'worker',
            metadataJson: {
              jobId: job.id,
              total: job.total,
              sent: job.sent + sent,
              failed: job.failed + failedSkipped,
              textLength: job.text.length,
            },
          },
        });
      } catch (error) {
        logger.error({ err: error, jobId: job.id }, 'Failed to record Telegram broadcast analytics event');
      }

      return { checked: 1, sent, failed: failedSkipped, deadLettered: 0 };
    } catch (error) {
      if (error instanceof BroadcastClaimLostError) {
        logger.warn({ jobId: job.id }, 'Telegram broadcast worker stopped after losing its claim');
        return { checked: 1, sent, failed: failedSkipped, deadLettered: 0 };
      }
      throw error;
    }
  });
  await syncTelegramNewsPostSafely(job.id, 'worker_result');
  return result;
}

let broadcastInterval: NodeJS.Timeout | null = null;
let broadcastStartupTimer: NodeJS.Timeout | null = null;
let broadcastRunning = false;

export function startTelegramBroadcastWorker() {
  if (env.NODE_ENV === 'test' || enabledBroadcastKinds().length === 0) {
    return null;
  }

  initializeWorkerSubsystemProgress('broadcast');
  const reportProgress = () => reportWorkerSubsystemProgress('broadcast');

  const tick = () => {
    if (broadcastRunning) {
      return;
    }
    broadcastRunning = true;
    reportProgress();
    runTelegramBroadcastJobOnce(new Date(), { onProgress: reportProgress })
      .catch(error => logger.error({ err: error }, 'Telegram broadcast worker failed'))
      .finally(() => {
        reportProgress();
        broadcastRunning = false;
      });
  };

  broadcastInterval = setInterval(tick, 5000);
  broadcastStartupTimer = setTimeout(tick, 1000);
  return broadcastInterval;
}

export function stopTelegramBroadcastWorker() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (broadcastStartupTimer) {
    clearTimeout(broadcastStartupTimer);
    broadcastStartupTimer = null;
  }
  stopWorkerSubsystemProgress('broadcast');
}
