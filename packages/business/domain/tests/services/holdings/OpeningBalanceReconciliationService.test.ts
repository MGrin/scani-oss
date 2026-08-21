process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
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
    createdAt?: Date;
  } | null;
  txSumAllTime: string;
  firstTxAt?: Date;
  // The holding's balance observations, oldest first. SC-475 moved the
  // opening stamp onto the earliest of these, and SC-481 takes the opening
  // QUANTITY from the first one, so a fixture without them exercises only
  // the observation-free path.
  observations?: Array<{ observedAt: Date; balance: string }>;
  // Real transactions the walk from the first observation back to the
  // opening has to pass through.
  txsBeforeFirstObs?: Array<{ occurredAt: Date; quantity: string; source?: string }>;
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

  const holdingRow = opts.holding
    ? { createdAt: opts.firstTxAt ?? new Date('2100-01-01T00:00:00Z'), ...opts.holding }
    : null;
  Container.set(HoldingRepository, {
    findById: async () => (holdingRow as never) ?? null,
    findByUser: async () => [] as never,
  } as unknown as HoldingRepository);

  const observations = opts.observations ?? [];
  Container.set(HoldingBalanceObservationRepository, {
    findExtremesForHolding: async () =>
      ({
        first: observations[0]?.observedAt ?? null,
        last: observations[observations.length - 1]?.observedAt ?? null,
      }) as never,
    findLatestAtOrAfter: async (_id: string, at: Date) =>
      (observations.find((o) => o.observedAt.getTime() >= at.getTime()) ?? null) as never,
    findLatestAtOrBefore: async () => null as never,
  } as unknown as HoldingBalanceObservationRepository);

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
    findForHoldingInRange: async (_id: string, from: Date, to: Date) =>
      (opts.txsBeforeFirstObs ?? []).filter(
        (t) => t.occurredAt.getTime() > from.getTime() && t.occurredAt.getTime() <= to.getTime()
      ) as never,
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

  // Rebuilt per test: typedi caches by class, and a BalanceAtTimeService
  // constructed against the previous test's stubs would hold references to
  // them for the rest of the file.
  Container.set(BalanceAtTimeService, new BalanceAtTimeService());

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

  // ---------------------------------------------------------------------
  // SC-475 fault A and SC-481. Both live in this service and they interact:
  // moving the stamp changes which observation is "at" the opening, which
  // changes what the right quantity is.
  // ---------------------------------------------------------------------

  test('THE DEFECT (SC-475): the opening is stamped before the first OBSERVATION, not the first tx', async () => {
    // The production shape, exactly. A daily-interest cash account is
    // observed at connect time and its first real transaction is the NEXT
    // day's accrual, so an opening at `first tx − 1ms` lands 7h08m AFTER the
    // observation that anchors every earlier date. `BalanceAtTimeService`
    // walks back only `(at, anchor]`, so it never subtracted it: the balance
    // was projected flat across thirteen months of history AND booked as a
    // fresh +26,976.50 contribution on the same day.
    const observedAt = new Date('2026-05-17T16:51:42.148Z');
    const firstTxAt = new Date('2026-05-18T00:00:00.000Z');
    const { service, capturedTxs } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '10671.32',
        createdAt: observedAt,
      },
      txSumAllTime: '0',
      firstTxAt,
      observations: [{ observedAt, balance: '10671.32' }],
    });

    const r = await service.reconcileHolding('h1');

    expect(r?.openingBalanceSynthesized).toBe(true);
    expect(capturedTxs[0]?.occurredAt.getTime()).toBe(observedAt.getTime() - 1);
    // …and emphatically not the old answer.
    expect(capturedTxs[0]?.occurredAt.getTime()).not.toBe(firstTxAt.getTime() - 1);
  });

  test('an imported trade history is UNMOVED — its first tx already precedes every observation', async () => {
    // The ten production rows that behaved correctly. The distinction is
    // mechanical, not a special case: `earliestEvidenceAt` takes the oldest
    // of first tx / first observation / holding row, and for an imported
    // brokerage history that is the first trade, exactly as before.
    const firstTxAt = new Date('2025-10-31T09:30:01.000Z');
    const observedAt = new Date('2026-05-17T14:57:00.110Z');
    const { service, capturedTxs } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '20',
        createdAt: observedAt,
      },
      txSumAllTime: '3',
      firstTxAt,
      observations: [{ observedAt, balance: '20' }],
      txsBeforeFirstObs: [{ occurredAt: firstTxAt, quantity: '3' }],
    });

    const r = await service.reconcileHolding('h1');
    expect(capturedTxs[0]?.occurredAt.getTime()).toBe(firstTxAt.getTime() - 1);
    // 20 observed, 3 explained by the trade in between → 17 held at the open,
    // which is the same number the pre-SC-481 rule produced here.
    expect(r?.openingQuantity.toString()).toBe('17');
    expect(r?.computedOpening.toString()).toBe('17');
    expect(r?.unexplainedResidual.toString()).toBe('0');
  });

  test("THE DEFECT (SC-481): the quantity is the balance observed AT the opening, not today's", async () => {
    // Production: Wise Savings opened at 20,037.16 against a balance observed
    // that same afternoon of 10,671.32. The difference is money that arrived
    // over the following three months, swept into the opening by a quantity
    // recomputed against today's balance and retro-dated to a moment it did
    // not exist.
    const observedAt = new Date('2026-05-17T16:51:42.148Z');
    const { service, capturedTxs, capturedReconciliations } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '20037.16',
        createdAt: observedAt,
      },
      txSumAllTime: '0',
      firstTxAt: new Date('2026-05-18T00:00:00.000Z'),
      observations: [{ observedAt, balance: '10671.32' }],
    });

    const r = await service.reconcileHolding('h1');

    expect(capturedTxs[0]?.quantity).toBe('10671.32');
    expect(r?.openingQuantity.toString()).toBe('10671.32');
    // The gap is still known in full — the 9,365.84 is not lost, it is
    // refused a date it cannot support.
    expect(r?.computedOpening.toString()).toBe('20037.16');
    expect(r?.unexplainedResidual.toString()).toBe('9365.84');
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain('9365.84');
  });

  test('…and where the ledger already explains the first observation, NO opening is written', async () => {
    // Production held this too: a USDC holding whose transactions account for
    // its balance at the first observation, with 516.2026 arriving untracked
    // afterwards. The old rule dated all 516.2026 to 2025-12-05.
    const observedAt = new Date('2026-05-17T15:06:35.613Z');
    const firstTxAt = new Date('2025-12-05T09:14:35.000Z');
    const { service, capturedTxs, capturedReconciliations, deletes } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '516.2026',
        createdAt: observedAt,
      },
      txSumAllTime: '0',
      firstTxAt,
      observations: [{ observedAt, balance: '100' }],
      txsBeforeFirstObs: [{ occurredAt: firstTxAt, quantity: '100' }],
    });

    const r = await service.reconcileHolding('h1');

    expect(capturedTxs).toHaveLength(0);
    expect(deletes()).toBe(1);
    expect(r?.openingBalanceSynthesized).toBe(false);
    expect(r?.unexplainedResidual.toString()).toBe('516.2026');
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain('NOT backdated');
  });

  test('a holding that has never been observed keeps the pre-SC-481 answer', async () => {
    // Manual and import-only holdings have no observation to take a quantity
    // from, so the whole gap remains the best claim available. Refusing to
    // write anything there would replace a wrong number with nothing, which
    // is the failure this service already documents at length.
    const firstTxAt = new Date('2024-03-15T12:00:00Z');
    const { service, capturedTxs } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '10',
        createdAt: firstTxAt,
      },
      txSumAllTime: '4',
      firstTxAt,
    });

    const r = await service.reconcileHolding('h1');
    expect(capturedTxs[0]?.quantity).toBe('6');
    expect(r?.unexplainedResidual.toString()).toBe('0');
  });

  test('running twice writes the same opening — the stamp does not creep', async () => {
    // `earliestEvidenceAt` is asked to exclude `reconciliation-opening` rows
    // for exactly this reason: counting its own output as evidence would put
    // each run's opening one millisecond before the last one, forever.
    const observedAt = new Date('2026-05-17T16:51:42.148Z');
    const fixture = {
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '20037.16',
        createdAt: observedAt,
      },
      txSumAllTime: '0',
      firstTxAt: new Date('2026-05-18T00:00:00.000Z'),
      observations: [{ observedAt, balance: '10671.32' }],
    };
    const { service, capturedTxs } = makeService(fixture);
    await service.reconcileHolding('h1');
    await service.reconcileHolding('h1');

    expect(capturedTxs).toHaveLength(2);
    expect(capturedTxs[0]?.occurredAt.getTime()).toBe(capturedTxs[1]?.occurredAt.getTime());
    expect(capturedTxs[0]?.quantity).toBe(capturedTxs[1]?.quantity);
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
