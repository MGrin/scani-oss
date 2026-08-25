import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { BalanceAtTimeService } from '../pricing/BalanceAtTimeService';

// What the reconciler will do to one holding, computed without doing it.
export interface OpeningProjection {
  holdingId: string;
  userId: string;
  accountId: string;
  tokenId: string;
  holdingsBalance: Decimal;
  txSumAllTime: Decimal;
  computedOpening: Decimal;
  // `reconciled`      — the ledger explains the balance; any opening row is deleted.
  // `missing-inflows` — the gap is NEGATIVE, so no row is written. A negative
  //                     opening asserts the user held minus four thousand USDT
  //                     before their history begins, which is not a thing that
  //                     can have been true; what is true is that inflows are
  //                     missing, and that is recorded on the coverage row in
  //                     the same column and with the same sign the UI already
  //                     keys on (SC-199).
  // `arrived-later`   — the ledger explains the balance as of the first
  //                     observation, so the unexplained amount arrived after
  //                     it. No row, and specifically not a backdated one.
  // `opening`         — a row is written, at `openingAt`, for `openingQuantity`.
  action: 'reconciled' | 'missing-inflows' | 'arrived-later' | 'opening';
  openingAt: Date | null;
  openingQuantity: Decimal;
  unexplainedResidual: Decimal;
}

export interface ReconciliationResult {
  holdingId: string;
  accountId: string;
  tokenId: string;
  holdingsBalance: Decimal;
  txSumAllTime: Decimal;
  // `holdings.balance - sum(real txs)` — the whole amount the ledger fails
  // to account for. Before SC-481 this WAS the synthesized quantity, which
  // is why every untracked inflow arriving after the opening was retro-dated
  // to it. It is now the bound, not the answer.
  computedOpening: Decimal;
  // What was actually synthesized: the balance observed at the opening
  // moment. Zero when no opening row was written.
  openingQuantity: Decimal;
  // `computedOpening - openingQuantity`: balance that is genuinely
  // unexplained but demonstrably did NOT exist at the opening, because an
  // observation there says otherwise. Left off the ledger rather than
  // backdated, and recorded here and in the coverage notes so it is not
  // silently dropped (SC-481).
  unexplainedResidual: Decimal;
  // Did we synthesize a new opening_balance tx?
  openingBalanceSynthesized: boolean;
  // The occurred_at of the synthesized opening tx, if any.
  openingAt: Date | null;
  // Note left on holding_coverage if anything notable happened.
  notes: string | null;
}

// Tiny threshold below which we treat diffs as "rounding" and skip synthesis.
// Decimal fiat has at most a few decimal places, crypto can have 18 — use
// absolute floor rather than relative because a 1e-8 BTC diff is meaningful
// but a 1e-8 USD diff is not. Callers can override per-token if needed.
/**
 * Exported so a caller that previews a reconciliation before running it
 * compares against the same threshold the service will use, rather than a
 * copy that can drift from it (SC-242).
 */
export const DEFAULT_OPENING_EPSILON = new Decimal('1e-12');

// Reconciles (sum-of-transactions) against (current holdings.balance) per
// holding. When they disagree, inserts a synthetic kind='opening_balance'
// tx at the start of known history so the tx chain fully explains the
// current balance. Never touches the `holdings` table.
//
// Idempotent per holding: running twice produces at most one opening row
// because the dedup key is (holding_id, 'reconciliation-opening',
// externalId='opening_balance').
@Service()
export class OpeningBalanceReconciliationService {
  private readonly logger = createComponentLogger('service:OpeningBalanceReconciliationService');

  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly balanceAtTimeService = Container.get(BalanceAtTimeService);

