import { describe, expect, test } from 'bun:test';
import type { HoldingEvidence } from '../../../src/engine/types';
import type { ClassifiedHolding } from '../../../src/services/foundation/legacy-classification';
import {
  BALANCE_DIFF_CATEGORIES,
  compareBalance,
  type LegacyBalanceReading,
  type ShadowDifference,
} from '../../../src/services/foundation/shadow-comparison';
import {
  checkpoint,
  entry,
  evidence,
  shuffled,
  snap,
  utc,
  verification,
} from '../../engine/fixtures';

const AT = utc('2026-01-20');
const JAN_10 = utc('2026-01-10');

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
    feedBeganAt: undefined,
  };
}

/** Written before any value the engine has, unless a case says otherwise. */
const LONG_AGO = utc('2025-01-01');

function stored(balance: string, fields: Partial<LegacyBalanceReading> = {}): LegacyBalanceReading {
  return { balance, lastUpdated: LONG_AGO, ...fields };
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
    name: 'the stored 80 applies an excluded -20 correction row',
    holding: classified(snapshot100(), {
      corrections: [entry('correction', utc('2026-01-12'), '-20')],
    }),
    at: utc('2026-01-15'),
    legacy: stored('80'),
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
    category: 'snapshot-first-anchor',
    name: 'before the first snapshot the engine holds its value',
    holding: classified(snapshot100()),
    at: utc('2026-01-05'),
    legacy: stored('95'),
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
    legacy: stored('77'),
    engineValue: '100',
    legacyValue: '77',
  },
];

describe('compareBalance', () => {
  for (const c of BALANCE_CASES) {
    test(`${c.category}: ${c.name}`, () => {
      const difference: ShadowDifference | null = compareBalance(c.holding, c.at, c.legacy);
      expect(difference).toMatchObject({
        comparator: 'stored-balance',
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

  test('a match on the stored balance is not a difference, whatever its formatting', () => {
    expect(compareBalance(ledgerAhead(), AT, stored('105.000'))).toBeNull();
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
    expect(compareBalance(verified, AT, stored('120'))?.category).toBe('verification-not-anchor');
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

  test('column-without-evidence needs the column written after the anchor', () => {
    const holding = classified(snapshot100());
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
