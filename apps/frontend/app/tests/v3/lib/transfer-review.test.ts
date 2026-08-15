import { describe, expect, test } from 'bun:test';
import {
  type AnsweredTransferReview,
  formatDate,
  type PendingTransferReview,
  TRANSFER_MATCH_WINDOW_LABEL,
  TRANSFER_MATCH_WINDOW_MS,
  type TransferCandidate,
} from '@scani/shared';
import { reviewHref } from '../../../src/v3/lib/review';
import {
  allocationHint,
  allocationOf,
  answeredSummary,
  candidateHint,
  candidateReasonLabel,
  candidateSummary,
  comparePendingTransfers,
  decisionConsequence,
  exactMoment,
  occurredLabel,
  pendingLocation,
  pendingTransferMatches,
  remainderFor,
  type SplitDraftRow,
  splitConsequence,
  splitIsCommittable,
  toSplitPortions,
} from '../../../src/v3/lib/transfer-review';

/**
 * The transfer-review surface's words (SC-150).
 *
 * These are tested rather than eyeballed because they are the product: the
 * queue's entire value is that a person can answer it, and a row that says
 * "we were unsure" instead of "0.40% apart" is a chore they cannot finish.
 */

function candidate(overrides: Partial<TransferCandidate> = {}): TransferCandidate {
  return {
    transactionId: 'tx-in',
    holdingId: 'h-in',
    accountName: 'Main',
    institutionName: 'Ledger',
    kind: 'deposit',
    quantity: '0.995',
    occurredAt: '2026-08-10T09:12:00.000Z',
    reason: 'ambiguous',
    quantityDeltaPct: -0.5,
    timeDeltaMs: 12 * 60_000,
    withinStrictTolerance: true,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingTransferReview> = {}): PendingTransferReview {
  return {
    transactionId: 'tx-out',
    holdingId: 'h-out',
    tokenSymbol: 'ETH',
    tokenName: 'Ethereum',
    accountName: 'Spot',
    institutionName: 'Kraken',
    kind: 'withdraw',
    quantity: '1',
    occurredAt: '2026-08-10T09:00:00.000Z',
    counterparty: null,
    description: null,
    marketValueInBase: '3120.44',
    baseCurrencyCode: 'EUR',
    candidates: [],
    ...overrides,
  };
}

describe('candidateReasonLabel', () => {
  test('an ambiguous candidate says the reader is the tie-break', () => {
    expect(candidateReasonLabel(candidate({ reason: 'ambiguous' }))).toBe(
      'Matches — but so does another deposit'
    );
  });

  test('a quantity miss names the actual percentage, not "roughly"', () => {
    expect(
      candidateReasonLabel(
        candidate({ reason: 'quantity_outside_tolerance', quantityDeltaPct: -3.42 })
      )
    ).toBe('Amount differs by 3.4%');
  });

  /**
   * Sub-1% keeps two decimals. Rounding 0.4% and 0.9% both to "0%" would erase
   * the only number on the row — and those two are the difference between "a
   * network fee" and "not the same transfer".
   */
  test('a sub-1% difference is not rounded away', () => {
    expect(
      candidateReasonLabel(
        candidate({ reason: 'quantity_outside_tolerance', quantityDeltaPct: -0.42 })
      )
    ).toBe('Amount differs by 0.42%');
  });

  /**
   * The gap itself is already on the line above, from `candidateSummary`. A
   * reason line that repeated it ("0.25 BTC · 4 h later" / "4 h apart") spent
   * a line saying the same number twice and never said the thing that
   * matters: that four hours is outside the rule.
   */
  test('a time miss names the rule rather than repeating the gap', () => {
    const label = candidateReasonLabel(
      candidate({ reason: 'time_outside_window', timeDeltaMs: 4 * 60 * 60_000 })
    );
    expect(label).toBe('Outside the 30-minute window we match on');
    expect(label).not.toContain('4 h');
  });

  test('a candidate that misses on both says so, and is not dressed up', () => {
    expect(
      candidateReasonLabel(
        candidate({ reason: 'both_outside', quantityDeltaPct: 4.5, timeDeltaMs: -3 * 60 * 60_000 })
      )
    ).toBe('4.5% off, and outside the 30-minute window');
  });

  /** The window in the copy is the window the matcher uses — one constant,
   *  read by both, so tuning one cannot make the other lie. */
  test('the stated window is the matcher’s own', () => {
    expect(TRANSFER_MATCH_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(candidateReasonLabel(candidate({ reason: 'time_outside_window' }))).toContain(
      TRANSFER_MATCH_WINDOW_LABEL
    );
  });
});

describe('candidateSummary', () => {
  /** Direction matters: "earlier" is the case that should make a reader look
   *  twice, because money usually arrives after it leaves. */
  test('carries the direction of the gap, not just its size', () => {
    expect(candidateSummary(candidate({ timeDeltaMs: 12 * 60_000 }), 'ETH')).toBe(
      '0.995 ETH · 12 min later'
    );
    expect(candidateSummary(candidate({ timeDeltaMs: -12 * 60_000 }), 'ETH')).toBe(
      '0.995 ETH · 12 min earlier'
    );
    expect(candidateSummary(candidate({ timeDeltaMs: 4_000 }), 'ETH')).toBe(
      '0.995 ETH · same minute'
    );
  });
});

describe('candidateHint', () => {
  test('no candidate is a finding, not a shrug', () => {
    expect(candidateHint(pending({ candidates: [] }))).toBe('No close deposit found');
  });

  test('several equally-good matches is the case the matcher exists to refuse', () => {
    expect(
      candidateHint(
        pending({
          candidates: [
            candidate({ transactionId: 'a' }),
            candidate({ transactionId: 'b' }),
            candidate({ transactionId: 'c', withinStrictTolerance: false, reason: 'both_outside' }),
          ],
        })
      )
    ).toBe('2 equally good matches');
  });

  test('near misses are counted as possibilities, singular when there is one', () => {
    const near = candidate({ withinStrictTolerance: false, reason: 'time_outside_window' });
    expect(candidateHint(pending({ candidates: [near] }))).toBe('1 possible match');
    expect(candidateHint(pending({ candidates: [near, { ...near, transactionId: 'b' }] }))).toBe(
      '2 possible matches'
    );
  });
});

describe('decisionConsequence', () => {
  test('pairing names the destination, so the reader can check they picked right', () => {
    expect(decisionConsequence('paired', pending(), candidate())).toContain('Ledger · Main');
    expect(decisionConsequence('paired', pending(), candidate())).toContain('no gain is booked');
  });

  test('pairing with nothing picked asks for a pick rather than describing a write', () => {
    expect(decisionConsequence('paired', pending(), null)).toBe(
      'Pick the deposit this money arrived in.'
    );
  });

  test('a disposal states the figure it will book, as money', () => {
    expect(decisionConsequence('left_control', pending(), null)).toContain('€3,120.44');
  });

  /**
   * SC-173. The fixture above carries `3120.44` — already rounded — which is
   * why this file passed while the screen read `about 3041.163666295339 EUR`.
   * A market value is a price times a quantity and arrives with the tail that
   * implies; the sentence a person reads before booking a taxable disposal has
   * to look like money whatever the arithmetic behind it.
   */
  test('a disposal reads as money even when the value arrives as a raw float', () => {
    const consequence = decisionConsequence(
      'left_control',
      pending({ marketValueInBase: '3041.163666295339' }),
      null
    );
    expect(consequence).toContain('€3,041.16');
    expect(consequence).not.toContain('3041.163666295339');
    expect(consequence).not.toContain('EUR');
  });

  test('a sub-cent disposal is not described as being worth nothing', () => {
    expect(
      decisionConsequence('left_control', pending({ marketValueInBase: '0.00007714' }), null)
    ).toContain('€0.00007714');
  });

  test('pairing quotes the quantity at the precision it carries', () => {
    expect(
      decisionConsequence('paired', pending({ quantity: '0.05000000' }), candidate())
    ).toContain('The 0.05 ETH');
    expect(
      decisionConsequence('paired', pending({ quantity: '500000000.00000000' }), candidate())
    ).toContain('The 500,000,000 ETH');
  });

  /** No price that day is its own answer, and it is not zero. */
  test('a disposal with no price says nothing is booked, not that nothing is worth', () => {
    const consequence = decisionConsequence(
      'left_control',
      pending({ marketValueInBase: null }),
      null
    );
    expect(consequence).toContain('no price for ETH');
    expect(consequence).not.toContain('0 EUR');
  });

  test('an untracked move is explicitly not a disposal', () => {
    expect(decisionConsequence('untracked', pending(), null)).toContain('Not a disposal');
  });
});

/**
 * SC-175 — one date, one format, across the whole surface.
 *
 * The queue, the peek it opens and the confirmation that peek leads to printed
 * the same instant three ways, two of them ~120px apart in one frame:
 * `7/16/2026` from `formatRelative`'s `en-US` default, `16 Jul 2026, 01:06`
 * from a local `toLocaleString`, and `16/07/2026` from a bare
 * `toLocaleDateString()` following the runtime. Comparing dates IS the task
 * here, so this is asserted rather than eyeballed — and asserted as agreement
 * between the three, not against a literal, because a literal only pins the
 * locale the test happens to run in.
 */
describe('one date format across the surface', () => {
  const iso = '2026-07-16T01:06:00Z';

  test('the peek\'s "When" and the row\'s label are the same date', () => {
    // Aged past 30 days, which is the only point at which the row shows a date
    // at all — and therefore the only point at which they could disagree.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(exactMoment(old).startsWith(occurredLabel(old))).toBe(true);
  });

  test('the peek and the disposal confirmation agree', () => {
    const consequence = decisionConsequence('left_control', pending({ occurredAt: iso }), null);
    expect(consequence).toContain(formatDate(iso));
    expect(exactMoment(iso).startsWith(formatDate(iso))).toBe(true);
  });

  test('no surface on this screen numbers the month', () => {
    // `16/07/2026` vs `7/16/2026` is the defect; a month name cannot be read
    // in the wrong order.
    const consequence = decisionConsequence('left_control', pending({ occurredAt: iso }), null);
    expect(consequence).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(exactMoment(iso)).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });
});

describe('list plumbing', () => {
  test('location falls back to the account when there is no institution', () => {
    expect(pendingLocation(pending())).toBe('Kraken · Spot');
    expect(pendingLocation(pending({ institutionName: null }))).toBe('Spot');
  });

  test('search reaches the fields a person would actually type', () => {
    const item = pending({ counterparty: '0xdeadbeef', description: 'to cold storage' });
    expect(pendingTransferMatches(item, 'kraken')).toBe(true);
    expect(pendingTransferMatches(item, 'ETH')).toBe(true);
    expect(pendingTransferMatches(item, 'cold')).toBe(true);
    expect(pendingTransferMatches(item, 'deadbeef')).toBe(true);
    expect(pendingTransferMatches(item, 'binance')).toBe(false);
  });

  test('sorting by value treats an unpriced row as the bottom rather than dropping it', () => {
    const priced = pending({ marketValueInBase: '100' });
    const unpriced = pending({ marketValueInBase: null });
    expect(comparePendingTransfers(unpriced, priced, 'amount', 'asc')).toBeLessThan(0);
  });

  /**
   * The comparator owns the direction — `useDataView` passes it in and does
   * not invert the result. A version that ignored it put the oldest
   * withdrawal at the top of a list whose control read "Newest".
   */
  test('descending really is newest first', () => {
    const older = pending({ occurredAt: '2026-01-01T00:00:00.000Z' });
    const newer = pending({ occurredAt: '2026-08-01T00:00:00.000Z' });
    expect(comparePendingTransfers(older, newer, 'occurred', 'asc')).toBeLessThan(0);
    expect(comparePendingTransfers(older, newer, 'occurred', 'desc')).toBeGreaterThan(0);
  });
});

/**
 * The feed's row for this queue has no id segment, so the prefix list cannot
 * match it. Without an exact entry the row would send the reader to
 * `/v2/review/transfers` — a 404 reached by clicking the thing that told them
 * something needed doing.
 */
describe('the feed can reach the queue', () => {
  test('the queue path stays in v3 rather than crossing to v2', () => {
    expect(reviewHref('/review/transfers')).toBe('/review/transfers');
  });
});

/**
 * The arithmetic behind the split (SC-181).
 *
 * A split that does not add up to the transaction is a new way to be wrong
 * about money, so the rule is exact equality and the reader is shown the
 * remainder while they type. Both halves are tested here rather than in a DOM
 * because they *are* the feature — the fields are three text inputs.
 */
describe('allocationOf', () => {
  const item = pending({ quantity: '4000', tokenSymbol: 'USDT' });

  const rows = (untracked: string, left: string, paired = ''): SplitDraftRow[] => [
    { decision: 'paired', amount: paired, matchTransactionId: paired ? 'tx-in' : null },
    { decision: 'left_control', amount: left, matchTransactionId: null },
    { decision: 'untracked', amount: untracked, matchTransactionId: null },
  ];

  test('the reported division adds up exactly', () => {
    const allocation = allocationOf(rows('3500', '500'), item.quantity);
    expect(allocation.status).toBe('exact');
    expect(allocation.remaining?.toString()).toBe('0');
    expect(allocationHint(allocation, item)).toBeNull();
  });

  test('an incomplete division says how much is left, not that it is wrong', () => {
    const allocation = allocationOf(rows('3500', ''), item.quantity);
    expect(allocation.status).toBe('under');
    expect(allocationHint(allocation, item)).toBe('500 USDT still to account for.');
  });

  test('an over-allocation says by how much', () => {
    const allocation = allocationOf(rows('3500', '600'), item.quantity);
    expect(allocation.status).toBe('over');
    expect(allocationHint(allocation, item)).toBe('That is 100 USDT more than the transfer.');
  });

  test('nothing entered is not an error — it is where the editor opens', () => {
    expect(allocationOf(rows('', ''), item.quantity).status).toBe('empty');
  });

  test('exactness is exact — a rounding-close division is not accepted', () => {
    const precise = pending({ quantity: '1.00000001', tokenSymbol: 'BTC' });
    const nearly = allocationOf(rows('1', '0.00000000'), precise.quantity);
    expect(nearly.status).not.toBe('exact');
    expect(allocationOf(rows('1', '0.00000001'), precise.quantity).status).toBe('exact');
  });
});

describe('splitIsCommittable', () => {
  const item = pending({ quantity: '4000', tokenSymbol: 'USDT' });
  const rows = (
    paired: string,
    left: string,
    untracked: string,
    match: string | null = null
  ): SplitDraftRow[] => [
    { decision: 'paired', amount: paired, matchTransactionId: match },
    { decision: 'left_control', amount: left, matchTransactionId: null },
    { decision: 'untracked', amount: untracked, matchTransactionId: null },
  ];

  test('two parts that add up', () => {
    expect(splitIsCommittable(rows('', '500', '3500'), item)).toBe(true);
  });

  test('one part is a whole answer, and is refused as a split', () => {
    // Quietly promoting it would commit a claim about 4,000 that the reader
    // made about 4,000 — but through a control that says "part of it".
    expect(splitIsCommittable(rows('', '', '4000'), item)).toBe(false);
  });

  test('a paired part with no deposit picked cannot be written', () => {
    expect(splitIsCommittable(rows('3500', '500', ''), item)).toBe(false);
    expect(splitIsCommittable(rows('3500', '500', '', 'tx-in'), item)).toBe(true);
  });

  test('parts that do not add up are refused however sensible they look', () => {
    expect(splitIsCommittable(rows('', '400', '3500'), item)).toBe(false);
  });

  test('a zero part is not a part', () => {
    expect(splitIsCommittable(rows('', '0', '4000'), item)).toBe(false);
  });
});

describe('toSplitPortions', () => {
  test('drops the untouched outcomes and keeps the order on screen', () => {
    const portions = toSplitPortions([
      { decision: 'paired', amount: '', matchTransactionId: null },
      { decision: 'left_control', amount: '500', matchTransactionId: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null },
    ]);
    expect(portions).toEqual([
      { decision: 'left_control', quantity: '500' },
      { decision: 'untracked', quantity: '3500' },
    ]);
  });

  test('carries the deposit only on the paired part', () => {
    const portions = toSplitPortions([
      { decision: 'paired', amount: '3500', matchTransactionId: 'tx-in' },
      { decision: 'left_control', amount: '500', matchTransactionId: 'tx-in' },
      { decision: 'untracked', amount: '', matchTransactionId: null },
    ]);
    expect(portions[0]).toEqual({
      decision: 'paired',
      quantity: '3500',
      matchTransactionId: 'tx-in',
    });
    expect(portions[1]).toEqual({ decision: 'left_control', quantity: '500' });
  });
});

describe('remainderFor', () => {
  const item = pending({ quantity: '4000' });

  test('offers what the other parts have left over', () => {
    const rows: SplitDraftRow[] = [
      { decision: 'paired', amount: '', matchTransactionId: null },
      { decision: 'left_control', amount: '', matchTransactionId: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null },
    ];
    expect(remainderFor(rows, 1, item.quantity)).toBe('500');
  });

  test('offers nothing once the transfer is fully accounted for', () => {
    const rows: SplitDraftRow[] = [
      { decision: 'paired', amount: '', matchTransactionId: null },
      { decision: 'left_control', amount: '500', matchTransactionId: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null },
    ];
    expect(remainderFor(rows, 0, item.quantity)).toBeNull();
  });

  test('never offers to overwrite an amount the reader already typed', () => {
    // The first phone capture: the row holding `3500` carried "Take the rest —
    // 4,000 USD" directly beneath it, because the OTHER rows summed to nothing.
    const rows: SplitDraftRow[] = [
      { decision: 'paired', amount: '', matchTransactionId: null },
      { decision: 'left_control', amount: '', matchTransactionId: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null },
    ];
    expect(remainderFor(rows, 2, item.quantity)).toBeNull();
  });
});

describe('splitConsequence', () => {
  const item = pending({ quantity: '4000', tokenSymbol: 'USDT' });

  test('names every part with its own amount before anything is written', () => {
    const sentence = splitConsequence(
      [
        { decision: 'paired', amount: '', matchTransactionId: null },
        { decision: 'left_control', amount: '500', matchTransactionId: null },
        { decision: 'untracked', amount: '3,500'.replace(',', ''), matchTransactionId: null },
      ],
      item,
      () => null
    );
    expect(sentence).toContain('500 USDT is counted as a disposal');
    expect(sentence).toContain('3,500 USDT is still yours');
    expect(sentence).toContain('Only the disposal books a gain');
  });

  test('an incomplete division asks for the total rather than describing one', () => {
    const sentence = splitConsequence(
      [
        { decision: 'paired', amount: '', matchTransactionId: null },
        { decision: 'left_control', amount: '500', matchTransactionId: null },
        { decision: 'untracked', amount: '', matchTransactionId: null },
      ],
      item,
      () => null
    );
    expect(sentence).toContain('4,000 USDT');
  });
});

describe('answeredSummary', () => {
  const answered = (over: Partial<AnsweredTransferReview>): AnsweredTransferReview => ({
    transactionId: 'tx-out',
    holdingId: 'h-out',
    tokenSymbol: 'USDT',
    accountName: 'Spot',
    institutionName: 'Airwallex',
    kind: 'withdraw',
    quantity: '4000',
    occurredAt: '2026-08-10T09:00:00.000Z',
    counterparty: null,
    decision: 'left_control',
    split: null,
    reviewedAt: '2026-08-11T09:00:00.000Z',
    ...over,
  });

  test('a whole answer reads as the answer', () => {
    expect(answeredSummary(answered({ decision: 'left_control' }))).toBe('Counted as a disposal');
    expect(answeredSummary(answered({ decision: 'untracked' }))).toBe(
      'Still yours, somewhere untracked'
    );
  });

  test('a divided answer shows the division, which is the whole reason to find it again', () => {
    expect(
      answeredSummary(
        answered({
          decision: 'split',
          split: [
            { decision: 'untracked', quantity: '3500' },
            { decision: 'left_control', quantity: '500' },
          ],
        })
      )
    ).toBe('3,500 untracked · 500 disposed');
  });
});
