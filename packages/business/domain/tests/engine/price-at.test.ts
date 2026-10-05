import { describe, expect, test } from 'bun:test';
import {
  assetClassOf,
  isManualSource,
  priceAt,
  readingPairsFor,
  STALENESS_HORIZON_MS,
} from '../../src/engine/price-at';
import { indexPriceEvidence } from '../../src/engine/price-index';
import type {
  AssetClass,
  PriceAsset,
  PriceAt,
  PriceEvidence,
  PriceGranularity,
  PriceReading,
} from '../../src/engine/types';
import { priceReading, shuffled, utc } from './fixtures';

const HUBS = ['USD', 'USDT', 'EUR'];
const HOUR_MS = 3_600_000;
const DAY = '2026-01-10';
const X: PriceAsset = { tokenId: 'X', assetClass: 'crypto' };
const USD: PriceAsset = { tokenId: 'USD', assetClass: 'fiat' };

/**
 * Every case in this file asks twice, of the evidence and of an index of it,
 * and the two answers must be one.
 */
function answered(
  evidence: PriceEvidence,
  asset: PriceAsset,
  base: string,
  at: Date
): PriceAt | null {
  const answer = priceAt(evidence, asset, base, at);
  expect(priceAt(indexPriceEvidence(evidence), asset, base, at)).toStrictEqual(answer);
  return answer;
}

function price(
  readings: PriceReading[],
  base: string,
  at: Date,
  asset: PriceAsset = X,
  hubTokenIds: readonly string[] = HUBS
): PriceAt | null {
  return answered({ readings, hubTokenIds }, asset, base, at);
}

function priced(result: PriceAt | null): PriceAt {
  if (result === null) throw new Error('expected a price, got null');
  return result;
}

function pairKeys(pairs: Array<{ tokenId: string; baseTokenId: string }>): string[] {
  return pairs.map((p) => `${p.tokenId}/${p.baseTokenId}`);
}

// Two currencies that are not hubs.
const CHF = 'CHF';
const GBP = 'GBP';
/** A private company: priced by a person, in whatever currency they typed. */
const P: PriceAsset = { tokenId: 'P', assetClass: 'custom' };

type Handed = Partial<Omit<PriceEvidence, 'readings'>>;

/** `price`, with what a loader hands beside the readings. */
function priceWith(
  handed: Handed,
  readings: PriceReading[],
  base: string,
  at: Date,
  asset: PriceAsset = X
): PriceAt | null {
  return answered({ readings, hubTokenIds: HUBS, ...handed }, asset, base, at);
}

function quotes(byAsset: Record<string, string[]>): ReadonlyMap<string, readonly string[]> {
  return new Map(Object.entries(byAsset));
}

function classes(byToken: Record<string, AssetClass>): ReadonlyMap<string, AssetClass> {
  return new Map(Object.entries(byToken));
}

function manual(
  tokenId: string,
  baseTokenId: string,
  price: string,
  at: Date,
  granularity: PriceGranularity = 'intraday'
): PriceReading {
  return priceReading(tokenId, baseTokenId, price, at, granularity, 'manual');
}

/** What a loader that keeps only each pair's rows at the latest stamp at or before `at` hands over. */
function latestPerPair(readings: readonly PriceReading[], at: Date): PriceReading[] {
  const upTo = readings.filter((r) => r.at <= at);
  return upTo.filter(
    (r) =>
      !upTo.some((o) => o.tokenId === r.tokenId && o.baseTokenId === r.baseTokenId && o.at > r.at)
  );
}

/** Every subset of at most `size` items, each once. */
function* subsetsUpTo<T>(items: readonly T[], size: number, from = 0): Generator<T[]> {
  yield [];
  if (size === 0) return;
  for (let i = from; i < items.length; i++) {
    for (const rest of subsetsUpTo(items, size - 1, i + 1)) yield [items[i] as T, ...rest];
  }
}

