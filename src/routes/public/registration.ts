import { Router, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler, getClientIp } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { createAccessToken, hashIp, hashToken } from '../../lib/tokens.js';
import { verifyUnsubscribeToken } from '../../lib/unsubscribe.js';
import { getDailyBroadcastDate, getWebinarAccess, getWebinarRoomState } from '../../lib/time.js';
import { getEffectiveVideoDurationMinutes, getWebinarLiveState } from '../../lib/webinarLive.js';
import { enqueueParticipantLoginEmail, enqueueRegistrationEmail } from '../../lib/emailOutbox.js';
import { buildTelegramStartUrl, notifyRegistration } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { createTelegramStartToken } from '../../lib/roomLinks.js';
import {
  buildAccessPayload,
  buildDailyRoomAccessPayload,
  buildFrontendUrl,
  clearRoomTokenCookie,
  clean,
  findRegistrationForRequest,
  getFirstSeen,
  refreshRoomTokenSession,
  getParticipantSessionExpiresAt,
  getRoomTokenExpiresAt,
  PARTICIPANT_LOGIN_TOKEN_PURPOSE,
  notifySafely,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_BINDING_VERSION,
  TELEGRAM_START_TOKEN_PURPOSE,
  saveEventSafely,
  setRoomTokenCookie,
} from './helpers.js';
import {
  CONSENT_POLICY_VERSION,
  MARKETING_EMAIL_CONSENT,
  MARKETING_TELEGRAM_CONSENT,
  PERSONAL_DATA_CONSENT,
  consentEvidenceData,
  legalAcceptanceEvidenceData,
} from '../../lib/consentDocuments.js';
import {
  acquireLeadSecurityLock,
  isLeadIdentityActive,
  isParticipantRegistrationActive,
} from '../../lib/leadSecurity.js';
import { getEmailDeliveryReadiness } from '../../lib/health.js';

export const registrationRouter = Router();

const utmSchema = {
  source: z.string().trim().max(120).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional().or(z.literal('')),
  utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
  utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
  utmContent: z.string().trim().max(120).optional().or(z.literal('')),
  utmTerm: z.string().trim().max(120).optional().or(z.literal('')),
};

// `z.coerce.boolean()` использует JavaScript truthiness, поэтому строка `"false"`
// превращается в `true`. Для юридически значимых согласий принимаем только явные
// boolean-значения (JSON) или их однозначное form-urlencoded представление.
const explicitBooleanSchema = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(160),
  companyWebsite: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  professionalStatus: z.string().trim().max(120).optional().or(z.literal('')),
  status: z.string().trim().max(120).optional().or(z.literal('')),
  clientsProblem: z.string().trim().max(120).optional().or(z.literal('')),
  personalDataConsent: explicitBooleanSchema.refine(value => value === true, 'Personal data consent is required'),
  termsAccepted: explicitBooleanSchema.refine(value => value === true, 'Terms acceptance is required'),
  marketingEmailConsent: explicitBooleanSchema.optional().default(false),
  marketingTelegramConsent: explicitBooleanSchema.optional().default(false),
  ...utmSchema,
});

const exchangeBodySchema = z.object({
  token: z.string().min(20),
});

const participantLoginRequestSchema = z.object({
  email: z.string().trim().email().max(160),
});

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

class LeadIdentityChangedError extends Error {}

type PublicEmailReadiness = Awaited<ReturnType<typeof getEmailDeliveryReadiness>>;

async function publicEmailReadiness(): Promise<PublicEmailReadiness> {
  const fallback: PublicEmailReadiness = {
    // EMAIL_MODE only says that delivery was requested; it is not evidence
    // that SMTP is reachable. On timeout/error expose a global degraded state
    // instead of optimistically promising that a verification mail was queued.
    available: false,
    status: 'degraded',
    retryAfterSeconds: 30,
  };
  try {
    // A warm dependency result is immediate. Do not put a cold SMTP/Telegram
    // probe on the registration critical path; the health check keeps running
    // and will populate its shared cache for subsequent requests.
    return await Promise.race([
      getEmailDeliveryReadiness(),
      new Promise<PublicEmailReadiness>(resolve => setTimeout(() => resolve(fallback), 250)),
    ]);
  } catch {
    return fallback;
  }
}

function genericParticipantLoginResponse(readiness: PublicEmailReadiness) {
  return {
    ok: true,
    message:
      'Если адрес зарегистрирован и email-доставка доступна, безопасная ссылка для входа будет отправлена на почту.',
    emailDeliveryAvailable: readiness.available,
    deliveryStatus: readiness.available ? ('queued' as const) : ('retrying' as const),
    retryAfterSeconds: readiness.retryAfterSeconds,
  };
}

function existingRegistrationVerificationResponse(readiness: PublicEmailReadiness) {
  return {
    ...genericParticipantLoginResponse(readiness),
    verificationRequired: true,
    accessUrl: buildFrontendUrl('/crisis_premium/access.html'),
  };
}

async function sendGenericEmailResponse(res: Response, kind: 'registration' | 'login') {
  const readiness = await publicEmailReadiness();
  if (!readiness.available && readiness.retryAfterSeconds) {
    res.setHeader('Retry-After', String(readiness.retryAfterSeconds));
  }
  const body =
    kind === 'registration'
      ? existingRegistrationVerificationResponse(readiness)
      : genericParticipantLoginResponse(readiness);
  res.status(202).json(body);
}

function publicTelegramUrl() {
  return buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL;
}

function pendingClientsProblem(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clientsProblem = (value as Record<string, unknown>).clientsProblem;
  return typeof clientsProblem === 'string' ? clean(clientsProblem) : null;
}

