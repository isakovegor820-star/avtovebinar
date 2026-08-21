import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from './env.js';
import { AppError } from './http.js';
import type { SpeechToTextAdapter, SpeechToTextInput, SpeechToTextSegment } from './speechToText.js';

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

function safeSttError(code: string) {
  return new AppError(503, 'Сервис расшифровки временно недоступен', undefined, code);
}

async function withTimeout(fetchImpl: FetchImplementation, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw safeSttError('stt_provider_unavailable');
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
        throw safeSttError('stt_provider_response_invalid');
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
    throw safeSttError('stt_provider_response_invalid');
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
      throw safeSttError('stt_provider_response_invalid');
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
      if (!Number.isSafeInteger(index) || index < 0) throw safeSttError('stt_provider_response_invalid');
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
  if (!segments.length) throw safeSttError('stt_provider_response_invalid');
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

  constructor(
    private readonly config: YandexSpeechKitConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)),
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

  async transcribe(input: SpeechToTextInput) {
    const requestId = crypto.createHash('sha256').update(`aspb-stt-v1:${input.storageKey}`).digest('hex').slice(0, 36);
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
    if (!submitted.ok) throw safeSttError('stt_provider_submit_failed');
    let operation: z.infer<typeof operationSchema>;
    try {
      operation = operationSchema.parse(await submitted.json());
    } catch {
      throw safeSttError('stt_provider_response_invalid');
    }
    let segments: SpeechToTextSegment[] | undefined;
    let operationError: unknown;
    try {
      const deadline = Date.now() + this.config.timeoutSeconds * 1_000;
      while (!operation.done) {
        if (Date.now() >= deadline) throw safeSttError('stt_provider_timeout');
        await this.sleep(this.config.pollIntervalMs);
        const status = await withTimeout(
          this.fetchImpl,
          `${this.config.operationEndpoint.replace(/\/$/, '')}/${encodeURIComponent(operation.id)}`,
          { method: 'GET', headers: this.headers() },
          30_000,
        );
        if (!status.ok) throw safeSttError('stt_provider_status_failed');
        try {
          operation = operationSchema.parse(await status.json());
        } catch {
          throw safeSttError('stt_provider_response_invalid');
        }
      }
      if (operation.error) throw safeSttError('stt_provider_failed');

      const result = await withTimeout(
        this.fetchImpl,
        `${this.config.resultEndpoint}?operationId=${encodeURIComponent(operation.id)}`,
        { method: 'GET', headers: this.headers() },
        60_000,
      );
      if (!result.ok) throw safeSttError('stt_provider_result_failed');
      segments = parseYandexRecognitionEvents(parseStreamingJson(await result.text()));
    } catch (error) {
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      const deleted = await withTimeout(
        this.fetchImpl,
        `${this.config.deleteEndpoint}?operationId=${encodeURIComponent(operation.id)}`,
        { method: 'DELETE', headers: this.headers() },
        30_000,
      );
      if (!deleted.ok) throw safeSttError('stt_provider_cleanup_failed');
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) throw cleanupError;
    if (operationError) throw operationError;
    if (!segments) throw safeSttError('stt_provider_response_invalid');
    return { segments };
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
