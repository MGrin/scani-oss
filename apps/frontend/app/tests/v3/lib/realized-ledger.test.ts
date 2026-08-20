import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { DisposalLotMatchDto } from '@scani/shared';
import i18n from 'i18next';
import {
  answerLabel,
  basisQualityLabel,
  disposalVerb,
  groupDisposals,
  holdingPeriodLabel,
  outcomeNote,
  portionLabel,
  valuationLabel,
  valuationNote,
} from '../../../src/v3/lib/realized-ledger';

/** The real `t`, so these assertions pin the English `en.json` produces. */
const t = i18n.t.bind(i18n);

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
    valuationBasis: 'execution_rate',
    answerSource: 'none',
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
    expect(disposalVerb('withdraw', t)).toBe('Withdrew');
    expect(disposalVerb('transfer_out', t)).toBe('Transferred out');
    expect(disposalVerb('sell', t)).toBe('Sold');
  });

  test('every non-realized outcome explains itself, and realized does not', () => {
    expect(outcomeNote('withdraw', 'realized', 'user', t)).toBeNull();
    expect(outcomeNote('withdraw', 'realized', 'none', t)).toBeNull();
    for (const outcome of ['unpriced', 'unreviewed', 'retained', 'awaiting_pair'] as const) {
      expect(outcomeNote('withdraw', outcome, 'none', t)).toBeTruthy();
    }
  });

  test('a booked gain nobody is recorded as choosing says so (SC-324)', () => {
    // The one that books money. Silence here is the defect: the reader cannot
    ***REMOVED***
    ***REMOVED***
    const note = outcomeNote('withdraw', 'realized', 'unattributed', t);
    expect(note).toContain('no record of anyone answering it');
    expect(answerLabel('withdraw', 'unattributed', t)).toBe('Answer not recorded');

    // And the answer must not be the reader's own words put in their mouth.
    expect(outcomeNote('withdraw', 'retained', 'user', t)).toContain('You said');
    expect(outcomeNote('withdraw', 'retained', 'unattributed', t)).not.toContain('You said');
  });

  test('a swap is asked nothing, so nothing is said about who answered (SC-402)', () => {
    // A swap books its gain on its kind. "There is no record of anyone
    // answering it" is not a caveat about that row — it is an answer to a
    // question nobody put, and it appeared because `disposalAnswerSourceOf`
    // read `transfer_review` with no kind gate. Silence is the decision: no
    // answer is owed, so the row says nothing about answers at all.
    for (const kind of ['swap_out', 'sell'] as const) {
      expect(outcomeNote(kind, 'realized', 'unattributed', t)).toBeNull();
      expect(answerLabel(kind, 'unattributed', t)).toBeNull();
    }

    // Only the provenance half is suppressed. A swap that could not be priced
    // still explains itself, because that caveat is about the price.
    expect(outcomeNote('swap_out', 'unpriced', 'unattributed', t)).toBeTruthy();
  });

  test('a group carries its outflow answer provenance (SC-324)', () => {
    const [group] = groupDisposals([
      row({ transactionId: 'a', outcome: 'realized', answerSource: 'unattributed' }),
      row({ transactionId: 'a', outcome: 'realized', answerSource: 'unattributed' }),
    ]);
    expect(group?.answerSource).toBe('unattributed');
  });

  test('a swap valued from the token that left says which price answered (SC-397)', () => {
    // The visible half of SC-397. Before it, this row's proceeds were 0.00 and
    // it said nothing — and 0.00 is what a disposal that genuinely earned
    // nothing books, so the two were the same row on screen. Valuing it from
    // the held token fixes the arithmetic; without this note it would have
    // traded a silent zero for a silent estimate, which is the same defect
    // wearing a plausible number.
    const note = valuationNote('swap_out', 'held_token', t);
    expect(note).toContain('no price history');
    expect(valuationLabel('swap_out', 'held_token', t)).toBeTruthy();
    expect(valuationNote('swap_in', 'held_token', t)).toBeTruthy();
  });

  test('nothing but a fallback-valued swap gets the note', () => {
    // A swap priced from its counter leg is the ordinary case and needs no
    // sentence, and a withdrawal is ALWAYS valued from the token in hand — so
    // saying so there would put a caveat on almost every row in the ledger and
    // teach the reader to skip it.
    expect(valuationNote('swap_out', 'execution_rate', t)).toBeNull();
    expect(valuationNote('transfer_out', 'held_token', t)).toBeNull();
    expect(valuationNote('sell', 'held_token', t)).toBeNull();
    expect(valuationNote('withdraw', 'held_token', t)).toBeNull();
    // Nothing was valued at all — `outcomeNote`'s `unpriced` case owns that
    // row, and two sentences about the same absence is one too many.
    expect(valuationNote('swap_out', null, t)).toBeNull();
    expect(valuationLabel('swap_out', null, t)).toBeNull();
  });

  test('a group carries the price its proceeds came from (SC-397)', () => {
    const [group] = groupDisposals([
      row({ transactionId: 'a', kind: 'swap_out', valuationBasis: 'held_token' }),
      row({ transactionId: 'a', kind: 'swap_out', valuationBasis: 'held_token' }),
    ]);
    expect(group?.valuationBasis).toBe('held_token');
  });

  test('only a non-known basis gets a chip', () => {
    expect(basisQualityLabel('known', t)).toBeNull();
    expect(basisQualityLabel('partial', t)).toBeTruthy();
    expect(basisQualityLabel('unknown', t)).toBeTruthy();
  });

  test('holding periods read in the unit a person would say', () => {
    expect(holdingPeriodLabel(null, t)).toBeNull();
    expect(holdingPeriodLabel(0, t)).toBe('same day');
    expect(holdingPeriodLabel(45, t)).toBe('45 days');
    expect(holdingPeriodLabel(425, t)).toBe('14 months');
    expect(holdingPeriodLabel(731, t)).toBe('2.0 years');
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
    expect(portionLabel(groups[0] as never, t)).toBe('Part 1 of 2 of one withdrawal');
    expect(portionLabel(groups[1] as never, t)).toBe('Part 2 of 2 of one withdrawal');
  });

  test('an undivided outflow says nothing at all', () => {
    const [group] = groupDisposals([row({ transactionId: 'tx-1' })]);
    expect(portionLabel(group as never, t)).toBeNull();
  });
});
