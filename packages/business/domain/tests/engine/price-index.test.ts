import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import { priceAt } from '../../src/engine/price-at';
import { bestReading, indexPriceEvidence, type PriceIndex } from '../../src/engine/price-index';
import type {
  AssetClass,
  PriceAsset,
  PriceAt,
  PriceEvidence,
  PriceGranularity,
  PriceReading,
} from '../../src/engine/types';
import { priceReading, shuffled, utc } from './fixtures';

const HUBS = ['USD', 'EUR'];
const HOUR_MS = 3_600_000;
const DAY = '2026-01-10';
const CHF = 'CHF';
const X: PriceAsset = { tokenId: 'X', assetClass: 'crypto' };
const USD: PriceAsset = { tokenId: 'USD', assetClass: 'fiat' };
/** A private company: priced by a person, in whatever currency they typed. */
const P: PriceAsset = { tokenId: 'P', assetClass: 'custom' };

/** One day of readings, out of order. A fresh one each time, so a test may change it. */
function oneDay(): PriceEvidence {
  const at = (time: string) => utc(DAY, time);
  const readings = [
    priceReading('X', 'USD', '10', at('08:00'), 'intraday', 'coingecko'),
    // Nearer than the reading above, and not prices.
    priceReading('X', 'USD', '0', at('09:00'), 'intraday', 'coingecko'),
    priceReading('X', 'USD', '-5', at('09:30'), 'intraday', 'coingecko'),
    // One instant, and the coarser reading is the higher.
    priceReading('X', 'USD', '12', at('12:00'), 'daily', 'kraken'),
    priceReading('X', 'USD', '11', at('12:00'), 'intraday', 'coingecko'),
    priceReading('EUR', 'USD', '1.25', at('07:00'), 'intraday', 'frankfurter'),
    priceReading('USD', 'EUR', '0.5', at('11:00'), 'intraday', 'frankfurter'),
    priceReading(CHF, 'USD', '1.1', at('06:00'), 'intraday', 'frankfurter'),
    // A person's price, then their correction in another currency.
    priceReading('P', 'USD', '10', at('08:00'), 'intraday', 'manual'),
    priceReading('P', CHF, '20', at('12:00'), 'intraday', 'manual'),
  ];
  return {
    readings: shuffled(readings, 7),
    hubTokenIds: [...HUBS],
    quoteTokenIds: new Map([['P', [CHF]]]),
    assetClasses: new Map<string, AssetClass>([
      ['USD', 'fiat'],
      ['EUR', 'fiat'],
      [CHF, 'fiat'],
    ]),
  };
}

type Told = readonly [
  price: string,
  path: string,
  readingAt: Date,
  stale: boolean,
  source: string | null,
];

function told(answer: PriceAt | null): Told | null {
  return answer === null
    ? null
    : [answer.price.toString(), answer.path, answer.readingAt, answer.stale, answer.source];
}

/** Worked by hand from `oneDay`, and in no order of time: an index serves every instant. */
const ASKS: ReadonlyArray<readonly [PriceAsset, base: string, at: Date, Told | null]> = [
  [X, 'USD', utc(DAY, '13:00'), ['11', 'direct', utc(DAY, '12:00'), false, 'coingecko']],
  [X, 'USD', utc(DAY, '07:00'), null],
  [X, 'USD', utc(DAY, '08:00'), ['10', 'direct', utc(DAY, '08:00'), false, 'coingecko']],
  [X, 'USD', utc(DAY, '10:00'), ['10', 'direct', utc(DAY, '08:00'), false, 'coingecko']],
  [X, 'USD', utc('2026-01-13', '13:00'), ['11', 'direct', utc(DAY, '12:00'), true, 'coingecko']],
  [X, 'EUR', utc(DAY, '13:00'), ['5.5', 'hub:USD', utc(DAY, '11:00'), false, 'coingecko']],
  [X, 'EUR', utc(DAY, '10:00'), ['8', 'hub:USD', utc(DAY, '07:00'), false, 'coingecko']],
  [USD, 'X', utc(DAY, '10:00'), ['0.1', 'inverse', utc(DAY, '08:00'), false, 'coingecko']],
  [USD, 'USD', utc(DAY, '10:00'), ['1', 'identity', utc(DAY, '10:00'), false, null]],
  // The correction supersedes the earlier price from 12:00, and not before.
  [P, 'USD', utc(DAY, '13:00'), ['22', `quote:${CHF}`, utc(DAY, '06:00'), false, 'manual']],
  [P, 'USD', utc(DAY, '10:00'), ['10', 'direct', utc(DAY, '08:00'), false, 'manual']],
];

