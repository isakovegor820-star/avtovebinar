import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { notifyPartnerApplication, notifyQuestion } from '../../lib/telegram.js';
import { getWebinarLiveState } from '../../lib/webinarLive.js';
import {
  buildDailyRoomAccessPayload,
  buildAccessPayload,
  buildFrontendUrl,
  clean,
  findRegistrationForRequest,
  notifySafely,
  roomAccessError,
  saveEventSafely,
} from './helpers.js';
import { CHAT_PUBLICATION_CONSENT, consentEvidenceData } from '../../lib/consentDocuments.js';
import { acquireLeadSecurityLock, isParticipantRegistrationActive } from '../../lib/leadSecurity.js';
import { recordCrmScoreSignalForRegistration } from '../../lib/tenancy/crm.js';
import { chatSpamKey, questionTextFingerprint, sanitizeParticipantQuestion } from '../../lib/chatPolicy.js';

export const partnersRouter = Router();

const questionSchema = z
  .object({
    text: z.string().max(4_000),
    showToParticipants: z.boolean().optional().default(false),
    displayMode: z.enum(['pseudonym', 'name_and_status']).optional().default('pseudonym'),
    publicationNoticeAccepted: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.showToParticipants && !data.publicationNoticeAccepted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicationNoticeAccepted'],
        message: 'Publication notice must be accepted for a public question',
      });
    }
  });

