import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeObservations,
  makeToken,
} from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingBalanceObservationRepository);

async function makeHoldingFixture(tx: Parameters<typeof makeUser>[0]): Promise<{
  userId: string;
  accountId: string;
  tokenId: string;
  holdingId: string;
}> {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const tok = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: acct.id,
    tokenId: tok.id,
  });
  return { userId: user.id, accountId: acct.id, tokenId: tok.id, holdingId: holding.id };
}

describe('HoldingBalanceObservationRepository', () => {
  test('append inserts a row and returns it', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const row = await repo().append(
        {
          userId,
          holdingId,
          balance: '5',
          observedAt: new Date('2024-06-01T00:00:00Z'),
          source: 'sync-capture',
        },
        tx
      );
      expect(row).not.toBeNull();
      expect(row?.balance).toBe('5');
      expect(row?.source).toBe('sync-capture');
    });
  });

  test('append is idempotent on (holding_id, observed_at, source) — re-append returns null', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const at = new Date('2024-06-01T00:00:00Z');
      const first = await repo().append(
        { userId, holdingId, balance: '5', observedAt: at, source: 'sync-capture' },
        tx
      );
      // Second append with the same dedup key — onConflictDoNothing returns
      // an empty result; the helper turns that into null.
      const second = await repo().append(
        { userId, holdingId, balance: '99', observedAt: at, source: 'sync-capture' },
        tx
      );
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      // The original balance is preserved (we don't overwrite on conflict).
      const all = await repo().findForHoldingBetween(
        holdingId,
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(all).toHaveLength(1);
      expect(all[0]?.balance).toBe('5');
    });
  });

  test('findLatestAtOrAfter returns the earliest observation at or after the cutoff', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      await makeObservations(tx, [
        {
          userId,
          holdingId,
          balance: '1',
          observedAt: new Date('2024-01-01T00:00:00Z'),
          source: 'sync-capture',
        },
        {
          userId,
          holdingId,
          balance: '2',
          observedAt: new Date('2024-06-01T00:00:00Z'),
          source: 'sync-capture',
        },
        {
          userId,
          holdingId,
          balance: '3',
          observedAt: new Date('2024-12-01T00:00:00Z'),
          source: 'sync-capture',
        },
      ]);
      const r = await repo().findLatestAtOrAfter(holdingId, new Date('2024-05-01T00:00:00Z'), tx);
      // The earliest observation on-or-after May is the June one.
      expect(r?.balance).toBe('2');
      const tooLate = await repo().findLatestAtOrAfter(
        holdingId,
        new Date('2025-01-01T00:00:00Z'),
        tx
      );
      expect(tooLate).toBeNull();
    });
  });

  test('findLatestAtOrBefore returns the latest observation at or before the cutoff', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      await makeObservations(tx, [
        {
          userId,
          holdingId,
          balance: '1',
          observedAt: new Date('2024-01-01T00:00:00Z'),
          source: 'sync-capture',
        },
        {
          userId,
          holdingId,
          balance: '2',
          observedAt: new Date('2024-06-01T00:00:00Z'),
          source: 'sync-capture',
        },
        {
          userId,
          holdingId,
          balance: '3',
          observedAt: new Date('2024-12-01T00:00:00Z'),
          source: 'sync-capture',
        },
      ]);
      const r = await repo().findLatestAtOrBefore(holdingId, new Date('2024-07-01T00:00:00Z'), tx);
      // The latest observation on-or-before July is the June one.
      expect(r?.balance).toBe('2');
      const tooEarly = await repo().findLatestAtOrBefore(
        holdingId,
        new Date('2023-01-01T00:00:00Z'),
        tx
      );
      expect(tooEarly).toBeNull();
    });
  });

  test('findForHoldingBetween returns observations in [from, to] ordered ascending', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const t1 = new Date('2024-03-01T00:00:00Z');
      const t2 = new Date('2024-06-01T00:00:00Z');
      const t3 = new Date('2024-09-01T00:00:00Z');
      const tOut = new Date('2025-01-01T00:00:00Z');
      await makeObservations(tx, [
        { userId, holdingId, balance: '1', observedAt: t2, source: 's' },
        { userId, holdingId, balance: '2', observedAt: tOut, source: 's' },
        { userId, holdingId, balance: '3', observedAt: t1, source: 's' },
        { userId, holdingId, balance: '4', observedAt: t3, source: 's' },
      ]);
      const rows = await repo().findForHoldingBetween(
        holdingId,
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(rows.map((r) => r.observedAt.getTime())).toEqual([
        t1.getTime(),
        t2.getTime(),
        t3.getTime(),
      ]);
    });
  });

  test('findExtremesForHolding returns null/null on empty and earliest/latest otherwise', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const emptyExtremes = await repo().findExtremesForHolding(holdingId, tx);
      expect(emptyExtremes.first).toBeNull();
      expect(emptyExtremes.last).toBeNull();
      const tEarly = new Date('2023-01-01T00:00:00Z');
      const tLate = new Date('2025-09-30T00:00:00Z');
      await makeObservations(tx, [
        { userId, holdingId, balance: '1', observedAt: tEarly, source: 's' },
        { userId, holdingId, balance: '2', observedAt: tLate, source: 's' },
      ]);
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first?.getTime()).toBe(tEarly.getTime());
      expect(e.last?.getTime()).toBe(tLate.getTime());
    });
  });

  // SC-1462. Compared as numbers: as text, '10' sorts below '9'.
  test('findLowestBalance is the numeric minimum, null when there is none', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      expect(await repo().findLowestBalance(holdingId, tx)).toBeNull();
      for (const [balance, day] of [
        ['9', 1],
        ['10', 2],
        ['-5509.33', 3],
        ['93.86', 4],
      ] as const) {
        await repo().append(
          {
            userId,
            holdingId,
            balance,
            observedAt: new Date(`2026-07-0${day}T00:00:00Z`),
            source: 'sync-capture',
          },
          tx
        );
      }
      expect(await repo().findLowestBalance(holdingId, tx)).toBe('-5509.33');
    });
  });

  // SC-1462. Margin debt is a negative cash holding; the CHECK that refused
  // it is gone, and the writers decide who may go negative.
  test('a holding can carry a negative balance', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const tok = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: tok.id,
        balance: '-5509.33',
      });
      expect(holding.balance).toBe('-5509.33');
    });
  });
});

