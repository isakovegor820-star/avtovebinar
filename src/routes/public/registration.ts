import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { createAccessToken, hashToken } from '../../lib/tokens.js';
import {
  getNextWebinarDate,
  getSessionStatus,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
  WEBINAR_TITLE,
} from '../../lib/time.js';
import { sendRegistrationEmail } from '../../lib/email.js';
import { WEBINAR_VIDEO_PATH } from '../../lib/webinarTimeline.js';
import { buildTelegramStartUrl, notifyRegistration } from '../../lib/telegram.js';
import {
  buildAccessPayload,
  buildFrontendUrl,
  clean,
  findRegistrationForRequest,
  getFirstSeen,
  getRoomTokenExpiresAt,
  notifySafely,
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

async function findOrCreateWebinarSession(scheduledAt: Date) {
  const now = new Date();
  const status = getSessionStatus(now, scheduledAt, WEBINAR_DURATION_MINUTES);

  return prisma.webinarSession.upsert({
    where: { scheduledAt },
    update: {
      status,
      videoUrl: WEBINAR_VIDEO_PATH,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
    },
    create: {
      title: WEBINAR_TITLE,
      scheduledAt,
      durationMinutes: WEBINAR_DURATION_MINUTES,
      videoUrl: WEBINAR_VIDEO_PATH,
      videoDurationSeconds: 568,
      roomOpenBeforeMinutes: 15,
      replayAvailableHours: WEBINAR_REPLAY_HOURS,
      replayEnabled: true,
      liveMode: 'simulated',
      status,
    },
  });
}

registrationRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const professionalStatus = clean(data.professionalStatus) ?? clean(data.status);

    const existingLead = await prisma.lead.findUnique({
      where: { email: data.email.toLowerCase() },
    });

    let lead;
    if (existingLead) {
      lead = await prisma.lead.update({
        where: { id: existingLead.id },
        data: {
          name: existingLead.name || data.name,
          phone: existingLead.phone || data.phone,
          city: clean(data.city) ?? existingLead.city,
          professionalStatus: professionalStatus ?? existingLead.professionalStatus,
          consent: data.consent,
          marketingConsent: data.marketingConsent || existingLead.marketingConsent,
          source: clean(data.source) ?? existingLead.source,
          utmSource: clean(data.utmSource) ?? existingLead.utmSource,
          utmMedium: clean(data.utmMedium) ?? existingLead.utmMedium,
          utmCampaign: clean(data.utmCampaign) ?? existingLead.utmCampaign,
          utmContent: clean(data.utmContent) ?? existingLead.utmContent,
          utmTerm: clean(data.utmTerm) ?? existingLead.utmTerm,
        },
      });
    } else {
      lead = await prisma.lead.create({
        data: {
          name: data.name,
          phone: data.phone,
          email: data.email.toLowerCase(),
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
    }

    const token = createAccessToken();
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        accessTokenHash: hashToken(token),
        status: 'registered',
      },
    });
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(token),
        purpose: 'registration',
        expiresAt: getRoomTokenExpiresAt(session),
      },
    });

    const webinarUrl = buildFrontendUrl('/crisis_premium/webinar.html', token);
    const successUrl = buildFrontendUrl('/crisis_premium/success.html', token);
    setRoomTokenCookie(res, token, getRoomTokenExpiresAt(session));
    await sendRegistrationEmail({
      to: lead.email,
      name: lead.name,
      scheduledAt: session.scheduledAt,
      webinarUrl,
      partnerUrl: `${webinarUrl}#partnerApplication`,
    });

    await prisma.registration.update({
      where: { id: registration.id },
      data: { emailSentAt: new Date(), confirmationSentAt: new Date() },
    });

    await saveEvent({
      eventName: 'registration_submit',
      req,
      token,
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
      token,
      successUrl,
      webinarUrl,
      telegramUrl: env.TELEGRAM_GROUP_URL,
      telegramBotUrl: buildTelegramStartUrl(token),
      registration: {
        id: registration.id,
        scheduledAt: session.scheduledAt.toISOString(),
        status: registration.status,
      },
    });
  }),
);

async function sendRegistrationState(req: Request, res: Response, token?: string | null) {
  const view = z.enum(['success', 'room']).optional().parse(req.query.view);
  const registration = await findRegistrationForRequest(req, token);

  if (!registration) {
    throw new AppError(404, 'Registration not found');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  const requestToken = clean(token) ?? clean(req.cookies?.aspb_room_token);
  const explicitToken = clean(token);
  const tokenForLinks = explicitToken ?? (env.NODE_ENV === 'production' ? null : requestToken);
  if (requestToken) {
    setRoomTokenCookie(res, requestToken, access.replayExpiresAt);
  }

  if (view === 'success' && !registration.successViewedAt) {
    await prisma.registration.update({
      where: { id: registration.id },
      data: { successViewedAt: now },
    });
    await saveEvent({ eventName: 'registration_success', req, token, page: '/crisis_premium/success.html' });
  }

  if (view === 'room') {
    if (access.canEnterRoom) {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { roomEnteredAt: registration.roomEnteredAt ?? now },
      });
      await saveEvent({ eventName: 'webinar_room_open', req, token, page: '/crisis_premium/webinar.html' });
    } else if (access.accessStatus === 'waiting' || access.accessStatus === 'pre_live') {
      await saveEvent({ eventName: 'webinar_room_waiting', req, token, page: '/crisis_premium/webinar.html' });
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
    telegramUrl: env.TELEGRAM_GROUP_URL,
    telegramBotUrl: buildTelegramStartUrl(tokenForLinks || undefined),
    webinarUrl: tokenForLinks
      ? buildFrontendUrl('/crisis_premium/webinar.html', tokenForLinks)
      : buildFrontendUrl('/crisis_premium/webinar.html'),
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
      status: access.webinarStatus,
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

registrationRouter.get(
  '/registration/:token',
  asyncHandler(async (req, res) => {
    const token = z.string().min(20).parse(req.params.token);
    await sendRegistrationState(req, res, token);
  }),
);
