import { describe, expect, test } from 'bun:test';
import type { HoldingEvidence, PriceAt } from '../../../src/engine/types';
import type { ClassifiedHolding } from '../../../src/services/foundation/legacy-classification';
import {
  BALANCE_DIFF_CATEGORIES,
  type BalanceComparator,
  compareBalance,
  comparePrice,
  type LegacyBalanceReading,
  type LegacyPriceReading,
  PRICE_DIFF_CATEGORIES,
  type PriceComparator,
  readingTimes,
  type ShadowDifference,
} from '../../../src/services/foundation/shadow-comparison';
import {
  checkpoint,
  entry,
  evidence,
  priceReading,
  quoted,
  shuffled,
  snap,
  utc,
  verification,
} from '../../engine/fixtures';

const AT = utc('2026-01-20');
const JAN_10 = utc('2026-01-10');
const HOUR_MS = 3_600_000;

function classified(
  holdingEvidence: HoldingEvidence,
  excluded: Partial<ClassifiedHolding['excluded']> = {}
): ClassifiedHolding {
  return {
    evidence: holdingEvidence,
    excluded: { fabricated: [], openings: [], corrections: [], ...excluded },
    labels: { holdingId: holdingEvidence.holdingId, holding: {}, observations: [], entries: [] },
    unlabelled: { holding: false, observations: 0, entries: 0 },
    notes: {},
  };
}

function legacyBalance(
  comparator: BalanceComparator,
  balance: string | null,
  fields: Partial<LegacyBalanceReading>
): LegacyBalanceReading {
  return {
    comparator,
    balance,
    absent: balance === null,
    interpolated: false,
    floored: false,
    lastUpdated: null,
    ...fields,
  };
}

function stored(balance: string, fields: Partial<LegacyBalanceReading> = {}) {
  return legacyBalance('stored-balance', balance, fields);
}

function atTime(balance: string | null, fields: Partial<LegacyBalanceReading> = {}) {
  return legacyBalance('balance-at-time', balance, fields);
}

/** Frozen all the way down, so a comparison that writes to its input throws. */
function deepFrozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFrozen(nested);
    Object.freeze(value);
  }
  return value;
}

const statementCheckpoint = () => checkpoint('cp', JAN_10, '100', { authority: 'statement' });
const deposit = () => entry('deposit', utc('2026-01-12'), '5');
const snapshot100 = () => evidence({ observations: [snap('s', JAN_10, '100')] });

/** A statement checkpoint and a later deposit: the engine reads 105 from Jan 12 on. */
const ledgerAhead = () =>
  classified(
    evidence({ kind: 'feed', observations: [statementCheckpoint()], entries: [deposit()] })
  );

/** The same, plus the "now" copy a file import wrote and the classifier excluded (O2). */
const withFabricatedCopy = () =>
  classified(
    evidence({ kind: 'feed', observations: [statementCheckpoint()], entries: [deposit()] }),
    { fabricated: [checkpoint('copy', utc('2026-01-15'), '100', { authority: 'person' })] }
  );

type BalanceCategory = (typeof BALANCE_DIFF_CATEGORIES)[number];
type PriceCategory = (typeof PRICE_DIFF_CATEGORIES)[number];

interface BalanceCase {
  category: BalanceCategory;
  name: string;
  holding: ClassifiedHolding;
  at: Date;
  legacy: LegacyBalanceReading;
  engineValue: string | null;
  legacyValue: string | null;
}

