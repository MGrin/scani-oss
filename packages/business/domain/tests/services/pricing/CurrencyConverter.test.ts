process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { TokenPriceGranularity } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import {
  CurrencyConverter,
  type CurrencyRef,
} from '../../../src/services/pricing/CurrencyConverter';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface Edge {
  tokenId: string;
  baseTokenId: string;
  price: string;
  timestamp: Date;
}

function makeTokenPriceStub(edges: Edge[]): TokenPriceRepository {
  return {
    findClosestPriceByGranularity: async (
      tokenId: string,
      baseTokenId: string,
      timestamp: Date,
      _prefer: TokenPriceGranularity | null
    ) => {
      const match = edges
        .filter(
          (e) =>
            e.tokenId === tokenId &&
            e.baseTokenId === baseTokenId &&
            e.timestamp.getTime() <= timestamp.getTime()
        )
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
      if (!match) return null;
      return {
        ...match,
        id: 'x',
        source: 's',
        granularity: 'daily',
        createdAt: new Date(),
      } as never;
    },
  } as unknown as TokenPriceRepository;
}

/**
 * Serves exactly one caller now: `PriceGraphService.resolveHubTokenIds`, which
 * addresses each hub by `(symbol, type, market segment)` since SC-315. The
 * converter itself no longer looks a currency up by any of them — `never
 * resolves a currency by symbol` below holds it to that.
 *
 * Hubs are typed here the way production types them: `USDT` is a crypto
 * stablecoin, every other hub symbol is fiat.
 */
function makeTokenStub(bySymbol: Record<string, string>): TokenRepository {
  const typeOf = (symbol: string): string => (symbol === 'USDT' ? 'crypto' : 'fiat');
  const row = (symbol: string, id: string): unknown => ({
    id,
    symbol,
    typeId: typeOf(symbol),
    marketSegment: null,
  });
  return {
    findBySymbol: async (symbol: string) => {
      const id = bySymbol[symbol];
      return id ? (row(symbol, id) as never) : null;
    },
    findBySymbolAndType: async (symbol: string, typeId: string) => {
      const id = bySymbol[symbol];
      return id && typeOf(symbol) === typeId ? (row(symbol, id) as never) : null;
    },
    findByIdentityTuple: async (symbol: string, typeId: string, marketSegment: string | null) => {
      const id = bySymbol[symbol];
      return id && typeOf(symbol) === typeId && marketSegment === null
        ? (row(symbol, id) as never)
        : null;
    },
  } as unknown as TokenRepository;
}

function makeTokenTypeStub(): TokenTypeRepository {
  return {
    findByCode: async (code: string) => ({ id: code, code, name: code }) as never,
  } as unknown as TokenTypeRepository;
}

/** A `CurrencyRef` for a symbol in the test's id map. */
function ref(symbols: Record<string, string>, symbol: string): CurrencyRef {
  const id = symbols[symbol];
  if (!id) throw new Error(`test bug: no id for ${symbol}`);
  return { id, symbol };
}

function makeConverter(edges: Edge[], symbols: Record<string, string>): CurrencyConverter {
  Container.set(TokenPriceRepository, makeTokenPriceStub(edges));
  Container.set(TokenRepository, makeTokenStub(symbols));
  Container.set(TokenTypeRepository, makeTokenTypeStub());
  Container.set(PriceGraphService, new PriceGraphService());
  const instance = new CurrencyConverter();
  Container.set(CurrencyConverter, instance);
  return instance;
}

