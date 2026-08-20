import { describe, expect, test } from 'bun:test';
import {
  AS_OF_LAG_THRESHOLD_MS,
  deriveBalancesAsOf,
  withBalancesAsOf,
} from '../../src/lib/balances-as-of';

const NOTE = 'Interactive Brokers generates this statement after the close.';
const FETCHED_AT = new Date('2026-08-17T15:10:52.000Z');

function snapshot(capturedAt: string, asOfNote?: string) {
  return { capturedAt: new Date(capturedAt), ...(asOfNote ? { asOfNote } : {}) };
}

describe('deriveBalancesAsOf', () => {
  test('the IBKR case: a lagging as-of with a reason is recorded', () => {
    const asOf = deriveBalancesAsOf(
      [snapshot('2026-08-16T23:59:59.000Z', NOTE), snapshot('2026-08-16T23:59:59.000Z', NOTE)],
      FETCHED_AT
    );

    expect(asOf).toEqual({ at: '2026-08-16T23:59:59.000Z', note: NOTE });
  });

  test('a live provider says nothing — capturedAt is the fetch instant', () => {
    // The reason the threshold exists at all. Every other provider stamps
    // `new Date()` inside `fetchBalances`, milliseconds before the sync
    // commits; if that counted, twenty accounts would carry a fact and the
    // one that means something would be invisible among them.
    expect(deriveBalancesAsOf([snapshot(FETCHED_AT.toISOString())], FETCHED_AT)).toBeNull();
  });

  test('a date with no reason is not enough to render', () => {
    // Half the fix is the sentence. "As of two days ago" alone is the bare
    // staleness that leaves a reader deciding whether their broker data is
    // also wrong — which is the decision SC-384 is about.
    expect(deriveBalancesAsOf([snapshot('2026-08-15T23:59:59.000Z')], FETCHED_AT)).toBeNull();
  });

  test('a reason on a current figure is noise, not a fact', () => {
    const justInside = new Date(FETCHED_AT.getTime() - AS_OF_LAG_THRESHOLD_MS);
    expect(deriveBalancesAsOf([snapshot(justInside.toISOString(), NOTE)], FETCHED_AT)).toBeNull();
  });

  test('the NEWEST snapshot wins, so one lagging row cannot backdate the account', () => {
    // Older rows are still true at the newer instant; the reverse is not. A
    // min() here would let a single stale leg relabel figures that are
    // current, which is the same class of wrong claim in the other direction.
    const asOf = deriveBalancesAsOf(
      [
        snapshot('2026-08-10T23:59:59.000Z', NOTE),
        snapshot('2026-08-16T23:59:59.000Z', NOTE),
        snapshot('2026-08-12T23:59:59.000Z', NOTE),
      ],
      FETCHED_AT
    );

    expect(asOf?.at).toBe('2026-08-16T23:59:59.000Z');
  });

  test('an unparseable capturedAt is skipped rather than propagated', () => {
    const asOf = deriveBalancesAsOf(
      [snapshot('not-a-date', NOTE), snapshot('2026-08-16T23:59:59.000Z', NOTE)],
      FETCHED_AT
    );

    expect(asOf?.at).toBe('2026-08-16T23:59:59.000Z');
  });

  test('no snapshots is null, not a throw — an empty account still syncs', () => {
    expect(deriveBalancesAsOf([], FETCHED_AT)).toBeNull();
  });
});

describe('withBalancesAsOf', () => {
  test('merges alongside lastSync without disturbing it', () => {
    const merged = withBalancesAsOf(
      { lastSync: '2026-08-17T15:10:52.000Z', custom: 1 },
      { at: '2026-08-16T23:59:59.000Z', note: NOTE }
    );

    expect(merged).toEqual({
      lastSync: '2026-08-17T15:10:52.000Z',
      custom: 1,
      balancesAsOf: { at: '2026-08-16T23:59:59.000Z', note: NOTE },
    });
  });

  test('null DELETES the key — a warning that outlives its cause is worse than none', () => {
    const merged = withBalancesAsOf(
      { lastSync: 'x', balancesAsOf: { at: '2026-08-16T23:59:59.000Z', note: NOTE } },
      null
    );

    expect(merged).toEqual({ lastSync: 'x' });
    expect('balancesAsOf' in merged).toBe(false);
  });

  test('a missing or non-object metadata column starts from empty', () => {
    expect(withBalancesAsOf(null, null)).toEqual({});
    expect(withBalancesAsOf('nonsense', null)).toEqual({});
    expect(withBalancesAsOf([1, 2], null)).toEqual({});
  });
});
