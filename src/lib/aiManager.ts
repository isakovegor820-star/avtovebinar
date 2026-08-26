import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { ASPB_KNOWLEDGE_BASE } from './aspbKnowledge.js';
import { acquireLeadSecurityLock, isParticipantRegistrationActive } from './leadSecurity.js';

const RESPONSE_PROBABILITY = 0.28;
const MIN_RESPONSE_GAP_SECONDS = 75;

type AiQuestionInput = {
  questionId: string;
  leadId: string;
  webinarSessionId: string;
  registrationId: string;
  text: string;
  liveOffsetSeconds: number;
  now: Date;
};

function hashToUnit(value: string) {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function includesAny(text: string, keywords: string[]) {
  const normalized = text.toLowerCase();
  return keywords.some(keyword => normalized.includes(keyword));
}

function asksAboutFutureTopic(text: string, liveOffsetSeconds: number) {
  const futureTopics = [
    { offsetSeconds: 150, keywords: ['что берет', 'документ', 'суд', 'сопровожд', 'аспб делает'] },
    { offsetSeconds: 220, keywords: ['самому вести', 'роль юриста', 'передавать клиента', 'партнер'] },
    { offsetSeconds: 360, keywords: ['процент', 'вознагражд', 'условия', 'договор', 'оплата'] },
  ];

  return futureTopics.some(topic => liveOffsetSeconds + 45 < topic.offsetSeconds && includesAny(text, topic.keywords));
}

function buildAiManagerResponse(text: string) {
  if (includesAny(text, ['фнс', 'налог', 'блокиров', 'инкасс', 'счет'])) {
    return 'По налогам и блокировкам сначала важно смотреть документы и стадию взыскания. В чате можно дать только общий ориентир: такие ситуации обычно начинают с диагностики, без обещаний конкретного результата.';
  }

  if (includesAny(text, ['банкрот', 'ип', 'ооо', 'долг', 'кредитор', 'исполнительн'])) {
    return 'По долговым кейсам маршрут зависит от состава долгов, активов, кредиторов и документов. Без анализа нельзя обещать банкротство или списание, но можно передать обезличенную ситуацию на диагностику после премьеры записи.';
  }

  if (includesAny(text, ['партнер', 'процент', 'вознагражд', 'договор', 'услов'])) {
    return 'Партнерские условия корректно обсуждать индивидуально и фиксировать в договоре. Важно не обещать клиенту результат, а передавать его на спокойный разбор ситуации.';
  }

  if (includesAny(text, ['регион', 'город', 'дистанц', 'удален'])) {
    return 'По региональным кейсам обычно сначала оценивают документы и юрисдикцию. Многие вопросы можно разобрать дистанционно, но формат работы лучше уточнить после премьеры записи по конкретной ситуации.';
  }

  return `Здесь лучше не давать индивидуальное заключение по одному сообщению. По правилам АСПБ сначала нужна диагностика документов и обстоятельств, а уже потом можно обсуждать законный маршрут. ${ASPB_KNOWLEDGE_BASE.tone}`;
}

export async function maybeScheduleAiManagerReply(input: AiQuestionInput) {
  if (asksAboutFutureTopic(input.text, input.liveOffsetSeconds)) {
    return null;
  }

  if (hashToUnit(input.questionId) > RESPONSE_PROBABILITY) {
    return null;
  }

  const delaySeconds = 10 + Math.floor(hashToUnit(`${input.questionId}:delay`) * 11);
  const visibleAt = new Date(input.now.getTime() + delaySeconds * 1000);

  return prisma.$transaction(async tx => {
    await acquireLeadSecurityLock(tx, input.leadId);
    const activeQuestion = await tx.question.findUnique({
      where: { id: input.questionId },
      include: {
        registration: { include: { lead: true } },
        webinarSession: { select: { organizationId: true, webinarId: true } },
      },
    });
    if (
      !activeQuestion ||
      activeQuestion.leadId !== input.leadId ||
      activeQuestion.registrationId !== input.registrationId ||
      activeQuestion.webinarSessionId !== input.webinarSessionId ||
      !isParticipantRegistrationActive(activeQuestion.registration)
    ) {
      return null;
    }

    const lastAiMessage = await tx.webinarChatMessage.findFirst({
      where: {
        webinarSessionId: input.webinarSessionId,
        messageType: 'AI_MODERATOR',
      },
      orderBy: { visibleAt: 'desc' },
    });

    if (lastAiMessage && input.now.getTime() - lastAiMessage.visibleAt.getTime() < MIN_RESPONSE_GAP_SECONDS * 1000) {
      return null;
    }

    return tx.webinarChatMessage.create({
      data: {
        webinarSessionId: input.webinarSessionId,
        organizationId: activeQuestion.webinarSession.organizationId,
        webinarId: activeQuestion.webinarSession.webinarId,
        registrationId: input.registrationId,
        kind: 'ai_moderator',
        messageType: 'AI_MODERATOR',
        authorName: 'AI-модератор',
        authorRole: 'AI-модератор',
        message: buildAiManagerResponse(input.text),
        isSynthetic: true,
        visibleAt,
        metadataJson: {
          replyToQuestionId: input.questionId,
          delaySeconds,
        },
      },
    });
  });
}
