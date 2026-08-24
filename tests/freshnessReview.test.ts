import { describe, expect, it } from 'vitest';
import { isFreshnessReviewDue } from '../src/lib/tenancy/freshnessReview.js';

const now = new Date('2026-08-24T10:00:00.000Z');
const current = {
  contentStatus: 'PUBLISHED',
  freshnessStatus: 'CURRENT',
  reviewDueAt: now,
  archivedAt: null,
  authorProfileId: 'author_test',
};

describe('freshness review due state machine', () => {
  it('uses an inclusive due boundary without changing publication state', () => {
    expect(isFreshnessReviewDue(current, new Date(now.getTime() - 1))).toBe(false);
    expect(isFreshnessReviewDue(current, now)).toBe(true);
    expect(isFreshnessReviewDue(current, new Date(now.getTime() + 1))).toBe(true);
    expect(current.contentStatus).toBe('PUBLISHED');
  });

  it('rejects archived, unpublished, already due, or authorless records', () => {
    expect(isFreshnessReviewDue({ ...current, archivedAt: now }, now)).toBe(false);
    expect(isFreshnessReviewDue({ ...current, contentStatus: 'DRAFT' }, now)).toBe(false);
    expect(isFreshnessReviewDue({ ...current, freshnessStatus: 'REVIEW_DUE' }, now)).toBe(false);
    expect(isFreshnessReviewDue({ ...current, authorProfileId: null }, now)).toBe(false);
  });
});
