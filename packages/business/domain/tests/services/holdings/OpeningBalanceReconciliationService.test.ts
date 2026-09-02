process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { flowRoleOf } from '../../../src/lib/returns/flow-classification';
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
    isHidden?: boolean;
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
  // What `holding_coverage.history_starts_at` says: the earliest date this
  // holding's ledger SOURCE covers, or undefined for the default — no source
  // has stated one (SC-900).
  historyStartsAt?: Date;
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
  // Mirrors the real `HoldingRepository.findByUser` on the one axis these
  // tests turn on: hidden holdings come back only when the caller asks for
  // them. A stub that returned the holding unconditionally would let the
  // `reconcileUser` tests below pass against the enumeration SC-502 is about,
  // which is the whole thing they exist to catch.
  Container.set(HoldingRepository, {
    findById: async () => (holdingRow as never) ?? null,
    findByUser: async (_userId: string, _tx?: unknown, includeHidden = false) =>
      (holdingRow && (includeHidden || !holdingRow.isHidden) ? [holdingRow] : []) as never,
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
    // Only `history_starts_at` is read, and only the null/non-null distinction
    // decides anything — the rest of the row is left off deliberately so a
    // future reader cannot key on a column this stub happens to invent.
    findByHolding: async () =>
      (opts.historyStartsAt ? { historyStartsAt: opts.historyStartsAt } : null) as never,
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
    // was projected flat across the whole of prior history AND booked as a
    // fresh contribution of the same size on the same day.
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
    // Production: a Wise savings opening at roughly twice the balance observed
    // that same afternoon. The difference is money that arrived
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

  test('THE DEFECT (SC-613): a tx dated BEFORE the first observation is not double-counted', async () => {
    // Measured end-to-end on 2026-08-25 through `UpdateHoldingUseCase`, on a
    // manual USD holding created at 4,000 and edited to 2,000 answered
    // `flow`. The numbers below are that run's, not invented ones.
    //
    // The client pre-fills today's date and a date-only value becomes LOCAL
    // midnight, so the synthesized `withdraw` is stamped BEFORE the
    // observation that captured the pre-edit 4,000. The walk back from that
    // observation then subtracts a withdrawal the anchor never included, and
    // counts the same 2,000 twice: once inside the 4,000, once in the walk.
    //
    // Same edit stamped at the edit instant instead — after the observation —
    // wrote 4,000 and was correct, which is what identifies the ordering as
    // the cause rather than a straddle over a committing transaction.
    const withdrawAt = new Date('2026-08-24T12:00:00Z');
    const { service, capturedTxs } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '2000' },
      txSumAllTime: '-2000',
      firstTxAt: withdrawAt,
      observations: [
        { observedAt: new Date('2026-08-25T08:22:42.861Z'), balance: '4000' },
        { observedAt: new Date('2026-08-25T08:22:42.883Z'), balance: '2000' },
      ],
      txsBeforeFirstObs: [
        { occurredAt: withdrawAt, quantity: '-2000', source: 'user-balance-edit' },
      ],
    });

    const r = await service.reconcileHolding('h1');

    // The invariant, on the number itself: the synthesized opening plus every
    // real transaction has to come to the balance the holding actually holds.
    // A test that only asserted an opening row EXISTS passes against 6,000.
    expect(capturedTxs).toHaveLength(1);
    expect(capturedTxs[0]?.quantity).toBe('4000');
    expect(new Decimal(capturedTxs[0]?.quantity ?? '0').add(new Decimal('-2000')).toString()).toBe(
      '2000'
    );

    // A negative residual is not a fact either — it is the ledger claiming to
    // explain MORE balance than exists.
    expect(r?.unexplainedResidual.toNumber()).toBe(0);
  });

  test('…and the returns denominator moves with it: contributions are 4000, not 6000', async () => {
    // `opening_balance` is an external contribution in
    // `lib/returns/flow-classification`, so an opening 2,000 too high inflates
    // every contribution total the performance figures divide by — measured
    // 6,000 against a true 4,000 on the run above, which understates the
    // return. This is the number a person reads, one step downstream of the
    // row.
    const withdrawAt = new Date('2026-08-24T12:00:00Z');
    const { service, capturedTxs } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '2000' },
      txSumAllTime: '-2000',
      firstTxAt: withdrawAt,
      observations: [
        { observedAt: new Date('2026-08-25T08:22:42.861Z'), balance: '4000' },
        { observedAt: new Date('2026-08-25T08:22:42.883Z'), balance: '2000' },
      ],
      txsBeforeFirstObs: [
        { occurredAt: withdrawAt, quantity: '-2000', source: 'user-balance-edit' },
      ],
    });
    await service.reconcileHolding('h1');

    const ledger = [
      ...capturedTxs.map((t) => ({ kind: t.kind, quantity: t.quantity })),
      { kind: 'withdraw', quantity: '-2000' },
    ];
    const contributions = ledger
      .filter((t) => flowRoleOf(t.kind) === 'external' && new Decimal(t.quantity).gt(0))
      .reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
    expect(contributions.toString()).toBe('4000');
  });

  test('SC-613, second reproduction: a holding created through the app', async () => {
    // The other worker's holding, made by `batchOperations.createHoldingsBatch`
    // rather than by hand: balance 500, real transactions summing -3,500, and
    // an opening of 5,000 written against a computed 4,000 — over by exactly
    // the one transaction dated at or before its first observation.
    const firstTxAt = new Date('2026-08-20T09:00:00Z');
    const { service, capturedTxs } = makeService({
      holding: { id: 'h2', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '500' },
      txSumAllTime: '-3500',
      firstTxAt,
      observations: [{ observedAt: new Date('2026-08-21T09:00:00Z'), balance: '4000' }],
      txsBeforeFirstObs: [{ occurredAt: firstTxAt, quantity: '-1000', source: 'exchange' }],
    });

    await service.reconcileHolding('h2');

    expect(capturedTxs[0]?.quantity).toBe('4000');
    expect(new Decimal(capturedTxs[0]?.quantity ?? '0').add(new Decimal('-3500')).toString()).toBe(
      '500'
    );
  });

  test('the SC-481 walk still LOWERS an opening — the bound only ever caps it', async () => {
    // The case the walk exists for, unchanged: the ledger explains the first
    // observation, and money arrived untracked afterwards. `computedOpening`
    // is 20,037.16 and the observation says 10,671.32 was there — the walk
    // must still win, or SC-481 comes back.
    const firstTxAt = new Date('2026-01-10T00:00:00Z');
    const { service, capturedTxs } = makeService({
      holding: { id: 'h3', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '20037.16' },
      txSumAllTime: '0',
      firstTxAt,
      observations: [{ observedAt: new Date('2026-01-10T12:00:00Z'), balance: '10671.32' }],
    });

    const r = await service.reconcileHolding('h3');

    expect(capturedTxs[0]?.quantity).toBe('10671.32');
    expect(r?.unexplainedResidual.toString()).toBe('9365.84');
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

describe('OpeningBalanceReconciliationService.reconcileUser', () => {
  /**
   * SC-502. The user-wide enumeration used to inherit `findByUser`'s default,
   * which hides hidden holdings because that default was written for the
   * dashboard. So a hidden holding could receive an opening row through
   * `TransactionImportCoordinator` — which reconciles whatever an import
   * touched and has never filtered on `isHidden` — and then never be revisited
   * to have it corrected.
   *
   * This assertion stays meaningful after any later change to what the
   * reconciler DECIDES, because it turns on reach rather than on outcome: it
   * asserts a result came back for a hidden holding at all. The branch that
   * result came from is pinned by the test below it.
   */
  test('reaches a HIDDEN holding — the repair path can reach what it wrote (SC-502)', async () => {
    const { service } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '10',
        isHidden: true,
      },
      txSumAllTime: '4',
      firstTxAt: new Date('2024-03-15T12:00:00Z'),
    });

    const results = await service.reconcileUser('u1');

    expect(results).toHaveLength(1);
    expect(results[0]?.holdingId).toBe('h1');
  });

  test('…and REPAIRS it: a negative gap on a hidden holding deletes the stale row', async () => {
    const { service, capturedTxs, capturedReconciliations, deletes } = makeService({
      holding: {
        id: 'h1',
        userId: 'u1',
        accountId: 'a1',
        tokenId: 't1',
        balance: '0',
        isHidden: true,
      },
      // The production shape: one +4474 deposit against a balance of 0, so the
      // gap is negative and no opening row may stand (SC-199).
      txSumAllTime: '4474',
      firstTxAt: new Date('2026-07-14T15:31:54Z'),
    });

    const results = await service.reconcileUser('u1');

    expect(results[0]?.openingBalanceSynthesized).toBe(false);
    expect(capturedTxs).toHaveLength(0);
    expect(deletes()).toBe(1);
    expect(capturedReconciliations[0]?.openingBalanceQuantity).toBe('-4474');
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain('Missing inflows');
  });

  /**
   * SC-888 — why the queue's `fee` answer writes no `kind='fee'` row.
   *
   * The declared path (SC-857) writes one, and correctly: it owns the source
   * anchor, so it carves the charge OUT of the withdrawal and the two rows
   * still sum to the delta the anchor moved by. The queue owns neither the
   * imported row nor the anchor behind it. Its fee is a share of a quantity
   * ALREADY in the ledger — `splitSumMatches` refuses a division that does not
   * sum to the row — so a `kind='fee'` row beside it is the same money twice.
   *
   * The pair below is the measurement, not the argument. Identical holding,
   * identical anchor, one extra row. `sumQuantityForHoldingUntil` filters on
   * `source = 'reconciliation-opening'` and on nothing else, so no kind is
   * exempt and `fee` is not special here.
   */
  test('a fee row beside a full-amount withdrawal manufactures a phantom opening', async () => {
    const firstTxAt = new Date('2024-02-01T00:00:00Z');
    // The imported ledger as it stands: opened at 10,000, one withdrawal of
    // 4,000 of which 500 was the bank's charge. The anchor agrees.
    const asImported = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '6000' },
      txSumAllTime: '6000',
      firstTxAt,
    });
    const clean = await asImported.service.reconcileHolding('h1');
    expect(clean?.openingBalanceSynthesized).toBe(false);
    expect(clean?.computedOpening.toString()).toBe('0');

    // The same ledger with a -500 `kind='fee'` row added beside the untouched
    // -4,000 withdrawal, which is what "a fee portion writes a real fee row"
    // means when the withdrawal cannot be restated.
    const withFeeRow = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '6000' },
      txSumAllTime: '5500',
      firstTxAt,
    });
    const damaged = await withFeeRow.service.reconcileHolding('h1');
    expect(damaged?.openingBalanceSynthesized).toBe(true);
    // 500 of holdings this account never had, dated before its history begins,
    // on the very holding the reader was trying to describe accurately.
    expect(damaged?.computedOpening.toString()).toBe('500');
    expect(withFeeRow.capturedTxs[0]?.kind).toBe('opening_balance');
    expect(withFeeRow.capturedTxs[0]?.quantity).toBe('500');
  });

  test('a visible holding is still reconciled — the widen did not narrow anything', async () => {
    const { service } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10' },
      txSumAllTime: '4',
      firstTxAt: new Date('2024-03-15T12:00:00Z'),
    });

    const results = await service.reconcileUser('u1');

    expect(results).toHaveLength(1);
    expect(results[0]?.openingBalanceSynthesized).toBe(true);
  });
});

