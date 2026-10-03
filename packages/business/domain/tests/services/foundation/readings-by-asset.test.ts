import { describe, expect, test } from 'bun:test';
import { priceAt } from '../../../src/engine/price-at';
import { PRICE_GRANULARITIES, type PriceReading } from '../../../src/engine/types';
import { readingsByAsset } from '../../../src/services/foundation/readings-by-asset';
import { readingTimes } from '../../../src/services/foundation/shadow-comparison';
import { priceReading, utc } from '../../engine/fixtures';

const HUBS = ['USD', 'USDT', 'EUR'];
// Two bases below: EUR, a hub, and GBP, which is not one.
const TOKENS = ['X', 'Y', 'Z', 'GBP', ...HUBS];
const HOUR_MS = 3_600_000;

/** MINSTD, so a failing fixture reproduces from its seed. */
function generator(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 48271) % 2147483647;
    return state % below;
  };
}

/**
 * Up to two readings between every ordered pair of tokens, at random hours
 * over three days and at random granularities, a quarter of them priced at
 * zero: wider than any loader's list, so the share is tested against readings
 * it must leave out as well as ones it must keep.
 */
function fixture(seed: number): PriceReading[] {
  const next = generator(seed);
  const readings: PriceReading[] = [];
  for (const from of TOKENS) {
    for (const to of TOKENS) {
      if (from === to) continue;
      for (let i = next(3); i > 0; i--) {
        const price = next(4) === 0 ? '0' : String(1 + next(1000) / 10);
        const when = new Date(utc('2026-02-27').getTime() + next(72) * HOUR_MS);
        readings.push(priceReading(from, to, price, when, PRICE_GRANULARITIES[next(3)] ?? 'daily'));
      }
    }
  }
  return readings;
}

describe('readingsByAsset', () => {
  test("priceAt and readingTimes answer from an asset's share exactly as from every reading", () => {
    const routes = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const readings = fixture(seed);
      for (const base of ['EUR', 'GBP']) {
        const shareOf = readingsByAsset(readings, base, HUBS);
        for (const tokenId of TOKENS) {
          const asset = { tokenId, assetClass: 'crypto' as const };
          const share = shareOf(tokenId);
          for (const at of [utc('2026-02-28'), utc('2026-03-01', '12:00'), utc('2026-03-03')]) {
            const whole = priceAt({ readings, hubTokenIds: HUBS }, asset, base, at);
            expect(priceAt({ readings: share, hubTokenIds: HUBS }, asset, base, at)).toEqual(whole);
            expect(readingTimes(share, tokenId, base, at)).toEqual(
              readingTimes(readings, tokenId, base, at)
            );
            if (whole !== null) routes.add(whole.path.startsWith('hub:') ? 'hub' : whole.path);
          }
        }
      }
    }
    // Not vacuous: every kind of route was taken somewhere.
    expect(routes).toEqual(new Set(['identity', 'direct', 'inverse', 'hub']));
  });

  test("an asset's share keeps its own readings and those between the base and the hubs, and no other asset's", () => {
    const own = [
      priceReading('X', 'EUR', '9', utc('2026-03-01')),
      priceReading('GBP', 'X', '2', utc('2026-03-01')),
    ];
    const between = [
      priceReading('EUR', 'USD', '1.25', utc('2026-03-01')),
      priceReading('USDT', 'USD', '1', utc('2026-03-01')),
    ];
    const others = [
      priceReading('Y', 'EUR', '3', utc('2026-03-01')),
      priceReading('Y', 'GBP', '4', utc('2026-03-01')),
    ];

    const share = readingsByAsset([...others, ...between, ...own], 'EUR', HUBS)('X');

    expect(new Set(share)).toEqual(new Set([...own, ...between]));
    expect(share).toHaveLength(own.length + between.length);
  });
});
