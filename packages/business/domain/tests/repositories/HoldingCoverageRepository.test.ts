import { describe, expect, test } from 'bun:test';
import type { HoldingCoverage, NewHoldingCoverage } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  describeMergedCoverageRows,
  HoldingCoverageRepository,
} from '../../src/repositories/HoldingCoverageRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingCoverageRepository);

async function makeHoldingFixture(tx: Parameters<typeof makeUser>[0]): Promise<{
  userId: string;
  holdingId: string;
  accountId: string;
  tokenId: string;
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
  return { userId: user.id, holdingId: holding.id, accountId: acct.id, tokenId: tok.id };
}

// `upsertManyFromIngester` is the only ingester writer since SC-394 deleted the
// singular one beside it. It answers with a count rather than the row it wrote,
// so a test asserting on the ON CONFLICT merge has to read the row back.
async function ingest(
  tx: Parameters<typeof makeUser>[0],
  row: NewHoldingCoverage
): Promise<HoldingCoverage> {
  await repo().upsertManyFromIngester([row], {}, tx);
  const after = await repo().findByHolding(row.holdingId, tx);
  if (!after) throw new Error(`no coverage row was written for holding ${row.holdingId}`);
  return after;
}

describe('HoldingCoverageRepository', () => {
  test('findByHolding returns null when no coverage row exists', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const r = await repo().findByHolding(holdingId, tx);
      expect(r).toBeNull();
    });
  });

  test('upsertManyFromIngester inserts a fresh coverage row when none exists', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const row = await ingest(tx, {
        holdingId,
        firstTxAt: new Date('2024-01-01T00:00:00Z'),
        lastTxAt: new Date('2024-12-31T23:59:59Z'),
        txSources: ['kraken-api'],
        hasCompleteTxHistory: true,
      });
      expect(row.holdingId).toBe(holdingId);
      expect(row.txSources).toEqual(['kraken-api']);
      expect(row.hasCompleteTxHistory).toBe(true);
      expect(row.firstTxAt?.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    });
  });

  test('upsertManyFromIngester widens the tx range and unions tx sources on subsequent calls', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      // First ingest covers 2024 Q2 with kraken-api.
      await ingest(tx, {
        holdingId,
        firstTxAt: new Date('2024-04-01T00:00:00Z'),
        lastTxAt: new Date('2024-06-30T23:59:59Z'),
        txSources: ['kraken-api'],
        hasCompleteTxHistory: false,
      });
      // Second ingest extends to 2024 H1 + adds binance-api.
      const after = await ingest(tx, {
        holdingId,
        firstTxAt: new Date('2024-01-01T00:00:00Z'),
        lastTxAt: new Date('2024-12-31T23:59:59Z'),
        txSources: ['binance-api'],
        hasCompleteTxHistory: true,
      });
      // Range widens: earliest of firsts, latest of lasts.
      expect(after.firstTxAt?.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
      expect(after.lastTxAt?.getTime()).toBe(new Date('2024-12-31T23:59:59Z').getTime());
      // Sources union, distinct.
      expect(new Set(after.txSources)).toEqual(new Set(['kraken-api', 'binance-api']));
      // hasCompleteTxHistory is direct write-through (not sticky-OR).
      expect(after.hasCompleteTxHistory).toBe(true);
    });
  });

  test('upsertReconciliation updates only reconciliation fields without disturbing tx range', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      // Seed with ingester data first.
      await ingest(tx, {
        holdingId,
        firstTxAt: new Date('2024-01-01T00:00:00Z'),
        lastTxAt: new Date('2024-12-31T23:59:59Z'),
        txSources: ['kraken-api'],
        hasCompleteTxHistory: false,
      });
      const reconciledAt = new Date('2025-01-15T00:00:00Z');
      const after = await repo().upsertReconciliation(
        {
          holdingId,
          lastReconciledAt: reconciledAt,
          openingBalanceQuantity: '6.0',
          reconciliationNotes: 'Synthesized opening balance',
        },
        tx
      );
      expect(after.lastReconciledAt?.getTime()).toBe(reconciledAt.getTime());
      expect(after.openingBalanceQuantity).toBe('6.0');
      expect(after.reconciliationNotes).toBe('Synthesized opening balance');
      // Tx-range fields preserved from the ingester upsert.
      expect(after.firstTxAt?.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
      expect(after.lastTxAt?.getTime()).toBe(new Date('2024-12-31T23:59:59Z').getTime());
      expect(after.txSources).toEqual(['kraken-api']);
    });
  });

  test('upsertReconciliation creates the row when no prior coverage exists', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const after = await repo().upsertReconciliation(
        {
          holdingId,
          lastReconciledAt: new Date('2025-01-01T00:00:00Z'),
          openingBalanceQuantity: null,
          reconciliationNotes: null,
        },
        tx
      );
      expect(after.holdingId).toBe(holdingId);
      expect(after.openingBalanceQuantity).toBeNull();
      expect(after.firstTxAt).toBeNull();
      expect(after.txSources).toEqual([]);
    });
  });
});

