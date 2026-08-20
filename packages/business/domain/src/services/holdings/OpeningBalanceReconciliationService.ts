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

    if (computedOpening.abs().lte(epsilon)) {
      // Tx history perfectly explains the current balance — clear any
      // stale reconciliation-opening row left over from a prior pass
      // (e.g. after migration 0006/0007 rewired holdings, or after the
      // user manually backfills missing inflows) and mark coverage as
      // fully reconciled.
      await this.transactionRepository.deleteReconciliationOpening(holdingId);
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

    const openingAt = new Date(extremes.first.getTime() - 1);

    // A NEGATIVE opening is not a fact, and is not written to the ledger
    // (SC-199).
    //
    // The plug exists so the transaction chain fully explains the current
    // balance. Where it comes out positive that is a real statement: the user
    // already held this much when our history begins. Where it comes out
    // negative it says they held −4474 USDT before their history begins,
    // which is not a thing that can have been true. Production held eleven of
    // these.
    //
    // What is actually true is that inflows are MISSING — the ledger does not
    // reach far enough back — and the honest output is to say so rather than
    // to balance the books with an impossible number. Writing it also
    // corrupts everything downstream that trusts the chain: cost basis reads
    // a negative acquisition, and `BalanceAtTimeService.clamp` floors the
    // chart at zero, which hides the discrepancy it was invented to expose.
    //
    // **Silence is not the alternative**, and this is the half worth being
    // careful about: a user whose balance does not reconcile has a real
    // problem, and this codebase's characteristic failure is replacing a
    // wrong number with nothing. So the gap is still recorded, on the
    // coverage row, in the same column and with the same sign the UI already
    // keys on — `HoldingQueryService` raises `dataIntegrity.incompleteHistory`
    // from `openingBalanceQuantity < 0`, and the Data quality panel counts the
    // same predicate. The badge the reader sees is unchanged. What changes is
    // that the assertion is now "we are missing 4474 USDT of inflows before
    // 2026-07-14" instead of "you held −4474 USDT".
    //
    // Any row a previous run wrote is deleted, so re-running repairs the
    // ledger rather than leaving the old claim standing beside the new note.
    if (computedOpening.lt(0)) {
      await this.transactionRepository.deleteReconciliationOpening(holdingId);
      const gapNotes = `Missing inflows of ${computedOpening.abs().toString()} before ${openingAt.toISOString()} — the transaction history does not reach far enough back to explain the current balance. No opening balance was synthesized, because a negative holding is not a possible fact.`;
      await this.coverageRepository.upsertReconciliation({
        holdingId,
        lastReconciledAt: new Date(),
        openingBalanceQuantity: computedOpening.toString(),
        reconciliationNotes: gapNotes,
      });
      this.logger.warn(
        {
          holdingId,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          missingQuantity: computedOpening.abs().toString(),
          before: openingAt.toISOString(),
        },
        'Unreconciled holding — missing inflows, no opening balance synthesized'
      );
      return {
        holdingId,
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        holdingsBalance,
        txSumAllTime,
        computedOpening,
        openingBalanceSynthesized: false,
        openingAt: null,
        notes: gapNotes,
      };
    }

    // Synthesize an opening_balance tx one millisecond before the first
    // real tx. This keeps the ledger chronologically consistent and leaves
    // room for the real tx to follow.
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

    // Only positive openings reach here — the negative branch returned above.
    const notes = `Synthesized opening balance of ${computedOpening.toString()} at ${openingAt.toISOString()} — tx history began after user already held this amount.`;

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
