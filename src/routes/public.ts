import { Router, type Request, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { AppError, asyncHandler, getClientIp } from '../lib/http.js';
import { env } from '../lib/env.js';
import { createAccessToken, hashIp, hashToken } from '../lib/tokens.js';
import {
  getCountdown,
  getNextWebinarDate,
  getReplayExpiresAt,
  getSessionStatus,
  getWebinarAccess,
  parseFirstSeenCookie,
  WEBINAR_DURATION_MINUTES,
  WEBINAR_REPLAY_HOURS,
  WEBINAR_TITLE
} from '../lib/time.js';
import { sendRegistrationEmail } from '../lib/email.js';
import {
  DEFAULT_TIMELINE_EVENTS,
  WEBINAR_VIDEO_PATH
} from '../lib/webinarTimeline.js';
import { buildTelegramStartUrl, notifyPartnerApplication, notifyQuestion, notifyRegistration } from '../lib/telegram.js';
import { PUBLIC_ANALYTICS_EVENTS } from '../lib/events.js';

export const publicRouter = Router();

function roomAccessError(accessStatus: string) {
  if (accessStatus === 'waiting' || accessStatus === 'pre_live') {
    return new AppError(423, 'Webinar has not started yet');
  }

  return new AppError(403, 'Replay access has expired');
}

const utmSchema = {
  source: z.string().trim().max(120).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional().or(z.literal('')),
  utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
  utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
  utmContent: z.string().trim().max(120).optional().or(z.literal('')),
  utmTerm: z.string().trim().max(120).optional().or(z.literal(''))
};

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(160),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  professionalStatus: z.string().trim().max(120).optional().or(z.literal('')),
  status: z.string().trim().max(120).optional().or(z.literal('')),
  clientsProblem: z.string().trim().max(120).optional().or(z.literal('')),
  consent: z.coerce.boolean().refine(value => value === true, 'Consent is required'),
  ...utmSchema
});

const eventSchema = z.object({
  eventName: z.enum(PUBLIC_ANALYTICS_EVENTS),
  token: z.string().trim().optional(),
  page: z.string().trim().max(160).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ...utmSchema
});

const questionSchema = z.object({
  token: z.string().trim().min(20).optional().or(z.literal('')),
  text: z.string().trim().min(3).max(2000)
});

const partnerApplicationSchema = z.object({
  token: z.string().trim().min(20).optional().or(z.literal('')),
  sphere: z.string().trim().max(160).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  clientFlow: z.string().trim().max(160).optional().or(z.literal('')),
  experience: z.string().trim().max(500).optional().or(z.literal('')),
  preferredFormat: z.string().trim().max(160).optional().or(z.literal('')),
  comment: z.string().trim().max(2000).optional().or(z.literal(''))
});

function clean(value: string | undefined | null) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function setFirstSeenCookie(res: Response, firstSeenAt: Date) {
  res.cookie('aspb_first_seen_at', firstSeenAt.toISOString(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
}

function getFirstSeen(req: Request, res: Response) {
  const firstSeenAt = parseFirstSeenCookie(req.cookies?.aspb_first_seen_at) ?? new Date();
  setFirstSeenCookie(res, firstSeenAt);
  return firstSeenAt;
}

function setRoomTokenCookie(res: Response, token: string, replayExpiresAt?: Date) {
  const fallbackMaxAge = 1000 * 60 * 60 * (WEBINAR_REPLAY_HOURS + 48);
  const maxAge = replayExpiresAt ? Math.max(60 * 1000, replayExpiresAt.getTime() - Date.now()) : fallbackMaxAge;
  res.cookie('aspb_room_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge
  });
}

function getRoomTokenExpiresAt(session: { scheduledAt: Date; durationMinutes: number; replayAvailableHours: number }) {
  return getReplayExpiresAt(session.scheduledAt, session.durationMinutes, session.replayAvailableHours);
}

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
      replayEnabled: true
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
      status
    }
  });
}

async function findRegistrationByToken(token: string) {
  const accessTokenHash = hashToken(token);
  const tokenRecord = await prisma.registrationToken.findUnique({
    where: { tokenHash: accessTokenHash },
    include: {
      registration: {
        include: {
          lead: true,
          webinarSession: true
        }
      }
    }
  });

  if (!tokenRecord || (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date())) {
    if (tokenRecord?.expiresAt && tokenRecord.expiresAt < new Date()) {
      return null;
    }
    const direct = await prisma.registration.findUnique({
      where: { accessTokenHash },
      include: {
        lead: true,
        webinarSession: true
      }
    });
    return direct;
  }

  return tokenRecord.registration;
}

