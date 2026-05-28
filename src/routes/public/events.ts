import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { buildTelegramStartUrl } from '../../lib/telegram.js';
import { PUBLIC_ANALYTICS_EVENTS } from '../../lib/events.js';
import { clean, saveEvent } from './helpers.js';

export const eventsRouter = Router();

const utmSchema = {
  source: z.string().trim().max(120).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional().or(z.literal('')),
  utmMedium: z.string().trim().max(120).optional().or(z.literal('')),
  utmCampaign: z.string().trim().max(120).optional().or(z.literal('')),
  utmContent: z.string().trim().max(120).optional().or(z.literal('')),
  utmTerm: z.string().trim().max(120).optional().or(z.literal('')),
};

const eventSchema = z.object({
  eventName: z.enum(PUBLIC_ANALYTICS_EVENTS),
  token: z.string().trim().optional(),
  page: z.string().trim().max(160).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ...utmSchema,
});

eventsRouter.post(
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
      utmCampaign: clean(data.utmCampaign),
    });
    res.status(201).json({ ok: true });
  }),
);

eventsRouter.post(
  '/telegram-click',
  asyncHandler(async (req, res) => {
    const data = z.object({ token: z.string().optional(), page: z.string().optional() }).parse(req.body);
    const registration = await saveEvent({
      eventName: 'telegram_click',
      req,
      token: data.token,
      page: data.page,
    });

    if (registration && !registration.telegramClickedAt) {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { telegramClickedAt: new Date() },
      });
    }

    res.json({
      ok: true,
      telegramUrl: env.TELEGRAM_GROUP_URL,
      telegramBotUrl: data.token ? buildTelegramStartUrl(data.token) : buildTelegramStartUrl(),
    });
  }),
);
