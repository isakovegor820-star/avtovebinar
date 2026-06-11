import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { createAccessToken, hashToken } from '../../lib/tokens.js';
import { getNextWebinarDate, getWebinarRoomState } from '../../lib/time.js';
import { getWebinarLiveState } from '../../lib/webinarLive.js';
import { enqueueRegistrationEmail } from '../../lib/emailOutbox.js';
import { buildTelegramStartUrl, notifyRegistration } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import { buildTokenizedFrontendUrl, createTelegramStartToken } from '../../lib/roomLinks.js';
import {
  buildAccessPayload,
  buildFrontendUrl,
  clean,
  findRegistrationForRequest,
  getFirstSeen,
  getRoomTokenExpiresAt,
  notifySafely,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
  TELEGRAM_START_TOKEN_PURPOSE,
  saveEvent,
  setRoomTokenCookie,
} from './helpers.js';

export const registrationRouter = Router();

const utmSchema = {
  source: z.string().trim().max(120).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional().or(z.literal('')),
  utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
  utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
  utmContent: z.string().trim().max(120).optional().or(z.literal('')),
  utmTerm: z.string().trim().max(120).optional().or(z.literal('')),
};

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(160),
  companyWebsite: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  professionalStatus: z.string().trim().max(120).optional().or(z.literal('')),
  status: z.string().trim().max(120).optional().or(z.literal('')),
  clientsProblem: z.string().trim().max(120).optional().or(z.literal('')),
  consent: z.coerce.boolean().refine(value => value === true, 'Consent is required'),
  marketingConsent: z.coerce.boolean().optional().default(false),
  ...utmSchema,
});

const exchangeBodySchema = z.object({
  token: z.string().min(20),
});

async function exchangeRegistrationToken(token: string, res: Response) {
  const exchangeTokenHash = hashToken(token);
  const sessionToken = createAccessToken();
  const sessionTokenHash = hashToken(sessionToken);
  const { tokenExpiresAt } = await prisma.$transaction(async tx => {
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
      tokenRecord.purpose !== ROOM_EXCHANGE_TOKEN_PURPOSE ||
      (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)
    ) {
      throw new AppError(404, 'Registration not found');
    }

    const claimedToken = await tx.registrationToken.deleteMany({
      where: {
        id: tokenRecord.id,
        tokenHash: exchangeTokenHash,
        purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (claimedToken.count !== 1) {
      throw new AppError(404, 'Registration not found');
    }

    const tokenExpiresAt = tokenRecord.expiresAt ?? getRoomTokenExpiresAt(tokenRecord.registration.webinarSession);

    await tx.registrationToken.create({
      data: {
        registrationId: tokenRecord.registrationId,
        tokenHash: sessionTokenHash,
        purpose: ROOM_SESSION_TOKEN_PURPOSE,
        expiresAt: tokenExpiresAt,
      },
    });

    await tx.registration.update({
      where: { id: tokenRecord.registrationId },
      data: { accessTokenHash: sessionTokenHash },
    });

    return { tokenExpiresAt };
  });

  setRoomTokenCookie(res, sessionToken, tokenExpiresAt);
  res.json({
    ok: true,
    successUrl: buildFrontendUrl('/crisis_premium/success.html'),
    webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
    expiresAt: tokenExpiresAt.toISOString(),
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
        telegramUrl: env.TELEGRAM_GROUP_URL,
      });
      return;
    }

    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const professionalStatus = clean(data.professionalStatus) ?? clean(data.status);

    const email = data.email.toLowerCase();
    const exchangeToken = createAccessToken();
    const partnerExchangeToken = createAccessToken();
    const telegramStartToken = createAccessToken();
    const sessionToken = createAccessToken();
    const exchangeTokenHash = hashToken(exchangeToken);
    const partnerExchangeTokenHash = hashToken(partnerExchangeToken);
    const telegramStartTokenHash = hashToken(telegramStartToken);
    const sessionTokenHash = hashToken(sessionToken);
    const tokenExpiresAt = getRoomTokenExpiresAt(session);
    const emailWebinarUrl = buildTokenizedFrontendUrl('/crisis_premium/webinar.html', exchangeToken);
    const emailPartnerUrl = buildTokenizedFrontendUrl(
      '/crisis_premium/webinar.html',
      partnerExchangeToken,
      'partnerApplication',
    );
    const successUrl = buildFrontendUrl('/crisis_premium/success.html');

    const { lead, registration } = await prisma.$transaction(async tx => {
      const lead = await tx.lead.upsert({
        where: { email },
        update: {
          name: data.name,
          phone: data.phone,
          city: clean(data.city) ?? undefined,
          professionalStatus: professionalStatus ?? undefined,
          consent: data.consent,
          marketingConsent: data.marketingConsent ? true : undefined,
          source: clean(data.source) ?? undefined,
          utmSource: clean(data.utmSource) ?? undefined,
          utmMedium: clean(data.utmMedium) ?? undefined,
          utmCampaign: clean(data.utmCampaign) ?? undefined,
          utmContent: clean(data.utmContent) ?? undefined,
          utmTerm: clean(data.utmTerm) ?? undefined,
        },
        create: {
          name: data.name,
          phone: data.phone,
          email,
          city: clean(data.city),
          professionalStatus,
          consent: data.consent,
          marketingConsent: data.marketingConsent,
          source: clean(data.source),
          utmSource: clean(data.utmSource),
          utmMedium: clean(data.utmMedium),
          utmCampaign: clean(data.utmCampaign),
          utmContent: clean(data.utmContent),
          utmTerm: clean(data.utmTerm),
          firstSeenAt,
        },
      });

      const registration = await tx.registration.upsert({
        where: {
          leadId_webinarSessionId: {
            leadId: lead.id,
            webinarSessionId: session.id,
          },
        },
        update: {
          accessTokenHash: sessionTokenHash,
          status: 'registered',
        },
        create: {
          leadId: lead.id,
          webinarSessionId: session.id,
          accessTokenHash: sessionTokenHash,
          status: 'registered',
        },
      });

      await tx.registrationToken.deleteMany({
        where: {
          registrationId: registration.id,
        },
      });

      await tx.registrationToken.create({
        data: {
          registrationId: registration.id,
          tokenHash: exchangeTokenHash,
          purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
          expiresAt: tokenExpiresAt,
        },
      });

      await tx.registrationToken.create({
        data: {
          registrationId: registration.id,
          tokenHash: partnerExchangeTokenHash,
          purpose: ROOM_EXCHANGE_TOKEN_PURPOSE,
          expiresAt: tokenExpiresAt,
        },
      });

      await tx.registrationToken.create({
        data: {
          registrationId: registration.id,
          tokenHash: telegramStartTokenHash,
          purpose: TELEGRAM_START_TOKEN_PURPOSE,
          expiresAt: tokenExpiresAt,
        },
      });

      await tx.registrationToken.create({
        data: {
          registrationId: registration.id,
          tokenHash: sessionTokenHash,
          purpose: ROOM_SESSION_TOKEN_PURPOSE,
          expiresAt: tokenExpiresAt,
        },
      });

      await enqueueRegistrationEmail(tx, {
        registrationId: registration.id,
        webinarSessionId: session.id,
        toEmail: lead.email,
        toName: lead.name,
        scheduledAt: session.scheduledAt,
        webinarUrl: emailWebinarUrl,
        partnerUrl: emailPartnerUrl,
      });

      return { lead, registration };
    });

    setRoomTokenCookie(res, sessionToken, tokenExpiresAt);

    await saveEvent({
      eventName: 'registration_submit',
      req,
      registration,
      page: '/crisis_premium/register.html',
      metadata: { clientsProblem: clean(data.clientsProblem) },
      source: clean(data.source),
      utmSource: clean(data.utmSource),
      utmMedium: clean(data.utmMedium),
      utmCampaign: clean(data.utmCampaign),
    });

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

    res.status(201).json({
      ok: true,
      successUrl,
      webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      telegramUrl: env.TELEGRAM_GROUP_URL,
      telegramBotUrl: buildTelegramStartUrl(telegramStartToken),
      registration: {
        id: registration.id,
        scheduledAt: session.scheduledAt.toISOString(),
        status: registration.status,
      },
    });
  }),
);