/** One per category, in the order the categories are tried. */
const BALANCE_CASES: BalanceCase[] = [
  {
    category: 'starts-at',
    name: 'the engine has no balance before the holding starts, the legacy reader has 5',
    holding: classified(snapshot100()),
    at: utc('2025-12-20'),
    legacy: stored('5'),
    engineValue: null,
    legacyValue: '5',
  },
  {
    category: 'fabricated-observation',
    name: 'the stored 100 is the excluded copy written at Jan 15, over a deposit the ledger carries',
    holding: withFabricatedCopy(),
    at: AT,
    legacy: stored('100'),
    engineValue: '105',
    legacyValue: '100',
  },
  {
    category: 'opening-row',
    name: 'an opening 1 ms before the earliest evidence, restored by lowering startsAt (SC-481)',
    holding: classified(
      evidence({
        kind: 'feed',
        startsAt: JAN_10,
        entries: [entry('deposit', JAN_10, '10')],
      }),
      { openings: [entry('opening', new Date(JAN_10.getTime() - 1), '50')] }
    ),
    at: AT,
    legacy: stored('60'),
    engineValue: '10',
    legacyValue: '60',
  },
  {
    category: 'legacy-correction-row',
    name: 'the history reader applies an excluded -20 correction row',
    holding: classified(snapshot100(), {
      corrections: [entry('correction', utc('2026-01-12'), '-20')],
    }),
    at: utc('2026-01-15'),
    legacy: atTime('80'),
    engineValue: '100',
    legacyValue: '80',
  },
  {
    category: 'verification-not-anchor',
    name: 'the stored 120 is a typed verification, which never anchors a feed',
    holding: classified(
      evidence({
        kind: 'feed',
        observations: [statementCheckpoint(), verification('v', utc('2026-01-15'), '120')],
      })
    ),
    at: AT,
    legacy: stored('120'),
    engineValue: '100',
    legacyValue: '120',
  },
  {
    category: 'driftAhead-interpolation',
    name: 'the history reader interpolated',
    holding: classified(snapshot100()),
    at: utc('2026-01-15'),
    legacy: atTime('90', { interpolated: true }),
    engineValue: '100',
    legacyValue: '90',
  },
  {
    category: 'floored-walk',
    name: 'the history reader floored a walk at zero',
    holding: classified(snapshot100()),
    at: utc('2026-01-15'),
    legacy: atTime('90', { floored: true }),
    engineValue: '100',
    legacyValue: '90',
  },
  {
    category: 'snapshot-first-anchor',
    name: 'before the first snapshot the engine holds its value',
    holding: classified(snapshot100()),
    at: utc('2026-01-05'),
    legacy: atTime('95'),
    engineValue: '100',
    legacyValue: '95',
  },
  {
    category: 'ledger-ahead-of-anchor',
    name: 'the stored 100 is the checkpoint, and the ledger has moved on',
    holding: ledgerAhead(),
    at: AT,
    legacy: stored('100'),
    engineValue: '105',
    legacyValue: '100',
  },
  {
    category: 'column-without-evidence',
    name: 'the column was written on Jan 18, after the last value the engine has',
    holding: classified(snapshot100()),
    at: AT,
    legacy: stored('130', { lastUpdated: utc('2026-01-18') }),
    engineValue: '100',
    legacyValue: '130',
  },
  {
    category: 'no-anchor',
    name: 'no value at all, so the column is not later than one',
    holding: classified(evidence({ kind: 'feed', entries: [entry('deposit', JAN_10, '10')] })),
    at: AT,
    legacy: stored('0', { lastUpdated: utc('2026-01-18') }),
    engineValue: '10',
    legacyValue: '0',
  },
  {
    category: 'unexplained',
    name: 'nothing above holds',
    holding: classified(snapshot100()),
    at: utc('2026-01-15'),
    legacy: atTime('77'),
    engineValue: '100',
    legacyValue: '77',
  },
];

