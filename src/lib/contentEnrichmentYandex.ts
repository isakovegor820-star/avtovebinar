import { z } from 'zod';
import { env } from './env.js';
import { AppError } from './http.js';
import type { ContentEnrichmentAdapter, ContentEnrichmentInput, EnrichmentSuggestion } from './contentEnrichment.js';

type FetchImplementation = typeof fetch;

const completionResponseSchema = z
  .object({
    result: z
      .object({
        alternatives: z
          .array(
            z
              .object({
                message: z.object({ text: z.string().min(1) }).passthrough(),
                status: z.string().optional(),
              })
              .passthrough(),
          )
          .min(1),
        modelVersion: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const suggestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('TITLE'),
      orderIndex: z.number().int().nonnegative(),
      content: z.object({ text: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('DESCRIPTION'),
      orderIndex: z.number().int().nonnegative(),
      content: z.object({ text: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('CHAPTER'),
      orderIndex: z.number().int().nonnegative(),
      content: z
        .object({
          startMs: z.number().int().nonnegative(),
          title: z.string(),
          description: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('TAG'),
      orderIndex: z.number().int().nonnegative(),
      content: z.object({ name: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('PREPARED_QUESTION'),
      orderIndex: z.number().int().nonnegative(),
      content: z
        .object({
          offsetSeconds: z.number().int().nonnegative(),
          text: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

const suggestionsResponseSchema = z
  .object({
    suggestions: z.array(suggestionSchema).min(1).max(100),
  })
  .strict();

function safeAiError(code: string) {
  return new AppError(503, 'AI-сервис временно недоступен', undefined, code);
}

function compactTranscript(input: ContentEnrichmentInput) {
  const maxCharacters = 100_000;
  const formatted = input.segments.map(
    segment => `[${segment.startMs}-${segment.endMs}] ${segment.text.replace(/\s+/g, ' ').trim()}`,
  );
  if (formatted.join('\n').length <= maxCharacters) return formatted.join('\n');
  const selected: string[] = [];
  const step = Math.max(1, Math.ceil(formatted.length / 500));
  for (let index = 0; index < formatted.length; index += step) {
    const line = formatted[index];
    if (selected.join('\n').length + line.length > maxCharacters) break;
    selected.push(line);
  }
  return selected.join('\n');
}

const providerJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'orderIndex', 'content'],
        properties: {
          type: { type: 'string', enum: ['TITLE', 'DESCRIPTION', 'CHAPTER', 'TAG', 'PREPARED_QUESTION'] },
          orderIndex: { type: 'integer', minimum: 0 },
          content: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              startMs: { type: 'integer', minimum: 0 },
              title: { type: 'string' },
              description: { type: 'string' },
              name: { type: 'string' },
              offsetSeconds: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
};

export type YandexFoundationModelsConfig = {
  apiKey: string;
  folderId: string;
  modelUri: string;
  endpoint: string;
  timeoutSeconds: number;
};

export class YandexFoundationModelsAdapter implements ContentEnrichmentAdapter {
  readonly providerId = 'yandex_foundation_models';
  readonly templateVersion = 'legal-enrichment-v1';
  readonly modelId: string;

  constructor(
    private readonly config: YandexFoundationModelsConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {
    this.modelId = config.modelUri;
  }

  async enrich(input: ContentEnrichmentInput): Promise<{
    suggestions: EnrichmentSuggestion[];
    providerModelVersion?: string;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1_000);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Api-Key ${this.config.apiKey}`,
          'x-folder-id': this.config.folderId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          modelUri: this.config.modelUri,
          completionOptions: { stream: false, temperature: 0.1, maxTokens: '8000' },
          jsonSchema: { schema: providerJsonSchema },
          messages: [
            {
              role: 'system',
              text: [
                'Ты создаёшь только редакторские предложения для юридического вебинара.',
                'Не публикуй материал и не выдавай персонализированный юридический совет.',
                'Не выдумывай факты, участников, отзывы или результаты.',
                'Верни JSON строго по схеме. Все предложения требуют проверки человеком.',
              ].join(' '),
            },
            {
              role: 'user',
              text: JSON.stringify({
                webinarTitle: input.webinarTitle,
                language: input.language,
                dictionary: input.dictionary,
                transcript: compactTranscript(input),
              }),
            },
          ],
        }),
      });
    } catch {
      throw safeAiError('ai_provider_unavailable');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw safeAiError('ai_provider_request_failed');
    let completion: z.infer<typeof completionResponseSchema>;
    try {
      completion = completionResponseSchema.parse(await response.json());
    } catch {
      throw safeAiError('ai_provider_response_invalid');
    }
    const alternative = completion.result.alternatives[0];
    if (alternative.status && !['ALTERNATIVE_STATUS_FINAL', 'FINAL'].includes(alternative.status)) {
      throw safeAiError('ai_provider_response_incomplete');
    }
    let parsed: z.infer<typeof suggestionsResponseSchema>;
    try {
      parsed = suggestionsResponseSchema.parse(JSON.parse(alternative.message.text));
    } catch {
      throw safeAiError('ai_provider_response_invalid');
    }
    return {
      suggestions: parsed.suggestions as EnrichmentSuggestion[],
      providerModelVersion: completion.result.modelVersion,
    };
  }
}

export function createYandexFoundationModelsAdapterFromEnv() {
  if (!env.AI_YANDEX_API_KEY || !env.AI_YANDEX_FOLDER_ID || !env.AI_YANDEX_MODEL_URI) {
    throw new AppError(503, 'AI enrichment provider is not configured', undefined, 'ai_provider_unconfigured');
  }
  return new YandexFoundationModelsAdapter({
    apiKey: env.AI_YANDEX_API_KEY,
    folderId: env.AI_YANDEX_FOLDER_ID,
    modelUri: env.AI_YANDEX_MODEL_URI,
    endpoint: env.AI_YANDEX_ENDPOINT,
    timeoutSeconds: env.AI_YANDEX_TIMEOUT_SECONDS,
  });
}