async function exchangeRegistrationToken(
  token: string,
  req: Request,
  res: Response,
  allowedPurposes = [ROOM_EXCHANGE_TOKEN_PURPOSE],
) {
  const exchangeTokenHash = hashToken(token);
  const sessionToken = createAccessToken();
  const sessionTokenHash = hashToken(sessionToken);
  const { sessionExpiresAt, registrationId, purpose, newlyVerified } = await prisma.$transaction(async tx => {
    const tokenRecord = await tx.registrationToken.findUnique({
      where: { tokenHash: exchangeTokenHash },
      include: {
        registration: {
          include: {
            webinarSession: true,
          },
        },
      },
    });
    const now = new Date();
    if (
      !tokenRecord ||
      !allowedPurposes.includes(tokenRecord.purpose) ||
      (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)
    ) {
      throw new AppError(404, 'Registration not found');
    }

    await acquireLeadSecurityLock(tx, tokenRecord.registration.leadId);
    const activeTokenRecord = await tx.registrationToken.findUnique({
      where: { tokenHash: exchangeTokenHash },
      include: {
        registration: {
          include: {
            lead: true,
            webinarSession: true,
          },
        },
      },
    });
    if (
      !activeTokenRecord ||
      activeTokenRecord.id !== tokenRecord.id ||
      !allowedPurposes.includes(activeTokenRecord.purpose) ||
      (activeTokenRecord.expiresAt && activeTokenRecord.expiresAt <= now)
    ) {
      throw new AppError(404, 'Registration not found');
    }

    const isPendingRegistrationConfirmation =
      activeTokenRecord.purpose === ROOM_EXCHANGE_TOKEN_PURPOSE &&
      activeTokenRecord.registration.status === 'pending_verification' &&
      !activeTokenRecord.registration.emailVerifiedAt &&
      isLeadIdentityActive(activeTokenRecord.registration.lead);
    if (!isPendingRegistrationConfirmation && !isParticipantRegistrationActive(activeTokenRecord.registration)) {
      throw new AppError(404, 'Registration not found');
    }

    // ВАЖНО (защита от double-spend): это compare-and-swap. deleteMany с условием
    // по tokenHash атомарно «забирает» токен — две параллельные транзакции под
    // READ COMMITTED не смогут удалить одну строку дважды (вторая получит count=0).
    // НЕ заменять на update/findUnique+delete: это откроет гонку двойной траты.
    const claimedToken = await tx.registrationToken.deleteMany({
      where: {
        id: activeTokenRecord.id,
        tokenHash: exchangeTokenHash,
        purpose: { in: allowedPurposes },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (claimedToken.count !== 1) {
      throw new AppError(404, 'Registration not found');
    }

    const sessionExpiresAt = getParticipantSessionExpiresAt(now);

    let newlyVerified = null as null | {
      name: string;
      phone: string;
      email: string;
      city: string | null;
      professionalStatus: string | null;
      scheduledAt: Date;
      source: string | null;
      leadId: string;
      webinarSessionId: string;
      utmSource: string | null;
      utmMedium: string | null;
      utmCampaign: string | null;
      clientsProblem: string | null;
    };

    if (isPendingRegistrationConfirmation) {
      const [pendingConsents, termsAcceptance] = await Promise.all([
        tx.consentRecord.findMany({
          where: {
            registrationId: activeTokenRecord.registrationId,
            action: 'pending_verification',
          },
        }),
        tx.legalAcceptance.findFirst({
          where: { registrationId: activeTokenRecord.registrationId },
          select: { id: true },
        }),
      ]);
      const personalDataConsent = pendingConsents.find(consent => consent.kind === 'personal_data');
      if (!personalDataConsent || !termsAcceptance) {
        throw new AppError(404, 'Registration not found');
      }

      const marketingEmailConsent = pendingConsents.find(consent => consent.kind === 'marketing_email');
      const marketingTelegramConsent = pendingConsents.find(consent => consent.kind === 'marketing_telegram');
      const hasMarketingConsent = Boolean(marketingEmailConsent || marketingTelegramConsent);
      const activatedLead = await tx.lead.updateMany({
        where: {
          id: activeTokenRecord.registration.leadId,
          email: activeTokenRecord.registration.lead.email,
          personalDataConsentRevokedAt: null,
        },
        data: {
          consent: true,
          // The immutable pending row proves the original form action. Active
          // consent begins only when the mailbox owner consumes the link.
          consentAt: now,
          consentPolicyVersion: personalDataConsent.documentVersion,
          consentIpHash: personalDataConsent.ipHash,
          consentRevokedAt: null,
          marketingConsent: hasMarketingConsent,
          marketingConsentAt: hasMarketingConsent ? now : null,
          marketingEmailConsent: Boolean(marketingEmailConsent),
          marketingEmailConsentAt: marketingEmailConsent ? now : null,
          marketingEmailRevokedAt: null,
          marketingTelegramConsent: Boolean(marketingTelegramConsent),
          marketingTelegramConsentAt: marketingTelegramConsent ? now : null,
          marketingTelegramRevokedAt: null,
        },
      });
      if (activatedLead.count !== 1) {
        throw new AppError(404, 'Registration not found');
      }

      // Compliance evidence is append-only at the database layer. Never mutate
      // pending rows: append a grant snapshot effective at verification time.
      await tx.consentRecord.createMany({
        data: pendingConsents.map(consent => ({
          leadId: activeTokenRecord.registration.leadId,
          registrationId: activeTokenRecord.registrationId,
          questionId: consent.questionId,
          subjectRefHash: consent.subjectRefHash,
          kind: consent.kind,
          action: 'grant',
          documentId: consent.documentId,
          documentVersion: consent.documentVersion,
          documentHash: consent.documentHash,
          documentEffectiveAt: consent.documentEffectiveAt,
          purposes: consent.purposes as Prisma.InputJsonValue,
          dataCategories: consent.dataCategories as Prisma.InputJsonValue,
          operations: consent.operations as Prisma.InputJsonValue,
          retentionTerm: consent.retentionTerm,
          channels: consent.channels as Prisma.InputJsonValue,
          sourceForm: '/api/registration/exchange',
          ipHash: hashIp(getClientIp(req)),
          userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
          occurredAt: now,
        })),
      });
      await tx.registration.update({
        where: { id: activeTokenRecord.registrationId },
        data: {
          status: 'registered',
          registeredAt: now,
          emailVerifiedAt: now,
          accessTokenHash: sessionTokenHash,
          pendingMetadataJson: Prisma.DbNull,
        },
      });
      // Resends and ambiguous SMTP outcomes can produce several one-time
      // confirmation hashes. Once one succeeds, revoke every sibling link.
      await tx.registrationToken.deleteMany({
        where: {
          registrationId: activeTokenRecord.registrationId,
          purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
        },
      });

      newlyVerified = {
        name: activeTokenRecord.registration.lead.name,
        phone: activeTokenRecord.registration.lead.phone,
        email: activeTokenRecord.registration.lead.email,
        city: activeTokenRecord.registration.lead.city,
        professionalStatus: activeTokenRecord.registration.lead.professionalStatus,
        scheduledAt: activeTokenRecord.registration.webinarSession.scheduledAt,
        source: activeTokenRecord.registration.lead.source,
        leadId: activeTokenRecord.registration.leadId,
        webinarSessionId: activeTokenRecord.registration.webinarSessionId,
        utmSource: activeTokenRecord.registration.lead.utmSource,
        utmMedium: activeTokenRecord.registration.lead.utmMedium,
        utmCampaign: activeTokenRecord.registration.lead.utmCampaign,
        clientsProblem: pendingClientsProblem(activeTokenRecord.registration.pendingMetadataJson),
      };
    } else {
      await tx.registration.update({
        where: { id: activeTokenRecord.registrationId },
        data: { accessTokenHash: sessionTokenHash },
      });
    }

    await tx.registrationToken.create({
      data: {
        registrationId: activeTokenRecord.registrationId,
        tokenHash: sessionTokenHash,
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: sessionExpiresAt,
      },
    });

    return {
      sessionExpiresAt,
      registrationId: activeTokenRecord.registrationId,
      purpose: activeTokenRecord.purpose,
      newlyVerified,
    };
  });

  setRoomTokenCookie(res, sessionToken, sessionExpiresAt);
  if (newlyVerified) {
    await saveEventSafely(
      {
        eventName: 'registration_submit',
        req,
        registration: {
          id: registrationId,
          leadId: newlyVerified.leadId,
          webinarSessionId: newlyVerified.webinarSessionId,
        },
        page: '/crisis_premium/register.html',
        source: newlyVerified.source,
        utmSource: newlyVerified.utmSource,
        utmMedium: newlyVerified.utmMedium,
        utmCampaign: newlyVerified.utmCampaign,
        metadata: newlyVerified.clientsProblem ? { clientsProblem: newlyVerified.clientsProblem } : undefined,
      },
      'registration_verification',
    );
    notifySafely(
      notifyRegistration({
        name: newlyVerified.name,
        phone: newlyVerified.phone,
        email: newlyVerified.email,
        city: newlyVerified.city,
        professionalStatus: newlyVerified.professionalStatus,
        scheduledAt: newlyVerified.scheduledAt,
        source: newlyVerified.source,
        adminUrl: buildFrontendUrl('/admin'),
      }),
    );
  }
  res.json({
    ok: true,
    purpose,
    registrationId,
    accessUrl: buildFrontendUrl('/crisis_premium/access.html'),
    successUrl: buildFrontendUrl('/crisis_premium/success.html'),
    webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
    expiresAt: sessionExpiresAt.toISOString(),
  });
}

registrationRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    if (clean(data.companyWebsite)) {
      res.status(202).json({
        ok: true,
        successUrl: buildFrontendUrl('/crisis_premium/success.html'),
        webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
        telegramUrl: publicTelegramUrl(),
      });
      return;
    }

    const email = data.email.toLowerCase();
    const firstSeenAt = getFirstSeen(req, res);
    const [existingLead, authenticatedRegistration] = await Promise.all([
      prisma.lead.findUnique({ where: { email }, select: { id: true } }),
      findRegistrationForRequest(req),
    ]);

    // Знание email не является аутентификацией. Существующий профиль можно
    // переиспользовать/обновить только из уже подтверждённой participant-сессии
    // того же Lead. Во всех остальных случаях отправляем одноразовую ссылку на
    // сохранённый адрес и не меняем данные, токены или cookie.
    if (existingLead && authenticatedRegistration?.leadId !== existingLead.id) {
      await queueParticipantLoginForEmail(email, req);
      await sendGenericEmailResponse(res, 'registration');
      return;
    }

    const now = new Date();
    // firstSeenAt нужен для атрибуции, но слот всегда выбирается от текущего времени.
    // Так лендинг, регистрация, письма и комната используют один и тот же эфир.
    const scheduledAt = getDailyBroadcastDate(now);
    const session = await findOrCreateWebinarSession(scheduledAt, now);
    const professionalStatus = clean(data.professionalStatus) ?? clean(data.status);
    const clientsProblem = clean(data.clientsProblem);

    const issueImmediateParticipantSession = Boolean(
      existingLead && authenticatedRegistration?.leadId === existingLead.id,
    );
    const registrationStatus = issueImmediateParticipantSession ? 'registered' : 'pending_verification';
    const telegramStartToken = issueImmediateParticipantSession ? createAccessToken() : null;
    const sessionToken = createAccessToken();
    const telegramStartTokenHash = telegramStartToken ? hashToken(telegramStartToken) : null;
    const sessionTokenHash = hashToken(sessionToken);
    const linkTokenExpiresAt = getRoomTokenExpiresAt(session);
    const sessionExpiresAt = getParticipantSessionExpiresAt(now);
    const successUrl = buildFrontendUrl('/crisis_premium/success.html');

    // Доказуемость согласия (152-ФЗ): фиксируем момент, версию политики и хэш IP при согласии.
    const consentGivenAt = new Date();
    const consentIpHash = hashIp(getClientIp(req));

    const persistRegistration = () =>
      prisma.$transaction(async tx => {
        const existingLeadUpdate = {
          name: data.name,
          phone: data.phone,
          city: clean(data.city) ?? undefined,
          professionalStatus: professionalStatus ?? undefined,
          consent: true,
          marketingConsent: data.marketingEmailConsent || data.marketingTelegramConsent ? true : undefined,
          marketingEmailConsent: data.marketingEmailConsent ? true : undefined,
          marketingTelegramConsent: data.marketingTelegramConsent ? true : undefined,
          consentAt: consentGivenAt,
          marketingConsentAt: data.marketingEmailConsent || data.marketingTelegramConsent ? consentGivenAt : undefined,
          marketingEmailConsentAt: data.marketingEmailConsent ? consentGivenAt : undefined,
          marketingTelegramConsentAt: data.marketingTelegramConsent ? consentGivenAt : undefined,
          consentPolicyVersion: CONSENT_POLICY_VERSION,
          consentIpHash,
          personalDataConsentRevokedAt: null,
          source: clean(data.source) ?? undefined,
          utmSource: clean(data.utmSource) ?? undefined,
          utmMedium: clean(data.utmMedium) ?? undefined,
          utmCampaign: clean(data.utmCampaign) ?? undefined,
          utmContent: clean(data.utmContent) ?? undefined,
          utmTerm: clean(data.utmTerm) ?? undefined,
        };
        const newLead = {
          name: data.name,
          phone: data.phone,
          email,
          city: clean(data.city),
          professionalStatus,
          // Until the mailbox owner consumes the one-time confirmation link,
          // consent evidence is retained as pending but cannot authorize room,
          // reminders, Telegram, marketing or admin workflows.
          consent: false,
          marketingConsent: false,
          marketingEmailConsent: false,
          marketingTelegramConsent: false,
          consentAt: null,
          marketingConsentAt: null,
          marketingEmailConsentAt: null,
          marketingTelegramConsentAt: null,
          consentPolicyVersion: null,
          consentIpHash: null,
          source: clean(data.source),
          utmSource: clean(data.utmSource),
          utmMedium: clean(data.utmMedium),
          utmCampaign: clean(data.utmCampaign),
          utmContent: clean(data.utmContent),
          utmTerm: clean(data.utmTerm),
          firstSeenAt,
        };
        const lead = existingLead
          ? await (async () => {
              await acquireLeadSecurityLock(tx, existingLead.id);
              // An anonymization may have committed after the public/authenticated
              // pre-read. Match the original identity as a CAS tombstone check so a
              // delayed registration cannot restore PII, consent, tokens or status.
              const updated = await tx.lead.updateMany({
                where: { id: existingLead.id, email },
                data: existingLeadUpdate,
              });
              if (updated.count !== 1) {
                throw new LeadIdentityChangedError();
              }
              return tx.lead.findUniqueOrThrow({ where: { id: existingLead.id } });
            })()
          : await tx.lead.create({ data: newLead });

        const registration = await tx.registration.upsert({
          where: {
            leadId_webinarSessionId: {
              leadId: lead.id,
              webinarSessionId: session.id,
            },
          },
          update: {
            status: registrationStatus,
            emailVerifiedAt: issueImmediateParticipantSession ? now : null,
            ...(issueImmediateParticipantSession ? { pendingMetadataJson: Prisma.DbNull } : {}),
            ...(issueImmediateParticipantSession ? { accessTokenHash: sessionTokenHash } : {}),
          },
          create: {
            leadId: lead.id,
            webinarSessionId: session.id,
            // This required legacy column is not an authentication source. For
            // an unverified registration it receives an unreachable random hash;
            // the email worker later stores only a one-time token hash.
            accessTokenHash: issueImmediateParticipantSession ? sessionTokenHash : hashToken(createAccessToken()),
            status: registrationStatus,
            emailVerifiedAt: issueImmediateParticipantSession ? now : null,
            pendingMetadataJson: issueImmediateParticipantSession || !clientsProblem ? undefined : { clientsProblem },
          },
        });

        await tx.consentRecord.create({
          data: {
            ...consentEvidenceData(PERSONAL_DATA_CONSENT, {
              leadId: lead.id,
              registrationId: registration.id,
              email,
              kind: 'personal_data',
              sourceForm: '/crisis_premium/register.html',
              req,
              occurredAt: consentGivenAt,
            }),
            action: issueImmediateParticipantSession ? 'grant' : 'pending_verification',
          },
        });
        await tx.legalAcceptance.create({
          data: legalAcceptanceEvidenceData({
            leadId: lead.id,
            registrationId: registration.id,
            email,
            sourceForm: '/crisis_premium/register.html',
            req,
            acceptedAt: consentGivenAt,
          }),
        });
        if (data.marketingEmailConsent) {
          await tx.consentRecord.create({
            data: {
              ...consentEvidenceData(MARKETING_EMAIL_CONSENT, {
                leadId: lead.id,
                registrationId: registration.id,
                email,
                kind: 'marketing_email',
                sourceForm: '/crisis_premium/register.html',
                req,
                occurredAt: consentGivenAt,
              }),
              action: issueImmediateParticipantSession ? 'grant' : 'pending_verification',
            },
          });
        }
        if (data.marketingTelegramConsent) {
          await tx.consentRecord.create({
            data: {
              ...consentEvidenceData(MARKETING_TELEGRAM_CONSENT, {
                leadId: lead.id,
                registrationId: registration.id,
                email,
                kind: 'marketing_telegram',
                sourceForm: '/crisis_premium/register.html',
                req,
                occurredAt: consentGivenAt,
              }),
              action: issueImmediateParticipantSession ? 'grant' : 'pending_verification',
            },
          });
        }

        await tx.registrationToken.deleteMany({
          where: {
            registrationId: registration.id,
            purpose: ROOM_SESSION_TOKEN_PURPOSE,
            expiresAt: { lt: new Date() },
          },
        });

        if (issueImmediateParticipantSession && telegramStartTokenHash) {
          await tx.registrationToken.create({
            data: {
              registrationId: registration.id,
              tokenHash: telegramStartTokenHash,
              purpose: TELEGRAM_START_TOKEN_PURPOSE,
              expiresAt: linkTokenExpiresAt,
            },
          });
        }

        if (issueImmediateParticipantSession) {
          await tx.registrationToken.create({
            data: {
              registrationId: registration.id,
              tokenHash: sessionTokenHash,
              purpose: ROOM_SESSION_TOKEN_PURPOSE,
              expiresAt: sessionExpiresAt,
            },
          });
        }

        if (env.EMAIL_MODE === 'send') {
          await enqueueRegistrationEmail(tx, {
            registrationId: registration.id,
            webinarSessionId: session.id,
            toEmail: lead.email,
            toName: lead.name,
            scheduledAt: session.scheduledAt,
          });
        }

        return { lead, registration };
      });

    // Два одновременных запроса нового email могут оба пройти предварительную
    // проверку. Уникальный индекс email оставляет победителя; проигравший не
    // превращается в update/upsert и проходит тот же подтверждённый recovery flow.
    const transactionResult = await persistRegistration().catch(async error => {
      if (error instanceof LeadIdentityChangedError) {
        await queueParticipantLoginForEmail(email, req);
        await sendGenericEmailResponse(res, 'registration');
        return null;
      }
      // Only a unique-key collision can mean that another request created this
      // email between our read and transaction. Never turn unrelated database
      // failures into a misleading successful recovery response.
      if (existingLead || !isPrismaUniqueConstraintError(error)) {
        throw error;
      }
      const racedLead = await prisma.lead.findUnique({ where: { email }, select: { id: true } });
      if (!racedLead) {
        throw error;
      }

      await queueParticipantLoginForEmail(email, req);
      await sendGenericEmailResponse(res, 'registration');
      return null;
    });
    if (!transactionResult) {
      return;
    }
    const { lead, registration } = transactionResult;

    if (!issueImmediateParticipantSession) {
      await sendGenericEmailResponse(res, 'registration');
      return;
    }

    await saveEventSafely(
      {
        eventName: 'registration_submit',
        req,
        registration,
        page: '/crisis_premium/register.html',
        metadata: { clientsProblem: clean(data.clientsProblem) },
        source: clean(data.source),
        utmSource: clean(data.utmSource),
        utmMedium: clean(data.utmMedium),
        utmCampaign: clean(data.utmCampaign),
      },
      'authenticated_registration',
    );

    notifySafely(
      notifyRegistration({
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        city: lead.city,
        professionalStatus: lead.professionalStatus,
        scheduledAt: session.scheduledAt,
        source: clean(data.source),
        adminUrl: buildFrontendUrl('/admin'),
      }),
    );

    setRoomTokenCookie(res, sessionToken, sessionExpiresAt);
    res.status(201).json({
      ok: true,
      successUrl,
      webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      telegramUrl: publicTelegramUrl(),
      telegramBotUrl: telegramStartToken ? buildTelegramStartUrl(telegramStartToken) : publicTelegramUrl(),
      emailDeliveryAvailable: env.EMAIL_MODE === 'send',
      registration: {
        id: registration.id,
        scheduledAt: session.scheduledAt.toISOString(),
        status: registration.status,
      },
    });
  }),
);

