import { describe, expect, test } from 'bun:test';
import {
  MAX_TRANSFER_REVIEW_PORTIONS,
  splitSumMatches,
  splitTotal,
  transferReviewSplitSchema,
} from '../../src/dtos/transfer-review';

/**
 * The contract for a divided answer (SC-181).
 *
 * These rules are tested at the contract rather than in the form because the
 * form is not the only caller: the tRPC boundary parses with this schema, and
 * a split that does not add up is a new way to be wrong about money. The one
 * rule this file cannot check is the sum against the transaction — that needs
 * the row, so it lives in `TransferReviewService`.
 */

const REPORTED = [
  { decision: 'untracked', quantity: '3500' },
  { decision: 'left_control', quantity: '500' },
];

describe('transferReviewSplitSchema', () => {
  test('accepts the reported 3,500 untracked / 500 disposed division', () => {
    expect(transferReviewSplitSchema.safeParse(REPORTED).success).toBe(true);
  });

  test('accepts a three-way division, and nothing wider', () => {
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '2000', matchTransactionId: crypto.randomUUID() },
        { decision: 'untracked', quantity: '1500' },
        { decision: 'left_control', quantity: '500' },
      ]).success
    ).toBe(true);
    expect(MAX_TRANSFER_REVIEW_PORTIONS).toBe(3);
  });

  test('rejects one part — that is a whole answer, and has its own write', () => {
    expect(transferReviewSplitSchema.safeParse([REPORTED[0]]).success).toBe(false);
  });

  test('rejects the same outcome twice, which is one part written twice', () => {
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'untracked', quantity: '3500' },
        { decision: 'untracked', quantity: '500' },
      ]).success
    ).toBe(false);
  });

  test('rejects a zero or negative part', () => {
    for (const quantity of ['0', '-500', 'not a number', '']) {
      expect(
        transferReviewSplitSchema.safeParse([
          { decision: 'untracked', quantity: '3500' },
          { decision: 'left_control', quantity },
        ]).success
      ).toBe(false);
    }
  });

  test('a paired part without its deposit is unwritable, not merely incomplete', () => {
    // Pairing writes a shared `transfer_group_id`; without a partner there is
    // nothing to share it with, and the lots would be buffered for an inflow
    // that never arrives.
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '3500' },
        { decision: 'left_control', quantity: '500' },
      ]).success
    ).toBe(false);
  });
});

describe('splitSumMatches', () => {
  test('holds against the transaction, sign and all', () => {
    const split = transferReviewSplitSchema.parse(REPORTED);
    // Outflow quantities are stored negative; the parts are unsigned.
    expect(splitSumMatches(split, '-4000')).toBe(true);
    expect(splitSumMatches(split, '4000')).toBe(true);
    expect(splitSumMatches(split, '-4000.01')).toBe(false);
  });

  test('is exact — there is no tolerance to fall through', () => {
    // A tolerance here would be a second matcher, which is the thing SC-150
    // exists to stop trusting.
    const split = transferReviewSplitSchema.parse([
      { decision: 'untracked', quantity: '1' },
      { decision: 'left_control', quantity: '0.00000001' },
    ]);
    expect(splitSumMatches(split, '-1.00000001')).toBe(true);
    expect(splitSumMatches(split, '-1.00000002')).toBe(false);
  });

  test('adds in Decimal, not in floats', () => {
    const split = transferReviewSplitSchema.parse([
      { decision: 'untracked', quantity: '0.1' },
      { decision: 'left_control', quantity: '0.2' },
    ]);
    expect(splitTotal(split).toString()).toBe('0.3');
    expect(splitSumMatches(split, '-0.3')).toBe(true);
  });
});
