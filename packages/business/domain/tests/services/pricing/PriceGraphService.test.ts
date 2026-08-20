process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { TokenPriceGranularity } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
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

function toRow(edge: Edge): unknown {
  return { ...edge, id: 'x', source: 's', granularity: 'daily', createdAt: new Date() };
}

function makeTokenPriceStub(edges: Edge[]): TokenPriceRepository {
  return {
    findManyForPairsUpTo: async (
      pairs: ReadonlyArray<{ tokenId: string; baseTokenId: string }>,
      until: Date
    ) => {
      const wanted = new Set(pairs.map((p) => `${p.tokenId}|${p.baseTokenId}`));
      return edges
        .filter(
          (e) =>
            wanted.has(`${e.tokenId}|${e.baseTokenId}`) && e.timestamp.getTime() <= until.getTime()
        )
        .map(toRow) as never;
    },
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

// A `tokens` row, reduced to the columns hub resolution reads. The
// stub below reproduces the repository's real selection semantics
// rather than a symbol→id map, because which row a symbol resolves to
// is the thing under test (SC-315).
interface TokenRow {
  id: string;
  symbol: string;
  typeId: 'fiat' | 'crypto';
  marketSegment?: string | null;
  isScamProbability?: number;
  createdAt?: Date;
}

function toToken(row: TokenRow): unknown {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.symbol,
    typeId: row.typeId,
    marketSegment: row.marketSegment ?? null,
    decimals: 2,
    isScamProbability: row.isScamProbability ?? 0,
    isActive: true,
    providerMetadata: '{}',
    iconUrl: null,
    createdAt: row.createdAt ?? new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  };
}

// `asc(isScamProbability), desc(createdAt)` — the repository's tiebreak,
// reproduced so a test can show what it picks when two rows qualify.
function tiebreak(rows: TokenRow[]): TokenRow | null {
  return (
    [...rows].sort(
      (a, b) =>
        (a.isScamProbability ?? 0) - (b.isScamProbability ?? 0) ||
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    )[0] ?? null
  );
}

function makeTokenStub(rows: TokenRow[]): TokenRepository {
  return {
    findBySymbol: async (symbol: string) => {
      const match = tiebreak(rows.filter((r) => r.symbol === symbol.toUpperCase()));
      return match ? (toToken(match) as never) : null;
    },
    findBySymbolAndType: async (symbol: string, typeId: string) => {
      const match = tiebreak(
        rows.filter((r) => r.symbol === symbol.toUpperCase() && r.typeId === typeId)
      );
      return match ? (toToken(match) as never) : null;
    },
    // `(symbol, type_id, COALESCE(market_segment,''))` is unique, so this
    // has no tiebreak to apply — at most one row can match.
    findByIdentityTuple: async (symbol: string, typeId: string, marketSegment: string | null) => {
      const match = rows.find(
        (r) =>
          r.symbol === symbol.toUpperCase() &&
          r.typeId === typeId &&
          (r.marketSegment ?? null) === marketSegment
      );
      return match ? (toToken(match) as never) : null;
    },
  } as unknown as TokenRepository;
}

function makeTokenTypeStub(): TokenTypeRepository {
  return {
    findByCode: async (code: string) => ({ id: code, code, name: code }) as never,
  } as unknown as TokenTypeRepository;
}

const HUB_IDS = { USD: 'token-USD', USDT: 'token-USDT', EUR: 'token-EUR' };

// The three canonical hub rows: fiat USD/EUR and crypto USDT, all
// un-segmented, which is the shape every migrated database has.
const HUB_ROWS: TokenRow[] = [
  { id: HUB_IDS.USD, symbol: 'USD', typeId: 'fiat' },
  { id: HUB_IDS.EUR, symbol: 'EUR', typeId: 'fiat' },
  { id: HUB_IDS.USDT, symbol: 'USDT', typeId: 'crypto' },
];

// Same DI pattern as BalanceAtTimeService.test — seed stubs, then
// construct a fresh instance so class-field `Container.get()` calls
// in PriceGraphService's constructor see our stubs. See the detailed
// note in BalanceAtTimeService.test about why we don't reset / remove.
function makePriceGraphService(
  tpStub: TokenPriceRepository,
  tokStub: TokenRepository
): PriceGraphService {
  Container.set(TokenPriceRepository, tpStub);
  Container.set(TokenRepository, tokStub);
  Container.set(TokenTypeRepository, makeTokenTypeStub());
  const instance = new PriceGraphService();
  Container.set(PriceGraphService, instance);
  return instance;
}

describe('PriceGraphService.convert', () => {
  test('identity when from == to', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('7.5', 'same', 'same', new Date());
    expect(r?.amount.toString()).toBe('7.5');
    expect(r?.rate.toString()).toBe('1');
    expect(r?.path).toBe('identity');
  });

  test('direct edge: applies rate and reports effectiveAt', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert(new Decimal('2'), 'BTC', 'USD', at);
    expect(r?.amount.toString()).toBe('130000');
    expect(r?.path).toBe('direct');
    expect(r?.effectiveAt.toISOString()).toBe('2024-05-30T00:00:00.000Z');
  });

  test('reverse direct: inverts price when only to->from edge exists', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        // Only USD->BTC stored (price "USD per BTC" inversion), value = 0.00001538 BTC per USD
        {
          tokenId: 'USD',
          baseTokenId: 'BTC',
          price: '0.0000153846',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert(new Decimal('1'), 'BTC', 'USD', at);
    // 1 / 0.0000153846 ≈ 65000.195…
    expect(r?.amount.toNumber()).toBeCloseTo(65000, 0);
    expect(r?.path).toBe('direct');
  });

  test('one-hop via USD hub when no direct edge', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    // BTC -> USD (65000), USD -> EUR (0.92). Request BTC->EUR must chain.
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'token-USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
        {
          tokenId: 'token-USD',
          baseTokenId: 'EUR',
          price: '0.92',
          timestamp: new Date('2024-05-28T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert('1', 'BTC', 'EUR', at);
    expect(r?.amount.toNumber()).toBeCloseTo(59800, 1);
    expect(r?.path).toBe('one-hop-token-USD');
    // effectiveAt is the older of the two legs — the weakest link.
    expect(r?.effectiveAt.toISOString()).toBe('2024-05-28T00:00:00.000Z');
  });

  test('returns null when no path exists at maxDepth=1', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'token-USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert('1', 'BTC', 'EUR', new Date('2024-06-01T00:00:00Z'), {
      maxDepth: 1,
    });
    expect(r).toBeNull();
  });

  test('returns null when no edge whatsoever', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('1', 'BTC', 'EUR', new Date('2024-06-01T00:00:00Z'));
    expect(r).toBeNull();
  });

  test('zero-price reverse edge is treated as unpriceable', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'USD',
          baseTokenId: 'BTC',
          price: '0',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert('1', 'BTC', 'USD', new Date('2024-06-01T00:00:00Z'));
    expect(r).toBeNull();
  });
});

