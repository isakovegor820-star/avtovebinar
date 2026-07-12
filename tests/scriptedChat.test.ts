import { describe, expect, it } from 'vitest';
import {
  SCRIPTED_CHAT_SCENARIO,
  assertScriptedChatFitsDuration,
  getScriptedChatMessagesUntil,
  parseScriptedChatScenario,
} from '../src/lib/scriptedChat.js';
import { WEBINAR_VIDEO_DURATION_SECONDS } from '../src/lib/webinarTimeline.js';

describe('scripted chat scenario', () => {
  it('loads the JSON scenario and exposes only messages up to the live offset', () => {
    const messages = getScriptedChatMessagesUntil(120, { durationSeconds: WEBINAR_VIDEO_DURATION_SECONDS });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every(message => message.offsetSeconds <= 120)).toBe(true);
    expect(messages.some(message => message.kind === 'agent_question')).toBe(true);
    // Первым теперь может идти «волна» (scripted_user без answerStartSeconds).
    // Форму с answerStartSeconds проверяем на первом agent_question — именно у него оно есть.
    expect(messages[0]).toMatchObject({ isSynthetic: true, agentId: expect.any(String) });
    const firstQuestion = messages.find(message => message.kind === 'agent_question');
    expect(firstQuestion).toMatchObject({
      isSynthetic: true,
      agentId: expect.any(String),
      answerStartSeconds: expect.any(Number),
    });
  });

  it('fails clearly when a visible message exceeds the configured video duration', () => {
    const invalidScenario = parseScriptedChatScenario({
      version: 1,
      messages: [
        {
          id: 'too_late',
          sendAtSeconds: 600,
          answerStartSeconds: 660,
          agentId: 'agent',
          agentName: 'Агент',
          agentRole: 'роль',
          message: 'Этот вопрос не должен пройти при коротком видео.',
          kind: 'agent_question',
        },
      ],
    });

    expect(() => assertScriptedChatFitsDuration(568, invalidScenario)).toThrow(/exceeds webinar video duration/);
  });

  it('allows explicit post-webinar messages while protecting in-video timing', () => {
    const scenario = parseScriptedChatScenario({
      version: 1,
      messages: [
        {
          id: 'after_video',
          sendAtSeconds: 700,
          answerStartSeconds: 700,
          agentId: 'agent',
          agentName: 'Агент',
          agentRole: 'роль',
          message: 'Post-webinar follow-up can be explicit.',
          kind: 'scripted_user',
          allowAfterVideo: true,
        },
      ],
    });

    expect(() => assertScriptedChatFitsDuration(568, scenario)).not.toThrow();
  });

  it('keeps the committed scenario inside the current video duration', () => {
    expect(() => assertScriptedChatFitsDuration(WEBINAR_VIDEO_DURATION_SECONDS, SCRIPTED_CHAT_SCENARIO)).not.toThrow();
  });

  it('keeps curated scripted participants and messages unique (flood-волны исключены — они намеренно повторяются)', () => {
    // «Волны цифр» (flood_*) намеренно повторяют и текст («1», «+»), и имена участников —
    // это эффект живой толпы. Уникальность требуем только от курируемых (не-flood) сообщений.
    const curated = SCRIPTED_CHAT_SCENARIO.messages.filter(
      message => message.visible !== false && !message.id.startsWith('flood_'),
    );
    const authorNames = curated.map(message => message.agentName);
    const messageTexts = curated.map(message => message.message);

    expect(new Set(authorNames).size).toBe(authorNames.length);
    expect(new Set(messageTexts).size).toBe(messageTexts.length);

    // id уникальны по всему сценарию, включая волны.
    const allIds = SCRIPTED_CHAT_SCENARIO.messages.map(message => message.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