type WebinarTimingForAccess = {
  scheduledAt: Date;
  durationMinutes: number;
  videoDurationSeconds?: number | null;
  replayAvailableHours: number;
  roomOpenBeforeMinutes: number;
  replayEnabled: boolean;
};

function getAccessStatusForTiming(webinarSession: WebinarTimingForAccess, now: Date) {
  return getWebinarAccess(
    now,
    webinarSession.scheduledAt,
    getEffectiveVideoDurationMinutes(webinarSession),
    webinarSession.replayAvailableHours,
    webinarSession.roomOpenBeforeMinutes,
    webinarSession.replayEnabled,
  ).accessStatus;
}

function pickRestorableRegistration<T extends { webinarSession: WebinarTimingForAccess }>(
  registrations: T[],
  now: Date,
) {
  const restorable = registrations.map(registration => ({
    registration,
    accessStatus: getAccessStatusForTiming(registration.webinarSession, now),
  }));

  if (!restorable.length) {
    return null;
  }

  const upcoming = restorable
    .filter(item => item.registration.webinarSession.scheduledAt >= now)
    .sort(
      (left, right) =>
        left.registration.webinarSession.scheduledAt.getTime() -
        right.registration.webinarSession.scheduledAt.getTime(),
    );
  if (upcoming[0]) {
    return upcoming[0].registration;
  }

  const active = restorable
    .filter(item => item.accessStatus !== 'closed')
    .sort(
      (left, right) =>
        right.registration.webinarSession.scheduledAt.getTime() -
        left.registration.webinarSession.scheduledAt.getTime(),
    );
  if (active[0]) {
    return active[0].registration;
  }

  return restorable.sort(
    (left, right) =>
      right.registration.webinarSession.scheduledAt.getTime() - left.registration.webinarSession.scheduledAt.getTime(),
  )[0].registration;
}