describe('CurrencyConverter.getRate — DB lookup via PriceGraphService', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', GBP: 'tok-GBP', USDT: 'tok-USDT' };

  test('identity returns 1 for same currency', async () => {
    const c = makeConverter([], SYMBOLS);
    expect(await c.getRate(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'USD'), new Date(), true)).toBe('1');
  });

  test('resolves the reverse direction that forex-backfill actually stores', async () => {
    // forex-backfill stores `(EUR -> USD = 1.08)` — never the reverse.
    // The old `findLatestPrice(USD, EUR)` lookup always missed and forced
    // a live exchangerate-api call. This is the regression test for that
    // failure mode: cacheOnly=true must succeed off the DB alone.
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const rate = await c.getRate(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'EUR'), at, true);
    expect(rate).not.toBeNull();
    // 1 / 1.08 ≈ 0.9259…
    expect(Number(rate)).toBeCloseTo(0.9259, 4);
  });

  test('cross-fiat routing via the USD hub', async () => {
    // EUR -> GBP has no direct edge; both legs live as `(X -> USD)`.
    // Must hop via USD: (EUR -> USD = 1.08) inverted on the second leg
    // (GBP -> USD = 1.27) → EUR/GBP = 1.08 / 1.27 ≈ 0.8504.
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
        {
          tokenId: SYMBOLS.GBP,
          baseTokenId: SYMBOLS.USD,
          price: '1.27',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const rate = await c.getRate(ref(SYMBOLS, 'EUR'), ref(SYMBOLS, 'GBP'), at, true);
    expect(rate).not.toBeNull();
    expect(Number(rate)).toBeCloseTo(0.8504, 4);
  });

  test('returns null when DB has no path and cacheOnly=true (no live API)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter([], SYMBOLS);
    expect(await c.getRate(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'EUR'), at, true)).toBeNull();
  });

  test('returns null when the only DB rate is older than 24h (forces live refresh)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          // 2 days old → past the 24h freshness ceiling.
          timestamp: new Date('2024-06-13T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    expect(await c.getRate(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'EUR'), at, true)).toBeNull();
  });
});

describe('CurrencyConverter.getRateDetail', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', USDT: 'tok-USDT' };

  // The UI prints converted totals and has to be able to say how old the
  // rate behind one is; without the edge's own timestamp it could only
  // claim "today's rates" and hope.
  test('carries the timestamp of the edge the rate came from', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const effectiveAt = new Date('2024-06-15T03:30:00Z');
    const c = makeConverter(
      [{ tokenId: SYMBOLS.EUR, baseTokenId: SYMBOLS.USD, price: '1.08', timestamp: effectiveAt }],
      SYMBOLS
    );
    const detail = await c.getRateDetail(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'EUR'), at, true);
    expect(detail).not.toBeNull();
    expect(detail?.asOf.toISOString()).toBe(effectiveAt.toISOString());
  });

  test('an unresolvable pair is null, not a confident rate', async () => {
    const c = makeConverter([], SYMBOLS);
    expect(
      await c.getRateDetail(
        ref(SYMBOLS, 'USD'),
        ref(SYMBOLS, 'EUR'),
        new Date('2024-06-15T12:00:00Z'),
        true
      )
    ).toBeNull();
  });
});

describe('CurrencyConverter.convert', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', USDT: 'tok-USDT' };

  test('converts via reverse-direction DB rate (the regression case)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    // $100 worth of holdings, user just switched to EUR.
    const converted = await c.convert('100', ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'EUR'), at, true);
    expect(converted).not.toBeNull();
    expect(Number(converted)).toBeCloseTo(92.59, 2);
  });

  test('converts USDT to EUR via USD hub', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.USDT,
          baseTokenId: SYMBOLS.USD,
          price: '1.00',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const converted = await c.convert('1000', ref(SYMBOLS, 'USDT'), ref(SYMBOLS, 'EUR'), at, true);
    expect(converted).not.toBeNull();
    // 1000 USDT × 1.00 USD/USDT × (1 / 1.08) EUR/USD ≈ 925.93 EUR
    expect(Number(converted)).toBeCloseTo(925.93, 2);
  });
});

/**
 * The read path (SC-222).
 *
 * mgrin opened Money and watched a skeleton for twenty seconds. Measured
 * against production: 78–180 ms with the converter's memory cache warm,
 * **7.2 s** once that cache expired, **26 s** for three pairs with nothing
 * stored. The difference is a live exchangerate-api call behind an outflow
 * limiter of two requests per sixty seconds whose acquire *sleeps* — correct
 * for a nightly job, catastrophic on a request a person is waiting behind.
 *
 * `getStoredRateDetail` is the promise that never happens on a read. These
 * tests hold it to two things: it does not fetch, and it does not refuse a
 * rate for being old, because the alternative to an old rate here is no
 * figure at all.
 */
