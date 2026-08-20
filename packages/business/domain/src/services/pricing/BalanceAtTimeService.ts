import type { Holding, HoldingBalanceObservation, HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
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
    caches: BalanceAtTimeCaches = {}
  ): Promise<BalanceAtTimeResult> {
    // Resolved ONCE, above the anchor ladder, because every anchor has the
    // same lower-bound defect and anchor 1 reaches it first. Bounding the
    // holdings anchor alone would leave any holding carrying observations
    // answering exactly as before (SC-252).
    const holding = await this.findHolding(holdingId, caches);
    const earliest = await this.earliestEvidenceAt(holdingId, holding, caches);
    const beforeRecords = earliest !== null && at.getTime() < earliest.getTime();

    // Try anchor 1: nearest observation at or after `at`.
    const after = await this.findObservationAtOrAfter(holdingId, at, caches);
    if (after) {
      const txs = await this.findTxsInRange(holdingId, at, after.observedAt, caches);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(after.balance).sub(sumInRange));
      return {
        balance,
        anchor: 'observation-after',
        anchorAt: after.observedAt,
        txApplied: txs.length,
        beforeRecords,
      };
    }

    // Try anchor 2: current holdings.balance. The holding row IS the
    // anchor here — fetched by PK directly, not via (account, token) lookup.
    if (holding) {
      const txs = await this.findTxsInRange(holdingId, at, holding.lastUpdated, caches);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(holding.balance).sub(sumInRange));
      return {
        balance,
        anchor: 'holdings',
        anchorAt: holding.lastUpdated,
        txApplied: txs.length,
        beforeRecords,
      };
    }

    // Try anchor 3: latest observation before `at` — walk forward.
    const before = await this.findObservationAtOrBefore(holdingId, at, caches);
    if (before) {
      const txs = await this.findTxsInRange(holdingId, before.observedAt, at, caches);
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(before.balance).add(sumInRange));
      return {
        balance,
        anchor: 'observation-before',
        anchorAt: before.observedAt,
        txApplied: txs.length,
        beforeRecords,
      };
    }

    // No anchor of any kind reachable — honest "unknown". `beforeRecords`
    // is false rather than true: there is no balance to qualify, and the
    // claim being made is "we do not know", not "we are projecting".
    return { balance: null, anchor: null, anchorAt: null, txApplied: 0, beforeRecords: false };
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
  private async earliestEvidenceAt(
    holdingId: string,
    holding: Holding | null,
    caches: BalanceAtTimeCaches
  ): Promise<Date | null> {
    const candidates: Date[] = [];
    if (holding) candidates.push(holding.createdAt);

    // Both bulk prefetches order by their time column ASC, so on the
    // rollup's hot path the earliest row is `[0]` and this costs nothing.
    const cachedTxs = caches.transactions?.get(holdingId);
    if (cachedTxs) {
      const first = cachedTxs[0];
      if (first) candidates.push(first.occurredAt);
    } else {
      const { first } = await this.transactionRepository.findExtremesForHolding(holdingId);
      if (first) candidates.push(first);
    }

    const cachedObs = caches.observations?.get(holdingId);
    if (cachedObs) {
      const first = cachedObs[0];
      if (first) candidates.push(first.observedAt);
    } else {
      const { first } = await this.observationRepository.findExtremesForHolding(holdingId);
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
    caches: BalanceAtTimeCaches
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
    return this.observationRepository.findLatestAtOrAfter(holdingId, at);
  }

  private async findObservationAtOrBefore(
    holdingId: string,
    at: Date,
    caches: BalanceAtTimeCaches
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
    return this.observationRepository.findLatestAtOrBefore(holdingId, at);
  }

  private async findHolding(
    holdingId: string,
    caches: BalanceAtTimeCaches
  ): Promise<Holding | null> {
    const cached = caches.holdings?.get(holdingId);
    if (cached) return cached;
    return this.holdingRepository.findById(holdingId);
  }

  private async findTxsInRange(
    holdingId: string,
    from: Date,
    to: Date,
    caches: BalanceAtTimeCaches
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
    return this.transactionRepository.findForHoldingInRange(holdingId, from, to);
  }
}