async function findRestorableRegistrationByEmail(email: string) {
  const lead = await prisma.lead.findUnique({
    where: { email },
    include: {
      registrations: {
        where: {
          OR: [
            { status: 'registered', emailVerifiedAt: { not: null } },
            { status: 'pending_verification', emailVerifiedAt: null },
          ],
        },
        include: {
          lead: true,
          webinarSession: true,
        },
        orderBy: { registeredAt: 'desc' },
      },
    },
  });

  if (!lead) {
    return null;
  }

  const verifiedRegistrations = lead.registrations.filter(
    registration => registration.status === 'registered' && registration.emailVerifiedAt,
  );
  return (
    pickRestorableRegistration(verifiedRegistrations, new Date()) ??
    lead.registrations.find(
      registration => registration.status === 'pending_verification' && !registration.emailVerifiedAt,
    ) ??
    null
  );
}

async function queueParticipantLoginForEmail(email: string, req: Request) {
  const registration = await findRestorableRegistrationByEmail(email);
  if (!registration || env.EMAIL_MODE !== 'send') {
    return false;
  }

  const now = new Date();
  const registeredAccess = buildAccessPayload(registration, now);
  const fallbackDailySession =
    registeredAccess.accessStatus === 'closed'
      ? await findOrCreateWebinarSession(getDailyBroadcastDate(now), now)
      : registration.webinarSession;

  const queuedRegistration = await prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, registration.leadId);
    const currentRegistration = await tx.registration.findUnique({
      where: { id: registration.id },
      include: { lead: true, webinarSession: true },
    });
    if (
      !currentRegistration ||
      currentRegistration.leadId !== registration.leadId ||
      currentRegistration.lead.email.toLowerCase() !== email
    ) {
      return null;
    }

    const isPendingConfirmation =
      currentRegistration.status === 'pending_verification' &&
      !currentRegistration.emailVerifiedAt &&
      isLeadIdentityActive(currentRegistration.lead);
    const isVerifiedParticipant = isParticipantRegistrationActive(currentRegistration);
    if (!isPendingConfirmation && !isVerifiedParticipant) {
      return null;
    }

    // A verified participant can legitimately recover access long after the
    // session stored on the original Registration has closed. The room route
    // resolves that registration to the current daily/replay session, so the
    // recovery email must describe the same session instead of advertising an
    // obsolete date from the historical registration.
    const currentAccess = buildAccessPayload(currentRegistration, now);
    const deliverySession =
      isVerifiedParticipant && currentAccess.accessStatus === 'closed'
        ? fallbackDailySession
        : currentRegistration.webinarSession;
    const enqueue = isPendingConfirmation ? enqueueRegistrationEmail : enqueueParticipantLoginEmail;
    await enqueue(tx, {
      registrationId: currentRegistration.id,
      webinarSessionId: deliverySession.id,
      toEmail: currentRegistration.lead.email,
      toName: currentRegistration.lead.name,
      scheduledAt: deliverySession.scheduledAt,
    });

    return {
      registration: currentRegistration,
      webinarSessionId: deliverySession.id,
      kind: isPendingConfirmation ? ('confirmation' as const) : ('login' as const),
    };
  });

  if (!queuedRegistration) {
    return false;
  }

  if (queuedRegistration.kind === 'login') {
    await saveEventSafely(
      {
        eventName: 'participant_login_request',
        req,
        registration: queuedRegistration.registration,
        page: '/crisis_premium/access.html',
        webinarSessionId: queuedRegistration.webinarSessionId,
      },
      'participant_login_enqueue',
    );
  }
  return true;
}