describe('compareBalance', () => {
  for (const c of BALANCE_CASES) {
    test(`${c.category}: ${c.name}`, () => {
      const difference: ShadowDifference | null = compareBalance(c.holding, c.at, c.legacy);
      expect(difference).toMatchObject({
        comparator: c.legacy.comparator,
        category: c.category,
        at: c.at,
        engineValue: c.engineValue,
        legacyValue: c.legacyValue,
      });
    });
  }

  test('every category has a case, in the order they are tried', () => {
    expect(BALANCE_CASES.map((c) => c.category)).toEqual([...BALANCE_DIFF_CATEGORIES]);
  });

  test('starts-at: the engine has a balance where the legacy reader has none', () => {
    expect(
      compareBalance(classified(snapshot100()), utc('2026-01-15'), atTime(null))
    ).toMatchObject({ category: 'starts-at', engineValue: '100', legacyValue: null });
  });

  test('a match on the stored balance is not a difference, whatever its formatting', () => {
    expect(compareBalance(ledgerAhead(), AT, stored('105.000'))).toBeNull();
  });

  test('a match on the balance at a time is not a difference', () => {
    expect(compareBalance(classified(snapshot100()), utc('2026-01-15'), atTime('100'))).toBeNull();
  });

  test('both sides absent is a match', () => {
    expect(compareBalance(classified(snapshot100()), utc('2025-12-20'), atTime(null))).toBeNull();
  });

  test('the first category that holds names the difference', () => {
    // The fabricated case also satisfies ledger-ahead-of-anchor: forward, one entry, L = 100.
    expect(compareBalance(withFabricatedCopy(), AT, stored('100'))?.category).toBe(
      'fabricated-observation'
    );
    const verified = classified(
      evidence({
        kind: 'feed',
        observations: [statementCheckpoint(), verification('v', utc('2026-01-15'), '120')],
      })
    );
    expect(compareBalance(verified, AT, atTime('120', { interpolated: true }))?.category).toBe(
      'verification-not-anchor'
    );
    expect(
      compareBalance(
        classified(snapshot100()),
        utc('2026-01-15'),
        atTime('90', { interpolated: true, floored: true })
      )?.category
    ).toBe('driftAhead-interpolation');
  });

  test('only the latest unsuperseded verification at or before the instant counts', () => {
    const observations = [
      statementCheckpoint(),
      verification('v-old', utc('2026-01-12'), '120'),
      verification('v-early', utc('2026-01-15'), '130', { recordedAt: utc('2026-01-15', '10:00') }),
      verification('v-late', utc('2026-01-15'), '135', { recordedAt: utc('2026-01-15', '11:00') }),
      verification('v-gone', utc('2026-01-16'), '140', { supersededAt: utc('2026-01-17') }),
      verification('v-future', utc('2026-01-25'), '150'),
    ];
    for (const seed of [1, 2, 3, 4, 5]) {
      const holding = classified(
        evidence({ kind: 'feed', observations: shuffled(observations, seed) })
      );
      expect(compareBalance(holding, AT, stored('135'))?.category).toBe('verification-not-anchor');
      for (const other of ['120', '130', '140', '150']) {
        expect(compareBalance(holding, AT, stored(other))?.category).toBe('unexplained');
      }
    }
  });

  test('column-without-evidence needs the stored column, written after the anchor', () => {
    const holding = classified(snapshot100());
    expect(
      compareBalance(holding, AT, atTime('130', { lastUpdated: utc('2026-01-18') }))?.category
    ).toBe('unexplained');
    expect(compareBalance(holding, AT, stored('130', { lastUpdated: JAN_10 }))?.category).toBe(
      'unexplained'
    );
  });

  test('the counterfactuals restore a copy and leave the classified holding untouched', () => {
    const holding = deepFrozen(
      classified(snapshot100(), {
        fabricated: [snap('copy', utc('2026-01-15'), '100', { authority: 'person' })],
        openings: [entry('opening', new Date(JAN_10.getTime() - 1), '50')],
        corrections: [entry('correction', utc('2026-01-12'), '-20')],
      })
    );
    const first = compareBalance(holding, AT, stored('7'));
    expect(first).toMatchObject({ category: 'unexplained', engineValue: '100' });
    expect(compareBalance(holding, AT, stored('7'))).toEqual(first);
    expect(holding.evidence.observations).toHaveLength(1);
    expect(holding.evidence.entries).toHaveLength(0);
    expect(holding.evidence.startsAt).toEqual(utc('2026-01-01'));
  });

  test('detail carries the engine reading behind the difference', () => {
    expect(compareBalance(ledgerAhead(), AT, stored('100'))?.detail).toEqual({
      kind: 'feed',
      method: 'forward',
      anchorAt: '2026-01-10T00:00:00.000Z',
      entriesApplied: 1,
    });
    expect(
      compareBalance(classified(snapshot100()), utc('2025-12-20'), stored('5'))?.detail
    ).toEqual({ kind: 'snapshot', method: null, anchorAt: null, entriesApplied: null });
  });
});

const T = utc('2026-01-10', '12:00');
const ago = (ms: number) => new Date(T.getTime() - ms);

interface PriceInput {
  at: Date;
  engine: PriceAt | null;
  legacy: LegacyPriceReading;
  directReadingAt: Date | null;
  newestReadingAt: Date | null;
}

function legacyPrice(
  comparator: PriceComparator,
  price: string | null,
  readingAt: Date | null = null,
  path: string | null = null
): LegacyPriceReading {
  return { comparator, price, readingAt, path };
}

