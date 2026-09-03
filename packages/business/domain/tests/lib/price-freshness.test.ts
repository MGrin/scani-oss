import { describe, expect, test } from 'bun:test';
import { MAX_DAILY_PRICE_AGE_MS, MAX_INTRADAY_PRICE_AGE_MS } from '../../src/lib/constants';
import { isPriceStale } from '../../src/lib/price-freshness';

const at = new Date('2026-09-03T12:00:00.000Z');
const ago = (ms: number) => new Date(at.getTime() - ms);

describe('isPriceStale', () => {
  test('an intraday price inside its window is not stale', () => {
    expect(isPriceStale(ago(MAX_INTRADAY_PRICE_AGE_MS), at, 'intraday')).toBe(false);
  });

  test('an intraday price one millisecond past its window is stale', () => {
    expect(isPriceStale(ago(MAX_INTRADAY_PRICE_AGE_MS + 1), at, 'intraday')).toBe(true);
  });

  test('a daily price is held to the wider window, not the intraday one', () => {
    // The whole reason the two constants exist: a thin pair's weekly close is
    // legitimately older than the intraday cap and must not be flagged.
    const age = MAX_INTRADAY_PRICE_AGE_MS + 1;
    expect(isPriceStale(ago(age), at, 'intraday')).toBe(true);
    expect(isPriceStale(ago(age), at, 'daily')).toBe(false);
  });

  test('a daily price past the wider window is stale', () => {
    expect(isPriceStale(ago(MAX_DAILY_PRICE_AGE_MS + 1), at, 'daily')).toBe(true);
  });

  test('an unknown granularity gets the tighter cap, not the looser one', () => {
    // A rate the price graph derived carries no `token_prices` granularity.
    // Erring toward the tighter window makes an unknown say "old" rather than
    // say nothing, which is the direction that reaches a reader.
    const age = MAX_INTRADAY_PRICE_AGE_MS + 1;
    expect(isPriceStale(ago(age), at, null)).toBe(true);
    expect(isPriceStale(ago(age), at, undefined)).toBe(true);
  });

  test('a price from after the instant asked about is not stale', () => {
    expect(isPriceStale(new Date(at.getTime() + 1000), at, 'intraday')).toBe(false);
  });
});