async function findRegistrationForRequest(req: Request, token?: string | null) {
  const requestToken = clean(token) ?? clean(req.cookies?.aspb_room_token);
  if (!requestToken) {
    return null;
  }

  return findRegistrationByToken(requestToken);
}

function buildAccessPayload(registration: NonNullable<Awaited<ReturnType<typeof findRegistrationByToken>>>, now: Date) {
  const access = getWebinarAccess(
    now,
    registration.webinarSession.scheduledAt,
    registration.webinarSession.durationMinutes,
    registration.webinarSession.replayAvailableHours,
    registration.webinarSession.roomOpenBeforeMinutes,
    registration.webinarSession.replayEnabled
  );

  if (env.NODE_ENV !== 'production' && env.WEBINAR_TEST_ROOM_MODE === 'on') {
    return {
      accessStatus: 'replay' as const,
      webinarStatus: 'test',
      roomOpensAt: now,
      replayExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      canEnterRoom: true,
      countdown: getCountdown(now, now),
      testMode: true
    };
  }

  return {
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    roomOpensAt: access.roomOpensAt,
    replayExpiresAt: access.replayExpiresAt,
    canEnterRoom: access.canEnterRoom,
    countdown: getCountdown(now, registration.webinarSession.scheduledAt),
    testMode: false
  };
}

function buildFrontendUrl(pathname: string, token?: string) {
  const url = new URL(pathname, env.PUBLIC_SITE_URL);
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function notifySafely(task: Promise<unknown>) {
  task.catch(error => {
    console.error('[ASPБ telegram notify]', error);
  });
}

async function saveEvent(input: {
  eventName: string;
  req: any;
  token?: string | null;
  page?: string;
  metadata?: Record<string, unknown>;
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
}) {
  const registration = await findRegistrationForRequest(input.req, input.token);

  await prisma.event.create({
    data: {
      eventName: input.eventName,
      leadId: registration?.leadId ?? null,
      registrationId: registration?.id ?? null,
      webinarSessionId: registration?.webinarSessionId ?? null,
      page: input.page ?? null,
      source: input.source ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      userAgent: input.req.headers['user-agent'] ?? null,
      ipHash: hashIp(getClientIp(input.req)),
      metadataJson: input.metadata as Prisma.InputJsonValue | undefined
    }
  });

  return registration;
}

publicRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aspb-autowebinar' });
});

publicRouter.get(
  '/webinar/current',
  asyncHandler(async (req, res) => {
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const serverTime = new Date();

    res.json({
      ok: true,
      serverTime: serverTime.toISOString(),
      firstSeenAt: firstSeenAt.toISOString(),
      scheduledAt: session.scheduledAt.toISOString(),
      status: getSessionStatus(serverTime, session.scheduledAt, session.durationMinutes),
      countdown: getCountdown(serverTime, session.scheduledAt),
      webinar: {
        id: session.id,
        title: session.title,
        durationMinutes: session.durationMinutes,
        videoDurationSeconds: session.videoDurationSeconds,
        roomOpenBeforeMinutes: session.roomOpenBeforeMinutes,
        replayAvailableHours: session.replayAvailableHours
      },
      telegramUrl: env.TELEGRAM_GROUP_URL,
      telegramBotUrl: buildTelegramStartUrl()
    });
  })
);