describe('CurrencyConverter.getStoredRateDetail — the user read path', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', IDR: 'tok-IDR' };
  const NOW = new Date('2024-06-15T12:00:00Z');

  /** Fails the test rather than the request: any upstream call from a read
   *  path is the bug, and a stub that throws says so at the point of the call
   *  instead of leaving a 26-second timing to be noticed in production. */
  function forbidUpstream(converter: CurrencyConverter): void {
    (converter as unknown as { exchangeRateFetch: () => Promise<Response> }).exchangeRateFetch =
      () => {
        throw new Error('a user read path must never call exchangerate-api');
      };
  }

  test('serves a stored rate without going upstream', async () => {
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    forbidUpstream(c);

    const detail = await c.getStoredRateDetail(ref(SYMBOLS, 'EUR'), ref(SYMBOLS, 'USD'), NOW);
    expect(detail?.rate).toBe('1.08');
    expect(detail?.asOf.toISOString()).toBe('2024-06-15T03:30:00.000Z');
  });

  /**
   * The daily hole this closes. forex-backfill writes rows timestamped at
   * midnight and runs at 03:30, so a row is past `DB_RATE_MAX_AGE_MS` for the
   * three and a half hours between the two — and EUR->USD was measured at
   * **31.3 hours** old in production, a missed night on top of that. Under the
   * old rule every one of those reads paid the upstream call.
   */
  test('an old stored rate is served and dated, not refused', async () => {
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          // 31.3 hours before `NOW` — the real EUR->USD age on 2026-08-15.
          timestamp: new Date('2024-06-14T04:42:00Z'),
        },
      ],
      SYMBOLS
    );
    forbidUpstream(c);

    const detail = await c.getStoredRateDetail(ref(SYMBOLS, 'EUR'), ref(SYMBOLS, 'USD'), NOW);
    expect(detail?.rate).toBe('1.08');
    // Dated honestly: every surface that prints a converted figure reads this
    // and says "at rates from <date>" rather than presenting it as current.
    expect(detail?.asOf.toISOString()).toBe('2024-06-14T04:42:00.000Z');
  });

  test('a pair with nothing stored is null rather than a wait', async () => {
    // IDR had three price rows in its entire history while a user was billed
    // in it. Under the old read path that was a live call every time.
    const c = makeConverter([], SYMBOLS);
    forbidUpstream(c);

    expect(await c.getStoredRateDetail(ref(SYMBOLS, 'IDR'), ref(SYMBOLS, 'USD'), NOW)).toBeNull();
  });

  test('identity needs neither storage nor a fetch', async () => {
    const c = makeConverter([], SYMBOLS);
    forbidUpstream(c);
    expect((await c.getStoredRateDetail(ref(SYMBOLS, 'USD'), ref(SYMBOLS, 'USD'), NOW))?.rate).toBe(
      '1'
    );
  });

  /**
   * The two paths share a cache but not a freshness policy. Without this,
   * `getStoredRateDetail` warming the map with a deliberately old rate would
   * suppress the upstream refresh a valuation is entitled to — the read path
   * would quietly degrade every other caller.
   */
  test('a stale rate cached by a read is not reused by a valuation', async () => {
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-14T04:42:00Z'), // 31.3h old
        },
      ],
      SYMBOLS
    );

    // The read path caches it.
    expect((await c.getStoredRateDetail(ref(SYMBOLS, 'EUR'), ref(SYMBOLS, 'USD'), NOW))?.rate).toBe(
      '1.08'
    );

    // The valuation path must not take it: 31.3h is past its 24h tolerance,
    // and with `cacheOnly` it has nowhere else to go, so the honest answer is
    // null rather than a rate it would have refused from the database.
    expect(await c.getRate(ref(SYMBOLS, 'EUR'), ref(SYMBOLS, 'USD'), NOW, true)).toBeNull();
  });
});