// SC-168. A failed run is the narrowest run there is — it read nothing —
// and the flag is deliberately write-through so a narrower run can move
// it back. These cover the scope: the source's own holdings, nobody
// else's.
describe('HoldingCoverageRepository.retractCompleteHistoryClaim', () => {
  async function seed(
    tx: Parameters<typeof makeUser>[0],
    rows: Array<{ holdingId: string; txSources: string[]; complete: boolean }>
  ): Promise<void> {
    for (const r of rows) {
      await ingest(tx, {
        holdingId: r.holdingId,
        firstTxAt: new Date('2024-01-01T00:00:00Z'),
        lastTxAt: new Date('2024-12-31T23:59:59Z'),
        txSources: r.txSources,
        hasCompleteTxHistory: r.complete,
      });
    }
  }

  test('a failed run retracts the claim on the holdings that source wrote', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, accountId } = await makeHoldingFixture(tx);
      await seed(tx, [{ holdingId, txSources: ['bybit-api'], complete: true }]);

      const retracted = await repo().retractCompleteHistoryClaim(accountId, 'bybit-api', tx);

      expect(retracted).toBe(1);
      const after = await repo().findByHolding(holdingId, tx);
      expect(after?.hasCompleteTxHistory).toBe(false);
      // The ledger itself is untouched — only the claim about it moved.
      expect(after?.firstTxAt?.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
      expect(after?.txSources).toEqual(['bybit-api']);
    });
  });

  test('a holding that only ever heard from another source keeps its claim', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const tokA = await makeToken(tx);
      const tokB = await makeToken(tx);
      const fromBybit = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: tokA.id,
      });
      const fromFile = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: tokB.id,
      });
      await seed(tx, [
        { holdingId: fromBybit.id, txSources: ['bybit-api'], complete: true },
        { holdingId: fromFile.id, txSources: ['file-import'], complete: true },
      ]);

      const retracted = await repo().retractCompleteHistoryClaim(acct.id, 'bybit-api', tx);

      expect(retracted).toBe(1);
      expect((await repo().findByHolding(fromBybit.id, tx))?.hasCompleteTxHistory).toBe(false);
      expect((await repo().findByHolding(fromFile.id, tx))?.hasCompleteTxHistory).toBe(true);
    });
  });

  test('another account running the same source is not touched', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const failing = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const healthy = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const tok = await makeToken(tx);
      const hFailing = await makeHolding(tx, {
        userId: user.id,
        accountId: failing.id,
        tokenId: tok.id,
      });
      const hHealthy = await makeHolding(tx, {
        userId: user.id,
        accountId: healthy.id,
        tokenId: tok.id,
      });
      await seed(tx, [
        { holdingId: hFailing.id, txSources: ['bybit-api'], complete: true },
        { holdingId: hHealthy.id, txSources: ['bybit-api'], complete: true },
      ]);

      expect(await repo().retractCompleteHistoryClaim(failing.id, 'bybit-api', tx)).toBe(1);
      expect((await repo().findByHolding(hHealthy.id, tx))?.hasCompleteTxHistory).toBe(true);
    });
  });

  test('a claim already retracted reports nothing to retract', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, accountId } = await makeHoldingFixture(tx);
      await seed(tx, [{ holdingId, txSources: ['bybit-api'], complete: false }]);

      expect(await repo().retractCompleteHistoryClaim(accountId, 'bybit-api', tx)).toBe(0);
    });
  });

  test('a failure before any coverage row exists has nothing to lie about', async () => {
    await withTestDb(async (tx) => {
      const { accountId } = await makeHoldingFixture(tx);
      expect(await repo().retractCompleteHistoryClaim(accountId, 'bybit-api', tx)).toBe(0);
    });
  });

  test('a later successful run writes the claim back', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, accountId } = await makeHoldingFixture(tx);
      await seed(tx, [{ holdingId, txSources: ['bybit-api'], complete: true }]);
      await repo().retractCompleteHistoryClaim(accountId, 'bybit-api', tx);

      await seed(tx, [{ holdingId, txSources: ['bybit-api'], complete: true }]);

      expect((await repo().findByHolding(holdingId, tx))?.hasCompleteTxHistory).toBe(true);
    });
  });
});

