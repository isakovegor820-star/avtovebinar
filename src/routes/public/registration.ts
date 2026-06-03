import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { createAccessToken, hashToken } from '../../lib/tokens.js';
import { getNextWebinarDate } from '../../lib/time.js';
import { getWebinarLiveState } from '../../lib/webinarLive.js';
import { enqueueRegistrationEmail } from '../../lib/emailOutbox.js';
import { buildTelegramStartUrl, notifyRegistration } from '../../lib/telegram.js';
import { findOrCreateWebinarSession } from '../../lib/webinarSessions.js';
import {
  buildAccessPayload,
  buildFrontendUrl,
  clean,
  findRegistrationByToken,
  findRegistrationForRequest,
  getFirstSeen,
  getRoomTokenExpiresAt,
  notifySafely,
  ROOM_EXCHANGE_TOKEN_PURPOSE,
  ROOM_SESSION_TOKEN_PURPOSE,
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
  city: z.string().trim().max(120).optional().or(z.literal('')),
  professionalStatus: z.string().trim().max(120).optional().or(z.literal('')),
  status: z.string().trim().max(120).optional().or(z.literal('')),
  clientsProblem: z.string().trim().max(120).optional().or(z.literal('')),
  consent: z.coerce.boolean().refine(value => value === true, 'Consent is required'),
  marketingConsent: z.coerce.boolean().optional().default(false),
  ...utmSchema,
});

registrationRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const professionalStatus = clean(data.professionalStatus) ?? clean(data.status);

    const email = data.email.toLowerCase();
    const exchangeToken = createAccessToken();
    const sessionToken = createAccessToken();
    const exchangeTokenHash = hashToken(exchangeToken);
    const sessionTokenHash = hashToken(sessionToken);
    const tokenExpiresAt = getRoomTokenExpiresAt(session);
    const webinarUrl = buildFrontendUrl('/crisis_premium/webinar.html', exchangeToken);
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
          purpose: { in: [ROOM_EXCHANGE_TOKEN_PURPOSE, ROOM_SESSION_TOKEN_PURPOSE] },
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
        webinarUrl,
        partnerUrl: `${webinarUrl}#partnerApplication`,
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
      telegramBotUrl: buildTelegramStartUrl(),
      registration: {
        id: registration.id,
        scheduledAt: session.scheduledAt.toISOString(),
        status: registration.status,
      },
    });
  }),
);

registrationRouter.post(
  '/registration/exchange/:token',
  asyncHandler(async (req, res) => {
    const token = z.string().min(20).parse(req.params.token);
    const registration = await findRegistrationByToken(token);

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    const exchangeTokenHash = hashToken(token);
    const tokenRecord = await prisma.registrationToken.findUnique({
      where: { tokenHash: exchangeTokenHash },
    });

    if (!tokenRecord || tokenRecord.purpose === ROOM_SESSION_TOKEN_PURPOSE) {
      throw new AppError(404, 'Registration not found');
    }

    const sessionToken = createAccessToken();
    const sessionTokenHash = hashToken(sessionToken);
    const tokenExpiresAt = tokenRecord.expiresAt ?? getRoomTokenExpiresAt(registration.webinarSession);

    await prisma.$transaction(async tx => {
      await tx.registrationToken.deleteMany({
        where: { id: tokenRecord.id },
      });

      await tx.registrationToken.deleteMany({
        where: {
          registrationId: registration.id,
          purpose: ROOM_SESSION_TOKEN_PURPOSE,
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

      await tx.registration.update({
        where: { id: registration.id },
        data: { accessTokenHash: sessionTokenHash },
      });
    });

    setRoomTokenCookie(res, sessionToken, tokenExpiresAt);
    res.json({
      ok: true,
      successUrl: buildFrontendUrl('/crisis_premium/success.html'),
      webinarUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      expiresAt: tokenExpiresAt.toISOString(),
    });
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
  const liveState = getWebinarLiveState(now, registration.webinarSession, { testMode: access.testMode });
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

  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
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
    telegramBotUrl: buildTelegramStartUrl(),
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
      id: registration.webinarSession.id,
      title: registration.webinarSession.title,
      scheduledAt: registration.webinarSession.scheduledAt.toISOString(),
      roomOpensAt: access.roomOpensAt.toISOString(),
      replayExpiresAt: access.replayExpiresAt.toISOString(),
      durationMinutes: registration.webinarSession.durationMinutes,
      videoDurationSeconds: registration.webinarSession.videoDurationSeconds,
      replayAvailableHours: registration.webinarSession.replayAvailableHours,
      replayEnabled: registration.webinarSession.replayEnabled,
      testMode: access.testMode,
      status: liveState.status,
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