async function createTelegramStartTokenForActiveRegistration(registrationId: string, expiresAt: Date) {
  return prisma.$transaction(async tx => {
    const registrationRef = await tx.registration.findUnique({
      where: { id: registrationId },
      select: { leadId: true },
    });
    if (!registrationRef) return null;

    await acquireLeadSecurityLock(tx, registrationRef.leadId);
    const activeRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      include: { lead: true },
    });
    if (!activeRegistration || !isParticipantRegistrationActive(activeRegistration)) {
      return null;
    }

    return createTelegramStartToken(tx, { registrationId, expiresAt });
  });
}

registrationRouter.post(
  '/participant/login/request',
  asyncHandler(async (req, res) => {
    const data = participantLoginRequestSchema.parse(req.body);
    const email = data.email.toLowerCase();
    await queueParticipantLoginForEmail(email, req);

    await sendGenericEmailResponse(res, 'login');
  }),
);

registrationRouter.post(
  '/registration/exchange',
  asyncHandler(async (req, res) => {
    const { token } = exchangeBodySchema.parse(req.body);
    await exchangeRegistrationToken(token, req, res);
  }),
);

registrationRouter.post(
  '/participant/login/consume',
  asyncHandler(async (req, res) => {
    const { token } = exchangeBodySchema.parse(req.body);
    await exchangeRegistrationToken(token, req, res, [PARTICIPANT_LOGIN_TOKEN_PURPOSE]);
  }),
);

