/**
 * The absence block (foundation A2 Task 14, R62), ported from the exchange
 * sync's stale-zero cases (`HoldingsSyncHelper.test.ts`, SC-236 and SC-1451)
 * and the integration import's (`IntegrationImportService.ts:338-368` at `03a867c6c`).
 */

import { describe, expect, test } from 'bun:test';
import {
  type AbsencePolicy,
  confirmAbsences,
} from '../../../../src/services/feeds/blocks/absence-confirmer';

type AbsenceCandidate = Parameters<typeof confirmAbsences>[0]['owned'][number];

const day = (iso: string, hour = '05') => new Date(`${iso}T${hour}:00:00Z`);

function confirmed(over: Partial<Extract<AbsencePolicy, { mode: 'confirmed' }>> = {}) {
  return {
    mode: 'confirmed',
    guardEmptySnapshot: true,
    confirmations: { typeCode: 'fiat', statements: 3 },
    providerRows: 1,
    statementAsOf: day('2026-07-20'),
    ...over,
  } satisfies AbsencePolicy;
}

function candidate(over: Partial<AbsenceCandidate> & Pick<AbsenceCandidate, 'holdingId'>) {
  return {
    key: over.holdingId,
    typeCode: 'crypto',
    balance: '5',
    absentFromStatements: null,
    ...over,
  } satisfies AbsenceCandidate;
}

const cash = (absent: string[] | null) =>
  candidate({
    holdingId: 'cad',
    typeCode: 'fiat',
    balance: '47.87',
    absentFromStatements: absent?.map((d) => day(d)) ?? null,
  });

const isoDays = (dates: readonly Date[] | undefined) =>
  dates?.map((d) => d.toISOString().slice(0, 10));

describe('confirmAbsences — the empty-snapshot guard (SC-236)', () => {
  test('an empty snapshot zeroes nothing and trips the guard', () => {
    const decision = confirmAbsences({
      policy: confirmed({ providerRows: 0 }),
      reportedKeys: new Set(),
      owned: [candidate({ holdingId: 'held', balance: '12345.67' }), cash(['2026-07-19'])],
    });

    expect(decision).toEqual({
      zero: [],
      tally: new Map(),
      cleared: [],
      failed: [],
      guardTripped: true,
    });
  });

  // The guard counts the rows the provider returned, not the rows that
  // survived: a lone short it dropped is still an answer (SC-1462).
  test('a snapshot with rows still zeroes what it omits', () => {
    const decision = confirmAbsences({
      policy: confirmed({ providerRows: 1, confirmations: null }),
      reportedKeys: new Set(),
      owned: [candidate({ holdingId: 'sold', balance: '999' })],
    });

    expect(decision.guardTripped).toBe(false);
    expect(decision.zero).toEqual(['sold']);
  });
});

describe('confirmAbsences — a currency missing from one statement is not a zero (SC-1451)', () => {
  test('a fiat holding is zeroed on its third absent statement day, counted per calendar day', () => {
    const first = confirmAbsences({
      policy: confirmed(),
      reportedKeys: new Set(),
      owned: [cash(null)],
    });
    expect(first.zero).toEqual([]);
    expect(isoDays(first.tally.get('cad'))).toEqual(['2026-07-20']);

    // The same statement read again hours later is the same day, counted once,
    // and the dates are written back as they are.
    const reread = confirmAbsences({
      policy: confirmed({ statementAsOf: day('2026-07-20', '23') }),
      reportedKeys: new Set(),
      owned: [cash(['2026-07-19', '2026-07-20'])],
    });
    expect(reread.zero).toEqual([]);
    expect(isoDays(reread.tally.get('cad'))).toEqual(['2026-07-19', '2026-07-20']);

    const third = confirmAbsences({
      policy: confirmed(),
      reportedKeys: new Set(),
      owned: [cash(['2026-07-18', '2026-07-19'])],
    });
    expect(third).toEqual({
      zero: ['cad'],
      tally: new Map(),
      cleared: ['cad'],
      failed: [],
      guardTripped: false,
    });
  });

  test('the recorded dates keep their instants, and the new one is the statement as-of', () => {
    const asOf = day('2026-07-21', '13');
    const decision = confirmAbsences({
      policy: confirmed({ statementAsOf: asOf }),
      reportedKeys: new Set(),
      owned: [cash(['2026-07-20'])],
    });
    expect(decision.tally.get('cad')).toEqual([day('2026-07-20'), asOf]);
  });

  test('a holding outside the confirmed set still zeroes at once, and its stale tally stays', () => {
    const decision = confirmAbsences({
      policy: confirmed(),
      reportedKeys: new Set(),
      owned: [candidate({ holdingId: 'stock', typeCode: 'stock' })],
    });
    expect(decision.zero).toEqual(['stock']);

    // With no confirmation configured a fiat zeroes at once, and a tally left
    // from before is not cleared: only the confirmed branch clears one.
    const unconfirmed = confirmAbsences({
      policy: confirmed({ confirmations: null }),
      reportedKeys: new Set(),
      owned: [cash(['2026-07-18', '2026-07-19'])],
    });
    expect(unconfirmed).toEqual({
      zero: ['cad'],
      tally: new Map(),
      cleared: [],
      failed: [],
      guardTripped: false,
    });
  });

  // Today's `absentDates` reads every recorded date's day, so an unreadable
  // statement date throws for a holding that has one; the sync logs it and
  // moves on, neither tallying nor zeroing it (C2).
  test('an unreadable statement date fails each confirmed holding with recorded dates, and the rest still zero', () => {
    const decision = confirmAbsences({
      policy: confirmed({ statementAsOf: new Date(Number.NaN) }),
      reportedKeys: new Set(),
      owned: [cash(['2026-07-19']), candidate({ holdingId: 'stock', typeCode: 'stock' })],
    });

    expect(decision.zero).toEqual(['stock']);
    expect(decision.tally).toEqual(new Map());
    expect(decision.failed.map((f) => f.holdingId)).toEqual(['cad']);
    expect(decision.failed[0]?.error).toBeTruthy();
  });
});

