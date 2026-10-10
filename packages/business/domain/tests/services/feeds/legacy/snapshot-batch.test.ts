import { describe, expect, test } from 'bun:test';
import { validateBatch } from '../../../../src/services/feeds/blocks/validate-batch';
import type { AssetRef } from '../../../../src/services/feeds/feed-batch';
import {
  legacySnapshotBatch,
  type SnapshotBatchOptions,
  snapshotInstant,
} from '../../../../src/services/feeds/legacy/snapshot-batch';

const FETCHED = new Date('2026-09-20T12:00:00Z');
const EARLIER = new Date('2026-09-18T00:00:00Z');
const EARLIEST = new Date('2026-09-17T00:00:00Z');

const asset = (symbol: string): AssetRef => ({
  key: `${symbol}-key`,
  identity: { symbol, name: symbol },
  typeCode: 'crypto',
  lookup: 'identity',
});

const options: SnapshotBatchOptions = {
  holdingMatch: 'external-id',
  holdingPolicy: 'create',
  holdingSource: 'import_test',
  arrival: 'user_confirmed',
  holdingFailure: 'skip-entry',
  absence: null,
  clearsAbsenceTally: false,
  unchangedCheckpoint: 'append',
  zeroOpensHolding: true,
};

const input = { accountId: 'account', source: 'provider:test', credentialId: null, walletId: null };

describe('snapshotInstant', () => {
  test("a balance is recorded at the provider's instant when it is before the fetch", () => {
    expect(snapshotInstant(EARLIER, FETCHED)).toEqual(EARLIER);
  });

  // `Math.min` would give NaN for an unreadable date, and `validateBatch`
  // would then refuse the whole run as `invalid-date` (Task 14 review, C2).
  test('an unreadable, missing, future or equal instant falls back to the fetch', () => {
    for (const capturedAt of [
      new Date('not a date'),
      undefined,
      new Date(FETCHED.getTime() + 1),
      new Date(FETCHED),
    ]) {
      expect(snapshotInstant(capturedAt, FETCHED)).toEqual(FETCHED);
    }
  });
});

describe('legacySnapshotBatch', () => {
  test("each balance is a provider checkpoint with today's sync-capture provenance", () => {
    const batch = legacySnapshotBatch({
      userId: 'user',
      input,
      returnedAt: [EARLIER, new Date('not a date')],
      snapshots: [
        { asset: asset('AAA'), balance: '1.5', capturedAt: EARLIER },
        { asset: asset('BBB'), balance: '2', capturedAt: new Date('not a date') },
      ],
      absences: [],
      fetchedAt: FETCHED,
      options,
    });

    expect(batch.checkpoints).toEqual([
      {
        asset: asset('AAA'),
        at: EARLIER,
        amount: '1.5',
        authority: 'provider',
        legacySource: 'sync-capture',
        legacyMeta: { origin: 'updateHoldingBalanceWithEvent' },
      },
      {
        asset: asset('BBB'),
        at: FETCHED,
        amount: '2',
        authority: 'provider',
        legacySource: 'sync-capture',
        legacyMeta: { origin: 'updateHoldingBalanceWithEvent' },
      },
    ]);
    expect(batch.legacy).toEqual({
      ...options,
      writesCache: true,
      createdWithoutCheckpoint: 'zero',
      derivesTradeLegs: false,
      // A holding the batch opens takes `createHoldingWithEvent`'s stamp, as A1's O4 reads it.
      createdCheckpointMeta: { origin: 'createHoldingWithEvent', source: 'import_test' },
    });
    expect([batch.entries, batch.absences, batch.notices]).toEqual([[], [], []]);
    expect(batch.input).toEqual(input);
    expect(validateBatch(batch, FETCHED)).toEqual([]);
  });

  // Z4 (R62 Q3): a position measured at zero is a balance like any other, so
  // it can open a holding, which an absence never does.
  test('an exited position at zero is a checkpoint, not an absence', () => {
    const batch = legacySnapshotBatch({
      userId: 'user',
      input,
      returnedAt: [EARLIER],
      snapshots: [{ asset: asset('GONE'), balance: '0', capturedAt: EARLIER }],
      absences: [],
      fetchedAt: FETCHED,
      options,
    });
    expect(batch.checkpoints.map((c) => [c.asset.identity.symbol, c.amount])).toEqual([
      ['GONE', '0'],
    ]);
    expect(batch.absences).toEqual([]);
  });

  // Z3 (R62 Q3): a probe's measured exit names a holding to zero, and opens none.
  test("a probe's exit is an absence at the instant the probe measured it", () => {
    const batch = legacySnapshotBatch({
      userId: 'user',
      input,
      returnedAt: [EARLIER],
      snapshots: [{ asset: asset('KEPT'), balance: '1', capturedAt: EARLIER }],
      absences: [{ asset: asset('GONE'), confirmedAt: FETCHED }],
      fetchedAt: FETCHED,
      options,
    });
    expect(batch.checkpoints.map((c) => c.asset.identity.symbol)).toEqual(['KEPT']);
    expect(batch.absences).toEqual([{ asset: asset('GONE'), confirmedAt: FETCHED }]);
    expect(validateBatch(batch, FETCHED)).toEqual([]);
  });

  test('the window runs from the earliest instant any returned snapshot was true at to the fetch', () => {
    const batch = legacySnapshotBatch({
      userId: 'user',
      input,
      // EARLIEST belongs to a row the caller dropped: the window covers what was read.
      returnedAt: [EARLIER, EARLIEST, new Date(FETCHED.getTime() + 60_000)],
      snapshots: [{ asset: asset('AAA'), balance: '1', capturedAt: EARLIER }],
      absences: [],
      fetchedAt: FETCHED,
      options,
    });
    expect(batch.window).toEqual({
      shape: 'balance-snapshot',
      from: EARLIEST,
      to: FETCHED,
      complete: false,
    });
    expect(batch.fetchedAt).toEqual(FETCHED);
  });

  // The task's own window rule: a fetch read the provider at that instant even
  // when nothing it returned survives, and its silence is what an immediate
  // absence zeroes on, so the run is ingested and records the fetch itself.
  test('a fetch that kept no balance still has a window: what it read, or the fetch alone when it read nothing', () => {
    for (const returnedAt of [[], [EARLIER]]) {
      const batch = legacySnapshotBatch({
        userId: 'user',
        input,
        returnedAt,
        snapshots: [],
        absences: [],
        fetchedAt: FETCHED,
        options,
      });
      expect(batch.checkpoints).toEqual([]);
      expect(batch.window).toEqual({
        shape: 'balance-snapshot',
        from: returnedAt.length === 0 ? FETCHED : EARLIER,
        to: FETCHED,
        complete: false,
      });
      expect(validateBatch(batch, FETCHED)).toEqual([]);
    }
  });
});
