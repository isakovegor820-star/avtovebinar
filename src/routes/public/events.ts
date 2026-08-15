import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { PUBLIC_ANALYTICS_EVENTS } from '../../lib/events.js';
import { clean, saveEvent, saveEventSafely } from './helpers.js';

export const eventsRouter = Router();

const MAX_METADATA_KEYS = 20;
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_DEPTH = 4;

const utmSchema = {
  source: z.string().trim().max(120).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional().or(z.literal('')),
  utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
  utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
  utmContent: z.string().trim().max(120).optional().or(z.literal('')),
  utmTerm: z.string().trim().max(120).optional().or(z.literal('')),
};

function isMetadataTooDeep(value: unknown, depth = 0): boolean {
  if (depth > MAX_METADATA_DEPTH) {
    return true;
  }
  if (!value || typeof value !== 'object') {
    return false;
  }

  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some(item => isMetadataTooDeep(item, depth + 1));
}

const metadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `metadata must contain at most ${MAX_METADATA_KEYS} keys`,
    });
  }

  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `metadata must be at most ${MAX_METADATA_BYTES} bytes`,
    });
  }

  if (isMetadataTooDeep(metadata)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `metadata nesting must be at most ${MAX_METADATA_DEPTH} levels`,
    });
  }
});

export const eventSchema = z.object({
  eventName: z.enum(PUBLIC_ANALYTICS_EVENTS),
  page: z.string().trim().max(160).optional(),
  metadata: metadataSchema.optional(),
  ...utmSchema,
});

eventsRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    const data = eventSchema.parse(req.body);
    await saveEvent({
      eventName: data.eventName,
      req,
      page: data.page,
      metadata: data.metadata,
      source: clean(data.source),
      utmSource: clean(data.utmSource),
      utmMedium: clean(data.utmMedium),
      utmCampaign: clean(data.utmCampaign),
      analyticsOnly: true,
      dailyRoom: data.page === '/crisis_premium/webinar.html',
    });
    res.status(201).json({ ok: true });
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