async function sendTimeline(req: Request, res: Response, token?: string | null) {
  const registration = await findRegistrationForRequest(req, token);

  if (!registration) {
    throw new AppError(401, 'Invalid webinar token');
  }

  const now = new Date();
  const access = buildAccessPayload(registration, now);
  if (!access.canEnterRoom) {
    throw roomAccessError(access.accessStatus);
  }

  const dbEvents = await prisma.webinarTimelineEvent.findMany({
    where: {
      OR: [{ webinarSessionId: null }, { webinarSessionId: registration.webinarSessionId }]
    },
    orderBy: { offsetSeconds: 'asc' }
  });

  const hasFreshTimeline =
    dbEvents.length > 0 &&
    dbEvents.every(event => event.offsetSeconds <= registration.webinarSession.videoDurationSeconds);

  const timeline = hasFreshTimeline
    ? dbEvents.map(event => ({
        offsetSeconds: event.offsetSeconds,
        title: event.title,
        text: event.text,
        type: event.type,
        ctaLabel: event.ctaLabel,
        ctaUrl: event.ctaUrl
      }))
    : DEFAULT_TIMELINE_EVENTS;

  res.json({
    ok: true,
    serverTime: now.toISOString(),
    accessStatus: access.accessStatus,
    webinarStatus: access.webinarStatus,
    testMode: access.testMode,
    replayExpiresAt: access.replayExpiresAt.toISOString(),
    roomOpensAt: access.roomOpensAt.toISOString(),
    video: {
      src: registration.webinarSession.videoUrl || WEBINAR_VIDEO_PATH,
      durationSeconds: registration.webinarSession.videoDurationSeconds,
      poster: registration.webinarSession.posterUrl,
      expected: true
    },
    timeline
  });
}

publicRouter.get(
  '/webinar/timeline/session/current',
  asyncHandler(async (req, res) => {
    await sendTimeline(req, res);
  })
);

publicRouter.get(
  '/webinar/timeline/:token',
  asyncHandler(async (req, res) => {
    const token = z.string().min(20).parse(req.params.token);
    await sendTimeline(req, res, token);
  })
);

publicRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const firstSeenAt = getFirstSeen(req, res);
    const scheduledAt = getNextWebinarDate(firstSeenAt);
    const session = await findOrCreateWebinarSession(scheduledAt);
    const professionalStatus = clean(data.professionalStatus) ?? clean(data.status);

    const lead = await prisma.lead.upsert({
      where: { email: data.email.toLowerCase() },
      update: {
        name: data.name,
        phone: data.phone,
        city: clean(data.city),
        professionalStatus,
        consent: data.consent,
        source: clean(data.source),
        utmSource: clean(data.utmSource),
        utmMedium: clean(data.utmMedium),
        utmCampaign: clean(data.utmCampaign),
        utmContent: clean(data.utmContent),
        utmTerm: clean(data.utmTerm)
      },
      create: {
        name: data.name,
        phone: data.phone,
        email: data.email.toLowerCase(),
        city: clean(data.city),
        professionalStatus,
        consent: data.consent,
        source: clean(data.source),
        utmSource: clean(data.utmSource),
        utmMedium: clean(data.utmMedium),
        utmCampaign: clean(data.utmCampaign),
        utmContent: clean(data.utmContent),
        utmTerm: clean(data.utmTerm),
        firstSeenAt
      }
    });

    const token = createAccessToken();
    const registration = await prisma.registration.create({
      data: {
        leadId: lead.id,
        webinarSessionId: session.id,
        accessTokenHash: hashToken(token),
        status: 'registered'
      }
    });
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(token),
        purpose: 'registration',
        expiresAt: getRoomTokenExpiresAt(session)
      }
    });

    const webinarUrl = buildFrontendUrl('/crisis_premium/webinar.html', token);
    const successUrl = buildFrontendUrl('/crisis_premium/success.html', token);
    setRoomTokenCookie(res, token, getRoomTokenExpiresAt(session));
    await sendRegistrationEmail({
      to: lead.email,
      name: lead.name,
      scheduledAt: session.scheduledAt,
      webinarUrl,
      partnerUrl: `${webinarUrl}#partnerApplication`
    });

    await prisma.registration.update({
      where: { id: registration.id },
      data: { emailSentAt: new Date(), confirmationSentAt: new Date() }
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
      utmCampaign: clean(data.utmCampaign)
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
        adminUrl: buildFrontendUrl('/admin')
      })
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
        status: registration.status
      }
    });
  })
);

publicRouter.get(
  '/registration/session/current',
  asyncHandler(async (req, res) => {
    await sendRegistrationState(req, res);
  })
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
      data: { successViewedAt: now }
    });
    await saveEvent({ eventName: 'registration_success', req, token, page: '/crisis_premium/success.html' });
  }

  if (view === 'room') {
    if (access.canEnterRoom) {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { roomEnteredAt: registration.roomEnteredAt ?? now }
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
    webinarUrl: tokenForLinks ? buildFrontendUrl('/crisis_premium/webinar.html', tokenForLinks) : buildFrontendUrl('/crisis_premium/webinar.html'),
    lead: {
      name: registration.lead.name,
      email: registration.lead.email,
      phone: registration.lead.phone,
      city: registration.lead.city,
      professionalStatus: registration.lead.professionalStatus
    },
    registration: {
      id: registration.id,
      registeredAt: registration.registeredAt.toISOString(),
      status: registration.status,
      crmStatus: registration.crmStatus
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
        countdown: access.countdown
      }
  });
}

