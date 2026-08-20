import { describe, expect, test } from 'bun:test';
import type { NewHoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../src/repositories/HoldingCoverageRepository';
import {
  describeMergedRows,
  HoldingTransactionRepository,
} from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);

/**
 * Helper to spin up a fresh (user, institution, account, token, holding)
 * tuple inside a test transaction. Returns the holding id since most
 * tests just need that anchor.
 */
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

describe('HoldingTransactionRepository', () => {
  test('bulkUpsert inserts new rows and short-circuits when given an empty array', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const empty = await repo().bulkUpsert([], tx);
      expect(empty).toEqual({ rows: [], merges: [] });

      const { rows: inserted } = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1.5',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.holdingId).toBe(holdingId);
      expect(inserted[0]?.quantity).toBe('1.5');
    });
  });

  // SC-349. `ON CONFLICT DO UPDATE` refuses a statement carrying the
  // conflict key twice (SQLSTATE 21000), so collapsing the batch is the
  // only thing `bulkUpsert` can do — but the collapse is the exact moment
  // a leg stops existing. SC-341 cost 13 of them while nine import jobs
  // each reported `status: 'ok'` and `warnings: []`, because nothing read
  // the size the map had lost. The count leaves the method now.
  test('bulkUpsert reports the rows it merged onto one dedup key', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const leg = (quantity: string): NewHoldingTransaction => ({
        userId,
        holdingId,
        tokenId,
        kind: 'transfer_in',
        quantity,
        occurredAt: new Date('2024-06-01T00:00:00Z'),
        source: 'etherscan',
        externalId: '0xdeadbeef',
      });

      const result = await repo().bulkUpsert([leg('1.0'), leg('2.0'), leg('3.0')], tx);

      // Postgres can only be given the key once, so one row lands and the
      // last occurrence wins — unchanged, and the part that must stay.
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.quantity).toBe('3.0');
      // What is new: the caller can see two legs were merged away.
      expect(result.merges).toEqual([
        { holdingId, source: 'etherscan', externalId: '0xdeadbeef', dropped: 2 },
      ]);
    });
  });

  test('bulkUpsert reports no merges when every row carries a distinct dedup key', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const leg = (externalId: string): NewHoldingTransaction => ({
        userId,
        holdingId,
        tokenId,
        kind: 'transfer_in',
        quantity: '1.0',
        occurredAt: new Date('2024-06-01T00:00:00Z'),
        source: 'etherscan',
        externalId,
      });

      const result = await repo().bulkUpsert([leg('0xa'), leg('0xb')], tx);

      expect(result.rows).toHaveLength(2);
      expect(result.merges).toEqual([]);
    });
  });

  // The count only helps if it reaches a person, and two producers write
  // it into a user-visible `warnings` array — the transaction-import
  // coordinator and the file-import processor. They share the sentence so
  // the two cannot drift into describing the same event differently.
  test('describeMergedRows states how many rows went and which keys took them', () => {
    expect(
      describeMergedRows([
        { holdingId: 'h1', source: 'etherscan', externalId: '0xdeadbeef', dropped: 2 },
        { holdingId: 'h1', source: 'etherscan', externalId: '0xfeed', dropped: 1 },
      ])
    ).toBe(
      '3 transaction row(s) across 2 dedup key(s) shared (holding, source, externalId) with ' +
        'another row in the same batch and were merged into one. Keys: h1/0xdeadbeef, h1/0xfeed'
    );
  });

  test('describeMergedRows says nothing when nothing was merged', () => {
    expect(describeMergedRows([])).toBeNull();
  });

  test('bulkUpsert is idempotent on (holding_id, source, external_id) and overwrites the quantity', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const { rows: first } = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1.0',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      // Re-ingest same external_id with a different normalized quantity —
      // the row must survive (no duplicate) but reflect the new value.
      const { rows: second } = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2.0',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      // Same id — UPSERT.
      expect(second[0]?.id).toBe(first[0]?.id ?? '');
      expect(second[0]?.quantity).toBe('2.0');
    });
  });

  test('findForHoldingInRange returns only txs strictly after `from` and at-or-before `to`, ordered by occurredAt', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const before = new Date('2024-01-01T00:00:00Z');
      const inside = new Date('2024-06-15T00:00:00Z');
      const inside2 = new Date('2024-06-20T00:00:00Z');
      const after = new Date('2025-01-01T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: before,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2',
            occurredAt: inside2,
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '3',
            occurredAt: inside,
            source: 's',
            externalId: 'c',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '4',
            occurredAt: after,
            source: 's',
            externalId: 'd',
          },
        ],
        tx
      );
      const rows = await repo().findForHoldingInRange(
        holdingId,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      // Excludes `before` (before from) and `after` (after to).
      expect(rows.map((r) => r.externalId)).toEqual(['c', 'b']);
    });
  });

  test('sumQuantityInRange aggregates signed quantities in (from, to]', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const t1 = new Date('2024-06-15T00:00:00Z');
      const t2 = new Date('2024-06-20T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '5',
            occurredAt: t1,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'withdraw',
            quantity: '-2',
            occurredAt: t2,
            source: 's',
            externalId: 'b',
          },
        ],
        tx
      );
      const sum = await repo().sumQuantityInRange(
        holdingId,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(sum).toBe('3');
    });
  });

  test("findExtremesForHolding can exclude the reconciler's own row (SC-199)", async () => {
    // Without the flag the reconciler asks "when does real history begin",
    // is handed the answer including the row it wrote last time, and places
    // the next one a millisecond before THAT — so the synthetic opening walks
    // one millisecond earlier on every run, away from the history it is
    // supposed to sit against. The row never duplicates (`holding_tx_dedup`
    // holds and the upsert rewrites `occurred_at`); it drifts.
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const real = new Date('2024-06-15T00:00:00Z');
      const synthetic = new Date(real.getTime() - 1);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'buy',
            quantity: '1',
            occurredAt: real,
            source: 'manual',
            externalId: 'real-1',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'opening_balance',
            quantity: '5',
            occurredAt: synthetic,
            source: 'reconciliation-opening',
            externalId: 'opening_balance',
          },
        ],
        tx
      );

      // Default: unchanged, so no existing caller shifts under this.
      const all = await repo().findExtremesForHolding(holdingId, tx);
      expect(all.first?.getTime()).toBe(synthetic.getTime());

      // Excluded: the first REAL transaction, which is what the reconciler
      // must anchor to.
      const real_only = await repo().findExtremesForHolding(holdingId, tx, {
        excludeReconciliationOpening: true,
      });
      expect(real_only.first?.getTime()).toBe(real.getTime());
      expect(real_only.last?.getTime()).toBe(real.getTime());
    });
  });

  test('findExtremesForHolding returns null/null when the holding has no transactions', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first).toBeNull();
      expect(e.last).toBeNull();
    });
  });

  test('findExtremesForHolding returns earliest and latest occurredAt across multiple txs', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const tEarly = new Date('2023-03-01T00:00:00Z');
      const tMid = new Date('2024-06-15T00:00:00Z');
      const tLate = new Date('2025-09-30T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tMid,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tLate,
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tEarly,
            source: 's',
            externalId: 'c',
          },
        ],
        tx
      );
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first?.getTime()).toBe(tEarly.getTime());
      expect(e.last?.getTime()).toBe(tLate.getTime());
    });
  });

  test('sumQuantityForHoldingUntil includes everything up to the cutoff (inclusive)', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '10',
            occurredAt: new Date('2024-01-01T00:00:00Z'),
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'withdraw',
            quantity: '-3',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '5',
            occurredAt: new Date('2025-01-01T00:00:00Z'),
            source: 's',
            externalId: 'c',
          },
        ],
        tx
      );
      const sumMid = await repo().sumQuantityForHoldingUntil(
        holdingId,
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      // Includes the +10 and the -3 but excludes the +5.
      expect(sumMid).toBe('7');
      const sumAll = await repo().sumQuantityForHoldingUntil(
        holdingId,
        new Date('9999-12-31T23:59:59Z'),
        tx
      );
      expect(sumAll).toBe('12');
    });
  });

  test('deleteForHoldingBySource removes only rows from the specified source', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k1',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2',
            occurredAt: new Date('2024-06-02T00:00:00Z'),
            source: 'manual',
            externalId: 'm1',
          },
        ],
        tx
      );
      const removed = await repo().deleteForHoldingBySource(holdingId, 'kraken-api', tx);
      expect(removed).toBe(1);
      // Only the manual row remains.
      const remaining = await repo().findForHoldingInRange(
        holdingId,
        new Date('2024-01-01'),
        new Date('2025-01-01'),
        tx
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.source).toBe('manual');
    });
  });
});

