import { Decimal } from '@scani/shared';

/**
 * Whether a return can count a holding's flows, and from when (SC-1427).
 *
 * `complete` — a full walk claimed the whole ledger.
 * `from` — the ledger is complete from `from` onward. With `heldBefore` false
 * the holding did not exist earlier, so it simply arrives. With `heldBefore`
 * true it did — a broker statement that starts after the purchase — and a
 * window starting earlier cannot see it.
 * `incomplete` — money moved that no row explains.
 *
 * Decided here rather than by setting `has_complete_tx_history`, which cost
 * basis, realized P&L and the daily rollup also read: counting a position in
 * a return from a date is not a claim about its whole ledger.
 */
export type FlowCoverage =
  | { kind: 'complete' }
  | { kind: 'from'; from: string; heldBefore: boolean }
  | { kind: 'incomplete' };

export interface CoverageFacts {
  hasCompleteTxHistory: boolean;
  unexplainedResidual: string | null;
  openingBalanceQuantity: string | null;
  txSources: readonly string[];
  firstTxAt: Date | null;
  lastReconciledAt: Date | null;
}

/**
 * Sources that are not a statement of the account: the reconciler's own
 * opening row and the app's interest payouts. A positive opening beside only
 * these is a hand-kept balance, which says nothing about when it was bought.
 */
const INTERNAL_SOURCES = new Set(['reconciliation-opening', 'apy-payout']);

/**
 * `unchangedSince` is the first reading of a position that has no ledger and
 * whose every reading held the same quantity (SC-1448): it was simply held,
 * so it counts from that reading, like a statement that starts after the buy.
 */
export function flowCoverageOf(
  coverage: CoverageFacts | undefined,
  unchangedSince?: string
): FlowCoverage {
  if (!coverage) {
    return unchangedSince
      ? { kind: 'from', from: unchangedSince, heldBefore: true }
      : { kind: 'incomplete' };
  }
  if (coverage.hasCompleteTxHistory) return { kind: 'complete' };
  const residual = coverage.unexplainedResidual;
  if (residual != null && !new Decimal(residual).isZero()) return { kind: 'incomplete' };
  if (!coverage.lastReconciledAt || !coverage.firstTxAt) return { kind: 'incomplete' };

  const from = coverage.firstTxAt.toISOString().slice(0, 10);
  const opening = new Decimal(coverage.openingBalanceQuantity ?? 0);
  // The ledger explains the first balance: it starts with the acquisition.
  if (opening.isZero()) return { kind: 'from', from, heldBefore: false };
  // Held before a statement that starts later. A negative opening is the
  // other case — money arrived before the first row — and is a real gap.
  const statement = coverage.txSources.some((source) => !INTERNAL_SOURCES.has(source));
  if (opening.isPositive() && statement) return { kind: 'from', from, heldBefore: true };
  return { kind: 'incomplete' };
}
