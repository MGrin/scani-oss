process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

// Stubbed-DI pattern (see BalanceAtTimeService.test.ts for the pattern's
// rationale). We seed the Container with minimal stubs that implement
// only the methods the service touches; anything else throws if hit.

interface CapturedTx {
  userId: string;
  holdingId: string;
  tokenId: string;
  kind: string;
  quantity: string;
  occurredAt: Date;
  source: string;
  externalId: string;
  sourceMetadata?: Record<string, unknown>;
}

interface CapturedReconciliation {
  holdingId: string;
  lastReconciledAt: Date;
  openingBalanceQuantity: string | null;
  reconciliationNotes: string | null;
}

function makeService(opts: {
  holding: {
    id: string;
    userId: string;
    accountId: string;
    tokenId: string;
    balance: string;
  } | null;
  txSumAllTime: string;
  firstTxAt?: Date;
}): {
  service: OpeningBalanceReconciliationService;
  capturedTxs: CapturedTx[];
  capturedReconciliations: CapturedReconciliation[];
  // Exposed for SC-199: the negative branch must DELETE any row a previous
  // run left behind, so re-running repairs the ledger instead of leaving the
  // old claim standing beside the new note.
  deletes: () => number;
} {
  const capturedTxs: CapturedTx[] = [];
  const capturedReconciliations: CapturedReconciliation[] = [];

  Container.set(HoldingRepository, {
    findById: async () => (opts.holding as never) ?? null,
    findByUser: async () => [] as never,
  } as unknown as HoldingRepository);

  let deletedReconciliationOpenings = 0;
  Container.set(HoldingTransactionRepository, {
    findExtremesForHolding: async () =>
      ({
        first: opts.firstTxAt ?? null,
        last: opts.firstTxAt ?? null,
      }) as never,
    sumQuantityForHoldingUntil: async () => opts.txSumAllTime,
    bulkUpsert: async (rows: CapturedTx[]) => {
      capturedTxs.push(...rows);
      return rows as never;
    },
    deleteReconciliationOpening: async () => {
      deletedReconciliationOpenings++;
      return 0;
    },
  } as unknown as HoldingTransactionRepository);

  Container.set(HoldingCoverageRepository, {
    upsertReconciliation: async (row: CapturedReconciliation) => {
      capturedReconciliations.push(row);
      return row as never;
    },
  } as unknown as HoldingCoverageRepository);

  const service = new OpeningBalanceReconciliationService();
  Container.set(OpeningBalanceReconciliationService, service);
  return {
    service,
    capturedTxs,
    capturedReconciliations,
    deletes: () => deletedReconciliationOpenings,
  };
}