describe('priceAt', () => {
  test('identity', () => {
    const at = utc(DAY, '10:00');
    const result = priced(price([priceReading('X', 'USD', '10', utc(DAY, '09:00'))], 'X', at));

    expect(result.price.toString()).toBe('1');
    expect(result.path).toBe('identity');
    expect(result.readingAt).toEqual(at);
    expect(result.stale).toBe(false);
  });

  test('nearest reading at or before T', () => {
    const readings = [
      priceReading('X', 'USD', '10', utc(DAY, '09:00')),
      priceReading('X', 'USD', '11', utc(DAY, '11:00')),
    ];

    const result = priced(price(readings, 'USD', utc(DAY, '10:00')));
    expect(result.price.toString()).toBe('10');
    expect(result.readingAt).toEqual(utc(DAY, '09:00'));
    expect(result.path).toBe('direct');

    // A reading exactly at T is at or before it.
    expect(priced(price(readings, 'USD', utc(DAY, '11:00'))).price.toString()).toBe('11');
  });

  test('never a reading after T', () => {
    expect(
      price([priceReading('X', 'USD', '11', utc(DAY, '11:00'))], 'USD', utc(DAY, '10:00'))
    ).toBeNull();

    // A hub route whose second leg is read only after T is no route.
    const routed = [
      priceReading('X', 'USD', '10', utc(DAY, '09:00')),
      priceReading('EUR', 'USD', '1.25', utc(DAY, '11:00')),
    ];
    expect(price(routed, 'EUR', utc(DAY, '10:00'))).toBeNull();
  });

  test('granularity breaks a tie at one instant', () => {
    const daily = priceReading('X', 'USD', '9', utc(DAY), 'daily');
    const intraday = priceReading('X', 'USD', '10', utc(DAY), 'intraday');
    const txExact = priceReading('X', 'USD', '12', utc(DAY), 'tx-exact');
    const at = utc(DAY, '01:00');

    expect(priced(price([daily, intraday, txExact], 'USD', at)).price.toString()).toBe('12');
    expect(priced(price([daily, intraday], 'USD', at)).price.toString()).toBe('10');
  });

  test('a granularity outside the type ranks below daily', () => {
    // `token_prices.granularity` is a text column, so a value no type allows can arrive.
    const unknown = {
      ...priceReading('X', 'USD', '99', utc(DAY)),
      granularity: 'weekly' as string as PriceGranularity,
    };
    const daily = priceReading('X', 'USD', '9', utc(DAY), 'daily');
    const at = utc(DAY, '01:00');

    expect(priced(price([unknown, daily], 'USD', at)).price.toString()).toBe('9');
    expect(priced(price([daily, unknown], 'USD', at)).price.toString()).toBe('9');
    expect(priced(price([unknown], 'USD', at)).price.toString()).toBe('99');
  });

  test('nearer beats finer', () => {
    const readings = [
      priceReading('X', 'USD', '9', utc(DAY, '09:00'), 'daily'),
      priceReading('X', 'USD', '10', utc(DAY, '08:00'), 'intraday'),
    ];

    expect(priced(price(readings, 'USD', utc(DAY, '10:00'))).price.toString()).toBe('9');
  });

  test('inverse', () => {
    const result = priced(
      price([priceReading('USD', 'X', '0.5', utc(DAY, '09:00'))], 'USD', utc(DAY, '10:00'))
    );

    expect(result.price.toString()).toBe('2');
    expect(result.path).toBe('inverse');
    expect(result.readingAt).toEqual(utc(DAY, '09:00'));
  });

  test("SC-1477: a newer reading through a hub beats an older row in the user's base", () => {
    const readings = [
      priceReading('X', 'EUR', '9', utc('2026-01-01')),
      priceReading('X', 'USD', '10', utc(DAY, '12:00')),
      priceReading('EUR', 'USD', '1.25', utc(DAY, '12:00')),
    ];

    const result = priced(price(readings, 'EUR', utc(DAY, '13:00')));
    expect(result.price.toString()).toBe('8');
    expect(result.path).toBe('hub:USD');
    expect(result.readingAt).toEqual(utc(DAY, '12:00'));
    expect(result.stale).toBe(false);
  });

  test('equally fresh: direct wins', () => {
    const t0 = utc(DAY, '12:00');
    const at = utc(DAY, '13:00');
    const hubRoute = [priceReading('X', 'USD', '10', t0), priceReading('EUR', 'USD', '1.25', t0)];

    const overHub = priced(price([priceReading('X', 'EUR', '9', t0), ...hubRoute], 'EUR', at));
    expect(overHub.path).toBe('direct');
    expect(overHub.price.toString()).toBe('9');

    const overInverse = priced(
      price([priceReading('USD', 'X', '0.2', t0), priceReading('X', 'USD', '10', t0)], 'USD', at)
    );
    expect(overInverse.path).toBe('direct');
    expect(overInverse.price.toString()).toBe('10');

    const inverseOverHub = priced(
      price([priceReading('EUR', 'X', '0.1', t0), ...hubRoute], 'EUR', at)
    );
    expect(inverseOverHub.path).toBe('inverse');
    expect(inverseOverHub.price.toString()).toBe('10');
  });

  test('equally fresh hubs: the first hub wins', () => {
    const t0 = utc(DAY, '12:00');
    const at = utc(DAY, '13:00');
    const readings = [
      priceReading('X', 'USDT', '11', t0),
      priceReading('USDT', 'EUR', '0.9', t0),
      priceReading('X', 'USD', '10', t0),
      priceReading('USD', 'EUR', '0.8', t0),
    ];

    const first = priced(price(readings, 'EUR', at));
    expect(first.path).toBe('hub:USD');
    expect(first.price.toString()).toBe('8');

    // "First" is the order of hubTokenIds, not of the readings or the ids.
    const reordered = priced(price(readings, 'EUR', at, X, ['USDT', 'USD', 'EUR']));
    expect(reordered.path).toBe('hub:USDT');
    expect(reordered.price.toString()).toBe('9.9');
  });

  test('the binding leg is the older one', () => {
    const route = [
      priceReading('X', 'USD', '10', utc(DAY, '12:00')),
      priceReading('USD', 'EUR', '0.8', utc(DAY, '08:00')),
    ];
    const at = utc(DAY, '13:00');

    const result = priced(price(route, 'EUR', at));
    expect(result.readingAt).toEqual(utc(DAY, '08:00'));
    expect(result.path).toBe('hub:USD');
    expect(result.price.toString()).toBe('8');

    // A direct row between the two legs is fresher than the route.
    const newerDirect = priceReading('X', 'EUR', '9', utc(DAY, '09:00'));
    expect(priced(price([...route, newerDirect], 'EUR', at)).path).toBe('direct');
    const olderDirect = priceReading('X', 'EUR', '9', utc(DAY, '07:00'));
    expect(priced(price([...route, olderDirect], 'EUR', at)).path).toBe('hub:USD');
  });

  test('a leg takes the later of its two directions; a tie goes to the forward reading', () => {
    const at = utc(DAY, '13:00');
    const first = priceReading('X', 'USD', '10', utc(DAY, '12:00'));

    const laterInverse = priced(
      price(
        [
          first,
          priceReading('USD', 'EUR', '0.5', utc(DAY, '08:00')),
          priceReading('EUR', 'USD', '1.25', utc(DAY, '11:00')),
        ],
        'EUR',
        at
      )
    );
    expect(laterInverse.price.toString()).toBe('8');
    expect(laterInverse.readingAt).toEqual(utc(DAY, '11:00'));

    const tied = priced(
      price(
        [
          first,
          priceReading('EUR', 'USD', '1.25', utc(DAY, '11:00')),
          priceReading('USD', 'EUR', '0.5', utc(DAY, '11:00')),
        ],
        'EUR',
        at
      )
    );
    expect(tied.price.toString()).toBe('5');
  });

  test('staleness per asset class', () => {
    const at = utc('2026-03-01');
    const staleAfter = (assetClass: AssetClass, hours: number): boolean => {
      const readAt = new Date(at.getTime() - hours * HOUR_MS);
      const readings = [priceReading('X', 'USD', '10', readAt)];
      return priced(price(readings, 'USD', at, { tokenId: 'X', assetClass })).stale;
    };

    expect(staleAfter('crypto', 47)).toBe(false);
    expect(staleAfter('crypto', 48)).toBe(false);
    expect(staleAfter('crypto', 49)).toBe(true);
    expect(staleAfter('fiat', 119)).toBe(false);
    expect(staleAfter('fiat', 121)).toBe(true);
    expect(staleAfter('stock', 119)).toBe(false);
    expect(staleAfter('stock', 121)).toBe(true);
    expect(staleAfter('custom', 400 * 24)).toBe(false);
    expect(staleAfter('unknown', 47)).toBe(false);
    expect(staleAfter('unknown', 49)).toBe(true);

    expect(STALENESS_HORIZON_MS).toEqual({
      crypto: 48 * HOUR_MS,
      fiat: 120 * HOUR_MS,
      stock: 120 * HOUR_MS,
      custom: null,
      unknown: 48 * HOUR_MS,
    });
  });

  test('staleness is measured from the binding leg', () => {
    const at = utc('2026-03-01');
    const readings = [
      priceReading('X', 'USD', '10', new Date(at.getTime() - HOUR_MS)),
      priceReading('USD', 'EUR', '0.8', new Date(at.getTime() - 49 * HOUR_MS)),
    ];

    const result = priced(price(readings, 'EUR', at));
    expect(result.path).toBe('hub:USD');
    expect(result.stale).toBe(true);
  });

  test('a zero or negative row is not a price', () => {
    const readings = [
      priceReading('X', 'USD', '0', utc(DAY, '09:00')),
      priceReading('X', 'USD', '-5', utc(DAY, '09:30')),
      priceReading('X', 'USD', '10', utc(DAY, '08:00')),
    ];
    expect(priced(price(readings, 'USD', utc(DAY, '10:00'))).price.toString()).toBe('10');

    // Nor is a zero inverted into an infinite one.
    expect(
      price([priceReading('USD', 'X', '0', utc(DAY, '09:00'))], 'USD', utc(DAY, '10:00'))
    ).toBeNull();
  });

  test('no readings → null', () => {
    expect(price([], 'USD', utc(DAY))).toBeNull();
  });

  test('readingPairsFor covers the traversal exactly', () => {
    const pairs = readingPairsFor(['X'], 'EUR', HUBS);
    const keys = pairKeys(pairs);

    expect(keys.toSorted()).toEqual(
      [
        'X/EUR',
        'EUR/X',
        'X/USD',
        'USD/X',
        'X/USDT',
        'USDT/X',
        'USD/EUR',
        'EUR/USD',
        'USDT/EUR',
        'EUR/USDT',
      ].toSorted()
    );
    // One hop never reads hub against hub when the asset is not a hub itself.
    expect(keys).not.toContain('USD/USDT');
    expect(keys).not.toContain('USDT/USD');
    expect(keys).not.toContain('EUR/EUR');
    expect(new Set(keys).size).toBe(pairs.length);
  });

  test('readingPairsFor: a hub held as an asset routes through the other hubs; the base and repeats add nothing', () => {
    const keys = pairKeys(readingPairsFor(['X', 'EUR', 'X', 'USD'], 'EUR', HUBS));

    expect(keys.toSorted()).toEqual(
      [
        'X/EUR',
        'EUR/X',
        'X/USD',
        'USD/X',
        'X/USDT',
        'USDT/X',
        'USD/EUR',
        'EUR/USD',
        'USDT/EUR',
        'EUR/USDT',
        'USD/USDT',
        'USDT/USD',
      ].toSorted()
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(readingPairsFor(['EUR'], 'EUR', HUBS)).toEqual([]);
  });

  test('readings outside the pair list never change an answer', () => {
    const tokens = ['X', 'Y', 'USD', 'USDT', 'EUR'];
    const times = ['08:00', '10:00', '12:00'];
    const readings = tokens.flatMap((from, i) =>
      tokens
        .filter((to) => to !== from)
        .map((to, j) => {
          const hubPair = HUBS.includes(from) && HUBS.includes(to);
          const usdEur = [from, to].toSorted().join('/') === 'EUR/USD';
          // Hub-against-hub rows are the freshest, so a traversal that read them would show
          // it; USD↔EUR is older than the route through USDT, so USD in EUR needs USD↔USDT.
          const time = usdEur
            ? '11:30'
            : hubPair
              ? '12:30'
              : (times[(i + j) % times.length] as string);
          return priceReading(from, to, String(1 + i + j / 10), utc(DAY, time));
        })
    );
    const loadedFor = (tokenIds: string[], base: string): PriceReading[] => {
      const wanted = new Set(pairKeys(readingPairsFor(tokenIds, base, HUBS)));
      return readings.filter((r) => wanted.has(`${r.tokenId}/${r.baseTokenId}`));
    };

    let answered = 0;
    for (const base of ['EUR', 'USD', 'USDT']) {
      const loadedForX = loadedFor(['X'], base);
      const droppedHubPairs = readings.filter(
        (r) => !loadedForX.includes(r) && HUBS.includes(r.tokenId) && HUBS.includes(r.baseTokenId)
      );
      expect(droppedHubPairs).toHaveLength(2);
      for (const asset of [X, USD]) {
        const loaded = loadedFor([asset.tokenId], base);
        for (const time of ['09:00', '11:00', '13:00']) {
          const full = price(readings, base, utc(DAY, time), asset);
          if (full !== null) answered++;
          expect(price(loaded, base, utc(DAY, time), asset)).toEqual(full);
        }
      }
    }
    expect(answered).toBe(13);

    // The hub-as-asset pairs are necessary: without USD↔USDT, USD in EUR falls back to an older row.
    const at = utc(DAY, '13:00');
    const full = priced(price(readings, 'EUR', at, USD));
    expect(full.path).toBe('hub:USDT');
    expect(price(loadedFor(['X'], 'EUR'), 'EUR', at, USD)).not.toEqual(full);
  });

  test('assetClassOf', () => {
    expect(assetClassOf('crypto')).toBe('crypto');
    expect(assetClassOf('fiat')).toBe('fiat');
    expect(assetClassOf('stock')).toBe('stock');
    expect(assetClassOf('private-company')).toBe('custom');
    expect(assetClassOf('other')).toBe('custom');
    expect(assetClassOf('bond')).toBe('unknown');
    expect(assetClassOf(null)).toBe('unknown');
    expect(assetClassOf(undefined)).toBe('unknown');
  });

  test('replay: shuffled readings give an identical answer', () => {
    const t0 = utc(DAY, '09:00');
    const readings = [
      priceReading('X', 'USD', '10', t0, 'daily'),
      priceReading('X', 'USD', '10.5', t0, 'intraday'),
      priceReading('X', 'USD', '11', t0, 'tx-exact'),
      // A full tie the table's unique key rules out; the answer must still not depend on order.
      priceReading('X', 'USD', '11.5', t0, 'tx-exact'),
      priceReading('USD', 'X', '0.09', t0),
      priceReading('X', 'USD', '0', utc(DAY, '10:00')),
      priceReading('X', 'USD', '-1', utc(DAY, '10:30')),
      priceReading('X', 'EUR', '9', utc('2026-01-09')),
      priceReading('EUR', 'X', '0.1', utc(DAY, '08:00')),
      priceReading('EUR', 'USD', '1.25', t0),
      priceReading('USD', 'EUR', '0.8', t0),
      priceReading('X', 'USDT', '11', t0),
      priceReading('USDT', 'EUR', '0.9', t0),
      priceReading('USDT', 'USD', '1', utc(DAY, '11:00')),
      priceReading('X', 'EUR', '8.5', utc(DAY, '14:00'), 'daily'),
      // The same full tie from two sources: the answer names one of them in every order.
      priceReading('X', 'USD', '11.5', t0, 'tx-exact', 'kraken'),
      priceReading('X', 'USD', '11.5', t0, 'tx-exact', 'coingecko'),
      // A quote route.
      priceReading('X', CHF, '100', utc(DAY, '13:00')),
      priceReading(CHF, 'USD', '1.1', utc(DAY, '13:00')),
      priceReading(CHF, 'EUR', '1.05', utc(DAY, '08:00')),
      priceReading(GBP, 'USD', '1.3', utc(DAY, '13:00')),
      // A person's prices: two over time, then two at one instant in two bases.
      manual('P', 'USD', '10', t0),
      manual('P', CHF, '20', utc(DAY, '11:00')),
      manual('P', CHF, '21', utc(DAY, '14:00')),
      manual('P', GBP, '21', utc(DAY, '14:00')),
    ];
    const handed: Handed = {
      quoteTokenIds: quotes({ X: [CHF], P: [GBP, CHF] }),
      assetClasses: classes({ USD: 'fiat', EUR: 'fiat', [CHF]: 'fiat', [GBP]: 'fiat' }),
    };
    const variants = [readings.toReversed(), ...[7, 1234, 99991].map((s) => shuffled(readings, s))];
    const assets: PriceAsset[] = [X, USD, { tokenId: 'USDT', assetClass: 'crypto' }, P];
    const instants = [
      utc('2026-01-09', '12:00'),
      t0,
      utc(DAY, '12:00'),
      utc(DAY, '15:00'),
      utc('2026-01-20'),
    ];

    let answered = 0;
    const routes = new Set<string>();
    for (const asset of assets) {
      for (const base of ['EUR', 'USD', 'USDT']) {
        for (const at of instants) {
          const original = priceWith(handed, readings, base, at, asset);
          if (original !== null) {
            answered++;
            routes.add(original.path.split(':')[0] as string);
          }
          for (const variant of variants) {
            expect(priceWith(handed, variant, base, at, asset)).toEqual(original);
          }
        }
      }
    }
    expect(answered).toBeGreaterThanOrEqual(40);
    expect(routes).toEqual(new Set(['identity', 'direct', 'inverse', 'hub', 'quote']));

    // The two manual prices at 14:00 tie on everything but the base, and one of them survives.
    const tied = priced(priceWith(handed, readings, 'USD', utc(DAY, '15:00'), P));
    expect(tied.path).toBe(`quote:${GBP}`);
    expect(tied.price.toString()).toBe('27.3');
    // The full tie in one pair is closed by the source.
    expect(priced(priceWith(handed, readings, 'USD', t0)).source).toBe('kraken');
  });
});

describe('isManualSource', () => {
  test("a person typed it when the source is 'manual' or starts with it", () => {
    expect(isManualSource('manual')).toBe(true);
    expect(isManualSource('manual-import')).toBe(true);
    expect(isManualSource('coingecko')).toBe(false);
    expect(isManualSource('downsample-daily')).toBe(false);
    // As the legacy readers' `LIKE 'manual%'`: a prefix, and case-sensitive.
    expect(isManualSource('semi-manual')).toBe(false);
    expect(isManualSource('Manual')).toBe(false);
    expect(isManualSource('')).toBe(false);
    expect(isManualSource(null)).toBe(false);
  });
});

describe('priceAt: the source', () => {
  test('the source is the asset leg’s', () => {
    const t = utc(DAY, '09:00');
    const at = utc(DAY, '10:00');
    const direct = priceReading('X', 'USD', '10', t, 'intraday', 'coingecko');
    const inverse = priceReading('USD', 'X', '0.1', t, 'intraday', 'kraken');
    const rate = priceReading('USD', 'EUR', '0.8', t, 'intraday', 'frankfurter');

    expect(priced(price([direct], 'USD', at)).source).toBe('coingecko');
    expect(priced(price([inverse], 'USD', at)).source).toBe('kraken');
    // Identity reads nothing.
    expect(priced(price([direct], 'X', at)).source).toBeNull();

    // A routed answer names its first leg, whichever direction that leg was read in.
    expect(priced(price([direct, rate], 'EUR', at)).source).toBe('coingecko');
    expect(priced(price([inverse, rate], 'EUR', at)).source).toBe('kraken');
    const typed = [
      manual('P', CHF, '20', t),
      priceReading(CHF, 'USD', '1.1', t, 'intraday', 'frankfurter'),
    ];
    expect(
      priced(priceWith({ quoteTokenIds: quotes({ P: [CHF] }) }, typed, 'USD', at, P)).source
    ).toBe('manual');

    // A reading that carries none.
    expect(priced(price([priceReading('X', 'USD', '10', t)], 'USD', at)).source).toBeNull();
  });
});

describe('priceAt: quote routes', () => {
  const at = utc(DAY, '13:00');
  const listed: Handed = { quoteTokenIds: quotes({ X: [CHF] }) };

  test('a reading quoted in a third currency routes through it', () => {
    const t1 = utc(DAY, '09:00');
    const readings = [priceReading('X', CHF, '100', t1), priceReading(CHF, 'USD', '1.1', t1)];

    const answer = priced(priceWith(listed, readings, 'USD', at));
    expect(answer.price.toString()).toBe('110');
    expect(answer.path).toBe(`quote:${CHF}`);
    expect(answer.readingAt).toEqual(t1);
    expect(answer.stale).toBe(false);
  });

  test('a quote route’s second leg may take one hub', () => {
    const t1 = utc(DAY, '09:00');
    const readings = [
      priceReading('X', CHF, '100', t1),
      priceReading(CHF, 'EUR', '1.05', t1),
      priceReading('EUR', GBP, '0.8', t1),
    ];

    const answer = priced(priceWith(listed, readings, GBP, at));
    expect(answer.price.toString()).toBe('84');
    expect(answer.path).toBe(`quote:${CHF}:EUR`);
    expect(answer.readingAt).toEqual(t1);
  });

  test('a quote route’s time is its oldest leg, and its second leg takes the later of two directions', () => {
    const first = priceReading('X', CHF, '100', utc(DAY, '12:00'));
    const forward = priceReading(CHF, 'USD', '1.1', utc(DAY, '07:00'));

    const olderSecond = priced(priceWith(listed, [first, forward], 'USD', at));
    expect(olderSecond.price.toString()).toBe('110');
    expect(olderSecond.readingAt).toEqual(utc(DAY, '07:00'));

    const laterInverse = priced(
      priceWith(
        listed,
        [first, forward, priceReading('USD', CHF, '0.8', utc(DAY, '08:00'))],
        'USD',
        at
      )
    );
    expect(laterInverse.price.toString()).toBe('125');
    expect(laterInverse.path).toBe(`quote:${CHF}`);
    expect(laterInverse.readingAt).toEqual(utc(DAY, '08:00'));

    const olderFirst = priced(
      priceWith(listed, [priceReading('X', CHF, '100', utc(DAY, '06:00')), forward], 'USD', at)
    );
    expect(olderFirst.readingAt).toEqual(utc(DAY, '06:00'));
  });

  test('the second leg of a quote route: the freshest, then the direct one, then the hubs in their given order', () => {
    const first = priceReading('X', CHF, '100', utc(DAY, '12:00'));
    const direct = (time: string) => priceReading(CHF, GBP, '0.9', utc(DAY, time));
    const viaEur = (time: string) => [
      priceReading(CHF, 'EUR', '1.05', utc(DAY, time)),
      priceReading('EUR', GBP, '0.8', utc(DAY, time)),
    ];
    const viaUsd = (time: string) => [
      priceReading(CHF, 'USD', '1.1', utc(DAY, time)),
      priceReading('USD', GBP, '0.75', utc(DAY, time)),
    ];
    const answer = (second: PriceReading[], handed: Handed = listed) =>
      priced(priceWith(handed, [first, ...second], GBP, at));

    const fresherHub = answer([direct('08:00'), ...viaEur('10:00')]);
    expect(fresherHub.path).toBe(`quote:${CHF}:EUR`);
    expect(fresherHub.price.toString()).toBe('84');
    expect(fresherHub.readingAt).toEqual(utc(DAY, '10:00'));

    const tied = answer([...viaEur('10:00'), direct('10:00')]);
    expect(tied.path).toBe(`quote:${CHF}`);
    expect(tied.price.toString()).toBe('90');

    const twoHubs = [direct('08:00'), ...viaEur('10:00'), ...viaUsd('10:00')];
    expect(answer(twoHubs).path).toBe(`quote:${CHF}:USD`);
    expect(answer(twoHubs).price.toString()).toBe('82.5');
    // "First" is the order of hubTokenIds.
    const reordered = answer(twoHubs, { ...listed, hubTokenIds: ['EUR', 'USDT', 'USD'] });
    expect(reordered.path).toBe(`quote:${CHF}:EUR`);

    // A second leg through a hub is as fresh as the older of its two readings.
    const olderHalf = answer([
      direct('08:00'),
      priceReading(CHF, 'EUR', '1.05', utc(DAY, '11:00')),
      priceReading('EUR', GBP, '0.8', utc(DAY, '07:00')),
    ]);
    expect(olderHalf.path).toBe(`quote:${CHF}`);
    expect(olderHalf.readingAt).toEqual(utc(DAY, '08:00'));
  });

  test('a currency the asset is not listed with is never a route', () => {
    const t1 = utc(DAY, '09:00');
    const readings = [priceReading('X', CHF, '100', t1), priceReading(CHF, 'USD', '1.1', t1)];

    expect(price(readings, 'USD', at)).toBeNull();
    expect(priceWith({ quoteTokenIds: quotes({}) }, readings, 'USD', at)).toBeNull();
    // Another asset's currency is not this one's.
    expect(priceWith({ quoteTokenIds: quotes({ Y: [CHF] }) }, readings, 'USD', at)).toBeNull();

    // CONTROL: listed, the same readings are a route.
    expect(priced(priceWith(listed, readings, 'USD', at)).path).toBe(`quote:${CHF}`);
  });

  test('the base and the hubs are never quote currencies', () => {
    const t1 = utc(DAY, '09:00');
    const through = (currency: string) => [
      priceReading('X', currency, '9', t1),
      priceReading(currency, 'USDT', '1.2', t1),
      priceReading('USDT', 'USD', '1', t1),
    ];

    // One hop at most: a hub handed as a quote currency opens no second one.
    const handed: Handed = { quoteTokenIds: quotes({ X: ['EUR', 'USD', 'X'] }) };
    expect(priceWith(handed, through('EUR'), 'USD', at)).toBeNull();
    const hub = [priceReading('X', 'EUR', '9', t1), priceReading('EUR', 'USD', '1.25', t1)];
    expect(priced(priceWith(handed, hub, 'USD', at)).path).toBe('hub:EUR');

    // CONTROL: the same shape through a currency that is not a hub is a route.
    const answer = priced(priceWith(listed, through(CHF), 'USD', at));
    expect(answer.path).toBe(`quote:${CHF}:USDT`);
    expect(answer.price.toString()).toBe('10.8');
  });

  test('an asset’s answer is the same whatever other tokens share the evidence', () => {
    const own = [
      priceReading('X', 'USD', '10', utc(DAY, '08:00')),
      priceReading('X', CHF, '100', utc(DAY, '10:00')),
      priceReading(CHF, 'USD', '1.1', utc(DAY, '10:00')),
    ];
    // Fresher than everything of X's own, and none of it in X's list: its newest row in
    // any base as the shadow hands it, the readings Y and Z are priced from, the reverse of
    // its first leg, and a hub against a hub.
    const others = [
      priceReading('X', GBP, '70', utc(DAY, '12:00')),
      priceReading(GBP, 'USD', '1.3', utc(DAY, '12:00')),
      priceReading('Y', GBP, '5', utc(DAY, '12:00')),
      priceReading('Z', 'X', '2', utc(DAY, '12:00')),
      priceReading('Z', 'USD', '21', utc(DAY, '12:00')),
      priceReading(CHF, 'X', '0.5', utc(DAY, '12:00')),
      priceReading('USDT', 'EUR', '0.9', utc(DAY, '12:00')),
    ];

    const alone = priced(priceWith(listed, own, 'USD', at));
    expect(alone.path).toBe(`quote:${CHF}`);
    expect(alone.price.toString()).toBe('110');

    const shared: Handed = { quoteTokenIds: quotes({ X: [CHF], Y: [GBP], Z: ['X', GBP] }) };
    expect(priceWith(shared, [...others, ...own], 'USD', at)).toEqual(alone);
    expect(priceWith(shared, [...own, ...others], 'USD', at)).toEqual(alone);
  });

  test('a reverse-only relation is not a quote route', () => {
    const t1 = utc(DAY, '09:00');
    const handed: Handed = { quoteTokenIds: quotes({ X: ['Z'] }) };
    const reverseOnly = [priceReading('Z', 'X', '0.01', t1), priceReading('Z', 'USD', '1.1', t1)];

    expect(priceWith(handed, reverseOnly, 'USD', at)).toBeNull();

    // CONTROL: the forward reading is a first leg.
    const forward = priced(
      priceWith(handed, [...reverseOnly, priceReading('X', 'Z', '100', t1)], 'USD', at)
    );
    expect(forward.path).toBe('quote:Z');
    expect(forward.price.toString()).toBe('110');
  });

  test('freshness decides between a hub route and a quote route, both ways', () => {
    const hub = (time: string) => [
      priceReading('X', 'EUR', '9', utc(DAY, time)),
      priceReading('EUR', 'USD', '1.25', utc(DAY, time)),
    ];
    const quote = (time: string) => [
      priceReading('X', CHF, '100', utc(DAY, time)),
      priceReading(CHF, 'USD', '1.1', utc(DAY, time)),
    ];

    const quoteNewer = priced(priceWith(listed, [...hub('10:00'), ...quote('11:00')], 'USD', at));
    expect(quoteNewer.path).toBe(`quote:${CHF}`);
    expect(quoteNewer.price.toString()).toBe('110');

    const hubNewer = priced(priceWith(listed, [...quote('10:00'), ...hub('11:00')], 'USD', at));
    expect(hubNewer.path).toBe('hub:EUR');
    expect(hubNewer.price.toString()).toBe('11.25');
  });

  test('equally fresh: every other route wins over a quote route, and quotes go by token id', () => {
    const t0 = utc(DAY, '12:00');
    const viaChf = [priceReading('X', CHF, '100', t0), priceReading(CHF, 'USD', '1.1', t0)];
    const viaGbp = [priceReading('X', GBP, '70', t0), priceReading(GBP, 'USD', '1.3', t0)];
    const hub = [priceReading('X', 'EUR', '9', t0), priceReading('EUR', 'USD', '1.25', t0)];
    // Handed in the other order: the order is the ids', not the list's.
    const handed: Handed = { quoteTokenIds: quotes({ X: [GBP, CHF, GBP] }) };
    const answer = (readings: PriceReading[]) => priced(priceWith(handed, readings, 'USD', at));

    expect(answer([...viaGbp, ...viaChf, ...hub]).path).toBe('hub:EUR');
    expect(answer([...viaGbp, ...viaChf, priceReading('USD', 'X', '0.2', t0)]).path).toBe(
      'inverse'
    );
    expect(answer([...viaGbp, ...viaChf]).path).toBe(`quote:${CHF}`);
    expect(answer([...viaChf, ...viaGbp]).price.toString()).toBe('110');
    expect(answer(viaGbp).path).toBe(`quote:${GBP}`);
  });

  test('a quote route never comes back through the asset', () => {
    // USD is a hub and here the asset. From CHF to the base a route may take another hub,
    // never USD itself: that would read the asset's own pairs a second time, and among them
    // a price its person has superseded.
    const usd: PriceAsset = { tokenId: 'USD', assetClass: 'fiat' };
    const handed: Handed = { quoteTokenIds: quotes({ USD: [CHF] }) };
    const typed = [
      manual('USD', GBP, '0.75', utc(DAY, '08:00')),
      manual('USD', CHF, '0.9', utc(DAY, '12:00')),
    ];

    expect(priceWith(handed, typed, GBP, at, usd)).toBeNull();

    // CONTROL: with a rate from CHF to the base it is a route.
    const rate = priceReading(CHF, GBP, '0.9', utc(DAY, '07:00'));
    const answer = priced(priceWith(handed, [...typed, rate], GBP, at, usd));
    expect(answer.path).toBe(`quote:${CHF}`);
    expect(answer.price.toString()).toBe('0.81');
  });

  test('readingPairsFor with quotes covers the traversal exactly', () => {
    const handed = quotes({ X: [CHF], Y: ['ZAR'] });
    const pairs = readingPairsFor(['X'], GBP, HUBS, handed);
    const keys = pairKeys(pairs);

    expect(keys.toSorted()).toEqual(
      [
        'X/GBP',
        'GBP/X',
        'X/USD',
        'USD/X',
        'X/USDT',
        'USDT/X',
        'X/EUR',
        'EUR/X',
        'USD/GBP',
        'GBP/USD',
        'USDT/GBP',
        'GBP/USDT',
        'EUR/GBP',
        'GBP/EUR',
        // The quote currency: the asset's forward reading in it, then its own way to the base.
        'X/CHF',
        'CHF/GBP',
        'GBP/CHF',
        'CHF/USD',
        'USD/CHF',
        'CHF/USDT',
        'USDT/CHF',
        'CHF/EUR',
        'EUR/CHF',
      ].toSorted()
    );
    expect(new Set(keys).size).toBe(keys.length);

    // The base, a hub and the asset itself are never quote currencies.
    const none = quotes({ X: [GBP, 'USD', 'X'], Y: [CHF] });
    expect(pairKeys(readingPairsFor(['X'], GBP, HUBS, none)).toSorted()).toEqual(
      pairKeys(readingPairsFor(['X'], GBP, HUBS)).toSorted()
    );
    // Each asset's currencies are its own.
    const two = pairKeys(readingPairsFor(['X', 'P'], 'USD', HUBS, quotes({ X: [CHF], P: [GBP] })));
    expect(two).toContain('X/CHF');
    expect(two).toContain('P/GBP');
    expect(two).not.toContain('X/GBP');
    expect(two).not.toContain('P/CHF');
    expect(two).not.toContain('CHF/X');
    // A hub held as an asset: its quote currency's way to the base never comes back through it.
    const hubAsset = pairKeys(readingPairsFor(['USD'], GBP, HUBS, quotes({ USD: [CHF] })));
    expect(hubAsset).toContain('USD/CHF');
    expect(hubAsset).toContain('CHF/EUR');
    expect(hubAsset).not.toContain('CHF/USD');

    // One reading per ordered pair of these tokens, the unlisted ones the fresher, so a
    // traversal that read one would show it. Twice, because a hub held as an asset has a
    // list of its own: neither it nor its quote currency routes through it.
    const tokens = ['X', 'Y', CHF, GBP, 'ZAR', ...HUBS];
    const keyOf = (r: PriceReading) => `${r.tokenId}/${r.baseTokenId}`;
    const signature = (result: PriceAt | null) =>
      result === null
        ? 'null'
        : [result.price, result.readingAt.toISOString(), result.path, result.source].join('|');
    const shapes = [
      { asset: X, quoteTokenIds: handed, worlds: 1 + 23 + 253 + 1771 },
      { asset: USD, quoteTokenIds: quotes({ USD: [CHF], Y: ['ZAR'] }), worlds: 1 + 17 + 136 + 680 },
    ];
    for (const shape of shapes) {
      const shapeKeys = pairKeys(
        readingPairsFor([shape.asset.tokenId], GBP, HUBS, shape.quoteTokenIds)
      );
      const listedKeys = new Set(shapeKeys);
      const all = tokens.flatMap((from, i) =>
        tokens
          .filter((to) => to !== from)
          .map((to, j) =>
            priceReading(
              from,
              to,
              String(1 + i + j / 10),
              utc(DAY, listedKeys.has(`${from}/${to}`) ? '09:00' : '11:00')
            )
          )
      );
      const loaded = all.filter((r) => listedKeys.has(keyOf(r)));
      const outside = all.filter((r) => !listedKeys.has(keyOf(r)));
      expect(loaded).toHaveLength(shapeKeys.length);
      expect(outside).toHaveLength(tokens.length * (tokens.length - 1) - shapeKeys.length);
      const answer = (readings: PriceReading[]) =>
        priceWith({ quoteTokenIds: shape.quoteTokenIds }, readings, GBP, at, shape.asset);

      const needed = new Set<string>();
      let worlds = 0;
      for (const world of subsetsUpTo(loaded, 3)) {
        worlds++;
        const alone = answer(world);
        // Adding every unlisted pair changes none.
        expect(answer([...outside, ...world])).toEqual(alone);
        for (const dropped of world) {
          const without = answer(world.filter((r) => r !== dropped));
          if (signature(without) !== signature(alone)) needed.add(keyOf(dropped));
        }
      }
      expect(worlds).toBe(shape.worlds);
      // Dropping any listed pair changes an answer.
      expect([...needed].toSorted()).toEqual(shapeKeys.toSorted());
    }
  });
});

describe('priceAt: a person’s latest price', () => {
  const rate = (time: string) =>
    priceReading(CHF, 'USD', '1.1', utc(DAY, time), 'intraday', 'frankfurter');
  const listed: Handed = { quoteTokenIds: quotes({ P: [CHF] }) };
  const inUsd = (readings: PriceReading[], time: string, handed: Handed = listed) =>
    priceWith(handed, readings, 'USD', utc(DAY, time), P);

  test('a manual price re-typed in another currency supersedes the earlier one at once', () => {
    // The rate is older than the first price: on freshness alone the first price would stand.
    const readings = [
      rate('06:00'),
      manual('P', 'USD', '10', utc(DAY, '08:00')),
      manual('P', CHF, '20', utc(DAY, '12:00')),
    ];

    const after = priced(inUsd(readings, '13:00'));
    expect(after.price.toString()).toBe('22');
    expect(after.path).toBe(`quote:${CHF}`);
    expect(after.readingAt).toEqual(utc(DAY, '06:00'));

    // CONTROL: before the correction.
    const before = priced(inUsd(readings, '10:00'));
    expect(before.price.toString()).toBe('10');
    expect(before.path).toBe('direct');
  });

  test('a manual price re-typed in a hub currency supersedes the earlier one in the base', () => {
    // No quote currency is handed: the base and the hubs are listed pairs too.
    const readings = [
      priceReading('EUR', 'USD', '1.25', utc(DAY, '06:00')),
      manual('P', 'USD', '10', utc(DAY, '08:00')),
      manual('P', 'EUR', '9', utc(DAY, '12:00')),
    ];

    const after = priced(price(readings, 'USD', utc(DAY, '13:00'), P));
    expect(after.price.toString()).toBe('11.25');
    expect(after.path).toBe('hub:EUR');

    expect(priced(price(readings, 'USD', utc(DAY, '10:00'), P)).price.toString()).toBe('10');
  });

  test('a provider reading is not superseded by a manual one', () => {
    const provider = priceReading('P', 'USD', '10', utc(DAY, '08:00'), 'intraday', 'coingecko');
    const typed = manual('P', CHF, '20', utc(DAY, '12:00'));

    // The typed price's route binds at 06:00, the provider's reading at 08:00: freshness decides…
    const fresherProvider = priced(inUsd([provider, typed, rate('06:00')], '13:00'));
    expect(fresherProvider.price.toString()).toBe('10');
    expect(fresherProvider.path).toBe('direct');
    // …both ways.
    const fresherTyped = priced(inUsd([provider, typed, rate('09:00')], '13:00'));
    expect(fresherTyped.price.toString()).toBe('22');
    expect(fresherTyped.path).toBe(`quote:${CHF}`);

    // Nor does a provider's later reading supersede a person's.
    const laterProvider = priceReading('P', CHF, '20', utc(DAY, '12:00'), 'intraday', 'coingecko');
    const kept = priced(
      inUsd([manual('P', 'USD', '10', utc(DAY, '08:00')), laterProvider, rate('06:00')], '13:00')
    );
    expect(kept.price.toString()).toBe('10');
    expect(kept.path).toBe('direct');
  });

  test('an unlisted manual reading supersedes nothing', () => {
    const readings = [
      rate('06:00'),
      manual('P', 'USD', '10', utc(DAY, '08:00')),
      manual('P', CHF, '20', utc(DAY, '12:00')),
    ];

    // CHF is not handed as one of P's currencies, so P→CHF is outside the pair list.
    const unlisted: Handed[] = [
      {},
      { quoteTokenIds: quotes({}) },
      { quoteTokenIds: quotes({ Y: [CHF] }) },
    ];
    for (const handed of unlisted) {
      const answer = priced(inUsd(readings, '13:00', handed));
      expect(answer.price.toString()).toBe('10');
      expect(answer.path).toBe('direct');
    }

    // CONTROL: listed, it supersedes.
    expect(priced(inUsd(readings, '13:00')).price.toString()).toBe('22');
  });

  test('a superseding price with no rate to the base is no price, and the earlier one does not come back', () => {
    const readings = [
      manual('P', 'USD', '10', utc(DAY, '08:00')),
      manual('P', CHF, '20', utc(DAY, '12:00')),
    ];

    expect(inUsd(readings, '13:00')).toBeNull();
    expect(priced(inUsd(readings, '10:00')).price.toString()).toBe('10');
  });

  test('a superseded pair’s reverse reading still serves', () => {
    // No CHF rate anywhere, so the correction opens no route of its own, and each reverse
    // reading is older than the typed price beside it: with no supersession the typed price
    // would answer, and with the whole pair dropped nothing would.
    const correction = manual('P', CHF, '20', utc(DAY, '12:00'));
    const reverse = (currency: string) =>
      priceReading(currency, 'P', '0.125', utc(DAY, '07:00'), 'intraday', 'coingecko');
    const hubPair = [
      manual('P', 'EUR', '9', utc(DAY, '08:00')),
      correction,
      reverse('EUR'),
      priceReading('EUR', 'USD', '1.25', utc(DAY, '07:00')),
    ];
    const basePair = [manual('P', 'USD', '10', utc(DAY, '08:00')), correction, reverse('USD')];
    const answers = (time: string) =>
      [hubPair, basePair].map((readings) => {
        const answer = inUsd(readings, time);
        return answer === null
          ? null
          : [answer.price.toString(), answer.path, answer.readingAt, answer.source];
      });

    expect(answers('13:00')).toEqual([
      ['10', 'hub:EUR', utc(DAY, '07:00'), 'coingecko'],
      ['8', 'inverse', utc(DAY, '07:00'), 'coingecko'],
    ]);
    // CONTROL: before the correction the typed price answers.
    expect(answers('10:00')).toEqual([
      ['11.25', 'hub:EUR', utc(DAY, '07:00'), 'manual'],
      ['10', 'direct', utc(DAY, '08:00'), 'manual'],
    ]);
  });

  test('the latest row per pair gives the same answer as the whole pair, with a provider row under a superseded manual one', () => {
    // The provider row is fresher than the rate the correction is priced through, so a rule
    // that fell back to it would answer 8 from the whole pair and 22 from its latest row.
    const whole = [
      rate('06:00'),
      priceReading('P', 'USD', '8', utc(DAY, '07:00'), 'intraday', 'coingecko'),
      manual('P', 'USD', '10', utc(DAY, '08:00')),
      manual('P', CHF, '20', utc(DAY, '10:00')),
    ];

    for (const [time, expected] of [
      ['07:30', '8'],
      ['09:00', '10'],
      ['11:00', '22'],
    ] as const) {
      const fromWhole = priced(inUsd(whole, time));
      expect(fromWhole.price.toString()).toBe(expected);
      expect(inUsd(latestPerPair(whole, utc(DAY, time)), time)).toEqual(fromWhole);
    }
    expect(latestPerPair(whole, utc(DAY, '11:00'))).toHaveLength(3);
  });

  test('two manual prices at one instant: the finer, then the higher, then the greater base token id survives', () => {
    const t = utc(DAY, '12:00');
    const handed: Handed = { quoteTokenIds: quotes({ P: [CHF, GBP] }) };
    // Both rates are older than the typed prices, and the loser's is the fresher of the two:
    // on freshness alone the answer would go through the loser.
    const rates = (fresher: string) =>
      [CHF, GBP].map((currency) =>
        priceReading(
          currency,
          'USD',
          currency === CHF ? '1.1' : '1.3',
          utc(DAY, currency === fresher ? '11:30' : '11:00')
        )
      );
    const survivor = (inChf: PriceReading, inGbp: PriceReading, fresher: string): PriceAt => {
      const answer = (typed: PriceReading[]) =>
        priced(priceWith(handed, [...typed, ...rates(fresher)], 'USD', utc(DAY, '13:00'), P));
      const first = answer([inChf, inGbp]);
      expect(answer([inGbp, inChf])).toEqual(first);
      return first;
    };

    const finer = survivor(manual('P', CHF, '20', t), manual('P', GBP, '20', t, 'daily'), GBP);
    expect(finer.path).toBe(`quote:${CHF}`);
    const higher = survivor(manual('P', CHF, '21', t), manual('P', GBP, '20', t), GBP);
    expect(higher.path).toBe(`quote:${CHF}`);
    const greaterId = survivor(manual('P', CHF, '20', t), manual('P', GBP, '20', t), CHF);
    expect(greaterId.path).toBe(`quote:${GBP}`);
    // Time comes before all three.
    const later = survivor(
      manual('P', CHF, '20', utc(DAY, '12:15'), 'daily'),
      manual('P', GBP, '21', t),
      GBP
    );
    expect(later.path).toBe(`quote:${CHF}`);
  });
});

describe('priceAt: staleness per leg', () => {
  const at = utc('2026-03-01');
  const ago = (hours: number) => new Date(at.getTime() - hours * HOUR_MS);

  test('a custom asset through a quote currency is stale when that currency’s rate is past the fiat horizon', () => {
    const handed: Handed = {
      quoteTokenIds: quotes({ P: [CHF] }),
      assetClasses: classes({ [CHF]: 'fiat' }),
    };
    const through = (rateAgeHours: number) =>
      priced(
        priceWith(
          handed,
          [
            manual('P', CHF, '100', ago(400 * 24)),
            priceReading(CHF, 'USD', '1.1', ago(rateAgeHours)),
          ],
          'USD',
          at,
          P
        )
      );

    expect(through(119).stale).toBe(false);
    expect(through(121).stale).toBe(true);
    // The person's own price is a step: its age alone never makes the answer stale.
    expect(through(1).readingAt).toEqual(ago(400 * 24));
    expect(through(1).stale).toBe(false);
  });

  test('a crypto price an hour old through a 60-hour-old fiat rate is not stale', () => {
    const handed: Handed = { assetClasses: classes({ USD: 'fiat' }) };
    const through = (assetAgeHours: number, rateAgeHours: number) =>
      priced(
        priceWith(
          handed,
          [
            priceReading('X', 'USD', '10', ago(assetAgeHours)),
            priceReading('USD', 'EUR', '0.8', ago(rateAgeHours)),
          ],
          'EUR',
          at
        )
      );

    const weekend = through(1, 60);
    expect(weekend.path).toBe('hub:USD');
    expect(weekend.stale).toBe(false);
    // `readingAt` stays the oldest leg's time.
    expect(weekend.readingAt).toEqual(ago(60));

    expect(through(1, 121).stale).toBe(true);
    // The asset's own leg is judged by the asset's class.
    expect(through(47, 1).stale).toBe(false);
    expect(through(49, 1).stale).toBe(true);
  });

  test('every leg of a quote route through a hub is judged by its own token', () => {
    const handed: Handed = {
      quoteTokenIds: quotes({ P: [CHF] }),
      assetClasses: classes({ [CHF]: 'fiat', USDT: 'crypto' }),
    };
    const through = (chfAgeHours: number, usdtAgeHours: number) =>
      priced(
        priceWith(
          handed,
          [
            manual('P', CHF, '100', ago(400 * 24)),
            priceReading(CHF, 'USDT', '1.1', ago(chfAgeHours)),
            priceReading('USDT', GBP, '0.8', ago(usdtAgeHours)),
          ],
          GBP,
          at,
          P
        )
      );

    expect(through(100, 47).path).toBe(`quote:${CHF}:USDT`);
    expect(through(100, 47).stale).toBe(false);
    expect(through(100, 49).stale).toBe(true);
    expect(through(121, 47).stale).toBe(true);
  });

  test('a hub or quote token with no class handed is judged as unknown', () => {
    // A fiat asset an hour old through a 60-hour-old hub rate.
    const gbp: PriceAsset = { tokenId: GBP, assetClass: 'fiat' };
    const readings = [
      priceReading(GBP, 'USD', '1.3', ago(1)),
      priceReading('USD', 'EUR', '0.8', ago(60)),
    ];

    expect(priced(price(readings, 'EUR', at, gbp)).stale).toBe(true);
    expect(priced(priceWith({ assetClasses: classes({}) }, readings, 'EUR', at, gbp)).stale).toBe(
      true
    );

    // CONTROL: classed, the same rate is inside its own horizon.
    const classed: Handed = { assetClasses: classes({ USD: 'fiat' }) };
    expect(priced(priceWith(classed, readings, 'EUR', at, gbp)).stale).toBe(false);
  });
});
