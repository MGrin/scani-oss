import type { DatabaseTransaction } from '@scani/db';
import type { Holding, HoldingBalanceObservation, HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { unexplainedDrift } from '../../lib/balances/unexplained-drift';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';

// Pre-loaded per-user data the rollup hands in to short-circuit the
// per-call DB reads. Each cache is a Map keyed by holdingId; absence
// of a key (or `undefined`) means "fall through to the DB" so the
// non-rollup callers (chart endpoint, ad-hoc valuation) still work.
export interface BalanceAtTimeCaches {
  holdings?: ReadonlyMap<string, Holding>;
  observations?: ReadonlyMap<string, ReadonlyArray<HoldingBalanceObservation>>;
  transactions?: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>;
}

export interface BalanceAtTimeResult {
  // The derived balance at `at`. null when we have no data reaching back
  // that far (no observation, no tx, no current holding we can anchor on).
  balance: Decimal | null;
  // The anchor source used — 'holdings' (current-state), 'observation-after',
  // 'observation-before' — so callers can judge confidence.
  anchor: 'holdings' | 'observation-after' | 'observation-before' | null;
  // The timestamp of the anchor. null when balance is null.
  anchorAt: Date | null;
  // Number of tx rows applied when walking between `at` and the anchor.
  // High counts + partial data can correlate with reconciliation drift.
  txApplied: number;
  // `at` precedes the earliest evidence this holding has — see
  // `earliestEvidenceAt`. The balance is still returned, and is still the
  // best projection available, but it is a projection into a period we
  // hold no record of rather than a reconstruction across one we do.
  // Callers must not present it as a measurement (SC-252).
  beforeRecords: boolean;
  // `at` sits strictly between two observations whose difference the ledger
  // does not explain, and part of that unexplained drift has been spread
  // across the gap to reach this number (SC-475 fault B). The balance is
  // therefore partly INVENTED: it is a straight line drawn between two
  // measurements, not a reconstruction from events. False whenever the walk
  // needed no interpolation, which includes every densely-observed holding
  // and every date at or before the first observation.
  interpolated: boolean;
}

// Reconstructs a holding's balance at an arbitrary past time by walking
// transactions backward from the most trustworthy anchor available:
//   * latest observation at or after `at` (highest priority)
//   * current holdings.balance at holdings.lastUpdated (fallback)
//   * latest observation at or before `at` (last-ditch anchor — accurate
//     at that moment, and we walk forward to `at` instead of backward)
//
// Never mutates holdings; never rewrites observations. Pure read.

// Floor the reconstructed past balance at zero. Imported tx histories
// from third-party APIs (Helius, Etherscan, exchange CSVs) are
// frequently INCOMPLETE for early periods — Helius's parsed-tx index
// has retention limits, exchange CSVs start at the first export date,
// etc. When the first tx in our ledger is an outflow, the math
// produces a negative reconstructed past balance even though the
// wallet really started at some unknown positive balance. Flooring at
// zero keeps the chart sensible (you can't have negatively held an
// asset you can't short) without rewriting the underlying ledger,
// which still preserves signed quantities for cost-basis math.
function clampNonNegative(d: Decimal): Decimal {
  return d.lt(0) ? new Decimal(0) : d;
}
@Service()
export class BalanceAtTimeService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);

  async getBalance(
    holdingId: string,
    at: Date,
    tx: DatabaseTransaction | undefined,
    caches: BalanceAtTimeCaches = {}
  ): Promise<BalanceAtTimeResult> {
    // Resolved ONCE, above the anchor ladder, because every anchor has the
    // same lower-bound defect and anchor 1 reaches it first. Bounding the
    // holdings anchor alone would leave any holding carrying observations
    // answering exactly as before (SC-252).
    const holding = await this.findHolding(holdingId, caches, tx);
    const earliest = await this.earliestEvidenceAt(holdingId, holding, tx, caches);
    const beforeRecords = earliest !== null && at.getTime() < earliest.getTime();

    // Try anchor 1: nearest observation at or after `at`.
    const after = await this.findObservationAtOrAfter(holdingId, at, caches, tx);
    if (after) {
      const txs = await this.findTxsInRange(holdingId, at, after.observedAt, caches, tx);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const walked = new Decimal(after.balance).sub(sumInRange);
      const spread = await this.driftAhead(holdingId, at, after, caches, tx);
      return {
        balance: clampNonNegative(walked.sub(spread.share)),
        anchor: 'observation-after',
        anchorAt: after.observedAt,
        txApplied: txs.length,
        beforeRecords,
        interpolated: spread.interpolated,
      };
    }

    // Try anchor 2: current holdings.balance. The holding row IS the
    // anchor here — fetched by PK directly, not via (account, token) lookup.
    if (holding) {
      const txs = await this.findTxsInRange(holdingId, at, holding.lastUpdated, caches, tx);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(holding.balance).sub(sumInRange));
      return {
        balance,
        anchor: 'holdings',
        anchorAt: holding.lastUpdated,
        txApplied: txs.length,
        beforeRecords,
        // No later observation exists to interpolate towards — this walks
        // back from current state, which is a measurement at its own end.
        interpolated: false,
      };
    }

    // Try anchor 3: latest observation before `at` — walk forward.
    const before = await this.findObservationAtOrBefore(holdingId, at, caches, tx);
    if (before) {
      const txs = await this.findTxsInRange(holdingId, before.observedAt, at, caches, tx);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(before.balance).add(sumInRange));
      return {
        balance,
        anchor: 'observation-before',
        anchorAt: before.observedAt,
        txApplied: txs.length,
        beforeRecords,
        // Only reachable when no holding row exists either, so there is
        // nothing on the far side of `at` to draw a line to.
        interpolated: false,
      };
    }

    // No anchor of any kind reachable — honest "unknown". `beforeRecords`
    // is false rather than true: there is no balance to qualify, and the
    // claim being made is "we do not know", not "we are projecting".
    return {
      balance: null,
      anchor: null,
      anchorAt: null,
      txApplied: 0,
      beforeRecords: false,
      interpolated: false,
    };
  }

  // How much of the gap's UNEXPLAINED drift still lies ahead of `at`.
  //
  // Anchor 1 walks back from the next observation through the transactions
  // in `(at, after]`. Where those transactions fully explain the difference
  // between two consecutive observations, that walk is exact and this
  // returns zero — which is every densely-observed holding, so the common
  // path is unchanged.
  //
  // Where they do not, the whole difference lands on the single day the
  // anchor rolls over from one observation to the next. A real account held
  // exactly that: a cash holding with two observations months apart and no
  // transaction between them dropped its whole accumulated difference in one
  // day, and a chained daily return read it as a double-digit percentage loss
  // on cash (SC-475 fault B).
  //
  // So the drift is spread linearly across the gap instead. This is
  // INVENTED data — a straight line between two measurements, drawn because
  // no record says what the shape really was — and the second return value
  // says so, all the way through to `portfolio_value_daily`.
  //
  // At `at = before.observedAt` the share is the whole drift, so the result
  // is exactly `before.balance`; at `at = after.observedAt` it is zero, so
  // the result is exactly `after.balance`. Both measurements are reproduced
  // unchanged — only the space between them moves.
  private async driftAhead(
    holdingId: string,
    at: Date,
    after: HoldingBalanceObservation,
    caches: BalanceAtTimeCaches,
    tx: DatabaseTransaction | undefined
  ): Promise<{ share: Decimal; interpolated: boolean }> {
    const before = await this.findObservationAtOrBefore(holdingId, at, caches, tx);
    // No earlier observation, or `at` sits exactly on one: nothing to
    // interpolate between, and a zero-length span would divide by zero.
    if (!before || before.observedAt.getTime() >= after.observedAt.getTime()) {
      return { share: new Decimal(0), interpolated: false };
    }

    const bridge = await this.findTxsInRange(
      holdingId,
      before.observedAt,
      after.observedAt,
      caches,
      tx
    );
    // The one implementation of this arithmetic — see `unexplainedDrift`.
    // `BalanceGapService` asks the owner about the same quantity this line
    // spreads, and a second copy here would let the queue and the ramp
    // disagree about what is unexplained (SC-501).
    const drift = unexplainedDrift(
      before.balance,
      after.balance,
      bridge.map((t) => t.quantity)
    );
    if (drift.isZero()) return { share: new Decimal(0), interpolated: false };

    const span = after.observedAt.getTime() - before.observedAt.getTime();
    const ahead = after.observedAt.getTime() - at.getTime();
    return { share: drift.mul(ahead).div(span), interpolated: true };
  }

  // The earliest instant this holding has any evidence for: the first
  // transaction, the first observation, or the moment the holding row
  // itself appeared — whichever is oldest. Below it, every anchor's walk
  // covers the ENTIRE ledger, so the arithmetic reduces to
  // `current balance - sum(all known transactions)`. That is zero only if
  // the ledger is complete, and the clamp note above says plainly that
  // imported histories frequently are not; the residue is the unexplained
  // opening balance, and without this bound it is reported for every date
  // before the ledger starts, forever (SC-252).
  //
  // The holding's own `createdAt` is included because a holding with no
  // ledger and no observations still has one known moment. It is the
  // OLDEST of the three, not the newest, so an imported wallet whose
  // transactions reach back years is still answered from its first
  // transaction rather than from the day we happened to learn of it.
  //
  // Public because `OpeningBalanceReconciliationService` stamps its synthetic
  // opening one millisecond before this instant, and a second copy of the
  // rule would be free to disagree with this one (SC-481).
  //
  // `excludeReconciliationOpening` is what that caller passes and nothing
  // else should: the reconciler's own output is a transaction, so counting it
  // as evidence would make each run place the next opening 1ms earlier than
  // the last, forever. Every other caller wants the opening included — after
  // SC-481 it is the oldest row on the holding, which is precisely what makes
  // `beforeRecords` true for the dates before it.
  async earliestEvidenceAt(
    holdingId: string,
    holding: Holding | null,
    tx: DatabaseTransaction | undefined,
    caches: BalanceAtTimeCaches = {},
    options: { excludeReconciliationOpening?: boolean } = {}
  ): Promise<Date | null> {
    const candidates: Date[] = [];
    if (holding) candidates.push(holding.createdAt);

    // Both bulk prefetches order by their time column ASC, so on the
    // rollup's hot path the earliest row is `[0]` and this costs nothing.
    // The cache is bypassed when openings must be excluded: it holds every
    // row including them, and filtering it here would put a second copy of
    // the exclusion rule in the hot path. The reconciler passes no caches.
    const cachedTxs = options.excludeReconciliationOpening
      ? undefined
      : caches.transactions?.get(holdingId);
    if (cachedTxs) {
      const first = cachedTxs[0];
      if (first) candidates.push(first.occurredAt);
    } else {
      const { first } = await this.transactionRepository.findExtremesForHolding(
        holdingId,
        tx,
        options.excludeReconciliationOpening ? { excludeReconciliationOpening: true } : undefined
      );
      if (first) candidates.push(first);
    }

    const cachedObs = caches.observations?.get(holdingId);
    if (cachedObs) {
      const first = cachedObs[0];
      if (first) candidates.push(first.observedAt);
    } else {
      const { first } = await this.observationRepository.findExtremesForHolding(holdingId, tx);
      if (first) candidates.push(first);
    }

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  }

  // Cache-or-DB lookups. The rollup hands in pre-loaded Maps; ad-hoc
  // callers (chart endpoint, valuation services) pass nothing and
  // hit the DB.
  private async findObservationAtOrAfter(
    holdingId: string,
    at: Date,
    caches: BalanceAtTimeCaches,
    tx: DatabaseTransaction | undefined
  ): Promise<HoldingBalanceObservation | null> {
    const cached = caches.observations?.get(holdingId);
    if (cached) {
      const target = at.getTime();
      // Observations are stored chronologically ASC; first one with
      // observedAt >= at wins.
      for (const obs of cached) {
        if (obs.observedAt.getTime() >= target) return obs;
      }
      return null;
    }
    return this.observationRepository.findLatestAtOrAfter(holdingId, at, tx);
  }

  private async findObservationAtOrBefore(
    holdingId: string,
    at: Date,
    caches: BalanceAtTimeCaches,
    tx: DatabaseTransaction | undefined
  ): Promise<HoldingBalanceObservation | null> {
    const cached = caches.observations?.get(holdingId);
    if (cached) {
      const target = at.getTime();
      let best: HoldingBalanceObservation | null = null;
      for (const obs of cached) {
        if (obs.observedAt.getTime() <= target) best = obs;
        else break;
      }
      return best;
    }
    return this.observationRepository.findLatestAtOrBefore(holdingId, at, tx);
  }

  private async findHolding(
    holdingId: string,
    caches: BalanceAtTimeCaches,
    tx: DatabaseTransaction | undefined
  ): Promise<Holding | null> {
    const cached = caches.holdings?.get(holdingId);
    if (cached) return cached;
    return this.holdingRepository.findById(holdingId, tx);
  }

  private async findTxsInRange(
    holdingId: string,
    from: Date,
    to: Date,
    caches: BalanceAtTimeCaches,
    tx: DatabaseTransaction | undefined
  ): Promise<HoldingTransaction[]> {
    const cached = caches.transactions?.get(holdingId);
    if (cached) {
      const lo = from.getTime();
      const hi = to.getTime();
      // findForHoldingInRange semantics: (from, to] — exclusive lower,
      // inclusive upper. Mirror that here so the in-memory path is a
      // drop-in for the DB path.
      return cached.filter((t) => {
        const ts = t.occurredAt.getTime();
        return ts > lo && ts <= hi;
      });
    }
    return this.transactionRepository.findForHoldingInRange(holdingId, from, to, tx);
  }
}