/**
 * Every part of `value` that can still be written to: an object left unfrozen,
 * or a collection, which freezing does not close. A date and a decimal are
 * leaves: neither can be frozen.
 */
function writable(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) return [];
  if (value instanceof Date || Decimal.isDecimal(value)) return [];
  if (value instanceof Map || value instanceof Set || !Object.isFrozen(value)) return [path];
  return Object.entries(value).flatMap(([key, part]) => writable(part, `${path}.${key}`));
}

/** `token_prices.price` is text with no check: none of these is a price. */
const NOT_PRICES = [
  '',
  ' 1.5',
  '1,5',
  'undefined',
  'null',
  'NaN',
  'Infinity',
  '-Infinity',
  '0',
  '-0',
  '-1',
];

const TEN = utc(DAY, '10:00');

/** What X in USD at 10:00 is, asked of the evidence and of its index, or what was thrown. */
function bothForms(readings: PriceReading[]): unknown {
  try {
    const evidence: PriceEvidence = { readings, hubTokenIds: HUBS };
    return [
      told(priceAt(evidence, X, 'USD', TEN)),
      told(priceAt(indexPriceEvidence(evidence), X, 'USD', TEN)),
    ];
  } catch (error) {
    return `threw ${(error as Error).message}`;
  }
}

function byText(readings: (text: string) => PriceReading[]): Record<string, unknown> {
  return Object.fromEntries(NOT_PRICES.map((text) => [text, bothForms(readings(text))]));
}

function everyText(answer: Told | null): Record<string, unknown> {
  return Object.fromEntries(NOT_PRICES.map((text) => [text, [answer, answer]]));
}

/** MINSTD, so a world that fails comes back from its seed. */
function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 48271) % 2147483647;
    return state % below;
  };
}

const WORLD_PAIRS = [
  ['X', 'USD'],
  ['X', 'EUR'],
  ['USD', 'X'],
  ['Y', 'USD'],
] as const;
const WORLD_PRICES = ['10', '10.0', '1e1', '9.5', '11', ...NOT_PRICES];
const WORLD_SOURCES = [null, 'coingecko', 'kraken', 'manual'];
// `token_prices.granularity` is text too.
const WORLD_GRANULARITIES = ['tx-exact', 'intraday', 'daily', 'weekly'] as PriceGranularity[];

/**
 * Up to a dozen readings over three instants: some without an instant, some
 * twice, and some beside another of their pair at its instant, differing from
 * it in granularity, price or source alone.
 */
function world(next: (below: number) => number): PriceReading[] {
  const pick = <T>(items: readonly T[]): T => items[next(items.length)] as T;
  const readings: PriceReading[] = [];
  const count = 1 + next(12);
  while (readings.length < count) {
    const roll = readings.length === 0 ? 9 : next(10);
    if (roll < 5) {
      const like = pick(readings);
      const copy = { ...like, at: new Date(like.at.getTime()) };
      if (roll === 0) readings.push(copy);
      else if (roll === 1) readings.push({ ...copy, granularity: pick(WORLD_GRANULARITIES) });
      else if (roll === 2) readings.push({ ...copy, price: pick(WORLD_PRICES) });
      else readings.push({ ...copy, source: pick(WORLD_SOURCES) });
      continue;
    }
    const [tokenId, baseTokenId] = pick(WORLD_PAIRS);
    const at = next(10) === 0 ? new Date(Number.NaN) : utc(DAY, pick(['06:00', '07:00', '08:00']));
    readings.push(
      priceReading(
        tokenId,
        baseTokenId,
        pick(WORLD_PRICES),
        at,
        pick(WORLD_GRANULARITIES),
        pick(WORLD_SOURCES)
      )
    );
  }
  return readings;
}