const partnerApplicationSchema = z.object({
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
    const registration = await findRegistrationForRequest(req);

    if (!registration) {
      throw new AppError(401, 'Invalid webinar token');
    }
    const access = await buildDailyRoomAccessPayload(registration, new Date());
    if (!access.canEnterRoom) {
      throw roomAccessError(access.accessStatus);
    }

    const { application, activeRegistration } = await prisma.$transaction(async tx => {
      await acquireLeadSecurityLock(tx, registration.leadId);
      const activeRegistration = await tx.registration.findUnique({
        where: { id: registration.id },
        include: { lead: true, webinarSession: true },
      });
      if (
        !activeRegistration ||
        activeRegistration.leadId !== registration.leadId ||
        !isParticipantRegistrationActive(activeRegistration)
      ) {
        throw new AppError(401, 'Invalid webinar token');
      }

      const application = await tx.partnerApplication.create({
        data: {
          leadId: activeRegistration.leadId,
          registrationId: activeRegistration.id,
          webinarSessionId: access.webinarSession.id,
          sphere: clean(data.sphere),
          city: clean(data.city) ?? activeRegistration.lead.city,
          clientFlow: clean(data.clientFlow),
          experience: clean(data.experience),
          preferredFormat: clean(data.preferredFormat),
          comment: clean(data.comment),
          status: 'new',
        },
      });
      await recordCrmScoreSignalForRegistration(
        tx,
        activeRegistration.id,
        'cta',
        'partner_application',
        application.id,
        application.createdAt,
      );

      await tx.registration.update({
        where: { id: activeRegistration.id },
        data: { crmStatus: 'contract_pending' },
      });
      return { application, activeRegistration };
    });

    await saveEventSafely(
      {
        eventName: 'partner_application_submit',
        req,
        registration: activeRegistration,
        page: '/crisis_premium/webinar.html',
        webinarSessionId: access.webinarSession.id,
        metadata: { partnerApplicationId: application.id },
      },
      'partner_application',
    );

    notifySafely(
      notifyPartnerApplication({
        name: activeRegistration.lead.name,
        phone: activeRegistration.lead.phone,
        email: activeRegistration.lead.email,
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
    const parsed = questionSchema.parse(req.body);
    const data = { ...parsed, text: sanitizeParticipantQuestion(parsed.text) };
    const registration = await findRegistrationForRequest(req);

    if (!registration) {
      throw new AppError(401, 'Invalid webinar token');
    }
    // Забаненный модератором участник не может отправлять вопросы в чат.
    if (registration.chatBannedAt) {
      throw new AppError(403, 'Чат для этой регистрации заблокирован', undefined, 'chat_registration_blocked');
    }
    const now = new Date();
    // A write is always tied to the Registration's exact WebinarSession. The
    // legacy daily rollover remains read-only and cannot create cross-session
    // questions or chat messages.
    const access = buildAccessPayload(registration, now);
    if (!access.canEnterRoom) {
      throw roomAccessError(access.accessStatus);
    }
    const liveState = getWebinarLiveState(now, access.webinarSession, { testMode: access.testMode });
    if (!access.testMode && liveState.status !== 'live' && liveState.status !== 'finished') {
      throw new AppError(423, 'Webinar chat is closed');
    }

    const { question, chatMessage, activeRegistration } = await prisma.$transaction(async tx => {
      await acquireLeadSecurityLock(tx, registration.leadId);
      const activeRegistration = await tx.registration.findUnique({
        where: { id: registration.id },
        include: { lead: true, webinarSession: true },
      });
      if (
        !activeRegistration ||
        activeRegistration.leadId !== registration.leadId ||
        !isParticipantRegistrationActive(activeRegistration)
      ) {
        throw new AppError(401, 'Invalid webinar token');
      }
      if (activeRegistration.chatBannedAt) {
        throw new AppError(403, 'Чат для этой регистрации заблокирован', undefined, 'chat_registration_blocked');
      }

      const recentQuestions = await tx.question.findMany({
        where: {
          registrationId: activeRegistration.id,
          webinarSessionId: access.webinarSession.id,
          createdAt: { gte: new Date(now.getTime() - 60_000) },
        },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { text: true, createdAt: true },
      });
      if (recentQuestions.length >= 5) {
        throw new AppError(429, 'Слишком много вопросов. Подождите минуту.', undefined, 'chat_question_rate_limited');
      }
      const spamKey = chatSpamKey(data.text);
      if (
        recentQuestions.some(
          question => question.createdAt >= new Date(now.getTime() - 30_000) && chatSpamKey(question.text) === spamKey,
        )
      ) {
        throw new AppError(429, 'Такой вопрос уже отправлен', undefined, 'chat_duplicate_limited');
      }

      const publishedName =
        data.showToParticipants && data.displayMode === 'name_and_status' ? activeRegistration.lead.name : 'Участник';
      const question = await tx.question.create({
        data: {
          organizationId: access.webinarSession.organizationId,
          webinarId: access.webinarSession.webinarId,
          leadId: activeRegistration.leadId,
          registrationId: activeRegistration.id,
          webinarSessionId: access.webinarSession.id,
          text: data.text,
          textFingerprint: questionTextFingerprint(data.text),
          showToParticipants: data.showToParticipants,
          displayMode: data.displayMode,
          publishedName: data.showToParticipants ? publishedName : null,
        },
      });
      await recordCrmScoreSignalForRegistration(
        tx,
        activeRegistration.id,
        'question',
        'question',
        question.id,
        question.createdAt,
      );

      if (!data.showToParticipants) {
        return { question, chatMessage: null, activeRegistration };
      }

      const publicationConsent = await tx.consentRecord.create({
        data: consentEvidenceData(CHAT_PUBLICATION_CONSENT, {
          leadId: activeRegistration.leadId,
          registrationId: activeRegistration.id,
          questionId: question.id,
          email: activeRegistration.lead.email,
          kind: 'chat_publication',
          sourceForm: '/crisis_premium/webinar.html#question',
          req,
          occurredAt: now,
        }),
      });
      await tx.question.update({
        where: { id: question.id },
        data: { publicationConsentRecordId: publicationConsent.id },
      });

      const chatMessage = await tx.webinarChatMessage.create({
        data: {
          webinarSessionId: access.webinarSession.id,
          organizationId: access.webinarSession.organizationId,
          webinarId: access.webinarSession.webinarId,
          registrationId: activeRegistration.id,
          questionId: question.id,
          kind: 'participant',
          messageType: 'PARTICIPANT',
          authorName: publishedName,
          authorRole: data.displayMode === 'name_and_status' ? activeRegistration.lead.professionalStatus : null,
          message: data.text,
          isSynthetic: false,
          visibleAt: now,
          metadataJson: {
            publicationMode: data.displayMode,
            consentRecordId: publicationConsent.id,
          },
        },
      });

      return { question, chatMessage, activeRegistration };
    });

    await saveEventSafely(
      {
        eventName: 'question_submit',
        req,
        registration: activeRegistration,
        page: '/crisis_premium/webinar.html',
        webinarSessionId: access.webinarSession.id,
        metadata: { questionId: question.id, showToParticipants: data.showToParticipants },
      },
      'question_submit',
    );

    notifySafely(
      notifyQuestion({
        name: activeRegistration.lead.name,
        phone: activeRegistration.lead.phone,
        email: activeRegistration.lead.email,
        text: data.text,
        adminUrl: buildFrontendUrl('/admin'),
      }),
    );

    res.status(201).json({ ok: true, questionId: question.id, chatMessageId: chatMessage?.id ?? null });
  }),
);