registrationRouter.post(
  '/registration/exchange/:token',
  asyncHandler(async (req, res) => {
    // Legacy endpoint kept temporarily for old email/Telegram links and clients.
    const token = z.string().min(20).parse(req.params.token);
    await exchangeRegistrationToken(token, req, res);
  }),
);

async function sendRegistrationState(req: Request, res: Response) {
  const view = z.enum(['success', 'room']).optional().parse(req.query.view);
  const registration = await findRegistrationForRequest(req);

  if (!registration) {
    throw new AppError(404, 'Registration not found');
  }

  const now = new Date();
  const access =
    view === 'room' ? await buildDailyRoomAccessPayload(registration, now) : buildAccessPayload(registration, now);
  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  await refreshRoomTokenSession(req, res, registration.id, now);

  if (view === 'success' && !registration.successViewedAt) {
    await prisma.registration.updateMany({
      where: { id: registration.id, status: 'registered' },
      data: { successViewedAt: now },
    });
    await saveEventSafely(
      { eventName: 'registration_success', req, page: '/crisis_premium/success.html' },
      'registration_success_view',
    );
  }

  if (view === 'room') {
    if (access.canViewRoom) {
      await prisma.registration.updateMany({
        where: { id: registration.id, status: 'registered' },
        data: { roomEnteredAt: registration.roomEnteredAt ?? now },
      });
      await saveEventSafely(
        {
          eventName: access.canEnterRoom ? 'webinar_room_open' : 'webinar_room_waiting',
          req,
          page: '/crisis_premium/webinar.html',
          webinarSessionId: access.webinarSession.id,
        },
        'room_state',
      );
    } else if (access.accessStatus === 'waiting' || access.accessStatus === 'pre_live') {
      await saveEventSafely(
        {
          eventName: 'webinar_room_waiting',
          req,
          page: '/crisis_premium/webinar.html',
          webinarSessionId: access.webinarSession.id,
        },
        'room_waiting',
      );
    }
  }

  const telegramStartToken =
    view === 'success'
      ? await createTelegramStartTokenForActiveRegistration(registration.id, access.replayExpiresAt)
      : null;
  const telegramBotUrl =
    view === 'success' && telegramStartToken ? buildTelegramStartUrl(telegramStartToken) : buildTelegramStartUrl();

  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    roomState: getWebinarRoomState(access),
    replayExpiresAt: access.replayExpiresAt.toISOString(),
    roomOpensAt: access.roomOpensAt.toISOString(),
    canEnterRoom: access.canEnterRoom,
    canViewRoom: access.canViewRoom,
    liveState: {
      scheduledAt: liveState.scheduledAt.toISOString(),
      durationSeconds: liveState.durationSeconds,
      liveOffsetSeconds: liveState.liveOffsetSeconds,
      elapsedSeconds: liveState.elapsedSeconds,
      isStarted: liveState.isStarted,
      isEnded: liveState.isEnded,
      status: liveState.status,
      chatStatus: liveState.chatStatus,
    },
    telegramUrl: publicTelegramUrl(),
    telegramBotUrl,
    accessUrl: buildFrontendUrl('/crisis_premium/access.html'),
    webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
    lead: {
      name: registration.lead.name,
      email: registration.lead.email,
      phone: registration.lead.phone,
      city: registration.lead.city,
      professionalStatus: registration.lead.professionalStatus,
    },
    registration: {
      id: registration.id,
      registeredAt: registration.registeredAt.toISOString(),
      status: registration.status,
      crmStatus: registration.crmStatus,
    },
    webinar: {
      id: access.webinarSession.id,
      title: access.webinarSession.title,
      scheduledAt: access.webinarSession.scheduledAt.toISOString(),
      roomOpensAt: access.roomOpensAt.toISOString(),
      replayExpiresAt: access.replayExpiresAt.toISOString(),
      durationMinutes: access.webinarSession.durationMinutes,
      videoDurationSeconds: access.webinarSession.videoDurationSeconds,
      replayAvailableHours: access.webinarSession.replayAvailableHours,
      replayEnabled: access.webinarSession.replayEnabled,
      testMode: access.testMode,
      status: getWebinarRoomState(access),
      countdown: access.countdown,
    },
  });
}