describe('PriceGraphService.convert — staleness', () => {
  const AT = new Date('2024-06-01T00:00:00Z');
  // Caps: intraday 7d, daily 45d. Pick edge dates relative to AT.
  const FRESH = new Date('2024-05-28T00:00:00Z'); // 4 days old
  const MID = new Date('2024-05-20T00:00:00Z'); // 12 days old
  const ANCIENT = new Date('2024-04-02T00:00:00Z'); // 60 days old

  function btcUsd(timestamp: Date): Edge {
    return { tokenId: 'BTC', baseTokenId: 'USD', price: '65000', timestamp };
  }

  test('identity conversion is never stale', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('1', 'same', 'same', AT);
    expect(r?.stale).toBe(false);
  });

  test('a fresh price (within the intraday cap) is not stale', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([btcUsd(FRESH)]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('1', 'BTC', 'USD', AT);
    expect(r?.stale).toBe(false);
  });

  test('a price past the 7-day intraday cap is flagged stale', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([btcUsd(MID)]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('1', 'BTC', 'USD', AT);
    expect(r?.amount.toString()).toBe('65000');
    expect(r?.stale).toBe(true);
  });

  test('the wider 45-day daily cap tolerates a mid-age daily price', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([btcUsd(MID)]), makeTokenStub(HUB_ROWS));
    const r = await svc.convert('1', 'BTC', 'USD', AT, { preferGranularity: 'daily' });
    expect(r?.stale).toBe(false);
  });

  test('a price past the 45-day daily cap is flagged stale even for daily', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([btcUsd(ANCIENT)]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert('1', 'BTC', 'USD', AT, { preferGranularity: 'daily' });
    expect(r?.stale).toBe(true);
  });

  test('one-hop staleness binds on the oldest leg', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        { tokenId: 'BTC', baseTokenId: 'token-USD', price: '65000', timestamp: FRESH },
        { tokenId: 'token-USD', baseTokenId: 'EUR', price: '0.92', timestamp: ANCIENT },
      ]),
      makeTokenStub(HUB_ROWS)
    );
    const r = await svc.convert('1', 'BTC', 'EUR', AT);
    expect(r?.path).toBe('one-hop-token-USD');
    expect(r?.stale).toBe(true);
  });
});

