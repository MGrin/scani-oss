import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  compareReviewItems,
  type ReviewRow,
  reviewKindOptions,
  reviewMatches,
} from '../../../src/v3/lib/review';

/** A row that has already been named — which is all this module sees now that
 *  the wording is composed in `review-text.ts` (SC-371). */
function item(overrides: Partial<ReviewRow> = {}): ReviewRow {
  const row: ReviewRow = {
    id: 'job:abc',
    kind: 'screenshot-parse',
    title: 'Document parse',
    detail: '2 holdings · BTC, ETH',
    amount: null,
    search: '',
    href: '/jobs/abc',
    createdAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
  // The searchable text follows the row rather than being set per fixture:
  // `toReviewRow` builds it from exactly these fields.
  return {
    ...row,
    search:
      overrides.search ??
      [row.title, row.detail, row.amount && `${row.amount.value} ${row.amount.currency}`]
        .filter(Boolean)
        .join(' '),
  };
}

describe('reviewKindOptions', () => {
  test('labels a kind with the title its rows carry, once each', () => {
    const options = reviewKindOptions([
      item({ kind: 'screenshot-parse', title: 'Document parse' }),
      item({ id: 'job:2', kind: 'screenshot-parse', title: 'Document parse' }),
      item({ id: 'ex:1', kind: 'document-extraction', title: 'Invoice extracted' }),
    ]);

    // Ordered by the label a reader sees, not by kind or by arrival.
    expect(options).toEqual([
      { value: 'screenshot-parse', label: 'Document parse' },
      { value: 'document-extraction', label: 'Invoice extracted' },
    ]);
  });

  test('is empty for an empty feed', () => {
    expect(reviewKindOptions([])).toEqual([]);
  });
});

describe('compareReviewItems', () => {
  const older = item({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' });
  const newer = item({ id: 'b', createdAt: '2026-08-09T00:00:00.000Z' });

  test('newest first is the default direction', () => {
    expect(compareReviewItems(newer, older, 'arrived', 'desc')).toBeLessThan(0);
  });

  test('sorts by title alphabetically', () => {
    const a = item({ title: 'Alpha' });
    const b = item({ title: 'Beta' });
    expect(compareReviewItems(a, b, 'title', 'asc')).toBeLessThan(0);
  });

  test('an unknown field leaves the order alone', () => {
    expect(compareReviewItems(newer, older, 'nonsense', 'asc')).toBe(0);
  });
});

describe('reviewMatches', () => {
  test('matches the title and the detail, case-insensitively', () => {
    expect(reviewMatches(item({ title: 'Wallet import' }), 'wallet')).toBe(true);
    expect(reviewMatches(item({ detail: 'Kraken · 12 rows' }), 'kraken')).toBe(true);
  });

  test('a missing detail is not a match for everything', () => {
    expect(reviewMatches(item({ detail: null }), 'kraken')).toBe(false);
  });

  /** The figure was searchable when it was spelled into the second line, and
   *  it stays searchable in the digits the extractor recorded. */
  test('matches the figure a row shows', () => {
    const row = item({
      title: 'Invoice extracted',
      detail: 'Albert Heijn',
      amount: { value: 42.5, currency: 'USD' },
      search: 'Invoice extracted Albert Heijn 42.50 USD',
    });
    expect(reviewMatches(row, '42.50')).toBe(true);
  });
});