// SC-307 / SC-308. `first_tx_at` is a summary of `holding_transactions`,
// so it is derived from that table rather than reported by whichever
// writer happened to touch the ledger. Every assertion here is about the
// ledger being the authority.
describe('HoldingCoverageRepository.syncTxBoundsFromLedger', () => {
  async function twoHoldings(tx: Parameters<typeof makeUser>[0]): Promise<{
    userId: string;
    old: string;
    recent: string;
  }> {
    const user = await makeUser(tx);
    const instType = await makeInstitutionType(tx);
    const inst = await makeInstitution(tx, { typeId: instType.id });
    const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
    const tokOld = await makeToken(tx);
    const tokRecent = await makeToken(tx);
    const old = await makeHolding(tx, {
      userId: user.id,
      accountId: acct.id,
      tokenId: tokOld.id,
    });
    const recent = await makeHolding(tx, {
      userId: user.id,
      accountId: acct.id,
      tokenId: tokRecent.id,
    });
    return { userId: user.id, old: old.id, recent: recent.id };
  }

  // THE SC-308 assertion. One run, two holdings, four years between their
  // first transactions. Before this, both rows were stamped with the run's
  // oldest event and the newer holding read as four years older than it is.
  test('each holding gets its OWN first/last, never the set-wide oldest event', async () => {
    await withTestDb(async (tx) => {
      const { userId, old, recent } = await twoHoldings(tx);
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: old,
        occurredAt: new Date('2021-03-04T00:00:00Z'),
      });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: old,
        occurredAt: new Date('2026-08-01T00:00:00Z'),
      });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: recent,
        occurredAt: new Date('2026-07-09T00:00:00Z'),
      });

      await repo().syncTxBoundsFromLedger([old, recent], tx);

      const oldRow = await repo().findByHolding(old, tx);
      const recentRow = await repo().findByHolding(recent, tx);
      expect(oldRow?.firstTxAt?.toISOString()).toBe('2021-03-04T00:00:00.000Z');
      expect(oldRow?.lastTxAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      // The run's oldest event is 2021-03-04. This holding's is not.
      expect(recentRow?.firstTxAt?.toISOString()).toBe('2026-07-09T00:00:00.000Z');
      expect(recentRow?.lastTxAt?.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    });
  });

  // SC-307: the population that has transactions and no coverage row at
  // all, because the path that wrote the ledger wrote no coverage.
  test('creates the row for a holding that has transactions and no coverage', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, userId } = await makeHoldingFixture(tx);
      await makeHoldingTransaction(tx, {
        userId,
        holdingId,
        occurredAt: new Date('2025-02-02T00:00:00Z'),
      });
      expect(await repo().findByHolding(holdingId, tx)).toBeNull();

      await repo().syncTxBoundsFromLedger([holdingId], tx);

      expect((await repo().findByHolding(holdingId, tx))?.firstTxAt?.toISOString()).toBe(
        '2025-02-02T00:00:00.000Z'
      );
    });
  });

  // The old `LEAST`/`GREATEST` upsert could only ever widen, so deleting
  // the oldest transaction left a first_tx_at nothing in the ledger
  // supported. Deriving means the value can move back.
  test('narrows when the oldest transaction is removed', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, userId } = await makeHoldingFixture(tx);
      const oldest = await makeHoldingTransaction(tx, {
        userId,
        holdingId,
        occurredAt: new Date('2020-01-01T00:00:00Z'),
      });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      });
      await repo().syncTxBoundsFromLedger([holdingId], tx);
      expect((await repo().findByHolding(holdingId, tx))?.firstTxAt?.getUTCFullYear()).toBe(2020);

      await tx
        .delete(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, oldest.id));
      await repo().syncTxBoundsFromLedger([holdingId], tx);

      expect((await repo().findByHolding(holdingId, tx))?.firstTxAt?.getUTCFullYear()).toBe(2026);
    });
  });

  test('a holding whose last transaction is gone reports no tx bounds at all', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, userId } = await makeHoldingFixture(tx);
      const only = await makeHoldingTransaction(tx, {
        userId,
        holdingId,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      });
      await repo().syncTxBoundsFromLedger([holdingId], tx);

      await tx.delete(schema.holdingTransactions).where(eq(schema.holdingTransactions.id, only.id));
      await repo().syncTxBoundsFromLedger([holdingId], tx);

      const row = await repo().findByHolding(holdingId, tx);
      expect(row?.firstTxAt).toBeNull();
      expect(row?.lastTxAt).toBeNull();
    });
  });

  // The split this repository already draws between ingester-owned and
  // reconciliation-owned columns has to survive a third writer.
  test('leaves reconciliation state and the completeness claim alone', async () => {
    await withTestDb(async (tx) => {
      const { holdingId, userId } = await makeHoldingFixture(tx);
      await ingest(tx, {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['kraken-api'],
        hasCompleteTxHistory: true,
      });
      await repo().upsertReconciliation(
        {
          holdingId,
          lastReconciledAt: new Date('2026-08-01T00:00:00Z'),
          openingBalanceQuantity: '12.5',
          reconciliationNotes: 'synthesized',
        },
        tx
      );
      await makeHoldingTransaction(tx, {
        userId,
        holdingId,
        occurredAt: new Date('2024-04-04T00:00:00Z'),
      });

      await repo().syncTxBoundsFromLedger([holdingId], tx);

      const row = await repo().findByHolding(holdingId, tx);
      expect(row?.firstTxAt?.toISOString()).toBe('2024-04-04T00:00:00.000Z');
      expect(row?.hasCompleteTxHistory).toBe(true);
      expect(row?.txSources).toEqual(['kraken-api']);
      expect(row?.openingBalanceQuantity).toBe('12.5');
      expect(row?.reconciliationNotes).toBe('synthesized');
    });
  });

  test('an empty holding list is a no-op', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().syncTxBoundsFromLedger([], tx)).toBe(0);
    });
  });
});

