import { describe, expect, test } from 'bun:test';
import { assetCurrencyOf } from '../../../src/lib/returns/asset-currency';

/**
 * SC-458 — which currency an asset's price is set in.
 *
 * Every row below is a shape that exists in the production `tokens` table,
 * read 2026-08-20. That matters more than the coverage: the reason this
 * consults BOTH `market_segment` and the symbol suffix is that production
 * holds `XEQT` with a segment and no suffix, and `1796.HK` / `SPCX.TO` /
 * `SPCX.VI` with a suffix and no segment. A rule built from either column
 * alone gets four of production's eighteen equities wrong.
 */

function token(typeCode: string | null, symbol: string, marketSegment: string | null = null) {
  return { typeCode, symbol, marketSegment };
}

describe('assetCurrencyOf — fiat is its own currency', () => {
  test('a currency holding is quoted in itself', () => {
    // The whole ticket in one row: a GBP balance never changes in GBP, so
    // every penny a USD-based holder "makes" on it is the exchange rate.
    expect(assetCurrencyOf(token('fiat', 'GBP'))).toEqual({ kind: 'self' });
    expect(assetCurrencyOf(token('fiat', 'USD'))).toEqual({ kind: 'self' });
  });
});

describe('assetCurrencyOf — crypto is quoted in USD, as a stated choice', () => {
  test('a coin carries USD exposure for anyone not based in USD', () => {
    expect(assetCurrencyOf(token('crypto', 'BTC'))).toEqual({ kind: 'fiat', symbol: 'USD' });
  });

  test('a dollar stablecoin comes out as pure currency exposure for free', () => {
    expect(assetCurrencyOf(token('crypto', 'USDC'))).toEqual({ kind: 'fiat', symbol: 'USD' });
  });

  test("a crypto row's market_segment is an EVM contract and is never read as a venue", () => {
    // 60 of production's 92 crypto tokens carry `evm:<chain>:<address>` in
    // that column. Reading it the way an equity's segment is read would map
    // an ERC-20 to whatever currency its chain id happened to spell.
    expect(
      assetCurrencyOf(token('crypto', 'USDC', 'evm:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'))
    ).toEqual({ kind: 'fiat', symbol: 'USD' });
  });
});

describe('assetCurrencyOf — an equity is quoted where it is listed', () => {
  test('the market segment is read first', () => {
    expect(assetCurrencyOf(token('stock', 'XEQT', 'TO'))).toEqual({
      kind: 'fiat',
      symbol: 'CAD',
    });
    expect(assetCurrencyOf(token('stock', 'AAPL', 'US'))).toEqual({
      kind: 'fiat',
      symbol: 'USD',
    });
  });

  test('the symbol suffix answers when the segment was never set', () => {
    expect(assetCurrencyOf(token('stock', '1796.HK'))).toEqual({ kind: 'fiat', symbol: 'HKD' });
    expect(assetCurrencyOf(token('stock', 'SPCX.TO'))).toEqual({ kind: 'fiat', symbol: 'CAD' });
  });

  test('a plain ticker with neither is the ordinary US listing', () => {
    expect(assetCurrencyOf(token('stock', 'SPCX'))).toEqual({ kind: 'fiat', symbol: 'USD' });
  });

  test('a venue suffix the shared map does not carry is unknown, not USD', () => {
    // `SPCX.VI` is in production and `.VI` (Vienna) is absent from
    // `NON_US_EXCHANGE_SUFFIX_MAP`. Calling it a dollar asset would print a
    // real EUR movement as performance; saying nothing costs the split for
    // that holding and nothing else.
    expect(assetCurrencyOf(token('stock', 'SPCX.VI'))).toEqual({ kind: 'unknown' });
  });

  test('a one-letter suffix is a US share class, not a venue', () => {
    expect(assetCurrencyOf(token('stock', 'BRK.A'))).toEqual({ kind: 'fiat', symbol: 'USD' });
    expect(assetCurrencyOf(token('stock', 'BF.B'))).toEqual({ kind: 'fiat', symbol: 'USD' });
  });

  test('a segment we do not recognise is UNKNOWN, deliberately not USD', () => {
    // The one case where guessing is most likely to be wrong is the one a
    // default would silently cover, and a wrong currency here reports a real
    // rate movement as skill.
    expect(assetCurrencyOf(token('stock', 'FOO', 'ZZ'))).toEqual({ kind: 'unknown' });
  });

  test('an unrecognised segment still yields to a suffix that does say', () => {
    expect(assetCurrencyOf(token('stock', 'FOO.L', 'ZZ'))).toEqual({
      kind: 'fiat',
      symbol: 'GBP',
    });
  });
});

describe('assetCurrencyOf — everything else is unknown rather than assumed', () => {
  test('a private valuation says nothing about its currency', () => {
    expect(assetCurrencyOf(token('private-company', 'ACME'))).toEqual({ kind: 'unknown' });
    expect(assetCurrencyOf(token('other', 'THING'))).toEqual({ kind: 'unknown' });
  });

  test('a token whose type could not be joined is unknown, not defaulted', () => {
    expect(assetCurrencyOf(token(null, 'MYSTERY'))).toEqual({ kind: 'unknown' });
  });
});
