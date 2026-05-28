import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { notifyPartnerApplication, notifyQuestion } from '../../lib/telegram.js';
import {
  buildAccessPayload,
  buildFrontendUrl,
  clean,
  findRegistrationForRequest,
  notifySafely,
  roomAccessError,
  saveEvent,
} from './helpers.js';

export const partnersRouter = Router();

const questionSchema = z.object({
  token: z.string().trim().min(20).optional().or(z.literal('')),
  text: z.string().trim().min(3).max(2000),
});

const partnerApplicationSchema = z.object({
  token: z.string().trim().min(20).optional().or(z.literal('')),
  sphere: z.string().trim().max(160).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  clientFlow: z.string().trim().max(160).optional().or(z.literal('')),
  experience: z.string().trim().max(500).optional().or(z.literal('')),
  preferredFormat: z.string().trim().max(160).optional().or(z.literal('')),
  comment: z.string().trim().max(2000).optional().or(z.literal('')),
});

partnersRouter.post(
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
        status: 'new',
      },
    });

    await prisma.registration.update({
      where: { id: registration.id },
      data: { crmStatus: 'contract_pending' },
    });

    await saveEvent({
      eventName: 'partner_application_submit',
      req,
      token: data.token,
      page: '/crisis_premium/webinar.html',
      metadata: { partnerApplicationId: application.id },
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
        adminUrl: buildFrontendUrl('/admin'),
      }),
    );

    res.status(201).json({ ok: true, applicationId: application.id });
  }),
);

partnersRouter.post(
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
        text: data.text,
      },
    });

    await saveEvent({
      eventName: 'question_submit',
      req,
      token: data.token,
      page: '/crisis_premium/webinar.html',
      metadata: { questionId: question.id },
    });

    notifySafely(
      notifyQuestion({
        name: registration.lead.name,
        phone: registration.lead.phone,
        email: registration.lead.email,
        text: data.text,
        adminUrl: buildFrontendUrl('/admin'),
      }),
    );

    res.status(201).json({ ok: true, questionId: question.id });
  }),
);