// SC-360: an incremental run must not retract a full import's claim.
// `TransactionRouter.claimsCompleteHistory` returns false for ANY run that
// carries a `since` — because a window is not the ledger, not because the
// ledger is short — and that false used to be written straight through.
describe('upsertManyFromIngester — completeness is a claim, not a side effect', () => {
  const row = (holdingId: string, hasCompleteTxHistory: boolean) => ({
    holdingId,
    firstTxAt: null,
    lastTxAt: null,
    txSources: ['etherscan'],
    hasCompleteTxHistory,
  });

  test('a claiming run writes its verdict, true or false', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      await repo().upsertManyFromIngester([row(holdingId, true)], {}, tx);
      expect((await repo().findByHolding(holdingId, tx))?.hasCompleteTxHistory).toBe(true);

      await repo().upsertManyFromIngester(
        [row(holdingId, false)],
        { completenessIsClaimed: true },
        tx
      );
      expect((await repo().findByHolding(holdingId, tx))?.hasCompleteTxHistory).toBe(false);
    });
  });

  test('a non-claiming run leaves a standing true alone', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      await repo().upsertManyFromIngester([row(holdingId, true)], {}, tx);

      await repo().upsertManyFromIngester(
        [row(holdingId, false)],
        { completenessIsClaimed: false },
        tx
      );

      expect((await repo().findByHolding(holdingId, tx))?.hasCompleteTxHistory).toBe(true);
    });
  });

  test('a non-claiming run still merges the bounds and sources it did observe', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      await repo().upsertManyFromIngester([row(holdingId, true)], {}, tx);

      await repo().upsertManyFromIngester(
        [
          {
            ...row(holdingId, false),
            txSources: ['solana'],
            lastTxAt: new Date('2026-08-17T00:00:00Z'),
          },
        ],
        { completenessIsClaimed: false },
        tx
      );

      const after = await repo().findByHolding(holdingId, tx);
      expect(after?.hasCompleteTxHistory).toBe(true);
      expect([...(after?.txSources ?? [])].sort()).toEqual(['etherscan', 'solana']);
      expect(after?.lastTxAt?.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    });
  });

  test('a first-ever non-claiming run inserts without claiming completeness', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      await repo().upsertManyFromIngester(
        [row(holdingId, false)],
        { completenessIsClaimed: false },
        tx
      );
      expect((await repo().findByHolding(holdingId, tx))?.hasCompleteTxHistory).toBe(false);
    });
  });
});

