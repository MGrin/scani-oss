import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeObservations,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * SC-1671. The drift rows read every balance reading of every holding on each
 * `getReturns`: 85,741 rows for one production user, which held the api's event
 * loop for up to 24 s. An hourly sync writes a checkpoint whether or not the
 * balance moved, so all but the first and last of a run say nothing the two
 * ends do not. `withoutRepeatedCheckpoints` leaves those out in SQL.
 */

const repo = () => Container.get(EngineEvidenceRepository);

async function feedHolding(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId,
    accountId: account.id,
    tokenId: token.id,
    source: 'import_kraken',
    kind: 'feed',
    balance: '0',
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  return { userId, holdingId: holding.id, tokenId: token.id };
}

const at = (hour: number) => new Date(Date.UTC(2026, 8, 2, hour));

type Reading = {
  balance: string;
  gapReview?: 'flow';
  role?: 'snapshot' | 'checkpoint' | null;
  authority?: 'provider' | 'person' | 'statement';
  source?: string;
};

function checkpoints(h: { userId: string; holdingId: string }, balances: Array<string | Reading>) {
  return balances.map((b, hour) => ({
    userId: h.userId,
    holdingId: h.holdingId,
    observedAt: at(hour),
    source: 'sync-capture',
    role: 'checkpoint' as const,
    authority: 'provider' as const,
    ...(typeof b === 'string' ? { balance: b } : b),
  }));
}

async function hoursRead(
  tx: DatabaseTransaction,
  h: { userId: string; holdingId: string },
  options?: { withoutRepeatedCheckpoints: true }
): Promise<number[]> {
  const [evidence] = await repo().findHoldingEvidence(
    { userId: h.userId, holdingIds: [h.holdingId] },
    tx,
    options
  );
  return (evidence?.observations ?? []).map((o) => o.observedAt.getUTCHours());
}

const COLLAPSED = { withoutRepeatedCheckpoints: true } as const;

describe('findHoldingEvidence withoutRepeatedCheckpoints (SC-1671)', () => {
  test('a run of identical checkpoints is read as its first and last', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '10', '10']));
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 4]);
    });
  });

  test('control: the default read still returns every checkpoint', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '10', '10']));
      expect(await hoursRead(tx, h)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  test('both sides of a balance change are kept', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '12', '12', '12']));
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 2, 3, 5]);
    });
  });

  test('a checkpoint with a ledger row between its neighbours is kept', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '10', '10']));
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        tokenId: h.tokenId,
        kind: 'deposit',
        quantity: '1',
        occurredAt: new Date(at(1).getTime() + 30 * 60_000),
      });
      // The row sits between hours 1 and 2, so it lies between the neighbours
      // of both: neither may be dropped. Hour 3's neighbours are 2 and 4.
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 1, 2, 4]);
    });
  });

  test('a reading that differs in any other field keeps itself and its neighbours', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(
        tx,
        checkpoints(h, ['10', '10', '10', { balance: '10', gapReview: 'flow' }, '10', '10', '10'])
      );
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 2, 3, 4, 6]);
    });
  });

  test("a ledger row at a reading's own instant keeps it and both neighbours", async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '10', '10', '10', '10']));
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        tokenId: h.tokenId,
        kind: 'deposit',
        quantity: '1',
        occurredAt: at(3),
      });
      // Hour 3 absorbs the row, so the balance carried past it is not the one
      // carried past hour 2. The bounds are inclusive: hours 2 and 4 have it
      // at one end of their neighbours.
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 2, 3, 4, 6]);
    });
  });

  test('a run of readings that are not checkpoints is read whole', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      const unlabelled = { balance: '10', role: null };
      await makeObservations(
        tx,
        checkpoints(h, [unlabelled, unlabelled, unlabelled, unlabelled, unlabelled])
      );
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  test('a reviewed reading is kept when its neighbours carry the same review', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      const reviewed = { balance: '10', gapReview: 'flow' as const };
      await makeObservations(
        tx,
        checkpoints(h, ['10', '10', reviewed, reviewed, reviewed, '10', '10'])
      );
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  test('a holding with a snapshot reading is read whole', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      // A fetch window carries balances only while a checkpoint of its input
      // lies in it, so a dropped checkpoint could let the snapshot anchor.
      const snapshot = { balance: '10', role: 'snapshot' as const, authority: 'person' as const };
      await makeObservations(tx, checkpoints(h, ['10', '10', '10', '10', '10', snapshot]));
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  test('a run of statement closes is read whole', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      // The classifier reads every close's `created_at`: a balance copy written
      // within 120 s of one is the file import's own.
      const close = { balance: '10', source: 'statement-close', authority: 'statement' as const };
      await makeObservations(tx, checkpoints(h, [close, close, close, close, close]));
      expect(await hoursRead(tx, h, COLLAPSED)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  test("one holding's run does not lean on another's readings", async () => {
    await withTestDb(async (tx) => {
      const a = await feedHolding(tx);
      const b = await feedHolding(tx);
      await makeObservations(tx, checkpoints(a, ['10', '10', '10']));
      await makeObservations(tx, checkpoints({ userId: a.userId, holdingId: b.holdingId }, ['7']));
      expect(await hoursRead(tx, a, COLLAPSED)).toEqual([0, 2]);
    });
  });
});