const live = (price: string | null) => legacyPrice('live-resolver', price);
const graph = (price: string | null, readingAt: Date | null, path: string | null) =>
  legacyPrice('price-graph', price, readingAt, path);

function priceInput(fields: Partial<PriceInput> & Pick<PriceInput, 'engine' | 'legacy'>) {
  return { at: T, directReadingAt: T, newestReadingAt: T, ...fields };
}

interface PriceCase {
  category: PriceCategory;
  name: string;
  input: PriceInput;
  engineValue: string | null;
  legacyValue: string | null;
}

/** One per category, in the order the categories are tried. */
const PRICE_CASES: PriceCase[] = [
  {
    category: 'engine-unpriced',
    name: 'the engine has no price, the live resolver has 9',
    input: priceInput({ engine: null, legacy: live('9'), directReadingAt: null }),
    engineValue: null,
    legacyValue: '9',
  },
  {
    category: 'legacy-unpriced',
    name: 'the engine has a price, the live resolver has none',
    input: priceInput({ engine: quoted('8', T, 'direct'), legacy: live(null) }),
    engineValue: '8',
    legacyValue: null,
  },
  {
    category: 'stale-fallback',
    name: 'the newest reading is 2 h old, outside the live window',
    input: priceInput({
      engine: quoted('8', ago(2 * HOUR_MS), 'direct'),
      legacy: live('9'),
      directReadingAt: ago(2 * HOUR_MS),
      newestReadingAt: ago(2 * HOUR_MS),
    }),
    engineValue: '8',
    legacyValue: '9',
  },
  {
    category: 'fresher-price',
    name: 'the graph read Jan 1, the engine a Jan 10 route',
    input: priceInput({
      engine: quoted('8', JAN_10, 'hub:USD'),
      legacy: graph('9', utc('2026-01-01'), 'direct'),
    }),
    engineValue: '8',
    legacyValue: '9',
  },
  {
    category: 'route',
    name: 'the same reading time through a different route',
    input: priceInput({
      engine: quoted('8', JAN_10, 'hub:USD'),
      legacy: graph('9', JAN_10, 'direct'),
    }),
    engineValue: '8',
    legacyValue: '9',
  },
  {
    category: 'fx-leg',
    name: 'the engine goes through a hub, the live resolver converts its own direct row',
    input: priceInput({
      engine: quoted('8', ago(HOUR_MS / 2), 'hub:USD'),
      legacy: live('9'),
      directReadingAt: ago(HOUR_MS / 2),
      newestReadingAt: ago(HOUR_MS / 2),
    }),
    engineValue: '8',
    legacyValue: '9',
  },
  {
    category: 'unexplained',
    name: 'the graph took the same hub at the same time and still disagrees',
    input: priceInput({
      engine: quoted('8', JAN_10, 'hub:USD'),
      legacy: graph('9', JAN_10, 'one-hop-USD'),
    }),
    engineValue: '8',
    legacyValue: '9',
  },
];