/** Before the first of the pair's instants, at each, between each two, after the last, and at none. */
function asksOf(readings: readonly PriceReading[], from: string, to: string): Date[] {
  const times = [
    ...new Set(
      readings
        .filter((r) => r.tokenId === from && r.baseTokenId === to)
        .map((r) => r.at.getTime())
        .filter((time) => !Number.isNaN(time))
    ),
  ].sort((a, b) => a - b);
  const first = times[0] ?? utc(DAY, '12:00').getTime();
  const last = times.at(-1) ?? first;
  const between = times.slice(1).map((time, i) => (time + (times[i] as number)) / 2);
  return [first - HOUR_MS, ...times, ...between, last + HOUR_MS, Number.NaN].map(
    (time) => new Date(time)
  );
}

const RANKS: Readonly<Record<string, number>> = { 'tx-exact': 3, intraday: 2, daily: 1 };

/** The rule read straight off, as a scan: of the pair's readings at or before T, the greatest. */
function oracle(
  readings: readonly PriceReading[],
  from: string,
  to: string,
  at: Date
): PriceReading | null {
  let top: PriceReading | null = null;
  for (const reading of readings) {
    const counts =
      reading.tokenId === from &&
      reading.baseTokenId === to &&
      isReading(reading) &&
      reading.at.getTime() <= at.getTime();
    if (counts && (top === null || outranks(reading, top))) top = reading;
  }
  return top;
}

/** A positive finite price at a real instant. */
function isReading(reading: PriceReading): boolean {
  if (Number.isNaN(reading.at.getTime())) return false;
  try {
    const price = new Decimal(reading.price);
    return price.isFinite() && price.gt(0);
  } catch {
    return false;
  }
}

/** Later, then finer, then higher, then the greater source, with no source lowest. */
function outranks(a: PriceReading, b: PriceReading): boolean {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime > 0;
  const byRank = (RANKS[a.granularity] ?? 0) - (RANKS[b.granularity] ?? 0);
  if (byRank !== 0) return byRank > 0;
  const byPrice = new Decimal(a.price).comparedTo(b.price);
  if (byPrice !== 0) return byPrice > 0;
  if (a.source === null || b.source === null) return b.source === null && a.source !== null;
  return a.source > b.source;
}

