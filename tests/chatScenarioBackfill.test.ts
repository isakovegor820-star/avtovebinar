import { describe, expect, it } from 'vitest';
import { parseScriptedChatScenario } from '../src/lib/scriptedChat.js';
import {
  legacyChatScenarioFingerprint,
  legacyChatScenarioProjection,
} from '../src/lib/tenancy/chatScenarioBackfill.js';

const fixture = parseScriptedChatScenario({
  version: 1,
  messages: [
    {
      id: 'legacy-1',
      sendAtSeconds: 15,
      relatedVideoSeconds: 20,
      agentId: 'legacy-generic',
      agentName: 'Подготовленный вопрос',
      agentRole: 'подготовленный сценарий',
      message: 'Как проверить документ?',
      kind: 'agent_question',
      visible: true,
      priority: 1,
    },
  ],
});

describe('legacy ChatScenario backfill contract', () => {
  it('uses a deterministic fingerprint independent of object key order', () => {
    const reordered = parseScriptedChatScenario(JSON.parse(JSON.stringify(fixture)));
    expect(legacyChatScenarioFingerprint(reordered)).toBe(legacyChatScenarioFingerprint(fixture));
    expect(legacyChatScenarioFingerprint(fixture)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves order, offset and text but produces only synthetic prepared messages', () => {
    expect(legacyChatScenarioProjection(fixture)).toEqual([
      expect.objectContaining({
        orderIndex: 0,
        offsetSeconds: 15,
        text: 'Как проверить документ?',
        kind: 'PREPARED_QUESTION',
        status: 'APPROVED',
        authorLabel: 'Подготовленный вопрос',
        isSynthetic: true,
      }),
    ]);
  });
});