async function getPublishedRecordingsCount(now: Date) {
  return prisma.webinarRecording.count({
    where: {
      visible: true,
      publishedAt: { lte: now },
    },
  });
}

registrationRouter.get(
  '/participant/access/current',
  asyncHandler(async (req, res) => {
    const registration = await findRegistrationForRequest(req);

    if (!registration) {
      throw new AppError(401, 'Participant session not found');
    }

    const now = new Date();
    const access = await buildDailyRoomAccessPayload(registration, now);
    const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
    await refreshRoomTokenSession(req, res, registration.id, now);

    const recordingCount = await getPublishedRecordingsCount(now);
    const telegramTokenExpiresAt =
      access.replayExpiresAt > now ? access.replayExpiresAt : new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const hasVerifiedTelegramBinding =
      Boolean(registration.lead.telegramChatId) &&
      registration.lead.telegramBindingVersion === TELEGRAM_BINDING_VERSION;
    const telegramBotUrl = hasVerifiedTelegramBinding
      ? buildTelegramStartUrl()
      : await (async () => {
          const telegramStartToken = await createTelegramStartTokenForActiveRegistration(
            registration.id,
            telegramTokenExpiresAt,
          );
          return telegramStartToken ? buildTelegramStartUrl(telegramStartToken) : buildTelegramStartUrl();
        })();

    res.setHeader('Cache-Control', 'private, max-age=15');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      accessStatus: access.accessStatus,
      webinarStatus: access.webinarStatus,
      roomState: getWebinarRoomState(access),
      canEnterRoom: access.canEnterRoom,
      canViewRoom: access.canViewRoom,
      roomUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      replayExpiresAt: access.replayExpiresAt.toISOString(),
      roomOpensAt: access.roomOpensAt.toISOString(),
      liveState: {
        scheduledAt: liveState.scheduledAt.toISOString(),
        durationSeconds: liveState.durationSeconds,
        liveOffsetSeconds: liveState.liveOffsetSeconds,
        elapsedSeconds: liveState.elapsedSeconds,
        isStarted: liveState.isStarted,
        isEnded: liveState.isEnded,
        status: liveState.status,
        chatStatus: liveState.chatStatus,
      },
      lead: {
        name: registration.lead.name,
        email: registration.lead.email,
      },
      registration: {
        id: registration.id,
        registeredAt: registration.registeredAt.toISOString(),
        status: registration.status,
      },
      webinar: {
        id: access.webinarSession.id,
        title: access.webinarSession.title,
        scheduledAt: access.webinarSession.scheduledAt.toISOString(),
        roomOpensAt: access.roomOpensAt.toISOString(),
        replayExpiresAt: access.replayExpiresAt.toISOString(),
        durationMinutes: access.webinarSession.durationMinutes,
        status: getWebinarRoomState(access),
        countdown: access.countdown,
      },
      telegram: {
        subscribed: hasVerifiedTelegramBinding,
        username: hasVerifiedTelegramBinding ? registration.lead.telegramUsername : null,
        firstName: hasVerifiedTelegramBinding ? registration.lead.telegramFirstName : null,
        subscribedAt:
          hasVerifiedTelegramBinding && registration.lead.telegramSubscribedAt
            ? registration.lead.telegramSubscribedAt.toISOString()
            : null,
        groupUrl: publicTelegramUrl(),
        botUrl: telegramBotUrl,
      },
      recordings: {
        available: recordingCount > 0,
        locked: false,
        count: recordingCount,
        url: buildFrontendUrl('/crisis_premium/recordings.html'),
      },
      links: {
        access: buildFrontendUrl('/crisis_premium/access.html'),
        room: buildFrontendUrl('/crisis_premium/webinar.html'),
        register: buildFrontendUrl('/crisis_premium/register.html'),
        recordings: buildFrontendUrl('/crisis_premium/recordings.html'),
      },
    });
  }),
);

