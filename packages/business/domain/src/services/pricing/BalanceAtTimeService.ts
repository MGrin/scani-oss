import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';

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

  async getBalance(holdingId: string, at: Date): Promise<BalanceAtTimeResult> {
    // Try anchor 1: nearest observation at or after `at`.
    const after = await this.observationRepository.findLatestAtOrAfter(holdingId, at);
    if (after) {
      const txs = await this.transactionRepository.findForHoldingInRange(
        holdingId,
        at,
        after.observedAt
      );
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(after.balance).sub(sumInRange));
      return {
        balance,
        anchor: 'observation-after',
        anchorAt: after.observedAt,
        txApplied: txs.length,
      };
    }

    // Try anchor 2: current holdings.balance. The holding row IS the
    // anchor here — fetched by PK directly, not via (account, token) lookup.
    const holding = await this.holdingRepository.findById(holdingId);
    if (holding) {
      const txs = await this.transactionRepository.findForHoldingInRange(
        holdingId,
        at,
        holding.lastUpdated
      );
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(holding.balance).sub(sumInRange));
      return {
        balance,
        anchor: 'holdings',
        anchorAt: holding.lastUpdated,
        txApplied: txs.length,
      };
    }

    // Try anchor 3: latest observation before `at` — walk forward.
    const before = await this.observationRepository.findLatestAtOrBefore(holdingId, at);
    if (before) {
      const txs = await this.transactionRepository.findForHoldingInRange(
        holdingId,
        before.observedAt,
        at
      );
      const sumInRange = txs.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
      const balance = clampNonNegative(new Decimal(before.balance).add(sumInRange));
      return {
        balance,
        anchor: 'observation-before',
        anchorAt: before.observedAt,
        txApplied: txs.length,
      };
    }

    // No anchor of any kind reachable — honest "unknown".
    return { balance: null, anchor: null, anchorAt: null, txApplied: 0 };
  }

  // FIFO cost basis at `at` for a holding. Walks tx history in
  // chronological order, maintaining a queue of open lots. On sell/withdraw,
  // dequeue oldest lots until the outgoing quantity is exhausted. Returns
  // the total cost basis of currently-open lots at `at` (converted to the
  // caller-specified display base via an injected converter).
  //
  // The converter is abstracted as a callback so this service doesn't
  // depend on `PriceGraphService` directly — avoids a circular import and
  // keeps this file pure-math testable.
  async getCostBasisFIFO(
    holdingId: string,
    at: Date,
    convertToBase: (
      amount: Decimal,
      fromTokenId: string,
      atTimestamp: Date
    ) => Promise<Decimal | null>
  ): Promise<{ costBasis: Decimal | null; openLotCount: number }> {
    // Load all txs up to `at` in chronological order. For heavy traders
    // this is O(n) where n could be thousands; acceptable for now since
    // cost basis is per-holding and the user-scoped UI rarely fans out
    // across more than a few dozen simultaneously.
    const txs = await this.transactionRepository.findByRange({
      holdingId,
      to: new Date(at.getTime() + 1),
      order: 'asc',
    });

    if (txs.length === 0) {
      return { costBasis: null, openLotCount: 0 };
    }

    interface Lot {
      remaining: Decimal; // positive quantity still held
      costPerUnitBase: Decimal; // cost basis in the display base, per unit
    }
    const lots: Lot[] = [];

    for (const tx of txs) {
      const qty = new Decimal(tx.quantity);
      if (qty.gt(0)) {
        // Inflow — open a new lot. Convert the native per-unit price to
        // the display base at the tx's occurred_at.
        if (!tx.priceNative || !tx.priceNativeTokenId) {
          // No price info — treat as zero-cost lot (airdrops, transfers
          // from unknown source). Caller can tell from openLotCount.
          lots.push({
            remaining: qty,
            costPerUnitBase: new Decimal(0),
          });
          continue;
        }
        const perUnitBase = await convertToBase(
          new Decimal(tx.priceNative),
          tx.priceNativeTokenId,
          tx.occurredAt
        );
        lots.push({
          remaining: qty,
          costPerUnitBase: perUnitBase ?? new Decimal(0),
        });
      } else if (qty.lt(0)) {
        // Outflow — consume oldest lots FIFO.
        let remainingToConsume = qty.abs();
        while (remainingToConsume.gt(0) && lots.length > 0) {
          const head = lots[0];
          if (!head) break;
          if (head.remaining.lte(remainingToConsume)) {
            remainingToConsume = remainingToConsume.sub(head.remaining);
            lots.shift();
          } else {
            head.remaining = head.remaining.sub(remainingToConsume);
            remainingToConsume = new Decimal(0);
          }
        }
      }
      // qty === 0 — fee rows (positive) or zero-quantity placeholders — skip.
    }

    const costBasis = lots.reduce(
      (acc, l) => acc.add(l.remaining.mul(l.costPerUnitBase)),
      new Decimal(0)
    );
    return { costBasis, openLotCount: lots.length };
  }
}
