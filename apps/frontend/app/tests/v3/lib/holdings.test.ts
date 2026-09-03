import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  formatDayMonth,
  type HoldingWithDetails,
  monthName,
  monthNameInDate,
  resetFormatLocale,
  setFormatLocale,
  weekdayName,
} from '@scani/shared';
import { parseAmountInput } from '@scani/ui/v3/lib/amount-input';
import i18n from 'i18next';
import shellRu from '../../../src/i18n/locales/ru.json';
import v3Ru from '../../../src/v3/i18n/locales/ru.json';
import {
  amountDecimals,
  BALANCE_EDIT_SCALE,
  balanceEditWrites,
  balanceIsBelowZero,
  compareHoldings,
  countsTowardTotal,
  daysInMonth,
  describeSource,
  entityOptions,
  excludedFromTotal,
  hasCustomPrice,
  holdingAllocation,
  holdingFiltersFromParams,
  holdingGainLoss,
  holdingMatches,
  holdingPrice,
  holdingsValue,
  isSynced,
  payoutScheduleLabel,
  stalePricedInTotal,
  supportsApy,
  tokenTypeOptions,
} from '../../../src/v3/lib/holdings';

// The real catalogue, not a fake `t`: it proves the keys exist as well as
// that they are used, which a stub would not.
const t = i18n.t.bind(i18n);

/**
 * The decisions the holdings surface makes about a holding, none of which needs
 * React to be wrong. The three that carry the ticket are the unpriceable cases:
 * a position with no resolvable price has no gain/loss, no rank in a value
 * sort, and no share of the allocation — and v2 answers all three with a zero.
 */

function holding(overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id: 'h1',
    token: {
      id: 't1',
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
    },
    amount: '0.2841',
    value: 18_204.55,
    costBasis: 12_000,
    price: { value: '64072.18', timestamp: '2026-08-12T09:00:00.000Z', source: 'coingecko' },
    account: {
      id: 'a1',
      name: 'Spot',
      type: 'Exchange',
      typeCode: 'exchange',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Kraken', type: 'Exchange', typeCode: 'exchange' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'import_wallet',
    ...overrides,
  };
}

describe('holdingGainLoss', () => {
  test('measures the position against its cost basis', () => {
    expect(holdingGainLoss({ value: 150, costBasis: 100 })).toEqual({
      absolute: 50,
      percent: 50,
    });
  });

  test('is null when there is no cost basis to measure against', () => {
    expect(holdingGainLoss({ value: 150, costBasis: 0 })).toBeNull();
    expect(holdingGainLoss({ value: 150, costBasis: null })).toBeNull();
  });

  test('is null — not a total loss — when the position is unpriceable', () => {
    // v2 coerces the null to 0 and reports −100%. The price is unknown; the
    // holding did not go to zero.
    expect(holdingGainLoss({ value: null, costBasis: 100 })).toBeNull();
  });
});

describe('holdingPrice', () => {
  test('parses the per-unit price', () => {
    expect(holdingPrice(holding())).toBe(64_072.18);
  });

  test('is null when there is no price, or the stored one is not a number', () => {
    expect(holdingPrice({ price: undefined })).toBeNull();
    expect(
      holdingPrice({ price: { value: null, timestamp: '2026-08-12T09:00:00.000Z' } })
    ).toBeNull();
    expect(
      holdingPrice({ price: { value: 'n/a', timestamp: '2026-08-12T09:00:00.000Z' } })
    ).toBeNull();
  });
});

describe('amountDecimals', () => {
  test('gives a fractional balance every digit it carries', () => {
    expect(amountDecimals(0.2841)).toBe(4);
    expect(amountDecimals(12_480.09)).toBe(2);
  });

  test('gives a whole share count none', () => {
    expect(amountDecimals(84)).toBe(0);
    expect(amountDecimals(0)).toBe(0);
  });

  test('stops at eight, where the balance column does', () => {
    expect(amountDecimals(0.123456789)).toBe(8);
  });

  /** Eight is a ceiling for a figure eight decimals can express, and the old
   *  version applied it to one they cannot: `1e-9` rendered as `0`, which is a
   *  claim about the position rather than about its size (SC-177). */
  test('goes past eight rather than render a dust balance as nothing', () => {
    expect(amountDecimals(0.000000001)).toBe(9);
  });
});

