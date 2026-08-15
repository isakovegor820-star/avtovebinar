import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from './env.js';
import { hashIp } from './tokens.js';
import { getClientIp } from './http.js';

export const CONSENT_POLICY_VERSION = '2026-07-30.1';
export const TERMS_VERSION = '2026-07-30.1';
export const MARKETING_CONSENT_VERSION = '2026-07-30.1';
export const CHAT_PUBLICATION_CONSENT_VERSION = '2026-07-30.1';
export const DOCUMENT_EFFECTIVE_AT = new Date('2026-07-30T00:00:00+03:00');

type ConsentDocument = {
  id: string;
  version: string;
  effectiveAt: Date;
  text: string;
  purposes: string[];
  dataCategories: string[];
  operations: string[];
  retentionTerm: string;
  channels: string[];
};

function documentHash(text: string) {
  return crypto.createHash('sha256').update(text.trim().replace(/\s+/g, ' '), 'utf8').digest('hex');
}

export const PERSONAL_DATA_CONSENT: ConsentDocument = {
  id: 'aspb-personal-data-registration-consent',
  version: CONSENT_POLICY_VERSION,
  effectiveAt: DOCUMENT_EFFECTIVE_AT,
  text: 'Отдельное согласие на обработку персональных данных для регистрации на премьеру записи АСПБ, предоставления доступа, организационных уведомлений, обработки вопросов и заявки, без включения рекламных сообщений и принятия пользовательского соглашения.',
  purposes: [
    'регистрация на премьеру записи',
    'предоставление и восстановление доступа',
    'организационные сообщения о зарегистрированной премьере',
    'обработка вопросов и партнерской заявки по инициативе пользователя',
    'обеспечение безопасности и доказательство законности обработки',
  ],
  dataCategories: [
    'имя',
    'телефон',
    'email',
    'город (если указан)',
    'профессиональный статус (если указан)',
    'ответ о наличии клиентов (если указан)',
    'вопросы и сведения заявки (если направлены)',
    'источник формы и UTM-метки',
    'IP-hash',
    'User-Agent',
    'идентификаторы регистрации и действий',
  ],
  operations: [
    'сбор',
    'запись',
    'систематизация',
    'накопление',
    'хранение',
    'уточнение',
    'извлечение',
    'использование',
    'предоставление уполномоченным обработчикам',
    'блокирование',
    'удаление',
    'уничтожение',
  ],
  retentionTerm:
    'до достижения заявленных целей, отзыва согласия либо истечения срока из действующей таблицы хранения; применимый более длительный срок допускается только при обязанности по закону или документированном законном основании',
  channels: [
    'сайт',
    'email для организационных сообщений',
    'Telegram только после отдельного подключения пользователем',
  ],
};

export const MARKETING_EMAIL_CONSENT: ConsentDocument = {
  id: 'aspb-marketing-email-consent',
  version: MARKETING_CONSENT_VERSION,
  effectiveAt: DOCUMENT_EFFECTIVE_AT,
  text: 'Необязательное отдельное согласие на рекламные и информационные сообщения АСПБ по email. Не влияет на регистрацию и организационные сообщения о выбранной премьере.',
  purposes: ['направление рекламы, новостей и предложений АСПБ по email'],
  dataCategories: ['имя', 'email', 'факт и доказательства согласия'],
  operations: ['сбор', 'запись', 'хранение', 'использование', 'передача SMTP-провайдеру', 'удаление'],
  retentionTerm:
    'до отзыва согласия или прекращения рекламной рассылки, затем доказательство согласия и отзыва — 3 года',
  channels: ['email'],
};

export const MARKETING_TELEGRAM_CONSENT: ConsentDocument = {
  id: 'aspb-marketing-telegram-consent',
  version: MARKETING_CONSENT_VERSION,
  effectiveAt: DOCUMENT_EFFECTIVE_AT,
  text: 'Необязательное отдельное согласие на рекламные и информационные сообщения АСПБ в Telegram. Действует только после добровольной привязки Telegram пользователем.',
  purposes: ['направление рекламы, новостей и предложений АСПБ в Telegram'],
  dataCategories: [
    'имя',
    'Telegram Chat ID',
    'Telegram username и имя профиля (если доступны)',
    'факт и доказательства согласия',
  ],
  operations: ['сбор', 'запись', 'хранение', 'использование', 'передача Telegram', 'удаление'],
  retentionTerm:
    'до отзыва согласия или прекращения рекламной рассылки, затем доказательство согласия и отзыва — 3 года',
  channels: ['Telegram'],
};

