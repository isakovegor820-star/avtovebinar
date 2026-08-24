import { describe, expect, it } from 'vitest';
import { chapterCreateSchema, chapterReorderSchema, chapterUpdateSchema } from '../src/lib/tenancy/webinarChapters.js';

describe('manual webinar chapter contracts', () => {
  it('accepts a strict chapter create payload', () => {
    expect(
      chapterCreateSchema.parse({
        transcriptId: 'transcript-1',
        expectedTranscriptRevision: 3,
        startMs: 42_000,
        title: 'Проверка договора',
        description: null,
      }),
    ).toMatchObject({ startMs: 42_000, expectedTranscriptRevision: 3 });
    expect(() =>
      chapterCreateSchema.parse({
        transcriptId: 'transcript-1',
        expectedTranscriptRevision: 3,
        startMs: -1,
        title: 'Проверка договора',
      }),
    ).toThrow();
  });

  it('requires an optimistic revision and unique reorder positions', () => {
    expect(() => chapterUpdateSchema.parse({ expectedRevision: 1 })).toThrow();
    expect(() =>
      chapterReorderSchema.parse({
        transcriptId: 'transcript-1',
        items: [
          { id: 'chapter-1', expectedRevision: 1, orderIndex: 0 },
          { id: 'chapter-2', expectedRevision: 1, orderIndex: 0 },
        ],
      }),
    ).toThrow();
  });
});