// SC-307 / SC-308. Six of the seven paths that write this ledger wrote no
// `holding_coverage` at all, and the seventh wrote the whole run's bounds
// to every holding it touched. Deriving the summary at the write is what
// makes both impossible; these are the assertions that hold it there.
describe('HoldingTransactionRepository — coverage follows the ledger', () => {
  const coverage = () => Container.get(HoldingCoverageRepository);

  // THE SC-308 assertion, at the level every writer shares. One batch,
  // two holdings, four years between their first transactions. A run-global
  // first/last stamps 2021 on both and this fails.
  test('a batch touching two holdings gives each its own first tx, not the batch"s oldest', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const btcToken = await makeToken(tx);
      const newToken = await makeToken(tx);
      const btc = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: btcToken.id,
      });
      const fresh = await makeHolding(tx, {
        userId: user.id,
        accountId: acct.id,
        tokenId: newToken.id,
      });

      await repo().bulkUpsert(
        [
          {
            userId: user.id,
            holdingId: btc.id,
            tokenId: btcToken.id,
            kind: 'buy',
            quantity: '1',
            occurredAt: new Date('2021-05-05T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'btc-1',
          },
          {
            userId: user.id,
            holdingId: fresh.id,
            tokenId: newToken.id,
            kind: 'buy',
            quantity: '3',
            occurredAt: new Date('2026-08-09T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'new-1',
          },
        ],
        tx
      );

      expect((await coverage().findByHolding(btc.id, tx))?.firstTxAt?.toISOString()).toBe(
        '2021-05-05T00:00:00.000Z'
      );
      expect((await coverage().findByHolding(fresh.id, tx))?.firstTxAt?.toISOString()).toBe(
        '2026-08-09T00:00:00.000Z'
      );
    });
  });

  // SC-307: this is the CSV / manual-entry / APY-payout population. They
  // all reach the ledger through `bulkUpsert` and none of them knew coverage
  // existed.
  test('a non-ingester write creates the coverage row it never used to', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      expect(await coverage().findByHolding(holdingId, tx)).toBeNull();

      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'buy',
            quantity: '2',
            occurredAt: new Date('2023-11-11T00:00:00Z'),
            source: 'user-entered',
            externalId: 'manual-1',
          },
        ],
        tx
      );

      const row = await coverage().findByHolding(holdingId, tx);
      expect(row?.firstTxAt?.toISOString()).toBe('2023-11-11T00:00:00.000Z');
      expect(row?.lastTxAt?.toISOString()).toBe('2023-11-11T00:00:00.000Z');
    });
  });

  test('deleting a source narrows coverage back to what the ledger still holds', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'buy',
            quantity: '1',
            occurredAt: new Date('2019-01-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-old',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'buy',
            quantity: '1',
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            source: 'user-entered',
            externalId: 'm-new',
          },
        ],
        tx
      );
      expect((await coverage().findByHolding(holdingId, tx))?.firstTxAt?.getUTCFullYear()).toBe(
        2019
      );

      await repo().deleteForHoldingBySource(holdingId, 'kraken-api', tx);

      expect((await coverage().findByHolding(holdingId, tx))?.firstTxAt?.getUTCFullYear()).toBe(
        2026
      );
    });
  });
});

