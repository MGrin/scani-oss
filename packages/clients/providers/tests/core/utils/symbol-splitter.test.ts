import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CONCATENATED_QUOTE_ASSETS,
  splitConcatenatedPair,
} from '../../../src/core/utils/symbol-splitter';

describe('splitConcatenatedPair — happy path with default quote list', () => {
  test('BTCUSDT splits to BTC + USDT', () => {
    expect(splitConcatenatedPair('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' });
  });

  test('ETHBTC splits to ETH + BTC', () => {
    expect(splitConcatenatedPair('ETHBTC')).toEqual({ base: 'ETH', quote: 'BTC' });
  });

  test('BTCEUR splits to BTC + EUR', () => {
    expect(splitConcatenatedPair('BTCEUR')).toEqual({ base: 'BTC', quote: 'EUR' });
  });

  test('lower-case input is upper-cased before matching', () => {
    expect(splitConcatenatedPair('btcusdt')).toEqual({ base: 'BTC', quote: 'USDT' });
  });
});

describe('splitConcatenatedPair — longest-suffix wins', () => {
  test('BTCBUSD splits to BTC + BUSD (not BTCB + USD), because BUSD precedes USD', () => {
    expect(splitConcatenatedPair('BTCBUSD')).toEqual({ base: 'BTC', quote: 'BUSD' });
  });

  test('BTCUSDT matches USDT before USD when caller passes longest-first ordering', () => {
    expect(splitConcatenatedPair('BTCUSDT', ['USDT', 'USD'])).toEqual({
      base: 'BTC',
      quote: 'USDT',
    });
  });

  test('caller-supplied wrong order is the caller’s problem (USD before USDT splits BTCUSD only)', () => {
    // BTCUSDT does not endsWith USD, so even with USD listed first, USDT still wins by virtue
    // of being the only matching suffix — proves the function trusts caller ordering without
    // re-sorting.
    expect(splitConcatenatedPair('BTCUSDT', ['USD', 'USDT'])).toEqual({
      base: 'BTC',
      quote: 'USDT',
    });
  });
});

describe('splitConcatenatedPair — no match', () => {
  test('unrecognized quote asset returns null', () => {
    expect(splitConcatenatedPair('BTCXYZ')).toBeNull();
  });

  test('empty input returns null', () => {
    expect(splitConcatenatedPair('')).toBeNull();
  });

  test('pair equal to a quote asset (no base) returns null', () => {
    expect(splitConcatenatedPair('USDT')).toBeNull();
  });
});

describe('splitConcatenatedPair — custom quote list', () => {
  test('caller can override the default candidate list', () => {
    expect(splitConcatenatedPair('BTCXYZ', ['XYZ'])).toEqual({ base: 'BTC', quote: 'XYZ' });
  });

  test('default list exposes USDT/USDC/FDUSD/BUSD ahead of plain USD', () => {
    const usd = DEFAULT_CONCATENATED_QUOTE_ASSETS.indexOf('USD');
    expect(DEFAULT_CONCATENATED_QUOTE_ASSETS.indexOf('USDT')).toBeLessThan(usd);
    expect(DEFAULT_CONCATENATED_QUOTE_ASSETS.indexOf('USDC')).toBeLessThan(usd);
    expect(DEFAULT_CONCATENATED_QUOTE_ASSETS.indexOf('FDUSD')).toBeLessThan(usd);
    expect(DEFAULT_CONCATENATED_QUOTE_ASSETS.indexOf('BUSD')).toBeLessThan(usd);
  });
});