describe('holdingMatches', () => {
  const item = holding({ groups: [{ id: 'g1', name: 'Long term', color: '#fff' }] });

  test('matches the symbol, the name, the account and the institution', () => {
    for (const query of ['btc', 'bitco', 'spot', 'kraken']) {
      expect(holdingMatches(t, item, query)).toBe(true);
    }
  });

  test('matches a group name, because group is one of the filters', () => {
    expect(holdingMatches(t, item, 'long term')).toBe(true);
  });

  test('does not match something absent', () => {
    expect(holdingMatches(t, item, 'solana')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(holdingMatches(t, item, '   ')).toBe(true);
  });

  /**
   * SC-419. The row shows a DERIVED name for fiat, so search has to run over
   * the same string — a list that renders `dólar estadounidense` and matches
   * only `US Dollar` is a search box that cannot find what it is displaying.
   */
  test('a fiat row is searchable by the name it actually shows', () => {
    const usd = holding({
      token: {
        id: 't2',
        symbol: 'USD',
        name: 'US Dollar',
        type: 'Fiat Currency',
        typeCode: 'fiat',
        isScamProbability: 0,
      },
    });
    expect(holdingMatches(t, usd, 'US Dollar')).toBe(true);
    try {
      setFormatLocale('es');
      expect(holdingMatches(t, usd, 'estadounidense')).toBe(true);
      // The must-be-ABSENT arm: the English stored name is NOT what a Spanish
      // row shows, so it must not be searchable there either.
      expect(holdingMatches(t, usd, 'US Dollar')).toBe(false);
      // And a non-fiat name is a proper noun — searchable in every locale.
      expect(holdingMatches(t, item, 'bitco')).toBe(true);
    } finally {
      resetFormatLocale();
    }
  });
});

describe('compareHoldings', () => {
  const priced = holding({ id: 'a', value: 100 });
  const cheaper = holding({ id: 'b', value: 10 });
  const unpriced = holding({ id: 'c', value: null, price: undefined });

  test('sorts by value in both directions', () => {
    expect(compareHoldings(priced, cheaper, 'value', 'asc')).toBeGreaterThan(0);
    expect(compareHoldings(priced, cheaper, 'value', 'desc')).toBeLessThan(0);
  });

  test('keeps unpriced holdings last whichever way the column points', () => {
    expect(compareHoldings(unpriced, priced, 'value', 'asc')).toBeGreaterThan(0);
    expect(compareHoldings(unpriced, priced, 'value', 'desc')).toBeGreaterThan(0);
    expect(compareHoldings(priced, unpriced, 'price', 'desc')).toBeLessThan(0);
  });

  test('sorts by symbol, amount and gain/loss', () => {
    const eth = holding({ token: { ...holding().token, symbol: 'ETH' } });
    expect(compareHoldings(holding(), eth, 'symbol', 'asc')).toBeLessThan(0);
    expect(
      compareHoldings(holding({ amount: '1' }), holding({ amount: '2' }), 'amount', 'asc')
    ).toBeLessThan(0);
    expect(
      compareHoldings(
        holding({ value: 200, costBasis: 100 }),
        holding({ value: 110, costBasis: 100 }),
        'pnl',
        'asc'
      )
    ).toBeGreaterThan(0);
  });

  test('an unknown field is treated as the default value sort', () => {
    expect(compareHoldings(priced, cheaper, 'nonsense', 'asc')).toBeGreaterThan(0);
  });
});

describe('holdingsValue', () => {
  test('sums what is known and treats the rest as nothing added', () => {
    expect(
      holdingsValue([holding({ value: 10 }), holding({ value: null }), holding({ value: 5 })])
    ).toBe(15);
  });

  /**
   * SC-63. The list summed every row it was handed while `/`, `/accounts` and
   * `/institutions` all summed the server's active-only figure, so
   * deactivating one position made two screens disagree by that position's
   * value — 14% of net worth in the report, and it survived a hard reload.
   */
  test('leaves out what the portfolio total leaves out', () => {
    const items = [
      holding({ id: 'a', value: 10 }),
      holding({ id: 'b', value: 90, isActive: false }),
    ];
    expect(holdingsValue(items)).toBe(10);
  });

  test('a deactivate moves this figure by exactly the deactivated value', () => {
    const before = [
      holding({ id: 'a', value: 525_728.45 }),
      holding({ id: 'b', value: 73_782.57 }),
    ];
    const after = before.map((item) => (item.id === 'b' ? { ...item, isActive: false } : item));
    expect(holdingsValue(before) - holdingsValue(after)).toBeCloseTo(73_782.57, 2);
  });
});

describe('countsTowardTotal', () => {
  test('mirrors the server rule: hidden, inactive and scam never count', () => {
    expect(countsTowardTotal(holding())).toBe(true);
    expect(countsTowardTotal(holding({ isActive: false }))).toBe(false);
    expect(countsTowardTotal(holding({ isHidden: true }))).toBe(false);
    expect(
      countsTowardTotal(holding({ token: { ...holding().token, isScamProbability: 0.9 } }))
    ).toBe(false);
  });
});

describe('excludedFromTotal', () => {
  test('counts the rows on screen the figure above them ignores, and their worth', () => {
    expect(
      excludedFromTotal([
        holding({ id: 'a', value: 10 }),
        holding({ id: 'b', value: 90, isActive: false }),
        holding({ id: 'c', value: null, isActive: false }),
      ])
    ).toEqual({ count: 2, value: 90 });
  });

  test('is silent when everything on screen counts', () => {
    expect(excludedFromTotal([holding({ value: 10 })])).toEqual({ count: 0, value: 0 });
  });
});

describe('stalePricedInTotal', () => {
  test('counts the rows the figure DOES include but should not read as fresh', () => {
    expect(
      stalePricedInTotal([
        holding({ id: 'a', value: 10 }),
        holding({ id: 'b', value: 90, priceStale: true }),
        holding({ id: 'c', value: 5, priceStale: false }),
      ])
    ).toEqual({ count: 1, value: 90 });
  });

  test('leaves out a stale row the total does not count either', () => {
    // The count has to describe the set the figure above it is made of. An
    // inactive holding is not in the total, so its stale price says nothing
    // about the number on screen.
    expect(
      stalePricedInTotal([holding({ id: 'a', value: 90, priceStale: true, isActive: false })])
    ).toEqual({ count: 0, value: 0 });
  });

  test('an absent flag is not counted — the question was never asked', () => {
    // `undefined` means nothing dated the price, which is a different fact
    // from a price we dated and found old. Counting it would put a number on
    // screen no server computed.
    expect(stalePricedInTotal([holding({ id: 'a', value: 90 })])).toEqual({ count: 0, value: 0 });
  });
});

describe('holdingAllocation', () => {
  const items = [
    holding({ value: 100 }),
    holding({ value: 50 }),
    holding({
      value: 400,
      token: { ...holding().token, typeCode: 'stock', type: 'Equity' },
    }),
    holding({ value: null }),
    holding({ value: 0 }),
  ];

  test('sums by token type and orders biggest first', () => {
    // The labels are the TRANSLATED names, not the `type` column the fixtures
    // carry — `Equity` and `Crypto` are what a reader saw before SC-419 and
    // what would come back if the map were bypassed.
    expect(holdingAllocation(t, items)).toEqual([
      { key: 'stock', label: 'Stock / ETF / Equity / Commodity', value: 400 },
      { key: 'crypto', label: 'Cryptocurrency', value: 150 },
    ]);
  });

  test('drops what has no positive value — a bar cannot draw an unknown', () => {
    expect(holdingAllocation(t, [holding({ value: null })])).toEqual([]);
  });

  /** SC-63 again: the bar and the figure above it are one claim about one
   *  portfolio, so a row the figure ignores cannot be a segment. */
  test('adds up to the same figure the summary shows', () => {
    const withInactive = [...items, holding({ value: 1000, isActive: false })];
    const barTotal = holdingAllocation(t, withInactive).reduce((sum, item) => sum + item.value, 0);
    expect(barTotal).toBe(holdingsValue(withInactive));
  });
});

describe('capability gates', () => {
  test('a custom-priced token is one whose price the user maintains', () => {
    expect(hasCustomPrice(holding())).toBe(false);
    expect(
      hasCustomPrice(holding({ token: { ...holding().token, typeCode: 'private-company' } }))
    ).toBe(true);
  });

  test('APY follows the account type, matching the backend gate', () => {
    expect(supportsApy(holding())).toBe(false);
    expect(supportsApy(holding({ account: { ...holding().account, typeCode: 'savings' } }))).toBe(
      true
    );
  });

  test('only a holding that came from somewhere can be re-synced', () => {
    expect(isSynced(holding())).toBe(true);
    expect(isSynced(holding({ source: 'manual' }))).toBe(false);
    expect(isSynced(holding({ source: '' }))).toBe(false);
  });
});

describe('describeSource', () => {
  test('drops the pipeline prefix and the underscores', () => {
    expect(describeSource('import_wallet')).toBe('wallet');
    expect(describeSource('exchange_sync')).toBe('exchange sync');
  });
});

describe('payoutScheduleLabel', () => {
  test('names each cadence without repeating the label above it', () => {
    expect(payoutScheduleLabel(t, 'daily', null, null, null)).toBe('Daily');
    expect(payoutScheduleLabel(t, 'weekly', 3, null, null)).toBe('Weekly on Wednesday');
    expect(payoutScheduleLabel(t, 'monthly', null, 15, null)).toBe('Monthly on day 15');
    // `5 April`, not `April 5`: the date is `Intl`'s now, and English here is
    // en-GB, which is the order every other date in this app is printed in
    // (SC-413). An en-US reader gets `April 5` off the same string.
    expect(payoutScheduleLabel(t, 'yearly', null, 5, 4)).toBe('Yearly on 5 April');
  });

  test('the DAY comes from the locale, the SENTENCE from the catalogue (SC-300)', () => {
    // The literals above are correct today and would also pass over the
    // hand-rolled DAY_NAMES table this replaced — under `en-GB` "from Intl"
    // and "reads Wednesday" are the same observation. This is the assertion
    // that separates them: the name must be whatever `weekdayName` returns,
    // and the sentence around it must be the catalogue's.
    expect(payoutScheduleLabel(t, 'weekly', 3, null, null)).toBe(
      t('v3.holdings.payout.weekly', { day: weekdayName(3) })
    );
    expect(payoutScheduleLabel(t, 'yearly', null, 5, 4)).toBe(
      t('v3.holdings.payout.yearly', { date: formatDayMonth(5, 4) })
    );
  });

  test('a null day or month still renders a real name, not an empty slot', () => {
    // `?? 0` and `?? 1` were in the original and are load-bearing: the old
    // table's index 0 for months was an EMPTY STRING, so a null month there
    // would have rendered "Yearly on  5" with a double space.
    expect(payoutScheduleLabel(t, 'weekly', null, null, null)).toBe('Weekly on Sunday');
    expect(payoutScheduleLabel(t, 'yearly', null, null, null)).toBe('Yearly on 1 January');
  });

  test('falls back to the raw frequency rather than inventing one', () => {
    expect(payoutScheduleLabel(t, 'fortnightly', null, null, null)).toBe('fortnightly');
  });

  test('never names a day that month does not have (SC-320)', () => {
    // `UpsertHoldingApyConfigDto` bounds the day at 31 without knowing the
    // month, so 31 February is a row the API accepts and the calendar refuses.
    // The job pays it on the 28th — `Math.min(day, daysInMonth)` — and saying
    // "Yearly on February 31" is a sentence about a date that never arrives.
    expect(payoutScheduleLabel(t, 'yearly', null, 31, 2, 2026)).toBe(
      'Yearly on the last day of February'
    );
    expect(payoutScheduleLabel(t, 'yearly', null, 31, 4, 2026)).toBe(
      'Yearly on the last day of April'
    );
    // A real date still names itself, in the month it is real in.
    expect(payoutScheduleLabel(t, 'yearly', null, 31, 1, 2026)).toBe('Yearly on 31 January');
    // And the leap year is why the year is a parameter: 29 February is a date
    // in 2028 and is not one in 2026.
    expect(payoutScheduleLabel(t, 'yearly', null, 29, 2, 2026)).toBe(
      'Yearly on the last day of February'
    );
    expect(payoutScheduleLabel(t, 'yearly', null, 29, 2, 2028)).toBe('Yearly on 29 February');
  });

  test('daysInMonth is the job’s, including the leap year', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('holdingFiltersFromParams', () => {
  test('carries v2 link parameters into the list filters', () => {
    const params = new URLSearchParams('institution=i1&account=a1&tokenType=crypto&group=g1');
    expect(holdingFiltersFromParams(params)).toEqual({
      institution: 'i1',
      account: 'a1',
      tokenType: 'crypto',
      group: 'g1',
    });
  });

  test('ignores empty values and anything it does not own', () => {
    const params = new URLSearchParams('institution=&sort=value&group=g1');
    expect(holdingFiltersFromParams(params)).toEqual({ group: 'g1' });
  });
});

describe('option builders', () => {
  test('token types are labelled by their human name, alphabetically', () => {
    expect(
      tokenTypeOptions(t, [
        holding({ token: { ...holding().token, typeCode: 'stock', type: 'Equity' } }),
        holding(),
        holding(),
      ])
    ).toEqual([
      { value: 'crypto', label: 'Cryptocurrency' },
      { value: 'stock', label: 'Stock / ETF / Equity / Commodity' },
    ]);
  });

  test('the full entity list wins, so a link to one with no holdings still names it', () => {
    expect(
      entityOptions(
        [
          { id: 'i2', name: 'Wise' },
          { id: 'i1', name: 'Kraken' },
        ],
        [{ id: 'i1', name: 'Kraken' }]
      )
    ).toEqual([
      { value: 'i1', label: 'Kraken' },
      { value: 'i2', label: 'Wise' },
    ]);
  });

  test('falls back to what the holdings name, de-duplicated', () => {
    expect(
      entityOptions(undefined, [
        { id: 'i1', name: 'Kraken' },
        { id: 'i1', name: 'Kraken' },
      ])
    ).toEqual([{ value: 'i1', label: 'Kraken' }]);
  });

  test('an empty list is not an answer — the fallback is used', () => {
    expect(entityOptions([], [{ id: 'i1', name: 'Kraken' }])).toEqual([
      { value: 'i1', label: 'Kraken' },
    ]);
  });
});

/**
 * The same sentence in a language that inflects its months (SC-413).
 *
 * English cannot catch this and neither can French or German: `Intl` returns
 * one month name for both contexts in all three. Russian returns «февраль»
 * standing alone and «февраля» inside a date, so a template that interpolated
 * a stand-alone month rendered «Ежегодно, 15 февраль» — a form no Russian
 * writes. The fix is at the formatter rather than in `ru.json`, because no
 * value in a catalogue can inflect a noun that arrives already wrong.
 *
 * `ru` is loaded here rather than in `i18n-preload` on purpose: the preload
 * mirrors what the app boots with, and the app boots with one language.
 */
describe('the yearly sentence in a language with cases', () => {
  i18n.addResourceBundle('ru', 'translation', { ...shellRu, ...v3Ru }, true, true);
  const ru = i18n.getFixedT('ru');

  function inRussian<T>(body: () => T): T {
    setFormatLocale('ru');
    try {
      return body();
    } finally {
      resetFormatLocale();
    }
  }

  test('a yearly payout names the month in the genitive', () => {
    expect(inRussian(() => payoutScheduleLabel(ru, 'yearly', null, 15, 2))).toBe(
      'Ежегодно, 15 февраля'
    );
    expect(inRussian(() => payoutScheduleLabel(ru, 'yearly', null, 1, 5))).toBe('Ежегодно, 1 мая');
  });

  test('the impossible-date sentence keeps its month in the genitive too', () => {
    // Slice 4's rule survives the change: 31 February is still "the last day",
    // and the month in that phrase is inflected the same way.
    expect(inRussian(() => payoutScheduleLabel(ru, 'yearly', null, 31, 2, 2026))).toBe(
      'Ежегодно, в последний день февраля'
    );
  });

  test('the month a picker offers stays in the nominative', () => {
    // `monthNameInDate` is for a month standing in a phrase. The list of
    // months in the form is the other context, and «февраль» is right there —
    // one helper for both would break whichever it was not written for.
    expect(inRussian(() => monthNameInDate(2))).toBe('февраля');
    expect(inRussian(() => monthName(2))).toBe('февраль');
  });
});

/**
 * SC-567 — the guard on the balance editor's save.
 *
 * The bug it closes was two reasonable halves meeting. `HoldingAmountFact`
 * seeds its editor from the balance it is showing, and the wire rounded any
 * balance below `1e-8` to `0` — so for a real dust position the editor opened
 * on `"0"`. Its save guard was `if (next)`, and `"0"` passes that: it is a
 * non-empty string. Tapping the pencil to look at the figure and tapping save
 * wrote `0` over the balance, with no keystroke in between.
 *
 * THE FIXTURES ARE THE PRODUCTION VALUES, not round ones. Every existing test
 * of this area uses `balance: '10'`, which is why the rounding this guard
 * protects against had never once been executed in a test — a fixture that
 * needs no formatting cannot test a formatter, and a balance that survives
 * rounding cannot test a rounder.
 */
describe('balanceEditWrites', () => {
  test('an untouched editor does not write, even when the seed reads as zero', () => {
    // THE CASE THE GUARD EXISTS FOR. Before SC-567 this returned true and the
    // real balance was replaced by 0.
    expect(balanceEditWrites('0', '0')).toBe(false);
  });

  test('an untouched editor does not write when the seed is the real dust figure', () => {
    // The same tap AFTER the wire is fixed. Still no write, and that is the
    // point: the route is closed by the absence of an edit, not by the seed
    // being faithful.
    expect(balanceEditWrites('0.0000000004013', '0.0000000004013')).toBe(false);
    expect(balanceEditWrites('0.000000000000000001', '0.000000000000000001')).toBe(false);
  });

  test('a cleared field does not write', () => {
    // Emptying the box is not a request to set the balance to nothing; it is
    // an abandoned edit. Writing `''` would fail validation server-side, and
    // writing `0` would be inventing an intention.
    expect(balanceEditWrites('143.59019742', '')).toBe(false);
    expect(balanceEditWrites('143.59019742', '   ')).toBe(false);
  });

  test('a real edit writes, including one that only adds precision', () => {
    expect(balanceEditWrites('0', '12500')).toBe(true);
    expect(balanceEditWrites('143.59019742', '143.59019743')).toBe(true);
    // The edit this whole ticket is about: correcting a wrongly-zeroed balance
    // back to what it should be.
    expect(balanceEditWrites('0', '0.0000000004013')).toBe(true);
  });

  test('surrounding whitespace is not an edit', () => {
    expect(balanceEditWrites('12500', ' 12500 ')).toBe(false);
  });

  /**
   * THE TEST A FUTURE READER WILL WANT TO DELETE, and the argument for
   * deleting it is good: comparing balances as text means `0.50` and `0.5`
   * read as different, so this writes where a numeric comparison would not.
   *
   * Argue with the reason, not the assertion. A reader who retyped `0.50` as
   * `0.5` DID touch the field, and writing an identical balance costs nothing
   * and loses nothing. The case this guard exists for is the one where nothing
   * was typed at all, and there the two strings are identical by construction.
   * A numeric comparison would additionally have to decide what `new
   * Decimal('')` means and what to do when the draft does not parse — two more
   * ways to be wrong, on the save path of a field that destroys data when it
   * is wrong.
   */
  test('a differently-written but equal balance still writes', () => {
    expect(balanceEditWrites('0.5', '0.50')).toBe(true);
  });
});

/**
 * SC-567 — the OTHER half of the same data loss, one layer down.
 *
 * The editor's save guard stops an untouched field writing. This stops a
 * touched one writing the wrong thing: `parseAmountInput` truncates the value
 * at the field's `decimalScale` and deliberately leaves the on-screen text
 * alone (SC-75), so at a scale of 8 the field reads `0.0000000004013` while
 * the value it would save is `0.00000000`. The screen and the value disagree
 * and the screen is the one that reassures.
 */
describe('BALANCE_EDIT_SCALE', () => {
  test('the balance editor parses a dust balance without truncating it', () => {
    for (const balance of ['0.0000000004013', '0.000000000000000001', '143.59019742', '12500']) {
      const parsed = parseAmountInput(balance, {
        decimalScale: BALANCE_EDIT_SCALE,
        allowNegative: false,
      });
      expect(`${balance} -> ${parsed.value}`).toBe(`${balance} -> ${balance}`);
    }
  });

  test('the display cap would have truncated them, which is why it is not used here', () => {
    // The negative control, and it is what makes the test above mean
    // something: without it, a scale of 8 and a scale of 18 are
    // indistinguishable on any balance anybody normally holds.
    const parsed = parseAmountInput('0.0000000004013', {
      decimalScale: 8,
      allowNegative: false,
    });
    expect(parsed.value).toBe('0.00000000');
    expect(parsed.text).toBe('0.0000000004013');
  });
});

/**
 * SC-567 — sorting and precision now that `amount` is a decimal string.
 */
describe('amount as a decimal string', () => {
  test('sorts two dust balances against each other, not both as zero', () => {
    // Before SC-567 both arrived as `0` and this comparison returned 0 — the
    // list put them in whatever order it received them and looked deliberate.
    const smaller = holding({ amount: '0.000000000000000001' });
    const larger = holding({ amount: '0.0000000004013' });
    expect(compareHoldings(smaller, larger, 'amount', 'asc')).toBeLessThan(0);
    expect(compareHoldings(smaller, larger, 'amount', 'desc')).toBeGreaterThan(0);
  });

  test('sorts balances a double cannot tell apart', () => {
    // 17 significant digits differing in the last one. Subtraction through a
    // double gives exactly 0 here, so the old comparator called them equal.
    const a = holding({ amount: '123456789012345.12345678' });
    const b = holding({ amount: '123456789012345.12345679' });
    expect(compareHoldings(a, b, 'amount', 'asc')).toBeLessThan(0);
    // Non-vacuous: this is what the old implementation was working with.
    expect(Number('123456789012345.12345678') - Number('123456789012345.12345679')).toBe(0);
  });

  test('sorts an ordinary pair the way it always did', () => {
    expect(
      compareHoldings(holding({ amount: '1' }), holding({ amount: '2' }), 'amount', 'asc')
    ).toBeLessThan(0);
    expect(
      compareHoldings(holding({ amount: '12500' }), holding({ amount: '143.59' }), 'amount', 'asc')
    ).toBeGreaterThan(0);
  });

  test('amountDecimals reads the decimals off the string, not off a double', () => {
    expect(amountDecimals('0.0000000004013')).toBe(13);
    expect(amountDecimals('0.000000000000000001')).toBe(18);
    expect(amountDecimals('143.59019742')).toBe(8);
    expect(amountDecimals('12500')).toBe(0);
  });
});

/**
 * SC-632. The rule is about the SIGN, and it is a claim about provenance:
 * a negative balance cannot have been entered, because both holding DTOs
 * refuse one and `UpdateHoldingDto` gates the mutation. That is what lets the
 * explanation hang off the number instead of a marker column.
 */
describe('balanceIsBelowZero', () => {
  test('a deficit is below zero', () => {
    expect(balanceIsBelowZero('-1900')).toBe(true);
    expect(balanceIsBelowZero('-0.00000001')).toBe(true);
  });

  test('zero is not, and neither is negative zero', () => {
    // decimal.js reports `-0` as negative. It is not a deficit, and a holding
    // that reached exactly zero by a signed route must not be told it is one.
    expect(balanceIsBelowZero('0')).toBe(false);
    expect(balanceIsBelowZero('-0')).toBe(false);
    expect(balanceIsBelowZero('0.0000000004013')).toBe(false);
  });

  test('an unparseable balance is a different defect and claims nothing', () => {
    expect(balanceIsBelowZero('not a number')).toBe(false);
    expect(balanceIsBelowZero('')).toBe(false);
  });
});