describe('HoldingTransactionRepository — swap group on re-import (SC-332)', () => {
  // `swap_group_id` is derived by the ingester from the transaction itself,
  // unlike `transfer_group_id` and `transfer_review`, which are the matcher's
  // and a person's and are deliberately preserved across a re-import. So the
  // re-import is authoritative about it — and if the conflict clause updates
  // `kind` to `swap_out` while leaving the group behind, the ledger gains a
  // swap leg linked to nothing at all.
  test('a re-import carries the swap group across with the kind', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const groupId = crypto.randomUUID();

      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'transfer_out',
            quantity: '-1',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'etherscan',
            externalId: '0xswap',
          },
        ],
        tx
      );

      const { rows: reimported } = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'swap_out',
            quantity: '-1',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'etherscan',
            externalId: '0xswap',
            swapGroupId: groupId,
          },
        ],
        tx
      );

      expect(reimported).toHaveLength(1);
      expect(reimported[0]?.kind).toBe('swap_out');
      expect(reimported[0]?.swapGroupId).toBe(groupId);
    });
  });
});

describe('describeMergedRows key list', () => {
  test('caps the key list so a bulk duplicate import cannot bury the count', () => {
    // The string is user-visible and is stored in the job result. A statement
    // with hundreds of repeated rows would otherwise carry several kilobytes
    // of UUIDs into the UI, hiding the one number an operator needs.
    const merges = Array.from({ length: 25 }, (_, i) => ({
      holdingId: `holding-${i}`,
      source: 'etherscan',
      externalId: `ext-${i}`,
      dropped: 1,
    }));
    const described = describeMergedRows(merges);
    expect(described).toContain('25 transaction row(s) across 25 dedup key(s)');
    expect(described).toContain('(+15 more)');
    expect(described).not.toContain('holding-10/');
  });
});