publicRouter.get(
  '/registration/:token',
  asyncHandler(async (req, res) => {
    const token = z.string().min(20).parse(req.params.token);
    await sendRegistrationState(req, res, token);
  })
);

publicRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    const data = eventSchema.parse(req.body);
    await saveEvent({
      eventName: data.eventName,
      req,
      token: data.token,
      page: data.page,
      metadata: data.metadata,
      source: clean(data.source),
      utmSource: clean(data.utmSource),
      utmMedium: clean(data.utmMedium),
      utmCampaign: clean(data.utmCampaign)
    });
    res.status(201).json({ ok: true });
  })
);

publicRouter.post(
  '/telegram-click',
  asyncHandler(async (req, res) => {
    const data = z.object({ token: z.string().optional(), page: z.string().optional() }).parse(req.body);
    const registration = await saveEvent({
      eventName: 'telegram_click',
      req,
      token: data.token,
      page: data.page
    });

    if (registration && !registration.telegramClickedAt) {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { telegramClickedAt: new Date() }
      });
    }

    res.json({ ok: true, telegramUrl: env.TELEGRAM_GROUP_URL, telegramBotUrl: data.token ? buildTelegramStartUrl(data.token) : buildTelegramStartUrl() });
  })
);

publicRouter.post(
  '/partner-application',
  asyncHandler(async (req, res) => {
    const data = partnerApplicationSchema.parse(req.body);
    const registration = await findRegistrationForRequest(req, data.token);

    if (!registration) {
      throw new AppError(401, 'Invalid webinar token');
    }
    const access = buildAccessPayload(registration, new Date());
    if (!access.canEnterRoom) {
      throw roomAccessError(access.accessStatus);
    }

    const application = await prisma.partnerApplication.create({
      data: {
        leadId: registration.leadId,
        registrationId: registration.id,
        webinarSessionId: registration.webinarSessionId,
        sphere: clean(data.sphere),
        city: clean(data.city) ?? registration.lead.city,
        clientFlow: clean(data.clientFlow),
        experience: clean(data.experience),
        preferredFormat: clean(data.preferredFormat),
        comment: clean(data.comment),
        status: 'new'
      }
    });

    await prisma.registration.update({
      where: { id: registration.id },
      data: { crmStatus: 'contract_pending' }
    });

    await saveEvent({
      eventName: 'partner_application_submit',
      req,
      token: data.token,
      page: '/crisis_premium/webinar.html',
      metadata: { partnerApplicationId: application.id }
    });

    notifySafely(
      notifyPartnerApplication({
        name: registration.lead.name,
        phone: registration.lead.phone,
        email: registration.lead.email,
        sphere: application.sphere,
        city: application.city,
        clientFlow: application.clientFlow,
        preferredFormat: application.preferredFormat,
        comment: application.comment,
        adminUrl: buildFrontendUrl('/admin')
      })
    );

    res.status(201).json({ ok: true, applicationId: application.id });
  })
);

publicRouter.post(
  '/questions',
  asyncHandler(async (req, res) => {
    const data = questionSchema.parse(req.body);
    const registration = await findRegistrationForRequest(req, data.token);

    if (!registration) {
      throw new AppError(401, 'Invalid webinar token');
    }
    const access = buildAccessPayload(registration, new Date());
    if (!access.canEnterRoom) {
      throw roomAccessError(access.accessStatus);
    }

    const question = await prisma.question.create({
      data: {
        leadId: registration.leadId,
        registrationId: registration.id,
        webinarSessionId: registration.webinarSessionId,
        text: data.text
      }
    });

    await saveEvent({
      eventName: 'question_submit',
      req,
      token: data.token,
      page: '/crisis_premium/webinar.html',
      metadata: { questionId: question.id }
    });

    notifySafely(
      notifyQuestion({
        name: registration.lead.name,
        phone: registration.lead.phone,
        email: registration.lead.email,
        text: data.text,
        adminUrl: buildFrontendUrl('/admin')
      })
    );

    res.status(201).json({ ok: true, questionId: question.id });
  })
);