registrationRouter.post(
  '/registration/exchange',
  asyncHandler(async (req, res) => {
    const { token } = exchangeBodySchema.parse(req.body);
    await exchangeRegistrationToken(token, res);
  }),
);

registrationRouter.post(
  '/registration/exchange/:token',
  asyncHandler(async (req, res) => {
    // Legacy endpoint kept temporarily for old email/Telegram links and clients.
    const token = z.string().min(20).parse(req.params.token);
    await exchangeRegistrationToken(token, res);
  }),
);

async function sendRegistrationState(req: Request, res: Response) {
  const view = z.enum(['success', 'room']).optional().parse(req.query.view);
  const registration = await findRegistrationForRequest(req);

  if (!registration) {
    throw new AppError(404, 'Registration not found');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
  const requestToken = clean(req.cookies?.aspb_room_token);
  if (requestToken) {
    setRoomTokenCookie(res, requestToken, access.replayExpiresAt);
  }

  if (view === 'success' && !registration.successViewedAt) {
    await prisma.registration.update({
      where: { id: registration.id },
      data: { successViewedAt: now },
    });
    await saveEvent({ eventName: 'registration_success', req, page: '/crisis_premium/success.html' });
  }

  if (view === 'room') {
    if (access.canViewRoom) {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { roomEnteredAt: registration.roomEnteredAt ?? now },
      });
      await saveEvent({
        eventName: access.canEnterRoom ? 'webinar_room_open' : 'webinar_room_waiting',
        req,
        page: '/crisis_premium/webinar.html',
      });
    } else if (access.accessStatus === 'waiting' || access.accessStatus === 'pre_live') {
      await saveEvent({ eventName: 'webinar_room_waiting', req, page: '/crisis_premium/webinar.html' });
    }
  }

  const telegramBotUrl =
    view === 'success'
      ? buildTelegramStartUrl(
          await prisma.$transaction(tx =>
            createTelegramStartToken(tx, {
              registrationId: registration.id,
              expiresAt: access.replayExpiresAt,
            }),
          ),
        )
      : buildTelegramStartUrl();

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
    telegramUrl: env.TELEGRAM_GROUP_URL,
    telegramBotUrl,
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

registrationRouter.get(
  '/registration/session/current',
  asyncHandler(async (req, res) => {
    await sendRegistrationState(req, res);
  }),
);