export const CHAT_PUBLICATION_CONSENT: ConsentDocument = {
  id: 'aspb-chat-publication-consent',
  version: CHAT_PUBLICATION_CONSENT_VERSION,
  effectiveAt: DOCUMENT_EFFECTIVE_AT,
  text: 'Отдельное информированное действие на публикацию конкретного вопроса другим участникам премьеры под выбранным пользователем способом отображения.',
  purposes: ['публикация конкретного вопроса другим зарегистрированным участникам'],
  dataCategories: ['текст вопроса', 'псевдоним либо имя и профессиональный статус по выбору пользователя'],
  operations: ['запись', 'хранение', 'публикация зарегистрированным участникам', 'удаление'],
  retentionTerm: '1 год с даты вопроса, если более длительное хранение не требуется для ответа или защиты прав',
  channels: ['закрытая вебинарная комната'],
};

export const USER_TERMS = {
  id: 'aspb-user-terms',
  version: TERMS_VERSION,
  effectiveAt: DOCUMENT_EFFECTIVE_AT,
  text: 'Пользовательское соглашение АСПБ для доступа к премьере записи и материалам; принятие не является согласием на обработку персональных данных или рекламу.',
};

export function consentDocumentHash(document: ConsentDocument | typeof USER_TERMS) {
  return documentHash(document.text);
}

export function subjectRefHash(email: string) {
  return crypto.createHmac('sha256', env.IP_HASH_SECRET).update(`subject:${email.trim().toLowerCase()}`).digest('hex');
}

export function consentEvidenceData(
  document: ConsentDocument,
  input: {
    leadId?: string;
    registrationId?: string;
    questionId?: string;
    email: string;
    kind: 'personal_data' | 'marketing_email' | 'marketing_telegram' | 'chat_publication';
    action?: 'grant' | 'revoke';
    sourceForm: string;
    req: { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } };
    occurredAt?: Date;
    revocationChannel?: string;
    revocationReason?: string;
    revokedConsentId?: string;
  },
): Prisma.ConsentRecordUncheckedCreateInput {
  return {
    leadId: input.leadId,
    registrationId: input.registrationId,
    questionId: input.questionId,
    subjectRefHash: subjectRefHash(input.email),
    kind: input.kind,
    action: input.action ?? 'grant',
    documentId: document.id,
    documentVersion: document.version,
    documentHash: consentDocumentHash(document),
    documentEffectiveAt: document.effectiveAt,
    purposes: document.purposes,
    dataCategories: document.dataCategories,
    operations: document.operations,
    retentionTerm: document.retentionTerm,
    channels: document.channels,
    sourceForm: input.sourceForm,
    ipHash: hashIp(getClientIp(input.req as any)),
    userAgent: typeof input.req.headers['user-agent'] === 'string' ? input.req.headers['user-agent'] : null,
    occurredAt: input.occurredAt,
    revocationChannel: input.revocationChannel,
    revocationReason: input.revocationReason,
    revokedConsentId: input.revokedConsentId,
  };
}

export function legalAcceptanceEvidenceData(input: {
  leadId: string;
  registrationId: string;
  email: string;
  sourceForm: string;
  req: { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } };
  acceptedAt?: Date;
}): Prisma.LegalAcceptanceUncheckedCreateInput {
  return {
    leadId: input.leadId,
    registrationId: input.registrationId,
    subjectRefHash: subjectRefHash(input.email),
    documentId: USER_TERMS.id,
    documentVersion: USER_TERMS.version,
    documentHash: consentDocumentHash(USER_TERMS),
    documentEffectiveAt: USER_TERMS.effectiveAt,
    sourceForm: input.sourceForm,
    ipHash: hashIp(getClientIp(input.req as any)),
    userAgent: typeof input.req.headers['user-agent'] === 'string' ? input.req.headers['user-agent'] : null,
    acceptedAt: input.acceptedAt,
  };
}