// What `SnapshotWriter.record` supersedes with (foundation A2). Superseding a
// row removes an anchor from the engine's evidence, so each of the three is
// scoped by the user in its own WHERE rather than trusted to a caller's check.
describe('HoldingBalanceObservationRepository supersession', () => {
  const T0 = new Date('2026-07-01T00:00:00Z');
  const T1 = new Date('2026-07-02T00:00:00Z');
  const T2 = new Date('2026-07-03T00:00:00Z');

  async function snapshotAt(
    tx: Parameters<typeof makeUser>[0],
    fixture: { userId: string; holdingId: string },
    observedAt: Date,
    fields: { source?: string; authority?: 'person' | 'provider' } = {}
  ) {
    const row = await repo().append(
      {
        userId: fixture.userId,
        holdingId: fixture.holdingId,
        balance: '100',
        observedAt,
        source: fields.source ?? 'sync-capture',
        role: 'snapshot',
        authority: fields.authority ?? 'person',
        cause: 'flow',
      },
      tx
    );
    if (!row) throw new Error('the fixture observation collided');
    return row;
  }

  const supersededAtOf = async (
    tx: Parameters<typeof makeUser>[0],
    holdingId: string,
    id: string
  ) =>
    (await repo().findForHoldingBetween(holdingId, T0, T2, tx)).find((o) => o.id === id)
      ?.supersededAt;

  test("another user's id finds nothing and supersedes nothing", async () => {
    await withTestDb(async (tx) => {
      const fixture = await makeHoldingFixture(tx);
      const { userId, holdingId } = fixture;
      const stranger = (await makeUser(tx)).id;
      const snapshot = await snapshotAt(tx, fixture, T1);

      expect(await repo().findLivePersonSnapshotsAt(stranger, holdingId, T1, tx)).toEqual([]);
      expect(await repo().findLatestLiveSnapshotAtOrBefore(stranger, holdingId, T2, tx)).toBeNull();
      await repo().supersede(stranger, [snapshot.id], tx);
      expect(await supersededAtOf(tx, holdingId, snapshot.id)).toBeNull();

      // The control: the same three calls as the holding's own user.
      expect(await repo().findLivePersonSnapshotsAt(userId, holdingId, T1, tx)).toEqual([
        { id: snapshot.id, cause: 'flow' },
      ]);
      expect(await repo().findLatestLiveSnapshotAtOrBefore(userId, holdingId, T2, tx)).toEqual({
        id: snapshot.id,
        observedAt: T1,
      });
      await repo().supersede(userId, [snapshot.id], tx);
      expect(await supersededAtOf(tx, holdingId, snapshot.id)).toBeInstanceOf(Date);
    });
  });

  test("a correction's predecessor is a person's snapshot, never another authority's", async () => {
    await withTestDb(async (tx) => {
      const fixture = await makeHoldingFixture(tx);
      const person = await snapshotAt(tx, fixture, T0);
      await snapshotAt(tx, fixture, T1, { authority: 'provider' });

      expect(
        await repo().findLatestLiveSnapshotAtOrBefore(fixture.userId, fixture.holdingId, T2, tx)
      ).toEqual({ id: person.id, observedAt: T0 });
    });
  });

  test('two live snapshots one transaction wrote at one instant: the higher id is the predecessor, as the engine ranks them', async () => {
    await withTestDb(async (tx) => {
      const fixture = await makeHoldingFixture(tx);
      // One transaction, so both rows carry the same `created_at`.
      const a = await snapshotAt(tx, fixture, T1);
      const b = await snapshotAt(tx, fixture, T1, { source: 'user-entered' });
      const higher = a.id > b.id ? a : b;

      expect(
        await repo().findLatestLiveSnapshotAtOrBefore(fixture.userId, fixture.holdingId, T2, tx)
      ).toEqual({ id: higher.id, observedAt: T1 });
    });
  });
});
