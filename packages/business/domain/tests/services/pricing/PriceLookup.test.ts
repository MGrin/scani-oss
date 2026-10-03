import { describe, expect, test } from 'bun:test';
import type { TokenPrice, TokenPriceGranularity } from '@scani/db/schema';
import { PriceLookup } from '../../../src/services/pricing/PriceLookup';

// SC-1543. A daily-preferring read took the latest `daily` row at or before
// T even when a newer reading existed. The hourly job writes `intraday`
// rows and the downsampler makes `daily` ones only once a day is 8 days
// old, so every read of the last week answered with a week-old price.

const TOKEN = 'token';
const BASE = 'base';

function reading(price: string, at: string, granularity: TokenPriceGranularity): TokenPrice {
  return {
    id: `${at}|${granularity}`,
    tokenId: TOKEN,
    baseTokenId: BASE,
    price,
    timestamp: new Date(at),
    source: 'test',
    granularity,
    createdAt: new Date(at),
  };
}

const CLOSE_OF_OCT_1 = new Date('2026-10-01T23:59:59.999Z');

function priceAt(
  rows: TokenPrice[],
  at: Date,
  prefer: TokenPriceGranularity | null
): string | undefined {
  return new PriceLookup(rows).findClosestByGranularity(TOKEN, BASE, at, prefer)?.price;
}

describe('PriceLookup.findClosestByGranularity', () => {
  test('a nearer reading beats an older row of the preferred granularity', () => {
    const rows = [
      reading('100', '2026-09-25T00:00:00Z', 'daily'),
      reading('110', '2026-10-01T23:00:00Z', 'intraday'),
    ];
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'daily')).toBe('110');
  });

  test('at one instant the preferred granularity wins', () => {
    const rows = [
      reading('101', '2026-10-01T00:00:00Z', 'intraday'),
      reading('100', '2026-10-01T00:00:00Z', 'daily'),
    ];
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'daily')).toBe('100');
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'intraday')).toBe('101');
  });

  test('a nearer row of the preferred granularity still wins', () => {
    const rows = [
      reading('110', '2026-10-01T23:00:00Z', 'intraday'),
      reading('120', '2026-10-01T23:59:00Z', 'daily'),
    ];
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'daily')).toBe('120');
  });

  test('a reading after T is never read', () => {
    const rows = [
      reading('100', '2026-09-25T00:00:00Z', 'daily'),
      reading('130', '2026-10-02T10:00:00Z', 'intraday'),
    ];
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'daily')).toBe('100');
  });

  test('daily rows only, as past the downsample window: the latest daily row (control)', () => {
    const rows = [
      reading('90', '2026-09-20T00:00:00Z', 'daily'),
      reading('95', '2026-09-21T00:00:00Z', 'daily'),
    ];
    expect(priceAt(rows, new Date('2026-09-21T23:59:59.999Z'), 'daily')).toBe('95');
    expect(priceAt(rows, new Date('2026-09-20T23:59:59.999Z'), 'daily')).toBe('90');
  });

  test('no preference: the nearest reading (control)', () => {
    const rows = [
      reading('100', '2026-09-25T00:00:00Z', 'daily'),
      reading('110', '2026-10-01T23:00:00Z', 'intraday'),
    ];
    expect(priceAt(rows, CLOSE_OF_OCT_1, null)).toBe('110');
  });

  test('nothing at or before T answers null', () => {
    const rows = [reading('130', '2026-10-02T10:00:00Z', 'intraday')];
    expect(priceAt(rows, CLOSE_OF_OCT_1, 'daily')).toBeUndefined();
  });
});
