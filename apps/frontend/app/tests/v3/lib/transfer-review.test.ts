import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  type AnsweredTransferReview,
  type BulkTransferPreview,
  formatDate,
  type PendingTransferReview,
  TRANSFER_MATCH_WINDOW_LABEL,
  TRANSFER_MATCH_WINDOW_MS,
  type TransferCandidate,
} from '@scani/shared';
import i18n from 'i18next';
import {
  allocationHint,
  allocationOf,
  answeredSummary,
  bulkConsequence,
  bulkRefusalNotes,
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
  reopenConsequence,
  type SplitDraftRow,
  splitConsequence,
  splitIsCommittable,
  toSplitPortions,
} from '../../../src/v3/lib/transfer-review';

// The real instance against the shipped `en.json` — a stub `t` would assert
// the key scheme rather than the sentence a reader gets.
const t = i18n.t.bind(i18n);

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
    tokenSymbol: 'ETH',
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
    counterpartyKey: null,
    explorerTxUrl: null,
    explorerAddressUrl: null,
    counterpartyIsOwnWallet: false,
    matchedRule: null,
    answerWithdrawnBy: null,
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
    expect(candidateReasonLabel(t, candidate({ reason: 'ambiguous' }))).toBe(
      'Matches — but so does another deposit'
    );
  });

  test('a quantity miss names the actual percentage, not "roughly"', () => {
    expect(
      candidateReasonLabel(
        t,
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
        t,
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
      t,
      candidate({ reason: 'time_outside_window', timeDeltaMs: 4 * 60 * 60_000 })
    );
    expect(label).toBe('Outside the 30-minute window we match on');
    expect(label).not.toContain('4 h');
  });

  test('a candidate that misses on both says so, and is not dressed up', () => {
    expect(
      candidateReasonLabel(
        t,
        candidate({ reason: 'both_outside', quantityDeltaPct: 4.5, timeDeltaMs: -3 * 60 * 60_000 })
      )
    ).toBe('4.5% off, and outside the 30-minute window');
  });

  /** The window in the copy is the window the matcher uses — one constant,
   *  read by both, so tuning one cannot make the other lie. */
  test('the stated window is the matcher’s own', () => {
    expect(TRANSFER_MATCH_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(candidateReasonLabel(t, candidate({ reason: 'time_outside_window' }))).toContain(
      TRANSFER_MATCH_WINDOW_LABEL
    );
  });
});

describe('candidateSummary', () => {
  /** Direction matters: "earlier" is the case that should make a reader look
   *  twice, because money usually arrives after it leaves. */
  test('carries the direction of the gap, not just its size', () => {
    expect(candidateSummary(t, candidate({ timeDeltaMs: 12 * 60_000 }))).toBe(
      '0.995 ETH · 12 min later'
    );
    expect(candidateSummary(t, candidate({ timeDeltaMs: -12 * 60_000 }))).toBe(
      '0.995 ETH · 12 min earlier'
    );
    expect(candidateSummary(t, candidate({ timeDeltaMs: 4_000 }))).toBe('0.995 ETH · same minute');
  });

  /**
   * SC-336. A bridge's arrival is a DIFFERENT token row from the withdrawal —
   * USDC on Base against USDC on mainnet — so labelling it with the
   * withdrawal's symbol would describe it as the thing it is not, and on a
   * memecoin-adjacent symbol that is the difference between two assets.
   */
  test('names a cross-chain arrival by its own symbol', () => {
    expect(
      candidateSummary(t, candidate({ tokenSymbol: 'USDC', quantity: '99.98', timeDeltaMs: 6_000 }))
    ).toBe('99.98 USDC · same minute');
  });
});