// SC-366. `ON CONFLICT DO UPDATE` refuses a statement carrying the conflict
// key twice, so a repeated holding HAS to collapse — but the collapse used
// to reach nobody. The row that loses takes its `txSources` and its
// completeness claim with it, because it never reaches the statement at all.
describe('upsertManyFromIngester — a collapsed batch says so', () => {
  const row = (holdingId: string, txSources: string[]) => ({
    holdingId,
    firstTxAt: null,
    lastTxAt: null,
    txSources,
    hasCompleteTxHistory: false,
  });

  test('one row lands, and the caller is told the other was merged into it', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);

      const result = await repo().upsertManyFromIngester(
        [row(holdingId, ['etherscan']), row(holdingId, ['solana'])],
        {},
        tx
      );

      expect(result.written).toBe(1);
      expect(result.merges).toEqual([{ holdingId, dropped: 1 }]);
      // The loser is gone, not merged: `ARRAY(SELECT DISTINCT UNNEST(...))`
      // in the `ON CONFLICT` never sees a row that was dropped first.
      expect((await repo().findByHolding(holdingId, tx))?.txSources).toEqual(['solana']);
    });
  });

  test('a batch of distinct holdings reports nothing merged', async () => {
    await withTestDb(async (tx) => {
      const a = await makeHoldingFixture(tx);
      const b = await makeHoldingFixture(tx);

      const result = await repo().upsertManyFromIngester(
        [row(a.holdingId, ['etherscan']), row(b.holdingId, ['etherscan'])],
        {},
        tx
      );

      expect(result.written).toBe(2);
      expect(result.merges).toEqual([]);
    });
  });

  test('an empty batch is still a no-op', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().upsertManyFromIngester([], {}, tx)).toEqual({ written: 0, merges: [] });
    });
  });

  // Same sentence the ledger's `describeMergedRows` produces, with coverage's
  // nouns — one wording, so a reader meeting both can tell they are one bug.
  test('describeMergedCoverageRows states how many rows went and which holdings took them', () => {
    expect(
      describeMergedCoverageRows([
        { holdingId: 'h1', dropped: 2 },
        { holdingId: 'h2', dropped: 1 },
      ])
    ).toBe(
      '3 coverage row(s) across 2 dedup key(s) shared (holding) with another row in the ' +
        'same batch and were merged into one. Keys: h1, h2'
    );
  });

  test('describeMergedCoverageRows says nothing when nothing was merged', () => {
    expect(describeMergedCoverageRows([])).toBeNull();
  });
});

