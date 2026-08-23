import crypto from 'node:crypto';
import { AppError } from './http.js';

export type PublicChatMessageType =
  | 'participant'
  | 'moderator'
  | 'prepared_question'
  | 'ai_moderator'
  | 'system';

const HTML_TAG_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const ACTIVE_CONTENT_PATTERN = /(?:javascript\s*:|data\s*:\s*text\/html)/iu;
const SYNTHETIC_ONLINE_COUNT_PATTERN = /(?:\d{1,7}\s*(?:человек|участник(?:ов|а)?|зрител(?:ей|я))\s*(?:онлайн|смотр)|онлайн\s*[:—-]?\s*\d{1,7})/iu;
const SYNTHETIC_TESTIMONIAL_PATTERN = /(?:(?:мой|наш)\s+отзыв|(?:я|мы)\s+(?:уже\s+)?(?:заработал(?:а|и)?|получил(?:а|и)?\s+(?:результат|выплату|деньги)|списал(?:а|и)?\s+долг|выиграл(?:а|и)?\s+(?:дело|суд)))/iu;
const PERSONAL_CONTEXT_PATTERN = /(?:\b(?:мне|нам|мой|моя|моё|мои|моего|моей|моём|нашей|нашего)\b|\bу\s+(?:меня|нас)\b|\bв\s+(?:моей|нашей)\s+ситуации\b)/iu;
const INDIVIDUAL_ACTION_PATTERN = /(?:что\s+(?:мне|нам)\s+делать|как\s+(?:мне|нам)\s+(?:поступить|действовать)|(?:можно|стоит|следует)\s+ли\s+(?:мне|нам)|(?:посоветуй(?:те)?|дайте\s+совет)|(?:оцените|проанализируйте|проверьте)\s+(?:мой|мою|моё|нашу|наш))/iu;
const PERSONAL_LEGAL_OBJECT_PATTERN = /\b(?:договор|иск|жалоб|суд|долг|банкротств|налог|штраф|увольнен|наследств|сделк|претензи|постановлен|исполнительн)\w*/iu;

export type SyntheticScenarioViolation = 'synthetic_online_count_forbidden' | 'synthetic_testimonial_forbidden';

export function syntheticScenarioViolation(text: string): SyntheticScenarioViolation | null {
  if (SYNTHETIC_ONLINE_COUNT_PATTERN.test(text)) return 'synthetic_online_count_forbidden';
  if (SYNTHETIC_TESTIMONIAL_PATTERN.test(text)) return 'synthetic_testimonial_forbidden';
  return null;
}

export function scenarioAuthorLabel(kind: string) {
  return kind === 'AI_MODERATOR' ? 'AI-модератор' : kind === 'SYSTEM' ? 'Система АСПБ' : 'Подготовленный вопрос';
}

function stripUnsafeControls(value: string) {
  return [...value]
    .filter(character => {
      const code = character.codePointAt(0) ?? 0;
      const disallowedControl =
        (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
      const bidiOverride = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
      return !disallowedControl && !bidiOverride;
    })
    .join('');
}

export function publicScenarioMessageType(kind: string): PublicChatMessageType {
  if (kind === 'AI_MODERATOR') return 'ai_moderator';
  if (kind === 'SYSTEM') return 'system';
  return 'prepared_question';
}

export function sanitizeParticipantQuestion(input: string) {
  const normalized = input
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n');
  const safeText = stripUnsafeControls(normalized).replace(/\n{3,}/gu, '\n\n').trim();

  if (HTML_TAG_PATTERN.test(safeText) || ACTIVE_CONTENT_PATTERN.test(safeText)) {
    throw new AppError(
      400,
      'Вопрос должен содержать только обычный текст',
      undefined,
      'chat_markup_not_allowed',
    );
  }
  if (safeText.length < 3 || safeText.length > 2_000) {
    throw new AppError(400, 'Длина вопроса должна быть от 3 до 2000 символов', undefined, 'chat_text_invalid');
  }
  return safeText;
}

export function chatSpamKey(text: string) {
  return text.toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim();
}

/** A non-secret grouping key. It must never be used as an authentication token. */
export function questionTextFingerprint(text: string) {
  return crypto.createHash('md5').update(chatSpamKey(text), 'utf8').digest('hex');
}

export type LegalAdvicePolicyOutcome = 'ALLOW_GROUNDED_RETRIEVAL' | 'PERSONALIZED_LEGAL_ADVICE';

export function classifyLegalAdviceRequest(text: string): LegalAdvicePolicyOutcome {
  const normalized = chatSpamKey(text.normalize('NFKC'));
  if (
    INDIVIDUAL_ACTION_PATTERN.test(normalized) ||
    (PERSONAL_CONTEXT_PATTERN.test(normalized) && PERSONAL_LEGAL_OBJECT_PATTERN.test(normalized))
  ) {
    return 'PERSONALIZED_LEGAL_ADVICE';
  }
  return 'ALLOW_GROUNDED_RETRIEVAL';
}