describe('candidateHint — own wallet outranks every match count (SC-350)', () => {
  test('says the destination is a wallet you added', () => {
    // The ten mis-answered rows all read "No close deposit found", which was
    // true and the least useful true thing available. This is a fact about the
    // transfer; a match count is a fact about our search.
    expect(candidateHint(t, pending({ counterpartyIsOwnWallet: true, candidates: [] }))).toBe(
      'Went to a wallet you added'
    );
  });

  test('wins even when candidates exist', () => {
    const near = candidate();
    expect(
      candidateHint(
        t,
        pending({
          counterpartyIsOwnWallet: true,
          candidates: [near, { ...near, transactionId: 'b' }],
        })
      )
    ).toBe('Went to a wallet you added');
  });

  test('is silent when the address is not a registered wallet', () => {
    // `false` means "not among the wallets you registered", not "this belongs to
    // a stranger" — a cold wallet never added reads identically — so the
    // negative case must assert nothing.
    expect(candidateHint(t, pending({ counterpartyIsOwnWallet: false, candidates: [] }))).toBe(
      'No close deposit found'
    );
  });
});

describe('candidateHint', () => {
  test('no candidate is a finding, not a shrug', () => {
    expect(candidateHint(t, pending({ candidates: [] }))).toBe('No close deposit found');
  });

  test('several equally-good matches is the case the matcher exists to refuse', () => {
    expect(
      candidateHint(
        t,
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
    expect(candidateHint(t, pending({ candidates: [near] }))).toBe('1 possible match');
    expect(candidateHint(t, pending({ candidates: [near, { ...near, transactionId: 'b' }] }))).toBe(
      '2 possible matches'
    );
  });
});

describe('decisionConsequence', () => {
  test('pairing names the destination, so the reader can check they picked right', () => {
    expect(decisionConsequence(t, 'paired', pending(), candidate())).toContain('Ledger · Main');
    expect(decisionConsequence(t, 'paired', pending(), candidate())).toContain('no gain is booked');
  });

  test('pairing with nothing picked asks for a pick rather than describing a write', () => {
    expect(decisionConsequence(t, 'paired', pending(), null)).toBe(
      'Pick the deposit this money arrived in.'
    );
  });

  test('a disposal states the figure it will book, as money', () => {
    expect(decisionConsequence(t, 'left_control', pending(), null)).toContain('€3,120.44');
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
      t,
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
      decisionConsequence(t, 'left_control', pending({ marketValueInBase: '0.00007714' }), null)
    ).toContain('€0.00007714');
  });

  test('pairing quotes the quantity at the precision it carries', () => {
    expect(
      decisionConsequence(t, 'paired', pending({ quantity: '0.05000000' }), candidate())
    ).toContain('The 0.05 ETH');
    expect(
      decisionConsequence(t, 'paired', pending({ quantity: '500000000.00000000' }), candidate())
    ).toContain('The 500,000,000 ETH');
  });

  /** No price that day is its own answer, and it is not zero. */
  test('a disposal with no price says nothing is booked, not that nothing is worth', () => {
    const consequence = decisionConsequence(
      t,
      'left_control',
      pending({ marketValueInBase: null }),
      null
    );
    expect(consequence).toContain('no price for ETH');
    expect(consequence).not.toContain('0 EUR');
  });

  test('an untracked move is explicitly not a disposal', () => {
    expect(decisionConsequence(t, 'untracked', pending(), null)).toContain('Not a disposal');
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
    expect(exactMoment(old).startsWith(occurredLabel(t, old))).toBe(true);
  });

  test('the peek and the disposal confirmation agree', () => {
    const consequence = decisionConsequence(t, 'left_control', pending({ occurredAt: iso }), null);
    expect(consequence).toContain(formatDate(iso));
    expect(exactMoment(iso).startsWith(formatDate(iso))).toBe(true);
  });

  test('no surface on this screen numbers the month', () => {
    // `16/07/2026` vs `7/16/2026` is the defect; a month name cannot be read
    // in the wrong order.
    const consequence = decisionConsequence(t, 'left_control', pending({ occurredAt: iso }), null);
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
    {
      decision: 'paired',
      amount: paired,
      matchTransactionId: paired ? 'tx-in' : null,
      destination: null,
    },
    { decision: 'left_control', amount: left, matchTransactionId: null, destination: null },
    { decision: 'untracked', amount: untracked, matchTransactionId: null, destination: null },
  ];

  test('the reported division adds up exactly', () => {
    const allocation = allocationOf(rows('3500', '500'), item.quantity);
    expect(allocation.status).toBe('exact');
    expect(allocation.remaining?.toString()).toBe('0');
    expect(allocationHint(t, allocation, item)).toBeNull();
  });

  test('an incomplete division says how much is left, not that it is wrong', () => {
    const allocation = allocationOf(rows('3500', ''), item.quantity);
    expect(allocation.status).toBe('under');
    expect(allocationHint(t, allocation, item)).toBe('500 USDT still to account for.');
  });

  test('an over-allocation says by how much', () => {
    const allocation = allocationOf(rows('3500', '600'), item.quantity);
    expect(allocation.status).toBe('over');
    expect(allocationHint(t, allocation, item)).toBe('That is 100 USDT more than the transfer.');
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
    { decision: 'paired', amount: paired, matchTransactionId: match, destination: null },
    { decision: 'left_control', amount: left, matchTransactionId: null, destination: null },
    { decision: 'untracked', amount: untracked, matchTransactionId: null, destination: null },
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
      { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
      { decision: 'left_control', amount: '500', matchTransactionId: null, destination: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null, destination: null },
    ]);
    expect(portions).toEqual([
      { decision: 'left_control', quantity: '500' },
      { decision: 'untracked', quantity: '3500' },
    ]);
  });

  test('carries the deposit only on the paired part', () => {
    const portions = toSplitPortions([
      { decision: 'paired', amount: '3500', matchTransactionId: 'tx-in', destination: null },
      { decision: 'left_control', amount: '500', matchTransactionId: 'tx-in', destination: null },
      { decision: 'untracked', amount: '', matchTransactionId: null, destination: null },
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
      { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
      { decision: 'left_control', amount: '', matchTransactionId: null, destination: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null, destination: null },
    ];
    expect(remainderFor(rows, 1, item.quantity)).toBe('500');
  });

  test('offers nothing once the transfer is fully accounted for', () => {
    const rows: SplitDraftRow[] = [
      { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
      { decision: 'left_control', amount: '500', matchTransactionId: null, destination: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null, destination: null },
    ];
    expect(remainderFor(rows, 0, item.quantity)).toBeNull();
  });

  test('never offers to overwrite an amount the reader already typed', () => {
    // The first phone capture: the row holding `3500` carried "Take the rest —
    // 4,000 USD" directly beneath it, because the OTHER rows summed to nothing.
    const rows: SplitDraftRow[] = [
      { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
      { decision: 'left_control', amount: '', matchTransactionId: null, destination: null },
      { decision: 'untracked', amount: '3500', matchTransactionId: null, destination: null },
    ];
    expect(remainderFor(rows, 2, item.quantity)).toBeNull();
  });
});

describe('splitConsequence', () => {
  const item = pending({ quantity: '4000', tokenSymbol: 'USDT' });

  test('names every part with its own amount before anything is written', () => {
    const sentence = splitConsequence(
      t,
      [
        { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
        { decision: 'left_control', amount: '500', matchTransactionId: null, destination: null },
        {
          decision: 'untracked',
          amount: '3,500'.replace(',', ''),
          matchTransactionId: null,
          destination: null,
        },
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
      t,
      [
        { decision: 'paired', amount: '', matchTransactionId: null, destination: null },
        { decision: 'left_control', amount: '500', matchTransactionId: null, destination: null },
        { decision: 'untracked', amount: '', matchTransactionId: null, destination: null },
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
    answerSource: 'unattributed',
    ruleNote: null,
    declared: false,
    createdDestination: false,
    ...over,
  });

  test('a whole answer reads as the answer', () => {
    expect(answeredSummary(t, answered({ decision: 'left_control' }))).toBe(
      'Counted as a disposal'
    );
    expect(answeredSummary(t, answered({ decision: 'untracked' }))).toBe(
      'Still yours, somewhere untracked'
    );
  });

  test('a divided answer shows the division, which is the whole reason to find it again', () => {
    expect(
      answeredSummary(
        t,
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

/**
 * The bulk confirmation's sentence (SC-382).
 *
 * Tested at the same weight as `decisionConsequence` and for a sharper reason:
 * this one stands between a single tap and N capital gains, and the failure
 * SC-173 caught on its single-row sibling — a raw twelve-decimal float where a
 * formatted amount belonged — is the same failure multiplied here.
 */
describe('bulkConsequence', () => {
  function preview(overrides: Partial<BulkTransferPreview> = {}): BulkTransferPreview {
    return {
      eligible: ['a', 'b', 'c'],
      refusals: [],
      baseCurrencyCode: 'EUR',
      proceedsInBase: '41203.554321',
      unpricedCount: 0,
      alreadyDisposedCount: 0,
      alreadyDisposedInBase: null,
      ...overrides,
    };
  }

  test('states the disposal in money, formatted — never a raw figure', () => {
    const said = bulkConsequence(t, 'left_control', preview());
    expect(said).toInclude('3 transfers');
    expect(said).toInclude('€41,203.55');
    expect(said).not.toInclude('41203.554321');
  });

  test('says nothing is booked when no selected row has a price', () => {
    const said = bulkConsequence(
      t,
      'left_control',
      preview({ proceedsInBase: null, unpricedCount: 3 })
    );
    expect(said).toInclude('nothing is booked');
    // The "so the figure is a floor" qualifier would be qualifying nothing.
    expect(said).not.toInclude('floor');
  });

  test('marks the total as a floor when only some rows are unpriced', () => {
    const said = bulkConsequence(t, 'left_control', preview({ unpricedCount: 1 }));
    expect(said).toInclude('€41,203.55');
    expect(said).toInclude('floor');
  });

  test('states what an untracked answer takes back OFF — the SC-186 direction', () => {
    const said = bulkConsequence(
      t,
      'untracked',
      preview({ alreadyDisposedCount: 2, alreadyDisposedInBase: '10500' })
    );
    expect(said).toInclude('Nothing is realized');
    expect(said).toInclude('takes about €10,500.00 of realized gains back off');
  });

  test('refuses to state a figure before the preview lands', () => {
    expect(bulkConsequence(t, 'left_control', undefined)).not.toInclude('€');
  });

  test('says so plainly when nothing in the selection can be answered', () => {
    expect(bulkConsequence(t, 'left_control', preview({ eligible: [] }))).toInclude(
      'None of the selected transfers'
    );
  });
});

describe('bulkRefusalNotes', () => {
  test('names the own wallet rather than counting it', () => {
    const notes = bulkRefusalNotes(t, [
      { transactionId: 'a', reason: 'own_wallet', detail: '0x9d8ae06a…14ab' },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toInclude('0x9d8ae06a…14ab');
    expect(notes[0]).toInclude('cannot be counted as a disposal');
  });

  test('groups one line per reason, not one per row', () => {
    const notes = bulkRefusalNotes(t, [
      { transactionId: 'a', reason: 'linked', detail: null },
      { transactionId: 'b', reason: 'linked', detail: null },
      { transactionId: 'c', reason: 'answered_otherwise', detail: 'paired' },
    ]);
    expect(notes).toHaveLength(2);
    expect(notes.join(' ')).toInclude('2 are already linked');
    expect(notes.join(' ')).toInclude('“paired”');
  });
});

/**
 * The confirm sentence over a declared transfer's Reopen (SC-618).
 *
 * The branch is checked FIRST in `reopenConsequence` and this is why: a
 * declared pair's `decision` is `paired`, so before the fix it fell to
 * `default` — *"nothing about it is settled until you answer it again"* — over
 * an action that moves two balances and deletes two entries. The sentence was
 * not merely thin, it asserted the opposite of what happens.
 */
describe('reopenConsequence — a transfer the owner declared', () => {
  const answeredRow = (over: Partial<AnsweredTransferReview>): AnsweredTransferReview => ({
    transactionId: 'tx-out',
    holdingId: 'h-out',
    tokenSymbol: 'USDT',
    accountName: 'Spot',
    institutionName: 'Airwallex',
    kind: 'withdraw',
    quantity: '2000',
    occurredAt: '2026-08-10T09:00:00.000Z',
    counterparty: null,
    decision: 'paired',
    split: null,
    reviewedAt: '2026-08-11T09:00:00.000Z',
    answerSource: 'user',
    ruleNote: null,
    declared: false,
    createdDestination: false,
    ...over,
  });

  test('says both balances move back, and that nothing rejoins the queue', () => {
    const sentence = reopenConsequence(t, answeredRow({ declared: true }));
    expect(sentence).toContain('balances back');
    expect(sentence).toContain('does not rejoin the queue');
  });

  test('a pairing the QUEUE made says the opposite, on the same decision', () => {
    // Same `decision: 'paired'`, so this is the control that shows the branch
    // is reading `declared` and not the answer.
    const sentence = reopenConsequence(t, answeredRow({ declared: false }));
    expect(sentence).toContain('rejoins the queue');
    expect(sentence).not.toContain('balances back');
  });

  test('declared wins over an internal answer, which would delete a deposit it never wrote', () => {
    const sentence = reopenConsequence(t, answeredRow({ declared: true, decision: 'internal' }));
    expect(sentence).toContain('balances back');
  });
});

/**
 * SC-631. An `internal` answer that had to CREATE its destination removes that
 * holding on reopen, and the ordinary sentence — "no balance changes either
 * way" — is false of it: an account loses a position it did not have before
 * the answer.
 */
describe('reopenConsequence — an internal answer that created its destination', () => {
  const answeredRow = (over: Partial<AnsweredTransferReview>): AnsweredTransferReview => ({
    transactionId: 'tx-out',
    holdingId: 'h-out',
    tokenSymbol: 'USDT',
    accountName: 'Savings',
    institutionName: 'Revolut',
    kind: 'withdraw',
    quantity: '250',
    occurredAt: '2026-08-10T09:00:00.000Z',
    counterparty: null,
    decision: 'internal',
    split: null,
    reviewedAt: '2026-08-11T09:00:00.000Z',
    answerSource: 'user',
    ruleNote: null,
    declared: false,
    createdDestination: false,
    ...over,
  });

  test('says the holding goes too, and stops promising no balance changes', () => {
    const sentence = reopenConsequence(t, answeredRow({ createdDestination: true }));
    expect(sentence).toContain('created the holding');
    expect(sentence).not.toContain('no balance changes either way');
  });

  test('a destination that already existed keeps the old sentence', () => {
    // MUST-BE-ABSENT, on the same `decision: 'internal'` — so this is what
    // shows the branch reads `createdDestination` rather than the answer.
    const sentence = reopenConsequence(t, answeredRow({ createdDestination: false }));
    expect(sentence).toContain('no balance changes either way');
    expect(sentence).not.toContain('created the holding');
  });

  test('declared still wins, even when this answer created a holding', () => {
    // `reopen` undoes a declared pair and returns before `clearAnswer` runs at
    // all, so the created-destination sentence would describe a delete that
    // never happens.
    const sentence = reopenConsequence(
      t,
      answeredRow({ declared: true, createdDestination: true })
    );
    expect(sentence).toContain('balances back');
  });
});
