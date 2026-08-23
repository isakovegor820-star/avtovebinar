import { describe, expect, it } from 'vitest';
import { classifyLegalAdviceRequest, questionTextFingerprint } from '../src/lib/chatPolicy.js';

describe('chat moderator legal-safety policy', () => {
  it.each([
    'Что мне делать с моим договором?',
    'Можно ли мне подать иск в моей ситуации?',
    'Проанализируйте мой договор и дайте совет',
    'У меня долг по налогам — как мне действовать?',
  ])('routes personalized legal advice to a human: %s', text => {
    expect(classifyLegalAdviceRequest(text)).toBe('PERSONALIZED_LEGAL_ADVICE');
  });

  it.each([
    'Какие признаки субсидиарной ответственности названы в вебинаре?',
    'Где найти опубликованный шаблон заявления?',
    'Какой срок указан в статье 61.11 закона?',
  ])('allows grounded educational retrieval: %s', text => {
    expect(classifyLegalAdviceRequest(text)).toBe('ALLOW_GROUNDED_RETRIEVAL');
  });

  it('uses a normalized non-secret key for repeated-question grouping', () => {
    expect(questionTextFingerprint('  Какие ДОКУМЕНТЫ\nнужны? ')).toBe(
      questionTextFingerprint('какие документы нужны?'),
    );
    expect(questionTextFingerprint('Другой вопрос')).not.toBe(questionTextFingerprint('какие документы нужны?'));
  });
});
