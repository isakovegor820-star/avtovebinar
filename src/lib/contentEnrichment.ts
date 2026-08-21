import { env } from './env.js';
import { AppError } from './http.js';
import { createYandexFoundationModelsAdapterFromEnv } from './contentEnrichmentYandex.js';

export type EnrichmentSuggestion =
  | { type: 'TITLE'; orderIndex: number; content: { text: string } }
  | { type: 'DESCRIPTION'; orderIndex: number; content: { text: string } }
  | { type: 'CHAPTER'; orderIndex: number; content: { startMs: number; title: string; description?: string } }
  | { type: 'TAG'; orderIndex: number; content: { name: string } }
  | { type: 'PREPARED_QUESTION'; orderIndex: number; content: { offsetSeconds: number; text: string } };

export type ContentEnrichmentInput = {
  webinarTitle: string;
  language: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  dictionary: Array<{ term: string; expansion: string | null }>;
};

export interface ContentEnrichmentAdapter {
  readonly providerId: string;
  readonly modelId: string;
  readonly templateVersion: string;
  enrich(input: ContentEnrichmentInput): Promise<{
    suggestions: EnrichmentSuggestion[];
    providerModelVersion?: string;
  }>;
}

class UnconfiguredContentEnrichmentAdapter implements ContentEnrichmentAdapter {
  readonly providerId = 'unconfigured';
  readonly modelId = 'unconfigured';
  readonly templateVersion = 'legal-enrichment-v1';

  async enrich(): Promise<never> {
    throw new AppError(503, 'AI enrichment provider is not configured', undefined, 'ai_provider_unconfigured');
  }
}

export class TestFakeContentEnrichmentAdapter implements ContentEnrichmentAdapter {
  readonly providerId = 'test_fake';
  readonly modelId = 'deterministic-enrichment-v1';
  readonly templateVersion = 'legal-enrichment-v1';

  async enrich(input: ContentEnrichmentInput) {
    const midpoint = input.segments[Math.floor(input.segments.length / 2)]?.startMs ?? 0;
    const baseTitle = input.webinarTitle.trim().slice(0, 200);
    return {
      suggestions: [
        { type: 'TITLE' as const, orderIndex: 0, content: { text: `Практический разбор: ${baseTitle}`.slice(0, 240) } },
        {
          type: 'DESCRIPTION' as const,
          orderIndex: 0,
          content: { text: 'Структурированный обзор правовых оснований, практики и общих выводов.' },
        },
        { type: 'CHAPTER' as const, orderIndex: 0, content: { startMs: 0, title: 'Введение' } },
        { type: 'CHAPTER' as const, orderIndex: 1, content: { startMs: midpoint, title: 'Правовая практика' } },
        { type: 'TAG' as const, orderIndex: 0, content: { name: 'право' } },
        { type: 'TAG' as const, orderIndex: 1, content: { name: 'практика' } },
        {
          type: 'PREPARED_QUESTION' as const,
          orderIndex: 0,
          content: { offsetSeconds: 30, text: 'Какой общий порядок применения рассмотренных норм?' },
        },
      ],
    };
  }
}

export function getContentEnrichmentAdapter(): ContentEnrichmentAdapter {
  if (env.AI_ENRICHMENT_PROVIDER === 'test_fake') return new TestFakeContentEnrichmentAdapter();
  if (env.AI_ENRICHMENT_PROVIDER === 'yandex_foundation_models') {
    return createYandexFoundationModelsAdapterFromEnv();
  }
  return new UnconfiguredContentEnrichmentAdapter();
}