// SC-315. A hub is a `tokens` row and a symbol cannot address one:
// `USDT` has two rows in production, both crypto, and `findBySymbol`
// tie-breaks `asc(isScamProbability), desc(createdAt)`. The row that
// carries the price edges is the canonical un-segmented one (migration
// 0007 merged the chain-spread duplicates into it); the row the tiebreak
// prefers is whichever was created last. Picking the wrong one does not
// fail — it takes the entire USDT lane out of service silently.
describe('PriceGraphService hub resolution', () => {
  const AT = new Date('2024-06-01T00:00:00Z');
  const EDGE_AT = new Date('2024-05-30T00:00:00Z');

  // The canonical USDT (un-segmented, older) carries both legs. The
  // newer chain-flavoured row carries nothing — exactly the production
  // shape, since 0007 moved every price onto the canonical row.
  const USDT_ROWS: TokenRow[] = [
    ...HUB_ROWS,
    {
      id: 'token-USDT-base-chain',
      symbol: 'USDT',
      typeId: 'crypto',
      marketSegment: 'evm:8453:0xdead',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
  ];

  const USDT_LEGS: Edge[] = [
    { tokenId: 'ARB', baseTokenId: HUB_IDS.USDT, price: '1.2', timestamp: EDGE_AT },
    { tokenId: HUB_IDS.USDT, baseTokenId: 'THB', price: '36', timestamp: EDGE_AT },
  ];

  test('the USDT hub is the canonical row, not the newest row with that symbol', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(USDT_ROWS));
    expect(await svc.resolveHubTokenIds()).toEqual([HUB_IDS.USD, HUB_IDS.USDT, HUB_IDS.EUR]);
  });

  test('a one-hop route through USDT survives a newer, edgeless USDT row', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub(USDT_LEGS), makeTokenStub(USDT_ROWS));
    const r = await svc.convert('10', 'ARB', 'THB', AT);
    // Resolving USDT to `token-USDT-base-chain` finds neither leg and
    // returns null here — a dead lane reported as an unpriceable pair.
    expect(r?.path).toBe(`one-hop-${HUB_IDS.USDT}`);
    expect(r?.amount.toString()).toBe('432');
  });

  test('the tiebreak would in fact have chosen the edgeless row', async () => {
    // Guards the test above from passing for the wrong reason: if the
    // fixture stopped being ambiguous, it would prove nothing.
    const tok = makeTokenStub(USDT_ROWS);
    expect((await tok.findBySymbol('USDT'))?.id).toBe('token-USDT-base-chain');
    expect((await tok.findBySymbolAndType('USDT', 'crypto'))?.id).toBe('token-USDT-base-chain');
  });

  test('a memecoin sharing a fiat hub symbol never becomes the hub', async () => {
    const rows: TokenRow[] = [
      ...HUB_ROWS,
      {
        id: 'token-USD-memecoin',
        symbol: 'USD',
        typeId: 'crypto',
        createdAt: new Date('2025-06-01T00:00:00Z'),
      },
    ];
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(rows));
    expect(await svc.resolveHubTokenIds()).toEqual([HUB_IDS.USD, HUB_IDS.USDT, HUB_IDS.EUR]);
  });

  test('the USDT hub is crypto — a fiat-scoped lookup would drop it', async () => {
    // The obvious fix for the memecoin case above is to resolve every
    // hub as fiat. USDT is a crypto stablecoin held as a hub on purpose,
    // so that fix silently deletes the lane crypto-quoted holdings reach
    // a fiat base through.
    const tok = makeTokenStub(HUB_ROWS);
    expect(await tok.findBySymbolAndType('USDT', 'fiat')).toBeNull();
    const svc = makePriceGraphService(makeTokenPriceStub([]), tok);
    expect(await svc.resolveHubTokenIds()).toContain(HUB_IDS.USDT);
  });

  test('an absent hub drops out of the list without taking the others with it', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([]),
      makeTokenStub(HUB_ROWS.filter((r) => r.symbol !== 'USDT'))
    );
    expect(await svc.resolveHubTokenIds()).toEqual([HUB_IDS.USD, HUB_IDS.EUR]);
  });

  test('a database with no canonical row falls back rather than losing the lane', async () => {
    const rows: TokenRow[] = [
      ...HUB_ROWS.filter((r) => r.symbol !== 'USDT'),
      {
        id: 'token-USDT-only-segmented',
        symbol: 'USDT',
        typeId: 'crypto',
        marketSegment: 'evm:1:0xbeef',
      },
    ];
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(rows));
    expect(await svc.resolveHubTokenIds()).toEqual([
      HUB_IDS.USD,
      'token-USDT-only-segmented',
      HUB_IDS.EUR,
    ]);
  });

  test('resolution is cached per hub, including hubs that resolve to nothing', async () => {
    // This runs on every convert() on the valuation hot path. A hub that
    // did not resolve used to be re-queried every single call, because
    // only a hit was cached.
    const tok = makeTokenStub(HUB_ROWS.filter((r) => r.symbol !== 'USDT'));
    let lookups = 0;
    const counting = {
      findByIdentityTuple: (...args: Parameters<TokenRepository['findByIdentityTuple']>) => {
        lookups += 1;
        return tok.findByIdentityTuple(...args);
      },
      findBySymbolAndType: (...args: Parameters<TokenRepository['findBySymbolAndType']>) => {
        lookups += 1;
        return tok.findBySymbolAndType(...args);
      },
    } as unknown as TokenRepository;

    const svc = makePriceGraphService(makeTokenPriceStub([]), counting);
    await svc.resolveHubTokenIds();
    const afterFirst = lookups;
    await svc.resolveHubTokenIds();
    await svc.resolveHubTokenIds();
    expect(afterFirst).toBeGreaterThan(0);
    expect(lookups).toBe(afterFirst);
  });
});

