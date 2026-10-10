import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import {
  type BreakdownHolding,
  type BreakdownRow,
  periodBreakdown,
} from '../../../src/lib/portfolio/period-breakdown';

/**
 * SC-1692 — what the Home chart peek shows for a period: the change by account
 * type, the biggest movers, and the biggest PnL. Every list is read from the
 * same rows as the user-wide series, between its first and last days, so the
 * parts add up to the change the chart shows.
 */

const HOLDINGS = new Map<string, BreakdownHolding>([
  [
    'btc',
    {
      symbol: 'BTC',
      accountName: 'BTC account',
      accountType: { code: 'crypto_exchange', name: 'Crypto exchange' },
    },
  ],
  [
    'eth',
    {
      symbol: 'ETH',
      accountName: 'ETH account',
      accountType: { code: 'crypto_exchange', name: 'Crypto exchange' },
    },
  ],
  [
    'vwrl',
    {
      symbol: 'VWRL',
      accountName: 'VWRL account',
      accountType: { code: 'brokerage', name: 'Brokerage' },
    },
  ],
  [
    'gbp',
    {
      symbol: 'GBP',
      accountName: 'GBP account',
      accountType: { code: 'checking', name: 'Checking' },
    },
  ],
  [
    'new',
    {
      symbol: 'SOL',
      accountName: 'SOL account',
      accountType: { code: 'crypto_exchange', name: 'Crypto exchange' },
    },
  ],
  [
    'sold',
    {
      symbol: 'AAPL',
      accountName: 'AAPL account',
      accountType: { code: 'brokerage', name: 'Brokerage' },
    },
  ],
]);

function row(
  snapshotDate: string,
  holdingId: string,
  totalValue: number,
  realizedPnl: number | null = 0,
  unrealizedPnl: number | null = 0
): BreakdownRow {
  return {
    snapshotDate,
    holdingId,
    totalValue: String(totalValue),
    realizedPnl: realizedPnl === null ? null : String(realizedPnl),
    unrealizedPnl: unrealizedPnl === null ? null : String(unrealizedPnl),
  };
}

const ROWS: BreakdownRow[] = [
  row('2026-09-10', 'btc', 1000, 0, 200),
  row('2026-09-10', 'eth', 500, 0, 50),
  row('2026-09-10', 'vwrl', 2000, 10, 300),
  row('2026-09-10', 'gbp', 800),
  row('2026-09-10', 'sold', 400, 0, 100),
  row('2026-09-25', 'btc', 1100, 0, 300),
  row('2026-10-10', 'btc', 1300, 0, 500),
  row('2026-10-10', 'eth', 450, 0, 0),
  row('2026-10-10', 'vwrl', 2100, 10, 400),
  row('2026-10-10', 'gbp', 700),
  // Bought mid-period: nothing on the first day.
  row('2026-10-10', 'new', 250, 0, 25),
  // Sold mid-period: the gain moved from unrealized to realized on the cash side,
  // and the holding has no row on the last day.
];

function sum(values: string[]): string {
  return values.reduce((total, value) => total.add(value), new Decimal(0)).toString();
}

describe('periodBreakdown', () => {
  const result = periodBreakdown(ROWS, HOLDINGS);

  test('measures between the first and last days of the rows', () => {
    expect(result.startDate).toBe('2026-09-10');
    expect(result.endDate).toBe('2026-10-10');
  });

  test('the account-type parts add up to the total change the chart shows', () => {
    // First day 4700, last day 4800.
    expect(result.total).toEqual({ start: '4700', end: '4800', change: '100' });
    expect(sum(result.byAccountType.map((part) => part.change))).toBe('100');
    expect(result.byAccountType).toEqual([
      {
        code: 'crypto_exchange',
        name: 'Crypto exchange',
        start: '1500',
        end: '2000',
        change: '500',
      },
      { code: 'brokerage', name: 'Brokerage', start: '2400', end: '2100', change: '-300' },
      { code: 'checking', name: 'Checking', start: '800', end: '700', change: '-100' },
    ]);
  });

  test('a holding missing on the first or last day counts as zero there', () => {
    const sol = result.topMovers.find((mover) => mover.holdingId === 'new');
    expect(sol).toEqual({
      holdingId: 'new',
      symbol: 'SOL',
      accountName: 'SOL account',
      start: '0',
      end: '250',
      change: '250',
    });
    const aapl = result.topMovers.find((mover) => mover.holdingId === 'sold');
    expect(aapl).toEqual({
      holdingId: 'sold',
      symbol: 'AAPL',
      accountName: 'AAPL account',
      start: '400',
      end: '0',
      change: '-400',
    });
  });

  // Ranked by the size of the change; on a tie the gain comes first.
  test('top movers rank by the size of the money change, up or down', () => {
    expect(result.topMovers.map((mover) => mover.symbol)).toEqual([
      'AAPL',
      'BTC',
      'SOL',
      'VWRL',
      'GBP',
    ]);
  });

  test('top PnL ranks by the change in realized plus unrealized', () => {
    expect(result.topPnl.map((entry) => [entry.symbol, entry.total])).toEqual([
      ['BTC', '300'],
      ['VWRL', '100'],
      ['AAPL', '-100'],
      ['ETH', '-50'],
      ['SOL', '25'],
    ]);
    expect(result.topPnl[0]).toEqual({
      holdingId: 'btc',
      symbol: 'BTC',
      accountName: 'BTC account',
      realized: '0',
      unrealized: '300',
      total: '300',
    });
  });

  test('a holding that did not move is not a mover, and zero PnL is not a top PnL', () => {
    const flat = periodBreakdown(
      [row('2026-09-10', 'gbp', 800), row('2026-10-10', 'gbp', 800)],
      HOLDINGS
    );
    expect(flat.topMovers).toEqual([]);
    expect(flat.topPnl).toEqual([]);
  });

  test('a holding with unknown PnL on either day is left out of top PnL, not counted as zero', () => {
    const unknown = periodBreakdown(
      [row('2026-09-10', 'btc', 1000, null, null), row('2026-10-10', 'btc', 1200, 0, 400)],
      HOLDINGS
    );
    expect(unknown.topPnl).toEqual([]);
    expect(unknown.topMovers).toHaveLength(1);
  });

  test('a holding with no account type lands in an "other" part rather than vanishing', () => {
    const orphan = periodBreakdown(
      [row('2026-09-10', 'ghost', 100), row('2026-10-10', 'ghost', 160)],
      new Map()
    );
    expect(orphan.byAccountType).toEqual([
      { code: null, name: null, start: '100', end: '160', change: '60' },
    ]);
    expect(orphan.topMovers[0]?.symbol).toBeNull();
    expect(orphan.topMovers[0]?.accountName).toBeNull();
  });

  test('no rows is an empty breakdown with no dates', () => {
    expect(periodBreakdown([], HOLDINGS)).toEqual({
      startDate: null,
      endDate: null,
      total: { start: '0', end: '0', change: '0' },
      byAccountType: [],
      topMovers: [],
      topPnl: [],
    });
  });
});
