process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';

// Stubs leak across files because typedi's Container is process-global.
// After this suite, restore real @Service() instances so a later
// repo/service test that ran in the same `bun test` invocation can
// resolve the real DB-backed implementation.
afterAll(() => {
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(HoldingCoverageRepository, new HoldingCoverageRepository());
  Container.set(OpeningBalanceReconciliationService, new OpeningBalanceReconciliationService());
});

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
} {
  const capturedTxs: CapturedTx[] = [];
  const capturedReconciliations: CapturedReconciliation[] = [];

  Container.set(HoldingRepository, {
    findById: async () => (opts.holding as never) ?? null,
    findByUser: async () => [] as never,
  } as unknown as HoldingRepository);

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
  } as unknown as HoldingTransactionRepository);

  Container.set(HoldingCoverageRepository, {
    upsertReconciliation: async (row: CapturedReconciliation) => {
      capturedReconciliations.push(row);
      return row as never;
    },
  } as unknown as HoldingCoverageRepository);

  const service = new OpeningBalanceReconciliationService();
  Container.set(OpeningBalanceReconciliationService, service);
  return { service, capturedTxs, capturedReconciliations };
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

  test('synthesizes a negative opening_balance when tx sum exceeds holdings (missing inflows)', async () => {
    const { service, capturedTxs, capturedReconciliations } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '5' },
      txSumAllTime: '12',
      firstTxAt: new Date('2024-04-01T00:00:00Z'),
    });
    const r = await service.reconcileHolding('h1');
    expect(r?.openingBalanceSynthesized).toBe(true);
    expect(new Decimal(r?.computedOpening.toString() ?? '0').toNumber()).toBe(-7);
    expect(capturedTxs[0]?.quantity).toBe('-7');
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain(
      'Synthesized negative opening balance'
    );
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
