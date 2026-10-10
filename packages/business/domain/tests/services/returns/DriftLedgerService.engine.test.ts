import { describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction } from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container } from 'typedi';
import { balanceAt } from '../../../src/engine/balance-at';
import { asLedgerRows, driftRows } from '../../../src/lib/balances/drift-rows';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { classifyHoldingEvidence } from '../../../src/services/foundation/legacy-classification';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeObservations,
  makeToken,
} from '../../../test/helpers/factories-extra';

/**
 * The money side reads the engine (SC-1637). Since A5 PR-2 the value series
 * holds a balance until the reading that reveals a change, so a drift row cut
 * at a day end inside the gap is money the value never shows, and a reading
 * the engine does not anchor on is a change it never makes.
 */

const DAY_MS = 86_400_000;

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
    createdAt: new Date('2026-09-01T12:00:00Z'),
  });
  return { userId, holdingId: holding.id, tokenId: token.id };
}

const checkpoint = (userId: string, holdingId: string, at: string, balance: string) => ({
  userId,
  holdingId,
  balance,
  observedAt: new Date(at),
  source: 'sync-capture',
  role: 'checkpoint' as const,
  authority: 'provider' as const,
});

async function driftOf(
  tx: DatabaseTransaction,
  h: { userId: string; holdingId: string; tokenId: string }
) {
  const rows = await Container.get(DriftLedgerService).forHoldings(
    h.userId,
    new Map([[h.holdingId, h.tokenId]]),
    { tx }
  );
  return rows.get(h.holdingId) ?? [];
}

/** Ledger plus drift up to each day end, against the engine's value at it. */
async function disagreeingDayEnds(
  tx: DatabaseTransaction,
  h: { userId: string; holdingId: string; tokenId: string },
  from: string,
  days: number
): Promise<string[]> {
  const [raw] = await Container.get(EngineEvidenceRepository).findHoldingEvidence(
    { userId: h.userId, holdingIds: [h.holdingId] },
    tx
  );
  if (!raw) throw new Error('no evidence');
  const evidence = classifyHoldingEvidence(raw).evidence;
  const ledger = (
    await Container.get(HoldingTransactionRepository).findForHoldingsAll([h.holdingId], tx)
  ).get(h.holdingId) as HoldingTransaction[] | undefined;
  const money = [...(ledger ?? []), ...(await driftOf(tx, h))];
  const out: string[] = [];
  const start = new Date(from).getTime();
  for (let d = 0; d < days; d += 1) {
    const end = start + d * DAY_MS + DAY_MS - 1;
    const value = balanceAt(evidence, new Date(end));
    const engine = value.status === 'absent' ? new Decimal(0) : value.balance;
    const sum = money
      .filter((r) => r.occurredAt.getTime() <= end)
      .reduce((s, r) => s.add(r.quantity), new Decimal(0));
    if (!engine.eq(sum)) out.push(new Date(end).toISOString());
  }
  return out;
}

describe('DriftLedgerService follows the engine (SC-1637)', () => {
  test("a gap's unexplained change is booked whole at the later reading, never cut at the day ends inside it", async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, [
        checkpoint(h.userId, h.holdingId, '2026-09-01T12:00:00Z', '100'),
        checkpoint(h.userId, h.holdingId, '2026-09-04T12:00:00Z', '130'),
      ]);

      const rows = await driftOf(tx, h);

      expect(rows.map((r) => [r.kind, r.quantity, r.occurredAt.toISOString()])).toEqual([
        ['drift_in', '100', '2026-09-01T11:59:59.999Z'],
        ['drift_in', '30', '2026-09-04T12:00:00.000Z'],
      ]);
    });
  });

  test('ledger plus drift equals the engine at every day end, across a gap and a ledger row inside it', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, [
        checkpoint(h.userId, h.holdingId, '2026-09-01T12:00:00Z', '100'),
        checkpoint(h.userId, h.holdingId, '2026-09-05T12:00:00Z', '160'),
      ]);
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        kind: 'deposit',
        quantity: '25',
        occurredAt: new Date('2026-09-02T09:00:00Z'),
      });

      expect(await disagreeingDayEnds(tx, h, '2026-08-30T00:00:00Z', 10)).toEqual([]);
    });
  });

  test('a reading the engine does not anchor on books no drift', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, [
        checkpoint(h.userId, h.holdingId, '2026-09-01T12:00:00Z', '100'),
        {
          userId: h.userId,
          holdingId: h.holdingId,
          balance: '150',
          observedAt: new Date('2026-09-02T12:00:00Z'),
          source: 'sync-capture',
          role: 'verification',
          authority: 'person',
        },
        checkpoint(h.userId, h.holdingId, '2026-09-03T12:00:00Z', '100'),
      ]);

      const rows = await driftOf(tx, h);

      expect(rows.map((r) => [r.kind, r.quantity])).toEqual([['drift_in', '100']]);
      expect(await disagreeingDayEnds(tx, h, '2026-08-30T00:00:00Z', 8)).toEqual([]);
    });
  });

  test('control: a gap the ledger explains books only the opening', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, [
        checkpoint(h.userId, h.holdingId, '2026-09-01T12:00:00Z', '100'),
        checkpoint(h.userId, h.holdingId, '2026-09-04T12:00:00Z', '130'),
      ]);
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        kind: 'deposit',
        quantity: '30',
        occurredAt: new Date('2026-09-03T09:00:00Z'),
      });

      const rows = await driftOf(tx, h);

      expect(rows.map((r) => [r.kind, r.quantity])).toEqual([['drift_in', '100']]);
    });
  });
});

