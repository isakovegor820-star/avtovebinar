import crypto from 'node:crypto';
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
  audioSizeBytes: bigint;
  dictionary: Array<{ term: string; expansion: string | null }>;
};

export type SpeechToTextSubmission = {
  providerJobId: string;
  providerModelVersion?: string;
  dictionaryApplied: boolean;
};

export type SpeechToTextPollResult =
  | { status: 'pending'; providerModelVersion?: string }
  | { status: 'succeeded'; providerModelVersion?: string }
  | { status: 'failed'; errorCode: string };

export class SpeechToTextProviderError extends AppError {
  constructor(
    code: string,
    readonly retryable: boolean,
  ) {
    super(
      retryable ? 503 : 422,
      retryable ? 'Сервис расшифровки временно недоступен' : 'Сервис расшифровки отклонил запрос',
      undefined,
      code,
    );
    this.name = 'SpeechToTextProviderError';
  }
}

export interface SpeechToTextAdapter {
  readonly providerId: string;
  readonly modelId: string;
  readonly templateVersion: string;
  readonly maxAudioSizeBytes: bigint;
  readonly maxDurationSeconds: number;
  readonly supportsNativeDictionary: boolean;
  submit(input: SpeechToTextInput, idempotencyKey: string): Promise<SpeechToTextSubmission>;
  poll(providerJobId: string): Promise<SpeechToTextPollResult>;
  getResult(providerJobId: string): Promise<{ segments: SpeechToTextSegment[]; providerModelVersion?: string }>;
  delete(providerJobId: string): Promise<void>;
}

class UnconfiguredSpeechToTextAdapter implements SpeechToTextAdapter {
  readonly providerId = 'unconfigured';
  readonly modelId = 'unconfigured';
  readonly templateVersion = 'transcript-v1';
  readonly maxAudioSizeBytes = 0n;
  readonly maxDurationSeconds = 0;
  readonly supportsNativeDictionary = false;

  private unavailable(): never {
    throw new AppError(503, 'Сервис расшифровки ещё не настроен', undefined, 'stt_provider_unconfigured');
  }

  async submit(): Promise<never> {
    return this.unavailable();
  }
  async poll(): Promise<never> {
    return this.unavailable();
  }
  async getResult(): Promise<never> {
    return this.unavailable();
  }
  async delete(): Promise<never> {
    return this.unavailable();
  }
}

const fakeJobs = new Map<string, SpeechToTextInput>();

export class TestFakeSpeechToTextAdapter implements SpeechToTextAdapter {
  readonly providerId = 'test_fake';
  readonly modelId = 'deterministic-stt-v2';
  readonly templateVersion = 'transcript-v1';
  readonly maxAudioSizeBytes = 1_073_741_824n;
  readonly maxDurationSeconds = 14_400;
  readonly supportsNativeDictionary = true;

  private assertTest() {
    if (env.NODE_ENV !== 'test') {
      throw new AppError(503, 'Test STT adapter is unavailable', undefined, 'stt_provider_unconfigured');
    }
  }

  async submit(input: SpeechToTextInput, idempotencyKey: string) {
    this.assertTest();
    const providerJobId = `fake_${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    fakeJobs.set(providerJobId, input);
    return { providerJobId, providerModelVersion: 'test-v2', dictionaryApplied: true };
  }

  async poll(providerJobId: string): Promise<SpeechToTextPollResult> {
    this.assertTest();
    if (!fakeJobs.has(providerJobId)) return { status: 'failed', errorCode: 'stt_provider_job_unknown' };
    return { status: 'succeeded', providerModelVersion: 'test-v2' };
  }

  async getResult(providerJobId: string) {
    this.assertTest();
    const input = fakeJobs.get(providerJobId);
    if (!input) throw new SpeechToTextProviderError('stt_provider_job_unknown', false);
    const durationMs = Math.max(3_000, Math.floor(input.durationSeconds * 1_000));
    const boundary = Math.floor(durationMs / 3);
    return {
      providerModelVersion: 'test-v2',
      segments: [
        { startMs: 0, endMs: boundary, speaker: 'Спикер', text: 'Введение в тему юридического вебинара.' },
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

  async delete(providerJobId: string) {
    this.assertTest();
    fakeJobs.delete(providerJobId);
  }
}

export function getSpeechToTextAdapter(): SpeechToTextAdapter {
  if (env.STT_PROVIDER === 'test_fake') return new TestFakeSpeechToTextAdapter();
  if (env.STT_PROVIDER === 'yandex_speechkit') return createYandexSpeechKitAdapterFromEnv();
  return new UnconfiguredSpeechToTextAdapter();
}
