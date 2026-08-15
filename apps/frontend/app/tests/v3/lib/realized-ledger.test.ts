import { describe, expect, test } from 'bun:test';
import type { DisposalLotMatchDto } from '@scani/shared';
import {
  basisQualityLabel,
  disposalVerb,
  groupDisposals,
  holdingPeriodLabel,
  outcomeNote,
  portionLabel,
} from '../../../src/v3/lib/realized-ledger';

/**
 * The reader half of SC-152.
 *
 * The API returns one row per (outflow, lot) pair because that is the shape the
 * arithmetic has. A person reading it sees three rows and infers three sales,
 * so the grouping back to the event is the part that decides whether the
 * surface answers the question or muddies it — and it is testable without a
 * DOM, which is why it lives in `lib`.
 */

function row(p: Partial<DisposalLotMatchDto> & { transactionId: string }): DisposalLotMatchDto {
  return {
    holdingId: 'h',
    tokenId: 't',
    kind: 'sell',
    disposedAt: '2025-03-01T00:00:00.000Z',
    acquiredAt: '2024-01-01T00:00:00.000Z',
    quantity: '4',
    proceeds: '1200',
    costBasis: '400',
    gain: '800',
    holdingDays: 425,
    portionIndex: 0,
    portionCount: 1,
    basisQuality: 'known',
    outcome: 'realized',
    ...p,
  };
}

describe('groupDisposals', () => {
  test('collapses one disposal spanning several lots into one event', () => {
    const groups = groupDisposals([
      row({ transactionId: 'tx-1', quantity: '4', costBasis: '400', gain: '800' }),
      row({
        transactionId: 'tx-1',
        quantity: '4',
        costBasis: '800',
        gain: '400',
        acquiredAt: '2024-06-01T00:00:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    const [group] = groups as [(typeof groups)[number]];
    // A reader who sold 8 units once must not be shown two sales of 4.
    expect(group.quantity).toBe('8');
    expect(group.gain).toBe('1200');
    expect(group.lots).toHaveLength(2);
  });

  test('keeps separate disposals separate, in the order they arrived', () => {
    const groups = groupDisposals([
      row({ transactionId: 'tx-2', disposedAt: '2025-06-01T00:00:00.000Z' }),
      row({ transactionId: 'tx-1', disposedAt: '2025-03-01T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.transactionId)).toEqual(['tx-2', 'tx-1']);
  });

  test('a group with no realized lots carries a null gain, never a zero', () => {
    // The distinction the whole surface rests on: "booked nothing" and "booked
    // zero" are different answers, and a 0 beside a disposal reads as the
    // second when it is the first.
    const groups = groupDisposals([
      row({ transactionId: 'tx-3', gain: null, proceeds: null, outcome: 'unreviewed' }),
      row({ transactionId: 'tx-3', gain: null, proceeds: null, outcome: 'unreviewed' }),
    ]);
    expect(groups[0]?.gain).toBeNull();
    expect(groups[0]?.outcome).toBe('unreviewed');
  });

  test('one unsettled lot qualifies the whole event', () => {
    const groups = groupDisposals([
      row({ transactionId: 'tx-4', basisQuality: 'known' }),
      row({ transactionId: 'tx-4', basisQuality: 'unknown', acquiredAt: null, holdingDays: null }),
    ]);
    expect(groups[0]?.qualified).toBe(true);
  });
});

describe('copy', () => {
  test('a withdrawal is never described as a sale', () => {
    // Whether a withdrawal was a disposal is a question the user answers
    // (SC-150). The verb must not assert the answer.
    expect(disposalVerb('withdraw')).toBe('Withdrew');
    expect(disposalVerb('transfer_out')).toBe('Transferred out');
    expect(disposalVerb('sell')).toBe('Sold');
  });

  test('every non-realized outcome explains itself, and realized does not', () => {
    expect(outcomeNote('realized')).toBeNull();
    for (const outcome of ['unpriced', 'unreviewed', 'retained', 'awaiting_pair'] as const) {
      expect(outcomeNote(outcome)).toBeTruthy();
    }
  });

  test('only a non-known basis gets a chip', () => {
    expect(basisQualityLabel('known')).toBeNull();
    expect(basisQualityLabel('partial')).toBeTruthy();
    expect(basisQualityLabel('unknown')).toBeTruthy();
  });

  test('holding periods read in the unit a person would say', () => {
    expect(holdingPeriodLabel(null)).toBeNull();
    expect(holdingPeriodLabel(0)).toBe('same day');
    expect(holdingPeriodLabel(45)).toBe('45 days');
    expect(holdingPeriodLabel(425)).toBe('14 months');
    expect(holdingPeriodLabel(731)).toBe('2.0 years');
  });
});

/**
 * A divided answer, on the ledger (SC-181).
 *
 * The ledger's job is to explain a figure. An outflow answered as two things
 * at once has two outcomes and two gains, so folding it back into one row
 * would put one `outcome` on a group that is true of neither half — the
 * explanation stops explaining at exactly the row that most needs it.
 */
describe('groupDisposals — a divided outflow', () => {
  const divided = [
    row({
      transactionId: 'tx-9',
      kind: 'withdraw',
      quantity: '3500',
      proceeds: null,
      costBasis: '3500',
      gain: null,
      outcome: 'retained',
      portionIndex: 0,
      portionCount: 2,
    }),
    row({
      transactionId: 'tx-9',
      kind: 'withdraw',
      quantity: '500',
      proceeds: '1000',
      costBasis: '500',
      gain: '500',
      outcome: 'realized',
      portionIndex: 1,
      portionCount: 2,
    }),
  ];

  test('keeps the two shares apart, each with its own outcome and gain', () => {
    const groups = groupDisposals(divided);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.outcome).toBe('retained');
    expect(groups[0]?.quantity).toBe('3500');
    expect(groups[0]?.gain).toBeNull();
    expect(groups[1]?.outcome).toBe('realized');
    expect(groups[1]?.quantity).toBe('500');
    expect(groups[1]?.gain).toBe('500');
  });

  test('still merges the lots WITHIN a share', () => {
    const groups = groupDisposals([
      row({
        transactionId: 'tx-9',
        quantity: '300',
        gain: '300',
        portionIndex: 1,
        portionCount: 2,
      }),
      row({
        transactionId: 'tx-9',
        quantity: '200',
        gain: '200',
        portionIndex: 1,
        portionCount: 2,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.quantity).toBe('500');
    expect(groups[0]?.gain).toBe('500');
    expect(groups[0]?.lots).toHaveLength(2);
  });

  test('each share says it is a part, and of what', () => {
    const groups = groupDisposals(divided);
    expect(portionLabel(groups[0] as never)).toBe('Part 1 of 2 of one withdrawal');
    expect(portionLabel(groups[1] as never)).toBe('Part 2 of 2 of one withdrawal');
  });

  test('an undivided outflow says nothing at all', () => {
    const [group] = groupDisposals([row({ transactionId: 'tx-1' })]);
    expect(portionLabel(group as never)).toBeNull();
  });
});
