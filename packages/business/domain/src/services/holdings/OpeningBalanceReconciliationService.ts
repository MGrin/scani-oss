import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';

export interface ReconciliationResult {
  holdingId: string;
  accountId: string;
  tokenId: string;
  holdingsBalance: Decimal;
  txSumAllTime: Decimal;
  computedOpening: Decimal;
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
const DEFAULT_OPENING_EPSILON = new Decimal('1e-12');

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

  async reconcileHolding(
    holdingId: string,
    options: { epsilon?: Decimal } = {}
  ): Promise<ReconciliationResult | null> {
    const epsilon = options.epsilon ?? DEFAULT_OPENING_EPSILON;

    const holding = await this.holdingRepository.findById(holdingId);
    if (!holding) {
      // Nothing to reconcile against — the holding was deleted while
      // transactions remain (shouldn't happen with FK cascade, but guard
      // anyway). Leave the ledger alone.
      return null;
    }

    const extremes = await this.transactionRepository.findExtremesForHolding(holdingId);
    if (!extremes.first) {
      // No transactions yet — nothing to reconcile.
      return null;
    }

    const txSumAllTime = new Decimal(
      await this.transactionRepository.sumQuantityForHoldingUntil(
        holdingId,
        // Year-9999 sentinel so forward-dated vesting cliffs, scheduled
        // payouts, and clock-skew future timestamps are all included.
        // A 24h cap accidentally drops any tx whose occurred_at sits in
        // the future, producing a spurious opening_balance row.
        new Date('9999-12-31T23:59:59Z')
      )
    );
    const holdingsBalance = new Decimal(holding.balance);
    const computedOpening = holdingsBalance.sub(txSumAllTime);

    if (computedOpening.abs().lte(epsilon)) {
      // Tx history perfectly explains the current balance — mark coverage
      // as fully reconciled and clear any prior opening row if it has
      // drifted to zero (rare but possible after re-ingest).
      await this.coverageRepository.upsertReconciliation({
        holdingId,
        lastReconciledAt: new Date(),
        openingBalanceQuantity: null,
        reconciliationNotes: null,
      });
      return {
        holdingId,
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        holdingsBalance,
        txSumAllTime,
        computedOpening,
        openingBalanceSynthesized: false,
        openingAt: null,
        notes: null,
      };
    }

    // Synthesize an opening_balance tx one millisecond before the first
    // real tx. This keeps the ledger chronologically consistent and leaves
    // room for the real tx to follow.
    const openingAt = new Date(extremes.first.getTime() - 1);
    await this.transactionRepository.bulkUpsert([
      {
        userId: holding.userId,
        holdingId,
        tokenId: holding.tokenId,
        kind: 'opening_balance',
        quantity: computedOpening.toString(),
        occurredAt: openingAt,
        source: 'reconciliation-opening',
        externalId: 'opening_balance',
        sourceMetadata: {
          reconciledAt: new Date().toISOString(),
          holdingsBalance: holdingsBalance.toString(),
          txSumAllTime: txSumAllTime.toString(),
        },
      },
    ]);

    const notes = computedOpening.gt(0)
      ? `Synthesized opening balance of ${computedOpening.toString()} at ${openingAt.toISOString()} — tx history began after user already held this amount.`
      : `Synthesized negative opening balance of ${computedOpening.toString()} — implies missing inflows before ${openingAt.toISOString()}.`;

    await this.coverageRepository.upsertReconciliation({
      holdingId,
      lastReconciledAt: new Date(),
      openingBalanceQuantity: computedOpening.toString(),
      reconciliationNotes: notes,
    });

    this.logger.info(
      {
        holdingId,
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        computedOpening: computedOpening.toString(),
        openingAt: openingAt.toISOString(),
      },
      'Synthesized opening_balance tx'
    );

    return {
      holdingId,
      accountId: holding.accountId,
      tokenId: holding.tokenId,
      holdingsBalance,
      txSumAllTime,
      computedOpening,
      openingBalanceSynthesized: true,
      openingAt,
      notes,
    };
  }

  // Run reconciliation for every holding of a user. Used after ingesters
  // run, or nightly.
  async reconcileUser(userId: string): Promise<ReconciliationResult[]> {
    const holdings = await this.holdingRepository.findByUser(userId);
    const results: ReconciliationResult[] = [];
    for (const h of holdings) {
      try {
        const r = await this.reconcileHolding(h.id);
        if (r) results.push(r);
      } catch (error) {
        this.logger.warn(
          {
            userId,
            holdingId: h.id,
            accountId: h.accountId,
            tokenId: h.tokenId,
            error: error instanceof Error ? error.message : error,
          },
          'Reconciliation failed for one holding; continuing'
        );
      }
    }
    return results;
  }
}