  // What `reconcileHolding` is about to decide, without deciding it.
  //
  // Exists so a repair script can show an operator the write before it
  // happens without a second implementation of the arithmetic to disagree
  // with this one. `reconcileHolding` calls it and then does exactly what it
  // says (SC-481).
  async projectHolding(
    holdingId: string,
    options: { epsilon?: Decimal } = {}
  ): Promise<OpeningProjection | null> {
    const epsilon = options.epsilon ?? DEFAULT_OPENING_EPSILON;

    const holding = await this.holdingRepository.findById(holdingId);
    if (!holding) {
      // Nothing to reconcile against — the holding was deleted while
      // transactions remain (shouldn't happen with FK cascade, but guard
      // anyway). Leave the ledger alone.
      return null;
    }

    const extremes = await this.transactionRepository.findExtremesForHolding(holdingId, undefined, {
      // The reconciler must not read its own previous output (SC-199).
      excludeReconciliationOpening: true,
    });
    if (!extremes.first) {
      // No transactions yet — nothing to reconcile.
      return null;
    }

    // Sum REAL transactions only — synthesized `reconciliation-opening`
    // rows are excluded so re-running the reconciler doesn't fold its
    // own previous output back into the gap calculation. Without this,
    // every other run flips the synthesized opening's sign (a +25 PLTR
    // opening becomes a 0 sum becomes a -25 opening on the next pass),
    // which is exactly what happened when migration 0006 merged the
    // duplicate IBKR holdings — the inherited synthesized row turned
    // every IBKR equity's cost basis to 0 and inflated PnL.
    const txSumAllTime = new Decimal(
      await this.transactionRepository.sumQuantityForHoldingUntil(
        holdingId,
        // Year-9999 sentinel so forward-dated vesting cliffs, scheduled
        // payouts, and clock-skew future timestamps are all included.
        // A 24h cap accidentally drops any tx whose occurred_at sits in
        // the future, producing a spurious opening_balance row.
        new Date('9999-12-31T23:59:59Z'),
        // The 3rd positional accepts either a DB transaction (legacy
        // callers) or the new options object — duck-typed inside.
        { excludeReconciliationOpening: true }
      )
    );
    const holdingsBalance = new Decimal(holding.balance);
    const computedOpening = holdingsBalance.sub(txSumAllTime);

    const base = {
      holdingId,
      userId: holding.userId,
      accountId: holding.accountId,
      tokenId: holding.tokenId,
      holdingsBalance,
      txSumAllTime,
      computedOpening,
    };

    if (computedOpening.abs().lte(epsilon)) {
      // Tx history perfectly explains the current balance — clear any
      // stale reconciliation-opening row left over from a prior pass
      // (e.g. after migration 0006/0007 rewired holdings, or after the
      // user manually backfills missing inflows) and mark coverage as
      // fully reconciled.
      return {
        ...base,
        action: 'reconciled',
        openingAt: null,
        openingQuantity: new Decimal(0),
        unexplainedResidual: new Decimal(0),
      };
    }

    // One millisecond before the holding's EARLIEST EVIDENCE of any kind —
    // first transaction, first observation, or the holding row itself,
    // whichever is oldest — and not, as it was until SC-475, one millisecond
    // before the first real TRANSACTION.
    //
    // The difference only shows on a holding whose first observation precedes
    // its first transaction, which is every daily-interest cash account: we
    // observe the balance at connect time and the first transaction is the
    // NEXT day's accrual. The opening then landed hours AFTER the observation
    // that anchors every earlier date, so `BalanceAtTimeService` — which
    // walks back only `(at, anchor]` — never subtracted it. The balance was
    // projected flat across all prior history AND booked as a fresh external
    ***REMOVED***
    ***REMOVED***
    //
    // Placing it before the first observation makes the walk-back subtract it,
    // so the pre-history balance is 0 and the value series steps up on the
    // opening day by the amount the flow ledger books. The phantom shape stops
    // being detectable because it stops being representable.
    const earliestEvidence = await this.balanceAtTimeService.earliestEvidenceAt(
      holdingId,
      holding,
      {},
      { excludeReconciliationOpening: true }
    );
    // `extremes.first` is one of the candidates `earliestEvidenceAt` compares,
    // and it is non-null here, so the fallback cannot fire — it is written
    // this way so the type is honest rather than asserted.
    const openingAt = new Date((earliestEvidence ?? extremes.first).getTime() - 1);

    // A NEGATIVE opening is not a fact (SC-199) — see `missing-inflows` on
    // `OpeningProjection` for why, at length.
    if (computedOpening.lt(0)) {
      return {
        ...base,
        action: 'missing-inflows',
        openingAt,
        openingQuantity: new Decimal(0),
        unexplainedResidual: computedOpening,
      };
    }

    // WHAT the opening claims, now that WHERE it sits is settled.
    //
    // `computedOpening` is `today's balance - sum(every real tx)`. Using it as
    // the quantity says the user held all of that at the opening moment, and
    // for an account whose ledger is incomplete AFTER the opening that is
    // false: every untracked inflow since gets swept in and retro-dated to a
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    //
    // The balance we actually OBSERVED at the opening is the honest claim, so
    // walk the first observation back to the opening through the transactions
    // between them. On an imported brokerage history — where the observation
    // is months of trades later — that walk returns the same number as before,
    // which is why the ten correctly-behaving production rows do not move.
    const observed = await this.observedBalanceAt(holdingId, openingAt, computedOpening);

    // `computedOpening` is the BOUND, as the comment on `ReconciliationResult`
    // has said since SC-481 — and until SC-613 nothing enforced it, so the walk
    // was free to return more than the balance can hold.
    //
    // The walk assumes the first observation already reflects every transaction
    // dated at or before it. A BACK-DATED flow breaks that: the user is telling
    // us today about money that moved before the observation which captured the
    // pre-edit figure, so the walk subtracts a withdrawal the anchor never
    // included and counts the same money twice. Measured 2026-08-25 through
    // `UpdateHoldingUseCase` on a manual USD holding edited 4,000 to 2,000 —
    // opening 6,000 against a computed 4,000, and 4,000 from the identical edit
    // stamped at the edit instant instead. One variable, the timestamp.
    //
    // SC-612 removed the commonest way to get there by accident — an untouched
    // date field means now rather than local midnight — and deliberately did
    // NOT clamp, because somebody who says "three weeks ago" means it. So this
    // is not dead code behind that fix: every genuine back-date still reaches
    // it, and a date is not the only route. The general condition is wider than
    // any of them — the walk overshoots whenever the ledger anchored at the
    // first observation predicts MORE than the holding currently holds, which
    // an unrecorded outflow after that observation does too (SC-613's second
    // reproduction, on a holding built by `createHoldingsBatch`).
    //
    // Two observations, one transaction and today's balance can genuinely
    // disagree — the user is telling us something about the past we did not
    // know when we recorded it — so the walk cannot be made to agree with the
    // ledger. What is NOT negotiable is that the ledger must not over-explain
    // the balance: `opening + sum(real txs)` claimed 4,000 against a holding of
    // 2,000, and `unexplainedResidual` went negative, which under its own
    // definition is not a quantity that can exist.
    //
    // Capping at the bound leaves the SC-481 case untouched — that walk returns
    // LESS than the computed opening, which is the whole point of it — and
    // makes the ledger close exactly where it previously overshot.
    const openingQuantity = Decimal.min(observed, computedOpening);
    const unexplainedResidual = computedOpening.sub(openingQuantity);

    return {
      ...base,
      action: openingQuantity.lte(epsilon) ? 'arrived-later' : 'opening',
      openingAt,
      openingQuantity,
      unexplainedResidual,
    };
  }

