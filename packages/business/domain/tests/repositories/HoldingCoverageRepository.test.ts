import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../src/repositories/HoldingCoverageRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

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

describe('HoldingCoverageRepository', () => {
  test('findByHolding returns null when no coverage row exists', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const r = await repo().findByHolding(holdingId, tx);
      expect(r).toBeNull();
    });
  });

  test('upsertFromIngester inserts a fresh coverage row when none exists', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const row = await repo().upsertFromIngester(
        {
          holdingId,
          firstTxAt: new Date('2024-01-01T00:00:00Z'),
          lastTxAt: new Date('2024-12-31T23:59:59Z'),
          firstObservationAt: null,
          lastObservationAt: null,
          txSources: ['kraken-api'],
          hasCompleteTxHistory: true,
        },
        tx
      );
      expect(row.holdingId).toBe(holdingId);
      expect(row.txSources).toEqual(['kraken-api']);
      expect(row.hasCompleteTxHistory).toBe(true);
      expect(row.firstTxAt?.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    });
  });

  test('upsertFromIngester widens the tx range and unions tx sources on subsequent calls', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      // First ingest covers 2024 Q2 with kraken-api.
      await repo().upsertFromIngester(
        {
          holdingId,
          firstTxAt: new Date('2024-04-01T00:00:00Z'),
          lastTxAt: new Date('2024-06-30T23:59:59Z'),
          firstObservationAt: null,
          lastObservationAt: null,
          txSources: ['kraken-api'],
          hasCompleteTxHistory: false,
        },
        tx
      );
      // Second ingest extends to 2024 H1 + adds binance-api.
      const after = await repo().upsertFromIngester(
        {
          holdingId,
          firstTxAt: new Date('2024-01-01T00:00:00Z'),
          lastTxAt: new Date('2024-12-31T23:59:59Z'),
          firstObservationAt: null,
          lastObservationAt: null,
          txSources: ['binance-api'],
          hasCompleteTxHistory: true,
        },
        tx
      );
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
      await repo().upsertFromIngester(
        {
          holdingId,
          firstTxAt: new Date('2024-01-01T00:00:00Z'),
          lastTxAt: new Date('2024-12-31T23:59:59Z'),
          firstObservationAt: null,
          lastObservationAt: null,
          txSources: ['kraken-api'],
          hasCompleteTxHistory: false,
        },
        tx
      );
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

  test('findByUser returns coverage rows for the user across multiple holdings', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const acctA = await makeAccount(tx, { userId: userA.id, institutionId: inst.id });
      const acctB = await makeAccount(tx, { userId: userB.id, institutionId: inst.id });
      const tok1 = await makeToken(tx);
      const tok2 = await makeToken(tx);
      const hA1 = await makeHolding(tx, {
        userId: userA.id,
        accountId: acctA.id,
        tokenId: tok1.id,
      });
      const hA2 = await makeHolding(tx, {
        userId: userA.id,
        accountId: acctA.id,
        tokenId: tok2.id,
      });
      const hB1 = await makeHolding(tx, {
        userId: userB.id,
        accountId: acctB.id,
        tokenId: tok1.id,
      });

      for (const h of [hA1, hA2, hB1]) {
        await repo().upsertFromIngester(
          {
            holdingId: h.id,
            firstTxAt: new Date('2024-01-01T00:00:00Z'),
            lastTxAt: new Date('2024-12-31T23:59:59Z'),
            firstObservationAt: null,
            lastObservationAt: null,
            txSources: [`source-${h.id.slice(0, 4)}`],
            hasCompleteTxHistory: false,
          },
          tx
        );
      }

      const coverageA = await repo().findByUser(userA.id, tx);
      // userA has 2 holdings → 2 coverage rows.
      expect(coverageA).toHaveLength(2);
      const idsA = new Set(coverageA.map((c) => c.holdingId));
      expect(idsA.has(hA1.id)).toBe(true);
      expect(idsA.has(hA2.id)).toBe(true);
      expect(idsA.has(hB1.id)).toBe(false);
    });
  });
});
