import { describe, expect, test } from 'bun:test';
import {
  assetClassOf,
  priceAt,
  readingPairsFor,
  STALENESS_HORIZON_MS,
} from '../../src/engine/price-at';
import type {
  AssetClass,
  PriceAsset,
  PriceAt,
  PriceGranularity,
  PriceReading,
} from '../../src/engine/types';
import { priceReading, shuffled, utc } from './fixtures';

const HUBS = ['USD', 'USDT', 'EUR'];
const HOUR_MS = 3_600_000;
const DAY = '2026-01-10';
const X: PriceAsset = { tokenId: 'X', assetClass: 'crypto' };
const USD: PriceAsset = { tokenId: 'USD', assetClass: 'fiat' };

function price(
  readings: PriceReading[],
  base: string,
  at: Date,
  asset: PriceAsset = X,
  hubTokenIds: readonly string[] = HUBS
): PriceAt | null {
  return priceAt({ readings, hubTokenIds }, asset, base, at);
}

function priced(result: PriceAt | null): PriceAt {
  if (result === null) throw new Error('expected a price, got null');
  return result;
}

function pairKeys(pairs: Array<{ tokenId: string; baseTokenId: string }>): string[] {
  return pairs.map((p) => `${p.tokenId}/${p.baseTokenId}`);
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
    ];
    const variants = [readings.toReversed(), ...[7, 1234, 99991].map((s) => shuffled(readings, s))];
    const assets: PriceAsset[] = [X, USD, { tokenId: 'USDT', assetClass: 'crypto' }];
    const instants = [
      utc('2026-01-09', '12:00'),
      t0,
      utc(DAY, '12:00'),
      utc(DAY, '15:00'),
      utc('2026-01-20'),
    ];

    let answered = 0;
    for (const asset of assets) {
      for (const base of ['EUR', 'USD', 'USDT']) {
        for (const at of instants) {
          const original = price(readings, base, at, asset);
          if (original !== null) answered++;
          for (const variant of variants) {
            expect(price(variant, base, at, asset)).toEqual(original);
          }
        }
      }
    }
    expect(answered).toBeGreaterThanOrEqual(30);
  });
});