describe('DriftLedgerService reads runs of checkpoints by their ends (SC-1671)', () => {
  // An hourly sync's repeated checkpoints: 85,741 readings loaded per
  // `getReturns` for one production user, and they held the event loop.
  const hourly = (h: { userId: string; holdingId: string }, days: number, balance: string) =>
    Array.from({ length: days * 24 }, (_, hour) =>
      checkpoint(
        h.userId,
        h.holdingId,
        new Date(Date.UTC(2026, 8, 2) + hour * 3_600_000).toISOString(),
        balance
      )
    );

  const shape = (r: HoldingTransaction) => [r.kind, r.quantity, r.occurredAt.toISOString()];

  /** The drift rows built from every reading, or from those `keep` lets through. */
  async function driftFromEveryReading(
    tx: DatabaseTransaction,
    h: { userId: string; holdingId: string; tokenId: string },
    keep: (o: { observedAt: Date }) => boolean = () => true
  ): Promise<HoldingTransaction[]> {
    const [every] = await Container.get(EngineEvidenceRepository).findHoldingEvidence(
      { userId: h.userId, holdingIds: [h.holdingId] },
      tx
    );
    if (!every) throw new Error('no evidence');
    const raw = { ...every, observations: every.observations.filter(keep) };
    const ledger = await Container.get(HoldingTransactionRepository).findForHoldingsAll(
      [h.holdingId],
      tx
    );
    return asLedgerRows(
      driftRows(
        { holdingId: h.holdingId, tokenId: h.tokenId },
        classifyHoldingEvidence(raw).evidence,
        ledger.get(h.holdingId) ?? [],
        new Map(raw.observations.map((o) => [o.id, o.gapReview ?? null])),
        null
      ),
      h.userId
    );
  }

  test('it asks the evidence read to leave repeated checkpoints out', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, hourly(h, 2, '100'));
      const read = spyOn(Container.get(EngineEvidenceRepository), 'findHoldingEvidence');
      try {
        await driftOf(tx, h);
        expect(read.mock.calls.map((call) => call[2])).toEqual([
          { withoutRepeatedCheckpoints: true },
        ]);
        const evidence = (await read.mock.results[0]?.value) as
          | Awaited<ReturnType<EngineEvidenceRepository['findHoldingEvidence']>>
          | undefined;
        expect(evidence?.[0]?.observations).toHaveLength(2);
      } finally {
        read.mockRestore();
      }
    });
  });

  test('the drift rows are the ones every reading gives', async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      await makeObservations(tx, [
        ...hourly(h, 3, '100'),
        checkpoint(h.userId, h.holdingId, '2026-09-06T12:00:00Z', '140'),
        checkpoint(h.userId, h.holdingId, '2026-09-06T13:00:00Z', '140'),
        checkpoint(h.userId, h.holdingId, '2026-09-06T14:00:00Z', '140'),
      ]);
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        kind: 'deposit',
        quantity: '10',
        occurredAt: new Date('2026-09-03T09:30:00Z'),
      });

      const fromEveryReading = await driftFromEveryReading(tx, h);
      const rows = await driftOf(tx, h);

      expect(rows.map(shape)).toEqual(fromEveryReading.map(shape));
      expect(rows.length).toBeGreaterThan(0);
      expect(await disagreeingDayEnds(tx, h, '2026-09-01T00:00:00Z', 8)).toEqual([]);
    });
  });

  test("control: a ledger row at a checkpoint's own instant makes that checkpoint matter, and it is read", async () => {
    await withTestDb(async (tx) => {
      const h = await feedHolding(tx);
      const readings = hourly(h, 1, '100');
      const absorbing = readings[12];
      if (!absorbing) throw new Error('no reading at hour 12');
      await makeObservations(tx, readings);
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        kind: 'deposit',
        quantity: '10',
        occurredAt: absorbing.observedAt,
      });

      const fromEveryReading = await driftFromEveryReading(tx, h);
      const withoutIt = await driftFromEveryReading(
        tx,
        h,
        (o) => o.observedAt.getTime() !== absorbing.observedAt.getTime()
      );
      const rows = await driftOf(tx, h);

      // The comparison can see this drop: the rows move when the reading goes.
      expect(withoutIt.map(shape)).not.toEqual(fromEveryReading.map(shape));
      expect(rows.map(shape)).toEqual(fromEveryReading.map(shape));
    });
  });
});