  async reconcileHolding(
    holdingId: string,
    options: { epsilon?: Decimal } = {}
  ): Promise<ReconciliationResult | null> {
    const epsilon = options.epsilon ?? DEFAULT_OPENING_EPSILON;
    const projection = await this.projectHolding(holdingId, options);
    if (!projection) return null;

    const {
      holdingsBalance,
      txSumAllTime,
      computedOpening,
      openingAt,
      openingQuantity,
      unexplainedResidual,
    } = projection;
    const identity = {
      holdingId,
      accountId: projection.accountId,
      tokenId: projection.tokenId,
    };

    if (projection.action === 'reconciled') {
      await this.transactionRepository.deleteReconciliationOpening(holdingId);
      await this.coverageRepository.upsertReconciliation({
        holdingId,
        lastReconciledAt: new Date(),
        openingBalanceQuantity: null,
        reconciliationNotes: null,
      });
      return {
        ...identity,
        holdingsBalance,
        txSumAllTime,
        computedOpening,
        openingQuantity: new Decimal(0),
        unexplainedResidual: new Decimal(0),
        openingBalanceSynthesized: false,
        openingAt: null,
        notes: null,
      };
    }

    if (projection.action === 'missing-inflows') {
      await this.transactionRepository.deleteReconciliationOpening(holdingId);
      const gapNotes = `Missing inflows of ${computedOpening.abs().toString()} before ${openingAt?.toISOString()} — the transaction history does not reach far enough back to explain the current balance. No opening balance was synthesized, because a negative holding is not a possible fact.`;
      await this.coverageRepository.upsertReconciliation({
        holdingId,
        lastReconciledAt: new Date(),
        openingBalanceQuantity: computedOpening.toString(),
        reconciliationNotes: gapNotes,
      });
      this.logger.warn(
        {
          ...identity,
          missingQuantity: computedOpening.abs().toString(),
          before: openingAt?.toISOString(),
        },
        'Unreconciled holding — missing inflows, no opening balance synthesized'
      );
      return {
        ...identity,
        holdingsBalance,
        txSumAllTime,
        computedOpening,
        openingQuantity: new Decimal(0),
        unexplainedResidual,
        openingBalanceSynthesized: false,
        openingAt: null,
        notes: gapNotes,
      };
    }

    if (projection.action === 'arrived-later') {
      // The ledger already explains the balance as of the first observation,
      // so there was no opening balance — the unexplained amount arrived
      // LATER, untracked. Writing it at the opening is the exact defect this
      // branch exists to refuse, and writing it at a date we cannot name is
      // not available, so the ledger says nothing and the coverage row says
      // what happened.
      await this.transactionRepository.deleteReconciliationOpening(holdingId);
      const laterNotes = `No opening balance: the transaction history already explains this holding's balance as of its first observation. ${unexplainedResidual.toString()} of the current balance arrived after that without a transaction to record it, and is deliberately NOT backdated to ${openingAt?.toISOString()}.`;
      await this.coverageRepository.upsertReconciliation({
        holdingId,
        lastReconciledAt: new Date(),
        openingBalanceQuantity: '0',
        reconciliationNotes: laterNotes,
      });
      return {
        ...identity,
        holdingsBalance,
        txSumAllTime,
        computedOpening,
        openingQuantity: new Decimal(0),
        unexplainedResidual,
        openingBalanceSynthesized: false,
        openingAt: null,
        notes: laterNotes,
      };
    }

    // `action === 'opening'`, the only branch that writes to the ledger.
    // `openingAt` is non-null on it by construction.
    const occurredAt = openingAt as Date;
    await this.transactionRepository.bulkUpsert([
      {
        userId: projection.userId,
        holdingId,
        tokenId: projection.tokenId,
        kind: 'opening_balance',
        quantity: openingQuantity.toString(),
        occurredAt,
        source: 'reconciliation-opening',
        externalId: 'opening_balance',
        sourceMetadata: {
          reconciledAt: new Date().toISOString(),
          holdingsBalance: holdingsBalance.toString(),
          txSumAllTime: txSumAllTime.toString(),
          // Kept beside the quantity because the two disagreeing IS the
          // finding: the difference is money the ledger cannot date.
          computedOpening: computedOpening.toString(),
          unexplainedResidual: unexplainedResidual.toString(),
        },
      },
    ]);

    const residualNote = unexplainedResidual.abs().lte(epsilon)
      ? ''
      : ` A further ${unexplainedResidual.toString()} of the current balance is unexplained by any transaction and did not exist at the opening, so it is recorded here rather than backdated.`;
    const notes = `Synthesized opening balance of ${openingQuantity.toString()} at ${occurredAt.toISOString()} — tx history began after user already held this amount.${residualNote}`;

    await this.coverageRepository.upsertReconciliation({
      holdingId,
      lastReconciledAt: new Date(),
      openingBalanceQuantity: openingQuantity.toString(),
      reconciliationNotes: notes,
    });

    this.logger.info(
      {
        ...identity,
        openingQuantity: openingQuantity.toString(),
        computedOpening: computedOpening.toString(),
        unexplainedResidual: unexplainedResidual.toString(),
        openingAt: occurredAt.toISOString(),
      },
      'Synthesized opening_balance tx'
    );

    return {
      ...identity,
      holdingsBalance,
      txSumAllTime,
      computedOpening,
      openingQuantity,
      unexplainedResidual,
      openingBalanceSynthesized: true,
      openingAt: occurredAt,
      notes,
    };
  }

