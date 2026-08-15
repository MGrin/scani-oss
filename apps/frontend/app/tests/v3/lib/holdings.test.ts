import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import {
  amountDecimals,
  compareHoldings,
  countsTowardTotal,
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
  supportsApy,
  tokenTypeOptions,
} from '../../../src/v3/lib/holdings';

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
    amount: 0.2841,
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
      expect(holdingMatches(item, query)).toBe(true);
    }
  });

  test('matches a group name, because group is one of the filters', () => {
    expect(holdingMatches(item, 'long term')).toBe(true);
  });

  test('does not match something absent', () => {
    expect(holdingMatches(item, 'solana')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(holdingMatches(item, '   ')).toBe(true);
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
      compareHoldings(holding({ amount: 1 }), holding({ amount: 2 }), 'amount', 'asc')
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
    expect(holdingAllocation(items)).toEqual([
      { key: 'stock', label: 'Equity', value: 400 },
      { key: 'crypto', label: 'Crypto', value: 150 },
    ]);
  });

  test('drops what has no positive value — a bar cannot draw an unknown', () => {
    expect(holdingAllocation([holding({ value: null })])).toEqual([]);
  });

  /** SC-63 again: the bar and the figure above it are one claim about one
   *  portfolio, so a row the figure ignores cannot be a segment. */
  test('adds up to the same figure the summary shows', () => {
    const withInactive = [...items, holding({ value: 1000, isActive: false })];
    const barTotal = holdingAllocation(withInactive).reduce((sum, item) => sum + item.value, 0);
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
    expect(payoutScheduleLabel('daily', null, null, null)).toBe('Daily');
    expect(payoutScheduleLabel('weekly', 3, null, null)).toBe('Weekly on Wednesday');
    expect(payoutScheduleLabel('monthly', null, 15, null)).toBe('Monthly on day 15');
    expect(payoutScheduleLabel('yearly', null, 5, 4)).toBe('Yearly on April 5');
  });

  test('falls back to the raw frequency rather than inventing one', () => {
    expect(payoutScheduleLabel('fortnightly', null, null, null)).toBe('fortnightly');
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
      tokenTypeOptions([
        holding({ token: { ...holding().token, typeCode: 'stock', type: 'Equity' } }),
        holding(),
        holding(),
      ])
    ).toEqual([
      { value: 'crypto', label: 'Crypto' },
      { value: 'stock', label: 'Equity' },
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