describe('indexPriceEvidence', () => {
  test('an index answers exactly as the evidence does', () => {
    const evidence = oneDay();
    const index = indexPriceEvidence(evidence);

    for (const [asset, base, at, expected] of ASKS) {
      const answer = priceAt(index, asset, base, at);
      expect(told(answer)).toEqual(expected);
      expect(answer).toStrictEqual(priceAt(evidence, asset, base, at));
    }
    expect(index.hubTokenIds).toEqual(HUBS);
  });

  test('an index is frozen, and an answer never changes it', () => {
    const evidence = oneDay();
    const index = indexPriceEvidence(evidence);

    expect(writable(index)).toEqual([]);
    // CONTROL: the walk reports an unfrozen part, and a collection under a frozen one.
    const loose = Object.freeze({ list: [], held: Object.freeze({ map: new Map() }) });
    expect(writable(loose)).toEqual(['$.list', '$.held.map']);

    const before = JSON.stringify(index);
    // CONTROL: the snapshot reaches the readings.
    expect(before).toContain('frankfurter');
    const answers = () => ASKS.map(([asset, base, at]) => told(priceAt(index, asset, base, at)));
    const first = answers();
    expect(JSON.stringify(index)).toBe(before);

    // An index keeps lists of its own. The evidence stays the caller's to change (frozen,
    // each of these lines would throw), and no change to it reaches an index already built.
    (evidence.readings as PriceReading[]).length = 0;
    (evidence.hubTokenIds as string[]).reverse();
    (evidence.quoteTokenIds as Map<string, readonly string[]>).clear();
    (evidence.assetClasses as Map<string, AssetClass>).clear();
    expect(JSON.stringify(index)).toBe(before);
    expect(answers()).toEqual(first);
    // CONTROL: the changes were ones an answer depends on.
    expect(told(priceAt(evidence, P, 'USD', utc(DAY, '13:00')))).toBeNull();
    expect(first.filter((answer) => answer !== null)).toHaveLength(10);
  });

  test('the lists inside an index are closed, and the caller’s lists stay open', () => {
    const evidence = oneDay();
    const index = indexPriceEvidence(evidence);
    const before = JSON.stringify(index);
    const pair = index.pairs.X?.USD as unknown[];
    const quotes = index.quoteTokenIds.P as string[];
    // CONTROL: both lists are there to write to.
    expect(pair).toHaveLength(3);
    expect(quotes).toEqual([CHF]);

    expect(() => pair.push(pair[0])).toThrow(TypeError);
    expect(() => {
      pair[0] = pair[1];
    }).toThrow(TypeError);
    expect(() => quotes.push('EUR')).toThrow(TypeError);
    expect(() => {
      quotes[0] = 'EUR';
    }).toThrow(TypeError);
    expect(JSON.stringify(index)).toBe(before);

    // Indexing froze none of the caller's own lists.
    (evidence.hubTokenIds as string[]).push(CHF);
    (evidence.quoteTokenIds?.get('P') as string[] | undefined)?.push('EUR');
    (evidence.readings as PriceReading[]).push(priceReading('X', 'USD', '1', utc(DAY, '23:00')));
    expect(evidence.hubTokenIds).toEqual([...HUBS, CHF]);
    expect(evidence.quoteTokenIds?.get('P')).toEqual([CHF, 'EUR']);
    expect(evidence.readings).toHaveLength(11);
    expect(JSON.stringify(index)).toBe(before);
  });

  test('an index holds no Date anyone else does: changing an answer or the evidence changes no later answer', () => {
    const evidence = oneDay();
    const index = indexPriceEvidence(evidence);
    const untouched = indexPriceEvidence(oneDay());
    const answers = (of: PriceIndex) =>
      ASKS.map(([asset, base, at]) => priceAt(of, asset, base, at));

    const answer = priceAt(index, X, 'USD', utc(DAY, '13:00'));
    // Back past the pair's earlier reading, where an order kept on this Date would misplace it.
    answer?.readingAt.setUTCHours(6);
    expect(answers(index)).toStrictEqual(answers(untouched));

    for (const reading of evidence.readings) reading.at.setUTCFullYear(2030);
    expect(answers(index)).toStrictEqual(answers(untouched));
    // CONTROL: both changes took, and the second is one an answer depends on.
    expect(answer?.readingAt).toEqual(utc(DAY, '06:00'));
    expect(priceAt(evidence, X, 'USD', utc(DAY, '13:00'))).toBeNull();
  });

  test('5,000 readings of one pair: the reading at or before T', () => {
    const MINUTE_MS = 60_000;
    const start = utc(DAY).getTime();
    const minute = (n: number) => start + n * MINUTE_MS;
    // Reading n is priced n and taken n minutes into the day.
    const readings = Array.from({ length: 5000 }, (_, i) =>
      priceReading('X', 'USD', String(i + 1), new Date(minute(i + 1)))
    );
    const evidence: PriceEvidence = { readings: shuffled(readings, 7), hubTokenIds: HUBS };
    const index = indexPriceEvidence(evidence);
    let reads = 0;
    // The same index with each look at one of the pair's readings counted, which is what
    // tells a search from a scan.
    const watched: PriceIndex = {
      ...index,
      pairs: {
        X: {
          USD: new Proxy(index.pairs.X?.USD ?? [], {
            get(readings, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
              return Reflect.get(readings, key, receiver);
            },
          }),
        },
      },
    };
    const asked = (n: number) => {
      const at = new Date(minute(n));
      reads = 0;
      const answer = priceAt(watched, X, 'USD', at);
      const counted = reads;
      expect(priceAt(index, X, 'USD', at)).toStrictEqual(answer);
      expect(priceAt(evidence, X, 'USD', at)).toStrictEqual(answer);
      return {
        price: answer?.price.toString() ?? null,
        readingAt: answer?.readingAt.getTime() ?? null,
        reads: counted,
      };
    };

    const between = asked(2499.5);
    expect(between.price).toBe('2499');
    expect(between.readingAt).toBe(minute(2499));
    // A reading exactly at T is at or before it.
    expect(asked(2500).price).toBe('2500');
    const beforeTheFirst = asked(0.5);
    expect(beforeTheFirst.price).toBeNull();
    expect(asked(1).price).toBe('1');
    expect(asked(5000).price).toBe('5000');
    expect(asked(9000).price).toBe('5000');

    // A search, not a scan of the pair: a scan to the middle reads 2,499 readings or more.
    // CONTROL: the count sees the readings an answer looks at.
    for (const answer of [between, beforeTheFirst]) {
      expect(answer.reads).toBeGreaterThan(0);
      expect(answer.reads).toBeLessThan(50);
    }
  });

  test('at one instant the finer reading stands, then the higher, then the greater source, in whatever order they arrive', () => {
    const t = utc(DAY, '09:00');
    const stands = (readings: PriceReading[]): Array<string | null> =>
      [readings, readings.toReversed(), shuffled(readings, 7), shuffled(readings, 99991)].map(
        (arrived) => {
          const index = indexPriceEvidence({ readings: arrived, hubTokenIds: HUBS });
          const answer = priceAt(index, X, 'USD', utc(DAY, '10:00'));
          return answer === null ? null : `${answer.price} ${answer.source}`;
        }
      );
    const everyOrder = (answer: string) => [answer, answer, answer, answer];

    // The coarser the reading the higher its price: an order that left granularity out
    // would take the daily one.
    const granularities = [
      priceReading('X', 'USD', '12', t, 'daily', 'kraken'),
      priceReading('X', 'USD', '11', t, 'intraday', 'kraken'),
      priceReading('X', 'USD', '10', t, 'tx-exact', 'coingecko'),
    ];
    expect(stands(granularities)).toEqual(everyOrder('10 coingecko'));

    // The higher price has the lesser source: an order that put the source first would
    // take the other.
    const prices = [
      priceReading('X', 'USD', '10', t, 'intraday', 'kraken'),
      priceReading('X', 'USD', '10.5', t, 'intraday', 'coingecko'),
    ];
    expect(stands(prices)).toEqual(everyOrder('10.5 coingecko'));

    const sources = [
      priceReading('X', 'USD', '10', t, 'intraday', null),
      priceReading('X', 'USD', '10', t, 'intraday', 'kraken'),
      priceReading('X', 'USD', '10', t, 'intraday', 'coingecko'),
    ];
    expect(stands(sources)).toEqual(everyOrder('10 kraken'));

    // A later reading stands over all three.
    const later = priceReading('X', 'USD', '9', utc(DAY, '09:01'), 'daily', null);
    expect(stands([...granularities, later, ...prices, ...sources])).toEqual(everyOrder('9 null'));
  });

  test('a token named as something every object carries is a token like any other', () => {
    // Token ids are text, and an index looks things up by id. 'constructor' is on every
    // ordinary object, so a lookup there would answer for a token nobody handed.
    const named = 'constructor';
    const at = utc('2026-03-01');
    const ago = (hours: number) => new Date(at.getTime() - hours * HOUR_MS);
    const evidence: PriceEvidence = {
      readings: [
        priceReading('X', named, '10', ago(1)),
        priceReading(named, 'USD', '0.5', ago(60)),
        priceReading(named, 'EUR', '2', ago(1)),
      ],
      hubTokenIds: [named],
    };
    const index = indexPriceEvidence(evidence);

    // No class was handed for the hub, so its leg is judged as unknown: stale past 48 hours.
    const throughIt = priceAt(index, X, 'USD', at);
    expect(told(throughIt)).toEqual(['5', `hub:${named}`, ago(60), true, null]);
    expect(priceAt(evidence, X, 'USD', at)).toStrictEqual(throughIt);
    // Nor was it handed any quote currency, as an asset.
    const itself = priceAt(index, { tokenId: named, assetClass: 'crypto' }, 'EUR', at);
    expect(told(itself)).toEqual(['2', 'direct', ago(1), false, null]);
  });

  test('a reading with no instant is at or before no T, and hides nothing', () => {
    const never = new Date(Number.NaN);
    // Priced between the other two, which is where an order by price would put it and
    // where a search for the later one looks first.
    const readings = [
      priceReading('X', 'USD', '10', utc(DAY, '08:00')),
      priceReading('X', 'USD', '10.5', never),
      priceReading('X', 'USD', '11', utc(DAY, '12:00')),
    ];

    for (const arrived of [readings, readings.toReversed(), shuffled(readings, 7)]) {
      const evidence: PriceEvidence = { readings: arrived, hubTokenIds: HUBS };
      const index = indexPriceEvidence(evidence);
      const prices = [utc(DAY, '07:00'), utc(DAY, '10:00'), utc(DAY, '13:00'), never].map((at) => {
        const answer = priceAt(index, X, 'USD', at);
        expect(priceAt(evidence, X, 'USD', at)).toStrictEqual(answer);
        return answer?.price.toString() ?? null;
      });
      // Nor is any reading at or before an instant that is not one.
      expect(prices).toEqual([null, '10', '11', null]);
    }
  });

  test('the best reading is the one a scan of the rule picks, over seeded worlds', () => {
    const tally = { worlds: 0, asks: 0, priced: 0, wonOnPrice: 0, wonOnSource: 0 };
    const mismatches: unknown[] = [];
    for (const seed of [7, 4242, 99991]) {
      const next = random(seed);
      for (let n = 0; n < 100; n++) {
        const readings = world(next);
        const index = indexPriceEvidence({ readings, hubTokenIds: [] });
        tally.worlds += 1;
        for (const [from, to] of [...WORLD_PAIRS, ['Z', 'USD'] as const]) {
          for (const at of asksOf(readings, from, to)) {
            const found = bestReading(index, from, to, at);
            const pick = oracle(readings, from, to, at);
            const got = found && [
              found.price.toString(),
              found.at.getTime(),
              found.rank,
              found.source,
            ];
            const want = pick && [
              new Decimal(pick.price).toString(),
              pick.at.getTime(),
              RANKS[pick.granularity] ?? 0,
              pick.source,
            ];
            tally.asks += 1;
            if (!Bun.deepEquals(got, want)) {
              mismatches.push({ seed, world: n, from, to, at: at.getTime(), got, want });
            }
            if (pick === null) continue;
            tally.priced += 1;
            const rivals = readings.filter(
              (r) =>
                r.tokenId === from &&
                r.baseTokenId === to &&
                isReading(r) &&
                r.at.getTime() === pick.at.getTime() &&
                (RANKS[r.granularity] ?? 0) === (RANKS[pick.granularity] ?? 0)
            );
            const samePrice = rivals.filter((r) => new Decimal(r.price).eq(pick.price));
            if (samePrice.length < rivals.length) tally.wonOnPrice += 1;
            if (samePrice.some((r) => r.source !== pick.source)) tally.wonOnSource += 1;
          }
        }
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(mismatches).toHaveLength(0);
    // CONTROL: the worlds were built and asked, some asks were priced, and some were
    // decided only by price, or only by source, among readings at one instant.
    expect(tally).toEqual({
      worlds: 300,
      asks: 5550,
      priced: 754,
      wonOnPrice: 24,
      wonOnSource: 102,
    });
  });
});

describe('a price text that is not a positive finite number is not a reading', () => {
  test('as the nearest reading of a pair, the older reading answers', () => {
    const older = priceReading('X', 'USD', '10', utc(DAY, '08:00'));
    const nearest = (text: string) => [older, priceReading('X', 'USD', text, utc(DAY, '09:00'))];

    expect(byText(nearest)).toEqual(everyText(['10', 'direct', utc(DAY, '08:00'), false, null]));
    // CONTROL: a price there answers from there, written in exponent form as two stored rows are.
    const exponent: Told = ['25', 'direct', utc(DAY, '09:00'), false, null];
    expect(bothForms(nearest('2.5e1'))).toEqual([exponent, exponent]);
  });

  test('in a pair the ask does not route through, the answer is unchanged', () => {
    const routed = [priceReading('X', 'USD', '10', utc(DAY, '08:00'))];
    const alone: Told = ['10', 'direct', utc(DAY, '08:00'), false, null];
    // GBP is neither a hub nor a quote currency of X; the price shadow hands such rows over.
    const unrouted = (text: string) => [
      ...routed,
      priceReading('Y', 'GBP', text, utc(DAY, '09:00')),
    ];

    expect(bothForms(routed)).toEqual([alone, alone]);
    expect(byText(unrouted)).toEqual(everyText(alone));
  });

  test('a pair with no other reading is unpriced', () => {
    const only = (text: string) => [priceReading('X', 'USD', text, utc(DAY, '09:00'))];
    const every = NOT_PRICES.map((text, i) =>
      priceReading('X', 'USD', text, new Date(utc(DAY, '09:00').getTime() - i * HOUR_MS))
    );

    expect(byText(only)).toEqual(everyText(null));
    expect(bothForms(every)).toEqual([null, null]);
  });
});