registrationRouter.post(
  '/participant/logout',
  asyncHandler(async (req, res) => {
    const token = clean(req.cookies?.aspb_room_token);
    if (token) {
      await prisma.registrationToken.deleteMany({
        where: {
          tokenHash: hashToken(token),
          purpose: ROOM_SESSION_TOKEN_PURPOSE,
        },
      });
    }

    clearRoomTokenCookie(res);
    res.json({ ok: true });
  }),
);

registrationRouter.get(
  '/registration/session/current',
  asyncHandler(async (req, res) => {
    await sendRegistrationState(req, res);
  }),
);

// #10 (152-ФЗ/38-ФЗ): отписка от маркетинговых рассылок по подписанному токену.
// Двухшаговый GET: переход показывает подтверждение (устойчиво к префетчу писем),
// отписка выполняется только при ?confirm=1. CSRF не нужен — меняет состояние только подтверждённый HMAC-токен.
registrationRouter.get(
  '/unsubscribe',
  asyncHandler(async (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const email = verifyUnsubscribeToken(token);
    if (!email) {
      res.status(400).type('html').send(renderUnsubscribePage('invalid'));
      return;
    }
    if (req.query.confirm === '1') {
      const lead = await prisma.lead.findUnique({
        where: { email },
        include: {
          consentRecords: {
            where: {
              kind: 'marketing_email',
              action: 'grant',
              documentId: MARKETING_EMAIL_CONSENT.id,
            },
            orderBy: { occurredAt: 'desc' },
            take: 1,
          },
        },
      });
      if (lead) {
        const revokedAt = new Date();
        await prisma.$transaction(async tx => {
          await acquireLeadSecurityLock(tx, lead.id);
          const currentLead = await tx.lead.findUnique({
            where: { id: lead.id },
            include: {
              consentRecords: {
                where: {
                  kind: 'marketing_email',
                  action: 'grant',
                  documentId: MARKETING_EMAIL_CONSENT.id,
                },
                orderBy: { occurredAt: 'desc' },
                take: 1,
              },
            },
          });
          if (
            !currentLead ||
            currentLead.email.toLowerCase() !== email.toLowerCase() ||
            !isLeadIdentityActive(currentLead)
          ) {
            return;
          }

          await tx.lead.update({
            where: { id: currentLead.id },
            data: {
              marketingEmailConsent: false,
              marketingEmailRevokedAt: revokedAt,
              marketingEmailRevocationChannel: 'email_link',
              marketingEmailRevocationReason: 'recipient_request',
              marketingConsent: currentLead.marketingTelegramConsent,
            },
          });
          await tx.consentRecord.create({
            data: consentEvidenceData(MARKETING_EMAIL_CONSENT, {
              leadId: currentLead.id,
              email,
              kind: 'marketing_email',
              action: 'revoke',
              sourceForm: '/api/unsubscribe',
              req,
              occurredAt: revokedAt,
              revocationChannel: 'email_link',
              revocationReason: 'recipient_request',
              revokedConsentId: currentLead.consentRecords[0]?.id,
            }),
          });
        });
      }
      res.type('html').send(renderUnsubscribePage('done'));
      return;
    }
    res.type('html').send(renderUnsubscribePage('confirm', token));
  }),
);

function renderUnsubscribePage(state: 'invalid' | 'confirm' | 'done', token?: string) {
  const title =
    state === 'done' ? 'Вы отписаны' : state === 'invalid' ? 'Ссылка недействительна' : 'Отписка от рассылок АСПБ';
  const body =
    state === 'done'
      ? '<p>Вы отписаны от маркетинговых рассылок АСПБ. Организационные письма о вашем вебинаре это не затрагивает.</p>'
      : state === 'invalid'
        ? '<p>Ссылка недействительна или устарела. Чтобы отписаться, напишите на <a href="mailto:partners@aspb.ru">partners@aspb.ru</a>.</p>'
        : `<p>Нажмите кнопку, чтобы отписаться от маркетинговых рассылок АСПБ.</p>
           <p><a class="btn" href="/api/unsubscribe?token=${encodeURIComponent(token ?? '')}&amp;confirm=1">Отписаться</a></p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} | АСПБ</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f8f9fa;color:#041627;line-height:1.6}
main{max-width:520px;margin:0 auto;padding:64px 24px}
.card{background:#fff;border:1px solid #dbe2ea;border-radius:18px;padding:32px}
h1{font-size:24px;margin-top:0}a{color:#041627}
.btn{display:inline-block;background:#041627;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700}
</style></head><body><main><div class="card"><h1>${title}</h1>${body}</div></main></body></html>`;
}