describe('comparePrice', () => {
  for (const c of PRICE_CASES) {
    test(`${c.category}: ${c.name}`, () => {
      expect(comparePrice(c.input)).toMatchObject({
        comparator: c.input.legacy.comparator,
        category: c.category,
        at: c.input.at,
        engineValue: c.engineValue,
        legacyValue: c.legacyValue,
      });
    });
  }

  test('every category has a case, in the order they are tried', () => {
    expect(PRICE_CASES.map((c) => c.category)).toEqual([...PRICE_DIFF_CATEGORIES]);
  });

  test('fresher-price: the live resolver read an older direct row than the engine route (SC-1477)', () => {
    const input = priceInput({
      engine: quoted('8', ago(HOUR_MS / 2), 'hub:USD'),
      legacy: live('9'),
      directReadingAt: utc('2026-01-01'),
      newestReadingAt: ago(HOUR_MS / 2),
    });
    expect(comparePrice(input)?.category).toBe('fresher-price');
  });

  test("the engine's inverse is the graph's direct, so the same route is unexplained", () => {
    const input = priceInput({
      engine: quoted('8', JAN_10, 'inverse'),
      legacy: graph('9', JAN_10, 'direct'),
    });
    expect(comparePrice(input)?.category).toBe('unexplained');
  });

  test('a live price from the same fresh direct reading that disagrees is unexplained', () => {
    const input = priceInput({ engine: quoted('8', T, 'direct'), legacy: live('9') });
    expect(comparePrice(input)?.category).toBe('unexplained');
    // Only a route other than direct can be fresher than the live resolver's direct row.
    expect(comparePrice({ ...input, directReadingAt: utc('2026-01-01') })?.category).toBe(
      'unexplained'
    );
  });

  test('a graph reading newer than the engine route is unexplained, whatever its path', () => {
    const input = priceInput({
      engine: quoted('8', utc('2026-01-01'), 'hub:USD'),
      legacy: graph('9', JAN_10, 'direct'),
    });
    expect(comparePrice(input)?.category).toBe('unexplained');
  });

  test('the live window is one hour, and a reading exactly that old is still live', () => {
    const at = (age: number) =>
      priceInput({
        engine: quoted('8', ago(age), 'direct'),
        legacy: live('9'),
        directReadingAt: ago(age),
        newestReadingAt: ago(age),
      });
    expect(comparePrice(at(HOUR_MS))?.category).toBe('unexplained');
    expect(comparePrice(at(HOUR_MS + 1))?.category).toBe('stale-fallback');
    expect(
      comparePrice({ ...at(HOUR_MS), newestReadingAt: null, directReadingAt: null })?.category
    ).toBe('stale-fallback');
  });

  test('a live price within a relative 1e-9 is a match', () => {
    expect(
      comparePrice(priceInput({ engine: quoted('9', T, 'direct'), legacy: live('9.0000000001') }))
    ).toBeNull();
    expect(
      comparePrice(priceInput({ engine: quoted('9', T, 'direct'), legacy: live('9.00000001') }))
    ).not.toBeNull();
  });

  test('a graph price that agrees is a match, whatever route it took', () => {
    const input = priceInput({
      engine: quoted('8', JAN_10, 'hub:USD'),
      legacy: graph('8.000', utc('2026-01-01'), 'direct'),
    });
    expect(comparePrice(input)).toBeNull();
  });

  test('neither side priced is a match for both comparators', () => {
    expect(comparePrice(priceInput({ engine: null, legacy: live(null) }))).toBeNull();
    expect(comparePrice(priceInput({ engine: null, legacy: graph(null, null, null) }))).toBeNull();
  });

  test('detail carries the readings behind the category', () => {
    const input = priceInput({
      engine: quoted('8', JAN_10, 'hub:USD', true),
      legacy: graph('9', JAN_10, 'one-hop-USD'),
      directReadingAt: utc('2026-01-01'),
      newestReadingAt: JAN_10,
    });
    expect(comparePrice(input)?.detail).toEqual({
      enginePath: 'hub:USD',
      engineReadingAt: '2026-01-10T00:00:00.000Z',
      engineStale: true,
      legacyPath: 'one-hop-USD',
      legacyReadingAt: '2026-01-10T00:00:00.000Z',
      directReadingAt: '2026-01-01T00:00:00.000Z',
      newestReadingAt: '2026-01-10T00:00:00.000Z',
    });
  });
});

describe('readingTimes', () => {
  test("the newest direct reading and the newest of the token's own readings in any base, a zero row included", () => {
    const readings = [
      priceReading('X', 'EUR', '9', utc('2026-02-01')),
      priceReading('X', 'EUR', '9.5', utc('2026-02-10')),
      priceReading('X', 'EUR', '0', utc('2026-02-20')),
      priceReading('EUR', 'X', '0.1', utc('2026-02-25')),
      priceReading('Y', 'EUR', '1', utc('2026-02-28')),
      priceReading('X', 'USD', '10', utc('2026-03-01')),
      priceReading('X', 'USD', '11', utc('2026-03-02')),
    ];
    for (const seed of [1, 2, 3]) {
      expect(
        readingTimes(shuffled(readings, seed), 'X', 'EUR', utc('2026-03-01', '00:30'))
      ).toEqual({ directReadingAt: utc('2026-02-20'), newestReadingAt: utc('2026-03-01') });
    }
  });

  test('no readings give no times', () => {
    expect(readingTimes([], 'X', 'EUR', T)).toEqual({
      directReadingAt: null,
      newestReadingAt: null,
    });
  });
});