/**
 * A ticker is not an identity (SC-223).
 *
 * `tokens` is unique on `(symbol, type_id, COALESCE(market_segment,''))`, and
 * eight symbols in production have more than one legitimate row. `SOS` is the
 * one that spans two token TYPES: the Somali shilling and a memecoin. The
 * converter used to take a symbol and call `findBySymbol`, whose tiebreak is
 * `asc(isScamProbability), desc(createdAt)` — so with both rows at scam
 * probability 0 the NEWER won, and a memecoin minted last month answered every
 * conversion asking for the currency.
 *
 * The signature is the fix: there is no longer a string to guess from. These
 * tests are what that buys — the same ticker, two ids, two different answers.
 */
describe('CurrencyConverter — a duplicated symbol addresses different price rows', () => {
  const NOW = new Date('2024-06-15T12:00:00Z');
  const EDGE_AT = new Date('2024-06-15T03:30:00Z');
  const FIAT_SOS = 'tok-SOS-fiat';
  const MEME_SOS = 'tok-SOS-memecoin';
  const USD = 'tok-USD';

  // Only the fiat row is priced. The memecoin row is the one `findBySymbol`
  // would have picked, and it has no edge at all.
  const EDGES: Edge[] = [
    { tokenId: FIAT_SOS, baseTokenId: USD, price: '0.00175', timestamp: EDGE_AT },
  ];
  // `SOS` deliberately maps to the memecoin here: this is the row the old
  // symbol lookup resolved, so anything that still resolves by symbol gets it.
  const HUB_SYMBOLS = { USD, SOS: MEME_SOS };

  const sosFiat: CurrencyRef = { id: FIAT_SOS, symbol: 'SOS' };
  const sosMeme: CurrencyRef = { id: MEME_SOS, symbol: 'SOS' };
  const usd: CurrencyRef = { id: USD, symbol: 'USD' };

  test('the fiat row resolves against its own price rows', async () => {
    const c = makeConverter(EDGES, HUB_SYMBOLS);
    expect(await c.getRate(sosFiat, usd, NOW, true)).toBe('0.00175');
  });

  test('the memecoin row of the same ticker resolves to nothing', async () => {
    const c = makeConverter(EDGES, HUB_SYMBOLS);
    expect(await c.getRate(sosMeme, usd, NOW, true)).toBeNull();
  });

  test('the two rows do not share a cache entry', async () => {
    const c = makeConverter(EDGES, HUB_SYMBOLS);
    // Deliberately `getStoredRateDetail`, which is the only entry point that
    // reads the cache with no maximum rate age. `getRate` would compare the
    // cached `asOf` against the real wall clock, and a fixture dated 2024 is
    // past every tolerance — so a symbol-keyed cache would be evicted before
    // it could be caught, and this test would pass by accident.
    expect((await c.getStoredRateDetail(sosFiat, usd, NOW))?.rate).toBe('0.00175');
    expect(await c.getStoredRateDetail(sosMeme, usd, NOW)).toBeNull();
  });

  test('two rows of one ticker are not the identity pair', async () => {
    const c = makeConverter(EDGES, HUB_SYMBOLS);
    // `from.symbol === to.symbol` was the old short-circuit and would return
    // '1' here, asserting that a shilling is worth a memecoin.
    expect(await c.convert('100', sosFiat, sosMeme, NOW, true)).toBeNull();
  });

  test('never resolves a currency by symbol', async () => {
    // Built by hand rather than via `makeConverter`: class-field DI captures
    // the repository at construction, so the throwing stub has to be in the
    // Container before `new PriceGraphService()` runs.
    Container.set(TokenPriceRepository, makeTokenPriceStub(EDGES));
    Container.set(TokenRepository, {
      findBySymbol: async () => {
        throw new Error('the converter must address a currency by id, not by symbol');
      },
    } as unknown as TokenRepository);
    Container.set(TokenTypeRepository, makeTokenTypeStub());
    Container.set(PriceGraphService, new PriceGraphService());
    const c = new CurrencyConverter();
    Container.set(CurrencyConverter, c);

    // A direct edge, so PriceGraphService never reaches hub resolution —
    // which since SC-315 does not take a bare symbol either.
    expect(await c.getRate(sosFiat, usd, NOW, true)).toBe('0.00175');
  });
});