describe('confirmAbsences — what is not an absence', () => {
  // The clear on reappearance is the checkpoint's, in ingest: it follows the
  // holding the batch placed the checkpoint on, as the sync's did.
  test('a reported holding is neither zeroed nor tallied, whatever it recorded', () => {
    const decision = confirmAbsences({
      policy: confirmed(),
      reportedKeys: new Set(['cad']),
      owned: [cash(['2026-07-19'])],
    });
    expect(decision).toEqual({
      zero: [],
      tally: new Map(),
      cleared: [],
      failed: [],
      guardTripped: false,
    });
  });

  // A text compare, as today's `existing.balance === '0'`: '0.00' is not '0'.
  test("a holding at '0' is not zeroed again; one at '0.00' is", () => {
    const decision = confirmAbsences({
      policy: confirmed({ confirmations: null }),
      reportedKeys: new Set(),
      owned: [
        candidate({ holdingId: 'zero', balance: '0' }),
        candidate({ holdingId: 'padded', balance: '0.00' }),
      ],
    });
    expect(decision.zero).toEqual(['padded']);
  });
});

describe('confirmAbsences — immediate (an integration import)', () => {
  const immediate = (reportedKeys: string[]) =>
    ({
      mode: 'immediate',
      guardEmptySnapshot: false,
      confirmations: null,
      reportedKeys,
      statementAsOf: day('2026-07-20'),
    }) satisfies AbsencePolicy;

  test('immediate with no confirmations zeroes on the first absence', () => {
    const decision = confirmAbsences({
      policy: immediate(['BTC']),
      reportedKeys: new Set(['BTC']),
      owned: [
        candidate({ holdingId: 'btc', key: 'BTC' }),
        cash(['2026-07-19']),
        candidate({ holdingId: 'unkeyed', key: null }),
      ],
    });
    // No tally: a fiat zeroes at once, and its recorded dates are left alone.
    expect(decision).toEqual({
      zero: ['cad', 'unkeyed'],
      tally: new Map(),
      cleared: [],
      failed: [],
      guardTripped: false,
    });
  });

  test('an empty import zeroes every candidate: there is no guard', () => {
    const decision = confirmAbsences({
      policy: immediate([]),
      reportedKeys: new Set(),
      owned: [candidate({ holdingId: 'a' }), candidate({ holdingId: 'b' })],
    });
    expect(decision.guardTripped).toBe(false);
    expect(decision.zero).toEqual(['a', 'b']);
  });

  test("immediate with the provider's confirmations tallies absent cash as the sync does (A5 D-22)", () => {
    const policy = {
      ...immediate(['BTC']),
      confirmations: { typeCode: 'fiat', statements: 3 },
    } satisfies AbsencePolicy;
    const owned = [
      candidate({ holdingId: 'btc', key: 'BTC' }),
      candidate({ holdingId: 'eth', key: 'ETH' }),
    ];

    const second = confirmAbsences({
      policy,
      reportedKeys: new Set(['BTC']),
      owned: [...owned, cash(['2026-07-19'])],
    });
    const third = confirmAbsences({
      policy,
      reportedKeys: new Set(['BTC']),
      owned: [...owned, cash(['2026-07-18', '2026-07-19'])],
    });

    expect({ zero: second.zero, tally: isoDays(second.tally.get('cad')) }).toEqual({
      zero: ['eth'],
      tally: ['2026-07-19', '2026-07-20'],
    });
    expect({ zero: third.zero, cleared: third.cleared }).toEqual({
      zero: ['eth', 'cad'],
      cleared: ['cad'],
    });
  });
});