describe('OpeningBalanceReconciliationService.reconcileHolding', () => {
  test('returns null when the holding does not exist', async () => {
    const { service } = makeService({ holding: null, txSumAllTime: '0' });
    const r = await service.reconcileHolding('missing-id');
    expect(r).toBeNull();
  });

  test('returns null when the holding has no transactions', async () => {
    const { service, capturedTxs } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '5' },
      txSumAllTime: '0',
      firstTxAt: undefined,
    });
    const r = await service.reconcileHolding('h1');
    expect(r).toBeNull();
    expect(capturedTxs).toHaveLength(0);
  });

  test('marks fully-reconciled when tx sum matches holdings balance within epsilon', async () => {
    const { service, capturedTxs, capturedReconciliations } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10' },
      txSumAllTime: '10',
      firstTxAt: new Date('2024-01-01T00:00:00Z'),
    });
    const r = await service.reconcileHolding('h1');
    expect(r).not.toBeNull();
    expect(r?.openingBalanceSynthesized).toBe(false);
    expect(r?.openingAt).toBeNull();
    // No opening tx synthesized.
    expect(capturedTxs).toHaveLength(0);
    // Coverage row written with no opening balance.
    expect(capturedReconciliations).toHaveLength(1);
    expect(capturedReconciliations[0]?.openingBalanceQuantity).toBeNull();
    expect(capturedReconciliations[0]?.reconciliationNotes).toBeNull();
  });

  test('synthesizes a positive opening_balance when holdings exceed tx sum', async () => {
    const firstTxAt = new Date('2024-03-15T12:00:00Z');
    const { service, capturedTxs, capturedReconciliations } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10' },
      txSumAllTime: '4',
      firstTxAt,
    });
    const r = await service.reconcileHolding('h1');
    expect(r?.openingBalanceSynthesized).toBe(true);
    expect(r?.computedOpening.toString()).toBe('6');
    expect(capturedTxs).toHaveLength(1);
    const tx = capturedTxs[0];
    expect(tx?.kind).toBe('opening_balance');
    expect(tx?.quantity).toBe('6');
    expect(tx?.source).toBe('reconciliation-opening');
    expect(tx?.externalId).toBe('opening_balance');
    // Opening tx lands one millisecond before the first real tx.
    expect(tx?.occurredAt.getTime()).toBe(firstTxAt.getTime() - 1);
    expect(capturedReconciliations[0]?.openingBalanceQuantity).toBe('6');
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain(
      'Synthesized opening balance'
    );
  });

  test('THE DEFECT: a negative opening is NOT written to the ledger (SC-199)', async () => {
    // Production held eleven of these. `USDT -4474` asserts the user held
    // minus four thousand USDT before their history begins, which is not a
    // thing that can have been true — and cost basis reads it as a negative
    // acquisition while `BalanceAtTimeService.clamp` floors the chart at zero,
    // hiding the very discrepancy the row was invented to expose.
    const { service, capturedTxs } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '5' },
      txSumAllTime: '12',
      firstTxAt: new Date('2024-04-01T00:00:00Z'),
    });
    const r = await service.reconcileHolding('h1');

    expect(capturedTxs).toHaveLength(0);
    expect(r?.openingBalanceSynthesized).toBe(false);
    expect(r?.openingAt).toBeNull();
    // The gap itself is still computed and returned — not writing it to the
    // ledger is not the same as not knowing it.
    expect(new Decimal(r?.computedOpening.toString() ?? '0').toNumber()).toBe(-7);
  });

  test('...and the gap is still FLAGGED, in the column the UI already reads', async () => {
    // The half worth being careful about. Replacing a wrong number with
    // silence is this codebase's characteristic failure, and a user whose
    // balance does not reconcile has a real problem. `HoldingQueryService`
    // raises `dataIntegrity.incompleteHistory` from
    // `openingBalanceQuantity < 0` and the Data quality panel counts the same
    // predicate, so the badge the reader sees is unchanged.
    const { service, capturedReconciliations } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '5' },
      txSumAllTime: '12',
      firstTxAt: new Date('2024-04-01T00:00:00Z'),
    });
    await service.reconcileHolding('h1');

    const coverage = capturedReconciliations[0];
    expect(coverage?.openingBalanceQuantity).toBe('-7');
    expect(new Decimal(coverage?.openingBalanceQuantity ?? '0').lt(0)).toBe(true);
    // It says what is missing, not what was held.
    expect(coverage?.reconciliationNotes).toContain('Missing inflows of 7');
    expect(coverage?.reconciliationNotes).not.toContain('Synthesized');
  });

  test('re-running REPAIRS a ledger a previous run wrote a negative row into', async () => {
    // Otherwise the old claim stands beside the new note and the ledger keeps
    // asserting the impossible number forever.
    const { service, deletes } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '5' },
      txSumAllTime: '12',
      firstTxAt: new Date('2024-04-01T00:00:00Z'),
    });
    await service.reconcileHolding('h1');
    expect(deletes()).toBe(1);
  });

  test('respects an explicit epsilon — small diffs treated as rounding', async () => {
    const { service, capturedTxs } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10.00000001' },
      txSumAllTime: '10',
      firstTxAt: new Date('2024-01-01T00:00:00Z'),
    });
    // Default epsilon is 1e-12 — too tight, so this would synthesize.
    // Pass a looser epsilon and confirm reconciliation skips synthesis.
    const r = await service.reconcileHolding('h1', { epsilon: new Decimal('1e-6') });
    expect(r?.openingBalanceSynthesized).toBe(false);
    expect(capturedTxs).toHaveLength(0);
  });
});
