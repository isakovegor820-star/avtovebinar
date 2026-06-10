import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type ScriptedChatKind = 'scripted_user' | 'agent_question';

const DEFAULT_SCENARIO_PATH = path.join(process.cwd(), 'webinar-data', 'agent-chat-scenario.json');

const scriptedChatMessageSchema = z
  .object({
    id: z.string().min(1),
    sendAtSeconds: z.number().int().nonnegative(),
    answerStartSeconds: z.number().int().nonnegative().optional(),
    relatedVideoSeconds: z.number().int().nonnegative().optional(),
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    agentRole: z.string().min(1),
    message: z.string().trim().min(3).max(700),
    kind: z.enum(['scripted_user', 'agent_question']),
    topic: z.string().trim().min(1).optional(),
    visible: z.boolean().default(true),
    priority: z.number().int().optional(),
    allowAfterVideo: z.boolean().default(false),
  })
  .strict()
  .refine(value => value.answerStartSeconds !== undefined || value.relatedVideoSeconds !== undefined, {
    message: 'Each scripted chat message needs answerStartSeconds or relatedVideoSeconds',
  });

const scriptedChatScenarioSchema = z
  .object({
    version: z.literal(1),
    description: z.string().optional(),
    messages: z.array(scriptedChatMessageSchema),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    for (const [index, message] of scenario.messages.entries()) {
      if (ids.has(message.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'id'],
          message: `Duplicate scripted chat message id "${message.id}"`,
        });
      }
      ids.add(message.id);
    }
  });

export type ScriptedChatScenarioItem = z.infer<typeof scriptedChatMessageSchema>;
export type ScriptedChatScenario = z.infer<typeof scriptedChatScenarioSchema>;

export type ScriptedChatMessage = {
  id: string;
  offsetSeconds: number;
  answerStartSeconds?: number;
  relatedVideoSeconds?: number;
  agentId: string;
  authorName: string;
  authorRole: string;
  message: string;
  kind: ScriptedChatKind;
  isSynthetic: true;
  videoBlock: string;
  topic?: string;
  priority?: number;
};

export function parseScriptedChatScenario(input: unknown) {
  return scriptedChatScenarioSchema.parse(input);
}

export function loadScriptedChatScenarioFromFile(filePath = DEFAULT_SCENARIO_PATH) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseScriptedChatScenario(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid scripted chat scenario at ${filePath}: ${message}`);
  }
}

export const SCRIPTED_CHAT_SCENARIO = loadScriptedChatScenarioFromFile();

export function assertScriptedChatFitsDuration(
  durationSeconds: number,
  scenario: ScriptedChatScenario = SCRIPTED_CHAT_SCENARIO,
) {
  const duration = Math.floor(Number(durationSeconds));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid webinar video duration for scripted chat: ${durationSeconds}`);
  }

  const invalid = scenario.messages.filter(message => {
    if (message.visible === false || message.allowAfterVideo) {
      return false;
    }
    return message.sendAtSeconds > duration;
  });

  if (invalid.length > 0) {
    const ids = invalid.map(message => `${message.id}@${message.sendAtSeconds}s`).join(', ');
    throw new Error(
      `Scripted chat scenario exceeds webinar video duration ${duration}s. ` +
        `Move these messages inside the video duration or set allowAfterVideo: true: ${ids}`,
    );
  }
}

function toRuntimeMessage(message: ScriptedChatScenarioItem): ScriptedChatMessage {
  return {
    id: message.id,
    offsetSeconds: message.sendAtSeconds,
    answerStartSeconds: message.answerStartSeconds,
    relatedVideoSeconds: message.relatedVideoSeconds,
    agentId: message.agentId,
    authorName: message.agentName,
    authorRole: message.agentRole,
    message: message.message,
    kind: message.kind,
    isSynthetic: true,
    videoBlock: message.topic ?? 'Вопрос по теме',
    topic: message.topic,
    priority: message.priority,
  };
}

export function getScriptedChatMessagesUntil(
  offsetSeconds: number,
  options: {
    durationSeconds: number;
    includeAfterVideo?: boolean;
    validateDuration?: boolean;
    scenario?: ScriptedChatScenario;
  },
) {
  const scenario = options.scenario ?? SCRIPTED_CHAT_SCENARIO;
  if (options.validateDuration !== false) {
    assertScriptedChatFitsDuration(options.durationSeconds, scenario);
  }

  const offset = Math.max(0, Math.floor(offsetSeconds));
  const duration = Math.max(1, Math.floor(options.durationSeconds));

  return scenario.messages
    .filter(message => message.visible !== false)
    .filter(message => message.sendAtSeconds <= offset)
    .filter(message => message.sendAtSeconds <= duration || (options.includeAfterVideo && message.allowAfterVideo))
    .sort((left, right) => {
      if (left.sendAtSeconds !== right.sendAtSeconds) {
        return left.sendAtSeconds - right.sendAtSeconds;
      }
      return (left.priority ?? 0) - (right.priority ?? 0);
    })
    .map(toRuntimeMessage);
}
