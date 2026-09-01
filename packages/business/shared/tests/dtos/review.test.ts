import { describe, expect, test } from 'bun:test';
import {
  isReviewableJobName,
  REVIEWABLE_JOB_NAMES,
  reviewBadgeCount,
  reviewItemSchema,
} from '../../src/dtos/review';

describe('REVIEWABLE_JOB_NAMES', () => {
  test('covers exactly the job kinds that produce rows a user must confirm', () => {
    expect([...REVIEWABLE_JOB_NAMES].sort()).toEqual([
      'file-import',
      'screenshot-parse',
      'wallet-import',
    ]);
  });

  test('does not include jobs that finish without asking anything', () => {
    expect(isReviewableJobName('holding-price-update')).toBe(false);
    expect(isReviewableJobName('user-data-delete')).toBe(false);
    expect(isReviewableJobName('exchange-import')).toBe(false);
    expect(isReviewableJobName('manual-holdings-create')).toBe(false);
  });

  test('is case-sensitive and rejects unknown names', () => {
    expect(isReviewableJobName('File-Import')).toBe(false);
    expect(isReviewableJobName('')).toBe(false);
    expect(isReviewableJobName('nonexistent')).toBe(false);
  });
});

describe('reviewItemSchema', () => {
  test('accepts a well-formed item', () => {
    const parsed = reviewItemSchema.parse({
      id: 'job:2f1c9d4e-0000-4000-8000-000000000001',
      kind: 'screenshot-parse',
      label: { code: 'job', jobName: 'screenshot-parse' },
      detail: { code: 'parsedHoldings', holdings: 3, symbols: ['BTC'] },
      represents: 1,
      createdAt: new Date('2026-08-10T10:00:00Z'),
      href: '/jobs/2f1c9d4e-0000-4000-8000-000000000001',
    });
    expect(parsed.kind).toBe('screenshot-parse');
  });

  test('the detail is optional — a row with nothing more to say is a row', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        label: { code: 'job', jobName: 'file-import' },
        represents: 1,
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/jobs/abc',
      })
    ).not.toThrow();
  });

  /**
   * The row says what it IS, not what it SAYS (SC-371). A free-text title was
   * the whole defect: it could only ever be filled in on the server, which is
   * the one place with no `t()`, so /review was the surface no translation
   * could reach and no string scanner could see.
   */
  test('rejects an item that sends a rendered sentence instead of a label', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        title: 'File import',
        subtitle: '3 transactions — needs a currency',
        represents: 1,
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/jobs/abc',
      })
    ).toThrow();
  });

  test('rejects a label naming no producer', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        label: { code: 'somethingElse' },
        represents: 1,
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/jobs/abc',
      })
    ).toThrow();
  });

  /** The figure stays a decimal string end to end: `42.50` is what the
   *  extractor recorded and what the classic page still prints. */
  test('an amount is a decimal string and a currency code, not a number', () => {
    const parsed = reviewItemSchema.parse({
      id: 'extraction:e1',
      kind: 'document-extraction',
      label: { code: 'invoiceExtracted' },
      detail: { code: 'vendor', name: 'Albert Heijn' },
      amount: { value: '42.50', currency: 'EUR' },
      represents: 1,
      createdAt: new Date('2026-08-10T10:00:00Z'),
      href: '/documents/doc-1',
    });
    expect(parsed.amount?.value).toBe('42.50');

    expect(() =>
      reviewItemSchema.parse({
        id: 'extraction:e1',
        kind: 'document-extraction',
        label: { code: 'invoiceExtracted' },
        amount: { value: 42.5, currency: 'EUR' },
        represents: 1,
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/documents/doc-1',
      })
    ).toThrow();
  });

  test('rejects an item with no href — every item must be actionable', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        label: { code: 'job', jobName: 'file-import' },
        represents: 1,
        createdAt: new Date('2026-08-10T10:00:00Z'),
      })
    ).toThrow();
  });

  /**
   * SC-860. Required rather than defaulted to 1: a collector added later that
   * aggregates an unbounded queue and forgets to say how many things are
   * behind its single row fails here, where a default would silently weigh
   * that queue as one and put the badge back where it started.
   */
  test('rejects an item that does not say how many things it represents', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'transfer-review:pending',
        kind: 'transfer-review',
        label: { code: 'transfersToConfirm' },
        detail: { code: 'unpairedTransfers', transfers: 200 },
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/review/transfers',
      })
    ).toThrow();
  });

  /** A row standing for nothing is not a row — an empty queue emits none. */
  test('rejects a weight of zero or a fractional one', () => {
    const row = (represents: number) => ({
      id: 'transfer-review:pending',
      kind: 'transfer-review',
      label: { code: 'transfersToConfirm' as const },
      represents,
      createdAt: new Date('2026-08-10T10:00:00Z'),
      href: '/review/transfers',
    });
    expect(() => reviewItemSchema.parse(row(0))).toThrow();
    expect(() => reviewItemSchema.parse(row(-1))).toThrow();
    expect(() => reviewItemSchema.parse(row(1.5))).toThrow();
    expect(() => reviewItemSchema.parse(row(200))).not.toThrow();
  });
});

/**
 * The badge's one summing rule (SC-860), asserted where it lives so both the
 * hook and `ReviewFeedService`'s suite are testing the same function rather
 * than two copies of a `reduce`.
 */
describe('reviewBadgeCount', () => {
  test('sums what each row represents rather than counting rows', () => {
    expect(reviewBadgeCount([{ represents: 200 }, { represents: 30 }])).toBe(230);
  });

  test('equals the row count when every row stands for one thing', () => {
    expect(reviewBadgeCount([{ represents: 1 }, { represents: 1 }, { represents: 1 }])).toBe(3);
  });

  /** Nothing waiting is zero, which is what hides the badge entirely. */
  test('an empty feed is zero', () => {
    expect(reviewBadgeCount([])).toBe(0);
  });
});