describe('PriceGraphService.buildPriceLookup (SC-471)', () => {
  const AT = new Date('2026-02-01T00:00:00Z');
  const EDGES: Edge[] = [
    {
      tokenId: 'token-BTC',
      baseTokenId: HUB_IDS.USD,
      price: '50000',
      timestamp: new Date('2026-01-15T00:00:00Z'),
    },
    {
      tokenId: HUB_IDS.EUR,
      baseTokenId: HUB_IDS.USD,
      price: '1.1',
      timestamp: new Date('2026-01-15T00:00:00Z'),
    },
    {
      tokenId: 'token-XRP',
      baseTokenId: HUB_IDS.USD,
      price: '3',
      timestamp: new Date('2026-01-15T00:00:00Z'),
    },
  ];

  // Counts the two shapes of read separately: the prefetch exists to turn N
  // of the second into one of the first.
  function makeCountingStub(edges: Edge[]): {
    repo: TokenPriceRepository;
    counts: { prefetch: number; perCall: number };
  } {
    const inner = makeTokenPriceStub(edges);
    const counts = { prefetch: 0, perCall: 0 };
    const repo = {
      findManyForPairsUpTo: (...args: Parameters<TokenPriceRepository['findManyForPairsUpTo']>) => {
        counts.prefetch += 1;
        return inner.findManyForPairsUpTo(...args);
      },
      findClosestPriceByGranularity: (
        ...args: Parameters<TokenPriceRepository['findClosestPriceByGranularity']>
      ) => {
        counts.perCall += 1;
        return inner.findClosestPriceByGranularity(...args);
      },
    } as unknown as TokenPriceRepository;
    return { repo, counts };
  }

  test('a prefetched conversion gives the same answer as a per-call one, and reads no rows', async () => {
    // The property that decides whether this optimisation is allowed to
    // exist. A faster number that differs from the slower number is not a
    // faster number, it is a second answer.
    const direct = makePriceGraphService(makeTokenPriceStub(EDGES), makeTokenStub(HUB_ROWS));
    const expected = await direct.convert('2', 'token-BTC', HUB_IDS.USD, AT, {
      preferGranularity: 'daily',
    });

    const { repo, counts } = makeCountingStub(EDGES);
    const svc = makePriceGraphService(repo, makeTokenStub(HUB_ROWS));
    const priceLookup = await svc.buildPriceLookup(['token-BTC'], HUB_IDS.USD, AT);
    const before = counts.perCall;
    const actual = await svc.convert('2', 'token-BTC', HUB_IDS.USD, AT, {
      preferGranularity: 'daily',
      priceLookup,
    });

    expect(actual?.amount.toString()).toBe(expected?.amount.toString());
    expect(actual?.rate.toString()).toBe(expected?.rate.toString());
    expect(actual?.effectiveAt.getTime()).toBe(expected?.effectiveAt.getTime());
    expect(actual?.stale).toBe(expected?.stale);
    expect(counts.prefetch).toBe(1);
    expect(counts.perCall).toBe(before);
  });

  test('many conversions, one query', async () => {
    const { repo, counts } = makeCountingStub(EDGES);
    const svc = makePriceGraphService(repo, makeTokenStub(HUB_ROWS));
    const priceLookup = await svc.buildPriceLookup(['token-BTC'], HUB_IDS.USD, AT);
    const after = counts.perCall;
    for (let i = 0; i < 25; i += 1) {
      await svc.convert('1', 'token-BTC', HUB_IDS.USD, AT, {
        preferGranularity: 'daily',
        priceLookup,
      });
    }
    expect(counts.prefetch).toBe(1);
    expect(counts.perCall).toBe(after);
  });

  test('a pair the prefetch does not cover falls back to the database, not to "no price"', async () => {
    // The failure this guards is silent and expensive: an uncovered pair
    // answering `null` turns a valued external flow into an unvalued one,
    // which the returns engine then attributes to PERFORMANCE. Nothing on
    // screen would say the number moved.
    const { repo, counts } = makeCountingStub(EDGES);
    const svc = makePriceGraphService(repo, makeTokenStub(HUB_ROWS));
    // Built for BTC only. XRP is a real priced token that this prefetch was
    // never asked about — a caller that under-enumerated its tokens.
    const priceLookup = await svc.buildPriceLookup(['token-BTC'], HUB_IDS.USD, AT);
    const before = counts.perCall;

    const converted = await svc.convert('10', 'token-XRP', HUB_IDS.USD, AT, {
      preferGranularity: 'daily',
      priceLookup,
    });

    expect(converted?.amount.toString()).toBe('30');
    expect(counts.perCall).toBeGreaterThan(before);
  });

  test('a covered pair with no row is an answer, not a prefetch gap', async () => {
    // The other side of the same distinction. BTC/USD was queried and the
    // date predates every edge, so `null` is the truth and re-asking the
    // database would be the N+1 coming back one pair at a time.
    const { repo, counts } = makeCountingStub(EDGES);
    const svc = makePriceGraphService(repo, makeTokenStub(HUB_ROWS));
    const early = new Date('2025-01-01T00:00:00Z');
    const priceLookup = await svc.buildPriceLookup(['token-BTC'], HUB_IDS.USD, early);
    const before = counts.perCall;

    const converted = await svc.convert('2', 'token-BTC', HUB_IDS.USD, early, {
      preferGranularity: 'daily',
      priceLookup,
      maxDepth: 1,
    });

    expect(converted).toBeNull();
    expect(counts.perCall).toBe(before);
  });
});
