import { env } from './env.js';
import { AppError } from './http.js';
import { createYandexSpeechKitAdapterFromEnv } from './speechToTextYandex.js';

export type SpeechToTextSegment = {
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
};

export type SpeechToTextInput = {
  storageKey: string;
  language: string;
  durationSeconds: number;
  dictionary: Array<{ term: string; expansion: string | null }>;
};

export interface SpeechToTextAdapter {
  readonly providerId: string;
  readonly modelId: string;
  readonly templateVersion: string;
  transcribe(input: SpeechToTextInput): Promise<{ segments: SpeechToTextSegment[] }>;
}

class UnconfiguredSpeechToTextAdapter implements SpeechToTextAdapter {
  readonly providerId = 'unconfigured';
  readonly modelId = 'unconfigured';
  readonly templateVersion = 'transcript-v1';

  async transcribe(): Promise<never> {
    throw new AppError(503, 'Сервис расшифровки ещё не настроен', undefined, 'stt_provider_unconfigured');
  }
}

export class TestFakeSpeechToTextAdapter implements SpeechToTextAdapter {
  readonly providerId = 'test_fake';
  readonly modelId = 'deterministic-stt-v1';
  readonly templateVersion = 'transcript-v1';

  async transcribe(input: SpeechToTextInput) {
    const durationMs = Math.max(3_000, Math.floor(input.durationSeconds * 1_000));
    const boundary = Math.floor(durationMs / 3);
    return {
      segments: [
        {
          startMs: 0,
          endMs: boundary,
          speaker: 'Спикер',
          text: 'Введение в тему юридического вебинара.',
        },
        {
          startMs: boundary,
          endMs: boundary * 2,
          speaker: 'Спикер',
          text: 'Разбор правовых оснований и практики.',
        },
        {
          startMs: boundary * 2,
          endMs: durationMs,
          speaker: 'Спикер',
          text: 'Итоги и общие рекомендации без персонализированной юридической консультации.',
        },
      ],
    };
  }
}

export function getSpeechToTextAdapter(): SpeechToTextAdapter {
  if (env.STT_PROVIDER === 'test_fake') return new TestFakeSpeechToTextAdapter();
  if (env.STT_PROVIDER === 'yandex_speechkit') return createYandexSpeechKitAdapterFromEnv();
  return new UnconfiguredSpeechToTextAdapter();
}
