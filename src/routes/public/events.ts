import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler, getClientIp } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import {
  adaptLegacyAnalyticsAttributes,
  ANALYTICS_EVENT_REGISTRY,
  CURRENT_ANALYTICS_SCHEMA_VERSION,
  legacyAnalyticsEventSchema,
  parseAnalyticsV1Request,
  recordAnalyticsEvent,
  type AnalyticsEventName,
} from '../../lib/analyticsEvents.js';
import { getRequestContext } from '../../lib/requestContext.js';
import { logger } from '../../lib/logger.js';
import { getVisitorId, hasAnalyticsConsent } from '../../lib/visitor.js';
import { hashIp } from '../../lib/tokens.js';
import {
  buildDailyRoomAccessPayload,
  clean,
  findRegistrationForRequest,
  saveEventSafely,
  saveLegacyEvent,
} from './helpers.js';

export const eventsRouter = Router();

const MAX_ANALYTICS_REQUEST_BYTES = 12 * 1024;
export const eventSchema = legacyAnalyticsEventSchema;

function assertAnalyticsRequestSize(body: unknown) {
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    // Validation below returns the same public error shape without serializing
    // the original request into a response or log.
  }
  if (bytes > MAX_ANALYTICS_REQUEST_BYTES) {
    throw new AppError(413, 'Analytics request is too large', undefined, 'analytics_payload_too_large');
  }
}

function hasScopeHints(data: ReturnType<typeof parseAnalyticsV1Request>) {
  return Boolean(data.organizationId || data.webinarId || data.webinarSessionId || data.registrationId || data.userId);
}

eventsRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    assertAnalyticsRequestSize(req.body);
    if ((req.body as { schemaVersion?: unknown } | null)?.schemaVersion === undefined) {
      const legacy = legacyAnalyticsEventSchema.parse(req.body);
      const eventName = legacy.eventName as AnalyticsEventName;
      logger.info(
        { eventName, correlationId: getRequestContext()?.correlationId },
        'analytics_legacy_payload_accepted',
      );
      await saveLegacyEvent({
        eventName,
        req,
        page: legacy.page,
        metadata: adaptLegacyAnalyticsAttributes(eventName, legacy.metadata),
        source: clean(legacy.source),
        utmSource: clean(legacy.utmSource),
        utmMedium: clean(legacy.utmMedium),
        utmCampaign: clean(legacy.utmCampaign),
        analyticsOnly: true,
        dailyRoom: legacy.page === '/crisis_premium/webinar.html',
      });
      res.status(201).json({
        ok: true,
        schemaVersion: 0,
        legacyCompatibility: true,
        correlationId: getRequestContext()?.correlationId,
      });
      return;
    }

    const now = new Date();
    const data = parseAnalyticsV1Request(req.body, now);
    const registration = await findRegistrationForRequest(req);
    if (!registration && (ANALYTICS_EVENT_REGISTRY[data.eventName].scope === 'tenant' || hasScopeHints(data))) {
      throw new AppError(404, 'Analytics scope not found', undefined, 'analytics_scope_not_found');
    }
    const effectiveWebinarSessionId =
      registration && data.source === 'room'
        ? (await buildDailyRoomAccessPayload(registration, now)).webinarSession.id
        : registration?.webinarSessionId;
    const analyticsConsent = hasAnalyticsConsent(req);
    const result = await recordAnalyticsEvent(prisma, {
      eventName: data.eventName,
      source: data.source,
      dedupKey: data.dedupKey,
      correlationId: getRequestContext()?.correlationId,
      scope: registration
        ? {
            kind: 'participant',
            trustedRegistrationId: registration.id,
            effectiveWebinarSessionId,
            identifiable: analyticsConsent,
            hints: {
              organizationId: data.organizationId,
              webinarId: data.webinarId,
              webinarSessionId: data.webinarSessionId,
              registrationId: data.registrationId,
              userId: data.userId,
            },
          }
        : { kind: 'platform' },
      attributes: data.attributes,
      page: data.page,
      visitorId: analyticsConsent ? getVisitorId(req) : null,
      userAgent: analyticsConsent ? (req.headers['user-agent'] ?? null) : null,
      ipHash: analyticsConsent ? hashIp(getClientIp(req)) : null,
      utmSource: analyticsConsent ? (data.utmSource ?? null) : null,
      utmMedium: analyticsConsent ? (data.utmMedium ?? null) : null,
      utmCampaign: analyticsConsent ? (data.utmCampaign ?? null) : null,
      clientOccurredAt: data.clientOccurredAt,
    });
    res.status(result.replayed ? 200 : 201).json({
      ok: true,
      accepted: true,
      replayed: result.replayed,
      schemaVersion: CURRENT_ANALYTICS_SCHEMA_VERSION,
      occurredAt: result.occurredAt.toISOString(),
      correlationId: result.correlationId,
    });
  }),
);

eventsRouter.post(
  '/telegram-click',
  asyncHandler(async (req, res) => {
    const data = z.object({ page: z.string().optional() }).parse(req.body);
    const registration = await saveEventSafely(
      {
        eventName: 'telegram_click',
        req,
        page: data.page,
        dailyRoom: data.page === '/crisis_premium/webinar.html',
      },
      'telegram_click',
    );

    if (registration && !registration.telegramClickedAt) {
      await prisma.registration.updateMany({
        where: { id: registration.id, status: 'registered' },
        data: { telegramClickedAt: new Date() },
      });
    }

    res.json({
      ok: true,
      telegramUrl: buildTelegramStartUrl() ?? env.TELEGRAM_GROUP_URL,
      telegramBotUrl: buildTelegramStartUrl(),
    });
  }),
);