/**
 * SC-900 — a settled fact must not render as an open question.
 *
 * A holding whose ledger comes from a bounded source leaves money that moved
 * before the bound with no transaction to record it. The arithmetic is
 * identical to a genuine reconciliation failure and the sentence used to be
 * identical too, so every audit that met the second case re-opened the first.
 * It was re-derived four times over one account before it was written down.
 *
 * Every figure and date below is invented. The production numbers this was
 * found on stay on the board.
 */
describe('OpeningBalanceReconciliationService — a bounded source is not an unexplained gap', () => {
  // A window a saved report query might name. Nothing here is derived from
  // any real account; the dates only have to be ordered.
  const STATEMENT_FROM = new Date('2024-03-01T00:00:00Z');
  const LATER_STATEMENT_FROM = new Date('2024-09-01T00:00:00Z');
  // Earlier than the window on purpose: a statement covering a range can
  // REPORT a row dated before that range (an accrued fee, a corrected
  // settlement), which is exactly why the boundary cannot be derived from the
  // ledger's own earliest row.
  const FIRST_TX_AT = new Date('2024-01-15T00:00:00Z');

  // The shape that reaches this branch: the transactions sum to more than the
  // holding actually holds, so `balance - sum(txs)` is negative — a "you held
  // minus a hundred before your history begins" that cannot be a fact, and is
  // recorded as missing inflows instead (SC-199).
  function missingInflows(historyStartsAt?: Date) {
    return makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '40' },
      txSumAllTime: '140',
      firstTxAt: FIRST_TX_AT,
      ...(historyStartsAt ? { historyStartsAt } : {}),
    });
  }

  test('with a stated window the shortfall is categorised as an opening position', async () => {
    const { service, capturedReconciliations } = missingInflows(STATEMENT_FROM);
    const r = await service.reconcileHolding('h1');

    expect(r?.residueCause).toBe('before-available-history');
    expect(r?.historyStartsAt).toEqual(STATEMENT_FROM);
    expect(capturedReconciliations[0]?.reconciliationNotes).toContain(
      'predates the earliest available statement'
    );
  });

  /**
   * THE CONTROL, and it has to be able to come back red on its own. Without a
   * stated window nothing is known about reach, so the honest answer is the
   * one that was always there. A change that reached the new category from
   * `has_complete_tx_history` — false by default, and false for reasons that
   * say nothing about reach — would relabel every unexplained residue in the
   * product and pass every other test in this block.
   */
  test('with NO stated window it stays unexplained, in the words it always had', async () => {
    const { service, capturedReconciliations } = missingInflows();
    const r = await service.reconcileHolding('h1');

    expect(r?.residueCause).toBe('unexplained');
    expect(r?.historyStartsAt).toBeNull();
    const note = capturedReconciliations[0]?.reconciliationNotes ?? '';
    expect(note).toContain('Missing inflows');
    expect(note).not.toContain('predates the earliest available statement');
  });

  /**
   * CONSTRAINT 1, and the whole reason the boundary is a stored value rather
   * than a literal. The window slides — it is a date range somebody picked in
   * their broker's report editor, and re-picking it moves the boundary. A
   * hardcoded date would go on printing the old one, which is a false
   * explanation over a real gap and strictly worse than the honest
   * "unexplained" it replaced.
   *
   * Two runs, one variable: the same holding, the same ledger, the same
   * shortfall, a different stated window.
   */
  test('the boundary follows the window: a later statement moves the date it names', async () => {
    const early = missingInflows(STATEMENT_FROM);
    await early.service.reconcileHolding('h1');
    const earlyNote = early.capturedReconciliations[0]?.reconciliationNotes ?? '';

    const late = missingInflows(LATER_STATEMENT_FROM);
    const lateResult = await late.service.reconcileHolding('h1');
    const lateNote = late.capturedReconciliations[0]?.reconciliationNotes ?? '';

    expect(earlyNote).toContain(STATEMENT_FROM.toISOString());
    expect(lateNote).toContain(LATER_STATEMENT_FROM.toISOString());
    expect(lateNote).not.toContain(STATEMENT_FROM.toISOString());
    expect(lateResult?.historyStartsAt).toEqual(LATER_STATEMENT_FROM);
  });

  /**
   * The date named is the SOURCE'S window, not `openingAt`.
   *
   * `openingAt` sits one millisecond before this holding's earliest evidence,
   * and the fixture puts that six weeks BEFORE the window the statement covers
   * — the real shape, because a statement can report a row dated before its
   * own range. Naming `openingAt` would claim a wider window than the one that
   * exists and explain away the weeks between the two dates, which nothing
   * fetched.
   */
  test('it names the window, not the holding earliest evidence', async () => {
    const { service, capturedReconciliations } = missingInflows(STATEMENT_FROM);
    await service.reconcileHolding('h1');
    const note = capturedReconciliations[0]?.reconciliationNotes ?? '';

    expect(note).toContain(STATEMENT_FROM.toISOString());
    expect(note).not.toContain(new Date(FIRST_TX_AT.getTime() - 1).toISOString());
  });

  /**
   * IT IS A CAUSE, NOT A DISCOUNT. Naming the boundary must change no
   * arithmetic and must not net the residue away — a figure reconciling to
   * zero is exactly what would stop anyone noticing the day the window
   * genuinely breaks.
   */
  test('the amount survives being explained', async () => {
    const named = missingInflows(STATEMENT_FROM);
    const bare = missingInflows();
    const withWindow = await named.service.reconcileHolding('h1');
    const without = await bare.service.reconcileHolding('h1');

    expect(withWindow?.unexplainedResidual.toString()).toBe(
      without?.unexplainedResidual.toString()
    );
    expect(withWindow?.computedOpening.toString()).toBe('-100');
    expect(withWindow?.openingBalanceSynthesized).toBe(false);
    // Still on the coverage row with the sign the data-quality UI keys on.
    expect(named.capturedReconciliations[0]?.openingBalanceQuantity).toBe('-100');
    expect(named.capturedReconciliations[0]?.reconciliationNotes).toContain('100');
  });

  /**
   * CONSTRAINT 2 — per holding, and derived rather than declared.
   *
   * A stated window does NOT reach a residue the reconciler has positive
   * evidence about. `arrived-later` means an observation says the ledger
   * explained the balance as of the holding's start, so whatever is missing
   * arrived AFTER the window rather than before it, and the boundary cannot
   * account for it. Two currencies on one bounded statement land on the two
   * different branches for exactly this reason, which is why the split falls
   * out of the evidence instead of needing a flag.
   */
  test('a residue that demonstrably arrived LATER is never explained by the window', async () => {
    const observedAt = new Date('2024-06-01T00:00:00Z');
    const { service, capturedReconciliations } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '30' },
      txSumAllTime: '10',
      firstTxAt: FIRST_TX_AT,
      // The balance observed at the opening moment is zero, so the ledger
      // already explained the holding then and the 20 arrived afterwards.
      observations: [{ observedAt, balance: '10' }],
      txsBeforeFirstObs: [{ occurredAt: new Date('2024-02-01T00:00:00Z'), quantity: '10' }],
      historyStartsAt: STATEMENT_FROM,
    });
    const r = await service.reconcileHolding('h1');

    expect(r?.residueCause).toBe('unexplained');
    expect(r?.unexplainedResidual.toString()).toBe('20');
    expect(capturedReconciliations[0]?.reconciliationNotes).not.toContain(
      'predates the earliest available statement'
    );
  });

  test('a holding whose ledger closes has no residue to categorise', async () => {
    const { service } = makeService({
      holding: { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10' },
      txSumAllTime: '10',
      firstTxAt: FIRST_TX_AT,
      historyStartsAt: STATEMENT_FROM,
    });
    const r = await service.reconcileHolding('h1');
    expect(r?.residueCause).toBe('none');
  });

  /**
   * `projectHolding` is what a repair script shows an operator before the
   * write happens, so it has to carry the same category the write will use —
   * a preview that could not show the boundary would put the operator back on
   * the original evidence, which is the repetition this ticket is about.
   */
  test('the projection carries the same category as the write', async () => {
    const { service } = missingInflows(STATEMENT_FROM);
    const projection = await service.projectHolding('h1');
    expect(projection?.action).toBe('missing-inflows');
    expect(projection?.residueCause).toBe('before-available-history');
    expect(projection?.historyStartsAt).toEqual(STATEMENT_FROM);
  });
});