/**
 * SC-900 — where the ledger's SOURCE begins, kept beside where its rows do.
 *
 * `first_tx_at` is the earliest row we hold; `history_starts_at` is the
 * earliest date the source covers. They are different numbers and the
 * difference is the whole point — a statement covering a date range can report
 * a row dated before that range, so a boundary derived from the ledger claims
 * a wider window than the one that was actually fetched.
 */
describe('HoldingCoverageRepository — the window the source covers', () => {
  const EARLY = new Date('2024-03-01T00:00:00Z');
  const LATER = new Date('2024-09-01T00:00:00Z');

  test('defaults to null, which means unstated rather than unbounded', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const row = await ingest(tx, {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['ibkr-api'],
        hasCompleteTxHistory: false,
      });
      expect(row.historyStartsAt).toBeNull();
    });
  });

  test('a run that states one writes it', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const row = await ingest(tx, {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['ibkr-api'],
        hasCompleteTxHistory: false,
        historyStartsAt: EARLY,
      });
      expect(row.historyStartsAt?.toISOString()).toBe(EARLY.toISOString());
    });
  });

  /**
   * LEAST, matching `first_tx_at` beside it, and the direction is load-bearing.
   *
   * The saved query's range slides. If it slides FORWARD, the rows an earlier
   * pull already wrote are still in the ledger — so taking the newest stated
   * window would move the boundary past rows we hold, and the boundary is read
   * as "money that moved before this has no row here". A sentence that reaches
   * forward over rows we have is a false explanation, which is strictly worse
   * than the honest "unexplained" this replaces.
   */
  test('a window sliding FORWARD does not move the boundary past rows we hold', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const base = {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['ibkr-api'],
        hasCompleteTxHistory: false,
      };
      await ingest(tx, { ...base, historyStartsAt: EARLY });
      const row = await ingest(tx, { ...base, historyStartsAt: LATER });
      expect(row.historyStartsAt?.toISOString()).toBe(EARLY.toISOString());
    });
  });

  /**
   * The other direction is the documented remedy — widen the saved query, or
   * add a second one covering the earlier period — so it has to take effect.
   * Without this the explanation would go on naming a boundary the account has
   * already reached past, which is the same defect with the sign flipped.
   */
  test('a window reaching FURTHER BACK moves the boundary with it', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const base = {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['ibkr-api'],
        hasCompleteTxHistory: false,
      };
      await ingest(tx, { ...base, historyStartsAt: LATER });
      const row = await ingest(tx, { ...base, historyStartsAt: EARLY });
      expect(row.historyStartsAt?.toISOString()).toBe(EARLY.toISOString());
    });
  });

  /**
   * A run whose provider names no window must not CLEAR one already stated —
   * the nightly is that run for every account with a ledger, so a merge that
   * overwrote with null would erase the boundary within a day of it being set
   * and nothing would fail.
   */
  test('a run that states nothing leaves a stored window standing', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const base = {
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: ['ibkr-api'],
        hasCompleteTxHistory: false,
      };
      await ingest(tx, { ...base, historyStartsAt: EARLY });
      const row = await ingest(tx, base);
      expect(row.historyStartsAt?.toISOString()).toBe(EARLY.toISOString());
    });
  });
});
