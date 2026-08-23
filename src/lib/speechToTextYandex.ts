import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from './env.js';
import { AppError } from './http.js';
import {
  SpeechToTextProviderError,
  type SpeechToTextAdapter,
  type SpeechToTextInput,
  type SpeechToTextPollResult,
  type SpeechToTextSegment,
} from './speechToText.js';

type FetchImplementation = typeof fetch;

const operationSchema = z
  .object({
    id: z.string().min(1),
    done: z.boolean().optional().default(false),
    error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const alternativeSchema = z
  .object({
    text: z.string().trim().min(1),
    startTimeMs: z.union([z.string(), z.number()]),
    endTimeMs: z.union([z.string(), z.number()]),
    words: z
      .array(
        z
          .object({
            text: z.string(),
            startTimeMs: z.union([z.string(), z.number()]),
            endTimeMs: z.union([z.string(), z.number()]),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const recognitionEventSchema = z
  .object({
    audioCursors: z
      .object({ finalIndex: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
    channelTag: z.union([z.string(), z.number()]).optional(),
    final: z
      .object({
        alternatives: z.array(alternativeSchema).min(1),
        channelTag: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
    finalRefinement: z
      .object({
        finalIndex: z.union([z.string(), z.number()]),
        normalizedText: z
          .object({
            alternatives: z.array(alternativeSchema).min(1),
            channelTag: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RecognitionEvent = z.infer<typeof recognitionEventSchema>;

function safeSttError(code: string, retryable = true) {
  return new SpeechToTextProviderError(code, retryable);
}

function responseError(response: Response, code: string) {
  return safeSttError(code, response.status === 408 || response.status === 429 || response.status >= 500);
}

async function withTimeout(fetchImpl: FetchImplementation, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw safeSttError(
      error instanceof Error && error.name === 'AbortError' ? 'stt_provider_timeout' : 'stt_provider_unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseStreamingJson(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const events: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim().replace(/^data:\s*/, '');
      if (!value) continue;
      try {
        events.push(JSON.parse(value));
      } catch {
        throw safeSttError('stt_provider_response_invalid', false);
      }
    }
    return events;
  }
}

function speakerLabel(tag: string | number | undefined) {
  if (tag === undefined || tag === '') return undefined;
  const numeric = Number(tag);
  return Number.isInteger(numeric) ? `Спикер ${numeric + 1}` : `Спикер ${String(tag).slice(0, 80)}`;
}

function segmentFromAlternative(
  alternative: z.infer<typeof alternativeSchema>,
  channelTag: string | number | undefined,
): SpeechToTextSegment {
  const startMs = Number(alternative.startTimeMs);
  const endMs = Number(alternative.endTimeMs);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw safeSttError('stt_provider_response_invalid', false);
  }
  return { startMs, endMs, speaker: speakerLabel(channelTag), text: alternative.text };
}

export function parseYandexRecognitionEvents(rawEvents: unknown[]): SpeechToTextSegment[] {
  const finals = new Map<number, SpeechToTextSegment>();
  const refinements = new Map<number, SpeechToTextSegment>();
  let fallbackIndex = 0;
  for (const raw of rawEvents) {
    let event: RecognitionEvent;
    try {
      event = recognitionEventSchema.parse(raw);
    } catch {
      throw safeSttError('stt_provider_response_invalid', false);
    }
    if (event.final) {
      const parsedIndex = Number(event.audioCursors?.finalIndex);
      const index = Number.isSafeInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : fallbackIndex;
      fallbackIndex = Math.max(fallbackIndex + 1, index + 1);
      finals.set(
        index,
        segmentFromAlternative(event.final.alternatives[0], event.final.channelTag ?? event.channelTag),
      );
    }
    if (event.finalRefinement) {
      const index = Number(event.finalRefinement.finalIndex);
      if (!Number.isSafeInteger(index) || index < 0) throw safeSttError('stt_provider_response_invalid', false);
      refinements.set(
        index,
        segmentFromAlternative(
          event.finalRefinement.normalizedText.alternatives[0],
          event.finalRefinement.normalizedText.channelTag ?? event.channelTag,
        ),
      );
    }
  }
  const indexes = [...new Set([...finals.keys(), ...refinements.keys()])].sort((left, right) => left - right);
  const segments = indexes
    .map(index => refinements.get(index) ?? finals.get(index))
    .filter(Boolean) as SpeechToTextSegment[];
  if (!segments.length) throw safeSttError('stt_provider_response_invalid', false);
  return segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

export type YandexSpeechKitConfig = {
  apiKey: string;
  folderId: string;
  recognizeEndpoint: string;
  operationEndpoint: string;
  resultEndpoint: string;
  deleteEndpoint: string;
  audioUriPrefix: string;
  model: string;
  pollIntervalMs: number;
  timeoutSeconds: number;
};

export class YandexSpeechKitAdapter implements SpeechToTextAdapter {
  readonly providerId = 'yandex_speechkit';
  readonly templateVersion = 'transcript-v1';
  readonly modelId: string;
  readonly maxAudioSizeBytes = 1_073_741_824n;
  readonly maxDurationSeconds = 14_400;
  readonly supportsNativeDictionary = false;

  constructor(
    private readonly config: YandexSpeechKitConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
    // Retained as a third constructor argument for source compatibility with
    // adapter contract tests from the pre-durable implementation.
    _sleep?: (milliseconds: number) => Promise<void>,
  ) {
    this.modelId = config.model;
  }

  private headers(requestId?: string) {
    return {
      Authorization: `Api-Key ${this.config.apiKey}`,
      'x-folder-id': this.config.folderId,
      'content-type': 'application/json',
      ...(requestId ? { 'x-client-request-id': requestId } : {}),
    };
  }

  async submit(input: SpeechToTextInput, idempotencyKey: string) {
    if (input.audioSizeBytes <= 0n || input.audioSizeBytes > this.maxAudioSizeBytes) {
      throw safeSttError('stt_audio_size_exceeded', false);
    }
    if (input.durationSeconds <= 0 || input.durationSeconds > this.maxDurationSeconds) {
      throw safeSttError('stt_audio_duration_exceeded', false);
    }
    if (input.dictionary.length > 500) throw safeSttError('stt_dictionary_limit_exceeded', false);
    const requestId = crypto.createHash('sha256').update(`aspb-stt-v2:${idempotencyKey}`).digest('hex').slice(0, 36);
    const uri = new URL(
      input.storageKey.split('/').map(encodeURIComponent).join('/'),
      this.config.audioUriPrefix.endsWith('/') ? this.config.audioUriPrefix : `${this.config.audioUriPrefix}/`,
    ).toString();
    const submitted = await withTimeout(
      this.fetchImpl,
      this.config.recognizeEndpoint,
      {
        method: 'POST',
        headers: this.headers(requestId),
        body: JSON.stringify({
          uri,
          recognitionModel: {
            model: this.config.model,
            audioFormat: { containerAudio: { containerAudioType: 'OGG_OPUS' } },
            textNormalization: {
              textNormalization: 'TEXT_NORMALIZATION_ENABLED',
              profanityFilter: false,
              literatureText: true,
            },
            languageRestriction: {
              restrictionType: 'WHITELIST',
              languageCode: [input.language || 'ru-RU'],
            },
            audioProcessingType: 'FULL_DATA',
          },
          speakerLabeling: { speakerLabeling: 'SPEAKER_LABELING_ENABLED' },
        }),
      },
      30_000,
    );
    if (!submitted.ok) throw responseError(submitted, 'stt_provider_submit_failed');
    let operation: z.infer<typeof operationSchema>;
    try {
      operation = operationSchema.parse(await submitted.json());
    } catch {
      throw safeSttError('stt_provider_response_invalid', false);
    }
    return {
      providerJobId: operation.id,
      dictionaryApplied: false,
    };
  }

  async poll(providerJobId: string): Promise<SpeechToTextPollResult> {
    const status = await withTimeout(
      this.fetchImpl,
      `${this.config.operationEndpoint.replace(/\/$/, '')}/${encodeURIComponent(providerJobId)}`,
      { method: 'GET', headers: this.headers() },
      30_000,
    );
    if (!status.ok) throw responseError(status, 'stt_provider_status_failed');
    let operation: z.infer<typeof operationSchema>;
    try {
      operation = operationSchema.parse(await status.json());
    } catch {
      throw safeSttError('stt_provider_response_invalid', false);
    }
    if (operation.id !== providerJobId) throw safeSttError('stt_provider_binding_mismatch', false);
    if (!operation.done) return { status: 'pending' };
    if (operation.error) return { status: 'failed', errorCode: 'stt_provider_failed' };
    return { status: 'succeeded' };
  }

  async getResult(providerJobId: string) {
    const result = await withTimeout(
      this.fetchImpl,
      `${this.config.resultEndpoint}?operationId=${encodeURIComponent(providerJobId)}`,
      { method: 'GET', headers: this.headers() },
      60_000,
    );
    if (!result.ok) throw responseError(result, 'stt_provider_result_failed');
    return { segments: parseYandexRecognitionEvents(parseStreamingJson(await result.text())) };
  }

  async delete(providerJobId: string) {
    const deleted = await withTimeout(
      this.fetchImpl,
      `${this.config.deleteEndpoint}?operationId=${encodeURIComponent(providerJobId)}`,
      { method: 'DELETE', headers: this.headers() },
      30_000,
    );
    if (!deleted.ok && deleted.status !== 404) throw responseError(deleted, 'stt_provider_cleanup_failed');
  }
}

export function createYandexSpeechKitAdapterFromEnv() {
  if (!env.STT_YANDEX_API_KEY || !env.STT_YANDEX_FOLDER_ID || !env.STT_YANDEX_AUDIO_URI_PREFIX) {
    throw new AppError(503, 'Сервис расшифровки ещё не настроен', undefined, 'stt_provider_unconfigured');
  }
  return new YandexSpeechKitAdapter({
    apiKey: env.STT_YANDEX_API_KEY,
    folderId: env.STT_YANDEX_FOLDER_ID,
    recognizeEndpoint: env.STT_YANDEX_ENDPOINT,
    operationEndpoint: env.STT_YANDEX_OPERATION_ENDPOINT,
    resultEndpoint: env.STT_YANDEX_RESULT_ENDPOINT,
    deleteEndpoint: env.STT_YANDEX_DELETE_ENDPOINT,
    audioUriPrefix: env.STT_YANDEX_AUDIO_URI_PREFIX,
    model: env.STT_YANDEX_MODEL,
    pollIntervalMs: env.STT_YANDEX_POLL_INTERVAL_MS,
    timeoutSeconds: env.STT_YANDEX_TIMEOUT_SECONDS,
  });
}
