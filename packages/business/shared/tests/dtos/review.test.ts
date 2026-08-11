import { describe, expect, test } from 'bun:test';
import { isReviewableJobName, REVIEWABLE_JOB_NAMES, reviewItemSchema } from '../../src/dtos/review';

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
      title: 'Screenshot import',
      subtitle: '3 holdings extracted',
      createdAt: new Date('2026-08-10T10:00:00Z'),
      href: '/jobs/2f1c9d4e-0000-4000-8000-000000000001',
    });
    expect(parsed.kind).toBe('screenshot-parse');
  });

  test('subtitle is optional', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        title: 'CSV import',
        createdAt: new Date('2026-08-10T10:00:00Z'),
        href: '/jobs/abc',
      })
    ).not.toThrow();
  });

  test('rejects an item with no href — every item must be actionable', () => {
    expect(() =>
      reviewItemSchema.parse({
        id: 'job:abc',
        kind: 'file-import',
        title: 'CSV import',
        createdAt: new Date('2026-08-10T10:00:00Z'),
      })
    ).toThrow();
  });
});
