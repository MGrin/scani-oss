import type { HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import { statementFeeFromRawPayload } from '@scani/file-import';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { OpeningBalanceReconciliationService } from '../services/holdings/OpeningBalanceReconciliationService';

export interface BackfillStatementFeesInput {
  /** Restrict to one account's owner. Absent means every user. */
  userId?: string;
  /** Read and report, write nothing. */
  dryRun?: boolean;
  /** Rows per keyset page. */
  batchSize?: number;
}

export interface BackfillStatementFeesSummary {
  /** Statement rows examined — the superset with no `:fee` sibling yet. */
  scanned: number;
  /** Of those, the ones whose `raw_payload` still states a fee. */
  feesFound: number;
  /** Fee rows written. Equals `feesFound` unless this was a dry run. */
  feesWritten: number;
  /** Sum of the fees, as a positive magnitude, in mixed currencies. */
  totalFeeMagnitude: string;
  /** Holdings whose ledger changed, and therefore whose opening was re-derived. */
  holdingsTouched: number;
  /** Of those, the ones the reconciler re-synthesized an opening balance for. */
  openingsResynthesized: number;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Puts back the statement fees that were dropped before SC-136 (PR #744).
 *
 * The importer used to read a statement's Fee column and discard it, so the
 * ledger is short by every fee on every statement imported before that PR. The
 * closing balance is anchored and therefore still right, which is what makes
 * this quiet: the error lands in the *derived* opening balance — the reconciler
 * computes it as (anchor − sum of imported quantities), and the fees were never
 * in that sum — and in the ledger the user reads when reconciling. Both
 * understate cost and overstate gain, the same one-directional error as SC-149
 * and SC-151.
 *
 * **Nobody has to re-upload anything.** The raw CSV row survived the whole time
 * on `holding_transactions.raw_payload`, so the charge is still there to read.
 *
 * **Idempotent by construction, in three independent ways:**
 *
 * 1. The candidate query excludes any row that already has an
 *    `<external_id>:fee` sibling, so a second run sees no candidates at all.
 * 2. The rows it writes are byte-identical to what the ingester writes today —
 *    same holding, token, instant, kind, quantity, source and external id — so
 *    even a forced re-write lands on `bulkUpsert`'s
 *    `(holding_id, source, external_id)` conflict target and updates one row
 *    rather than inserting a second. A later genuine re-upload of the same
 *    statement collides with it too, and wins with the same values.
 * 3. `OpeningBalanceReconciliationService` derives the opening from the current
 *    ledger each time and excludes its own prior output from the sum, so
 *    re-running it replaces the synthesized opening instead of compounding it.
 *
 * Cost basis is untouched: `CostBasisService`'s walk has no branch for
 * `kind='fee'` and skips it, so this needs no sequencing against SC-149/SC-151.
 */
@Service()
export class BackfillStatementFeesUseCase {
  private readonly logger = createComponentLogger('use-case:BackfillStatementFees');
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);
  private readonly reconciliation = Container.get(OpeningBalanceReconciliationService);

  async execute(input: BackfillStatementFeesInput = {}): Promise<BackfillStatementFeesSummary> {
    const dryRun = input.dryRun ?? false;
    const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;

    let scanned = 0;
    let feesFound = 0;
    let feesWritten = 0;
    let totalFee = new Decimal(0);
    const touchedHoldings = new Set<string>();
    let afterId: string | undefined;

    for (;;) {
      const page = await this.transactionRepository.findStatementRowsWithoutFeeSibling({
        limit: batchSize,
        afterId,
        userId: input.userId,
      });
      if (page.length === 0) break;
      scanned += page.length;
      afterId = page[page.length - 1]?.id;

      const feeRows: NewHoldingTransaction[] = [];
      for (const parent of page) {
        const metadata = (parent.sourceMetadata ?? {}) as Record<string, unknown>;
        const bankTemplate =
          typeof metadata.bankTemplate === 'string' ? metadata.bankTemplate : null;
        const fee = statementFeeFromRawPayload(parent.rawPayload, bankTemplate);
        if (fee === undefined) continue;

        feesFound += 1;
        totalFee = totalFee.add(new Decimal(fee).abs());
        touchedHoldings.add(parent.holdingId);
        feeRows.push(this.feeRowFor(parent, fee, metadata, bankTemplate));
      }

      if (feeRows.length > 0 && !dryRun) {
        const written = await this.transactionRepository.bulkUpsert(feeRows);
        feesWritten += written.rows.length;
      }

      // A short page means the keyset is exhausted. On a real run the rows just
      // written also stop matching the candidate predicate, so the cursor is
      // what keeps this from re-reading them — not the predicate.
      if (page.length < batchSize) break;
    }

    let openingsResynthesized = 0;
    if (!dryRun) {
      for (const holdingId of touchedHoldings) {
        const result = await this.reconciliation.reconcileHolding(holdingId);
        if (result?.openingBalanceSynthesized) openingsResynthesized += 1;
      }
    }

    const summary: BackfillStatementFeesSummary = {
      scanned,
      feesFound,
      feesWritten,
      totalFeeMagnitude: totalFee.toString(),
      holdingsTouched: touchedHoldings.size,
      openingsResynthesized,
    };
    this.logger.info({ ...summary, dryRun }, 'Statement fee backfill finished');
    return summary;
  }

  /**
   * The row the ingester would have written, reconstructed field for field
   * (`StatementTransactionIngester`, the `tx.fee` branch). Any divergence here
   * would make a re-upload of the same statement look like a different fee and
   * cost the backfill its idempotency, so nothing about this row is invented:
   * the sign, the instant, the `:fee` suffix and the metadata shape all come
   * from that branch.
   */
  private feeRowFor(
    parent: HoldingTransaction,
    fee: number,
    metadata: Record<string, unknown>,
    bankTemplate: string | null
  ): NewHoldingTransaction {
    const description = typeof metadata.description === 'string' ? metadata.description : '';
    return {
      userId: parent.userId,
      holdingId: parent.holdingId,
      tokenId: parent.tokenId,
      kind: 'fee',
      quantity: new Decimal(fee).abs().neg().toString(),
      occurredAt: parent.occurredAt,
      externalId: `${parent.externalId}:fee`,
      source: parent.source,
      sourceMetadata: {
        description: description ? `Fee — ${description}` : 'Fee',
        bankTemplate,
        format: metadata.format ?? null,
        feeForExternalId: parent.externalId,
      },
      rawPayload: parent.rawPayload as Record<string, unknown> | null,
    };
  }
}