  // The balance this holding is evidenced to have held at `openingAt`: its
  // first observation, walked back through every real transaction between
  // the two.
  //
  // Falls back to `fallback` (the whole unexplained gap) when the holding has
  // never been observed — a manual or import-only holding, where the ledger
  // plus today's balance is the only evidence there is and the pre-SC-481
  // answer remains the best one available.
  //
  // Floored at zero for the reason the negative branch gives at length: a
  // negative holding is not a possible fact, and a walk that goes negative
  // means outflows before the first observation that our history cannot
  // cover, not a debt.
  private async observedBalanceAt(
    holdingId: string,
    openingAt: Date,
    fallback: Decimal
  ): Promise<Decimal> {
    // `openingAt` precedes every piece of evidence, so "at or after" it is
    // the holding's first observation.
    const first = await this.observationRepository.findLatestAtOrAfter(holdingId, openingAt);
    if (!first) return fallback;

    const between = await this.transactionRepository.findForHoldingInRange(
      holdingId,
      openingAt,
      first.observedAt
    );
    const explained = between
      .filter((t) => t.source !== 'reconciliation-opening')
      .reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
    const walked = new Decimal(first.balance).sub(explained);
    return walked.lt(0) ? new Decimal(0) : walked;
  }

  // Run reconciliation for every holding of a user. Used after ingesters
  // run, or nightly.
  //
  // `includeHidden` is TRUE because reconciliation is not a claim the reader
  // sees — it makes the transaction ledger explain the balance, and a hidden
  // holding's ledger is no less obliged to. Hiding governs what is displayed;
  // nothing downstream of here reads a hidden holding's opening row or its
  // coverage note anyway, because the rollup, the valuation service, the
  // returns value series and the data-quality report each exclude hidden
  // holdings on their own account.
  //
  // Passing the default was never a decision about reconciliation: it is
  // `findByUser`'s dashboard-shaped default, inherited. The two per-holding
  // callers — `TransactionImportCoordinator` and `BackfillStatementFeesUseCase`
  // — reconcile whatever holdings an import touched and have never filtered on
  // it, so the user-wide path was the one out of three that disagreed. That is
  // what SC-502 is: an earlier run left an opening row on a hidden holding
  // through one of those paths, and this enumeration could not reach it to
  // repair it. A repair path that cannot reach what it wrote is the defect,
  // independently of whether any such row exists right now.
  //
  // Note this does NOT reach a holding whose token is over the scam threshold:
  // `findByUser` filters those with no parameter to opt out. Deliberate —
  // widening that is a separate decision about holdings the user can still
  // un-flag, and there is no evidence anything needs it.
  async reconcileUser(userId: string): Promise<ReconciliationResult[]> {
    const holdings = await this.holdingRepository.findByUser(userId, undefined, true);
    const results: ReconciliationResult[] = [];
    // Each holding reconciles independently — batch with bounded fan-out
    // rather than serializing every holding behind the previous one.
    const CONCURRENCY = 10;
    for (let i = 0; i < holdings.length; i += CONCURRENCY) {
      const batch = holdings.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((h) => this.reconcileHolding(h.id)));
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        const h = batch[j];
        if (s?.status === 'fulfilled') {
          if (s.value) results.push(s.value);
        } else if (s) {
          this.logger.warn(
            {
              userId,
              holdingId: h?.id,
              accountId: h?.accountId,
              tokenId: h?.tokenId,
              error: s.reason instanceof Error ? s.reason.message : s.reason,
            },
            'Reconciliation failed for one holding; continuing'
          );
        }
      }
    }
    return results;
  }
}
