import { describe, expect, test } from 'bun:test';
import {
  compareReviewItems,
  type ReviewRow,
  reviewHref,
  reviewKindOptions,
  reviewMatches,
  splitReviewSubtitle,
} from '../../../src/v3/lib/review';

function item(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'job:abc',
    kind: 'screenshot-parse',
    title: 'Document parse',
    subtitle: '2 files',
    href: '/jobs/abc',
    createdAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
}

describe('reviewHref', () => {
  /**
   * v3 took the root in V3-19, so the server's version-neutral href is already
   * v3's own path and a row v3 can render needs no translation at all. What the
   * function still decides is the *other* case — see below.
   */
  test('a job row is already at its v3 screen', () => {
    expect(reviewHref('/jobs/abc-123')).toBe('/jobs/abc-123');
  });

  test('an extraction row is too', () => {
    // V3-15 deliberately left this one crossing to v2: v3 had no document page
    // then, so a v3 path would have hit the catch-all and bounced the reader to
    // the home screen. V3-43 built the surface, so the exception is gone.
    expect(reviewHref('/documents/doc-1')).toBe('/documents/doc-1');
  });

  test('a surface v3 has not built is sent to the classic UI, not to a dead route', () => {
    // No producer hands out these today; the rule is what matters, because the
    // feed's shape is the server's to change and a v3 route that does not exist
    // resolves to Home.
    expect(reviewHref('/integrations-beta')).toBe('/v2/integrations-beta');
    expect(reviewHref('/add-data')).toBe('/v2/add-data');
  });

  test('a path that merely starts with the same letters is not read as owned', () => {
    expect(reviewHref('/jobs-archive/abc')).toBe('/v2/jobs-archive/abc');
  });
});

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
  test('matches the title and the subtitle, case-insensitively', () => {
    expect(reviewMatches(item({ title: 'Wallet import' }), 'wallet')).toBe(true);
    expect(reviewMatches(item({ subtitle: 'Kraken · 12 rows' }), 'kraken')).toBe(true);
  });

  test('a missing subtitle is not a match for everything', () => {
    expect(reviewMatches(item({ subtitle: null }), 'kraken')).toBe(false);
  });
});

/**
 * SC-71 10.3 — the amount comes out of the muted subtitle and into the value
 * column. The cases that matter are the ones that must *not* split: every other
 * summariser in `reviewSummary.ts` emits a count, and reading `2 files` as two
 * of a currency called FILES is how a review feed starts printing money that
 * does not exist.
 */
describe('splitReviewSubtitle', () => {
  test('splits a vendor and its invoiced amount', () => {
    expect(splitReviewSubtitle('Albert Heijn — 87.31 EUR')).toEqual({
      detail: 'Albert Heijn',
      amount: { value: 87.31, currency: 'EUR' },
    });
  });

  test('splits an amount with no vendor', () => {
    expect(splitReviewSubtitle('318.42 USD')).toEqual({
      detail: null,
      amount: { value: 318.42, currency: 'USD' },
    });
  });

  test('reads a grouped figure', () => {
    expect(splitReviewSubtitle('1,204.00 GBP').amount).toEqual({ value: 1204, currency: 'GBP' });
  });

  test('a count is not an amount', () => {
    for (const subtitle of [
      '2 files',
      '3 holdings · BTC, ETH',
      '4 transactions · CSV — needs a currency',
      '2 candidates across 1 chain',
    ]) {
      expect(splitReviewSubtitle(subtitle)).toEqual({ detail: subtitle, amount: null });
    }
  });

  test('a vendor with no amount stays whole', () => {
    expect(splitReviewSubtitle('Some Vendor')).toEqual({ detail: 'Some Vendor', amount: null });
  });

  test('no subtitle is no detail and no amount', () => {
    expect(splitReviewSubtitle(null)).toEqual({ detail: null, amount: null });
    expect(splitReviewSubtitle('  ')).toEqual({ detail: null, amount: null });
  });
});
