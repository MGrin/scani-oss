import { type DatabaseTransaction, getDb } from '@scani/db';
import type { HoldingCoverage, NewHoldingCoverage } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';

// Primary key is holding_id since migration 0054. We don't extend
// BaseRepository because its `findById` assumes the column is literally
// named `id`; the `holdings`-FK PK is named `holding_id` here.
@Service()
export class HoldingCoverageRepository {
  private readonly logger = createComponentLogger('repository:HoldingCoverageRepository');

  private getDb(transaction?: DatabaseTransaction) {
    return transaction || getDb();
  }

  async findByHolding(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<HoldingCoverage | null> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .select()
        .from(schema.holdingCoverage)
        .where(eq(schema.holdingCoverage.holdingId, holdingId))
        .limit(1);
      return (results[0] as HoldingCoverage) ?? null;
    } catch (error) {
      this.logger.error(
        { holdingId, error: error instanceof Error ? error.message : error },
        'Failed to find holding_coverage'
      );
      throw error;
    }
  }

  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction
  ): Promise<HoldingCoverage[]> {
    try {
      const db = this.getDb(transaction);
      // Join through holdings to surface coverage for every (account,
      // token[, …]) position under an account.
      const results = await db
        .select({
          holdingId: schema.holdingCoverage.holdingId,
          firstTxAt: schema.holdingCoverage.firstTxAt,
          lastTxAt: schema.holdingCoverage.lastTxAt,
          firstObservationAt: schema.holdingCoverage.firstObservationAt,
          lastObservationAt: schema.holdingCoverage.lastObservationAt,
          txSources: schema.holdingCoverage.txSources,
          hasCompleteTxHistory: schema.holdingCoverage.hasCompleteTxHistory,
          lastReconciledAt: schema.holdingCoverage.lastReconciledAt,
          openingBalanceQuantity: schema.holdingCoverage.openingBalanceQuantity,
          reconciliationNotes: schema.holdingCoverage.reconciliationNotes,
          updatedAt: schema.holdingCoverage.updatedAt,
        })
        .from(schema.holdingCoverage)
        .innerJoin(schema.holdings, eq(schema.holdingCoverage.holdingId, schema.holdings.id))
        .where(eq(schema.holdings.accountId, accountId));
      return results as HoldingCoverage[];
    } catch (error) {
      this.logger.error(
        { accountId, error: error instanceof Error ? error.message : error },
        'Failed to find holding_coverage by account'
      );
      throw error;
    }
  }

  // Upsert from an ingester path. Touches only fields an ingester knows
  // about (first/last tx+observation times, sources, completeness flag)
  // and deliberately does NOT overwrite reconciliation state, which is
  // owned by `upsertReconciliation` below. This split avoids silently
  // wiping reconciliation output every time any ingester finishes.
  //
  // `hasCompleteTxHistory` is written through from the incoming row as
  // the ingester's current claim. It is NOT OR'd with the existing
  // value: a subsequent narrower re-run (revoked API key, corrupted
  // statement) MUST be able to downgrade the flag so the data-quality
  // UI reflects reality. Callers that don't want to move the flag
  // should read the current value and pass it back explicitly.
  async upsertFromIngester(
    row: NewHoldingCoverage,
    transaction?: DatabaseTransaction
  ): Promise<HoldingCoverage> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .insert(schema.holdingCoverage)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle insert type constraint
        .values(row as any)
        .onConflictDoUpdate({
          target: schema.holdingCoverage.holdingId,
          set: {
            firstTxAt: sql`LEAST(${schema.holdingCoverage.firstTxAt}, EXCLUDED.first_tx_at)`,
            lastTxAt: sql`GREATEST(${schema.holdingCoverage.lastTxAt}, EXCLUDED.last_tx_at)`,
            firstObservationAt: sql`LEAST(${schema.holdingCoverage.firstObservationAt}, EXCLUDED.first_observation_at)`,
            lastObservationAt: sql`GREATEST(${schema.holdingCoverage.lastObservationAt}, EXCLUDED.last_observation_at)`,
            // Array union — append new sources without duplicating existing.
            txSources: sql`ARRAY(SELECT DISTINCT UNNEST(${schema.holdingCoverage.txSources} || EXCLUDED.tx_sources))`,
            // Direct write-through, not sticky-OR: a narrower re-run must
            // be able to move the flag back to false.
            hasCompleteTxHistory: sql`EXCLUDED.has_complete_tx_history`,
            updatedAt: sql`now()`,
            // Intentionally omitted: lastReconciledAt, openingBalanceQuantity,
            // reconciliationNotes. Those belong to `upsertReconciliation`.
          },
        })
        .returning();
      if (!results[0]) {
        throw new Error(`Upsert of holding_coverage (${row.holdingId}) returned no row`);
      }
      return results[0] as HoldingCoverage;
    } catch (error) {
      this.logger.error(
        { row, error: error instanceof Error ? error.message : error },
        'Failed to upsert holding_coverage from ingester'
      );
      throw error;
    }
  }

  // Upsert from the reconciliation path. Only touches reconciliation-
  // owned fields. Paired with `upsertFromIngester`; the two don't step
  // on each other.
  async upsertReconciliation(
    row: Pick<NewHoldingCoverage, 'holdingId'> & {
      lastReconciledAt: Date;
      openingBalanceQuantity: string | null;
      reconciliationNotes: string | null;
    },
    transaction?: DatabaseTransaction
  ): Promise<HoldingCoverage> {
    try {
      const db = this.getDb(transaction);
      const values = {
        ...row,
        firstTxAt: null,
        lastTxAt: null,
        firstObservationAt: null,
        lastObservationAt: null,
        txSources: [],
        hasCompleteTxHistory: false,
        updatedAt: new Date(),
      } satisfies typeof schema.holdingCoverage.$inferInsert;
      const results = await db
        .insert(schema.holdingCoverage)
        .values(values)
        .onConflictDoUpdate({
          target: schema.holdingCoverage.holdingId,
          set: {
            lastReconciledAt: sql`EXCLUDED.last_reconciled_at`,
            openingBalanceQuantity: sql`EXCLUDED.opening_balance_quantity`,
            reconciliationNotes: sql`EXCLUDED.reconciliation_notes`,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (!results[0]) {
        throw new Error(
          `Reconciliation upsert of holding_coverage (${row.holdingId}) returned no row`
        );
      }
      return results[0] as HoldingCoverage;
    } catch (error) {
      this.logger.error(
        { row, error: error instanceof Error ? error.message : error },
        'Failed to upsert holding_coverage reconciliation'
      );
      throw error;
    }
  }

  // Thin alias for callers that pass the full row. Routes to
  // `upsertFromIngester` (writes all ingester fields). New code should
  // pick the specific method.
  async upsert(
    row: NewHoldingCoverage,
    transaction?: DatabaseTransaction
  ): Promise<HoldingCoverage> {
    return this.upsertFromIngester(row, transaction);
  }

  // Bulk fetch keyed by the holdingIds the caller already has in hand.
  // Used by the holdings list view to surface a "missing earlier
  // history" badge for holdings whose import couldn't reach back far
  // enough (Helius truncation, mid-history CSV exports). Returns a Map
  // keyed by holding_id; missing keys mean no coverage row was written
  // for that holding (~22% of prod holdings as of 2026-05).
  async findManyByHoldingIds(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, HoldingCoverage>> {
    if (holdingIds.length === 0) return new Map();
    const db = this.getDb(transaction);
    const rows = await db
      .select()
      .from(schema.holdingCoverage)
      .where(inArray(schema.holdingCoverage.holdingId, holdingIds));
    const out = new Map<string, HoldingCoverage>();
    for (const row of rows as HoldingCoverage[]) out.set(row.holdingId, row);
    return out;
  }

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<HoldingCoverage[]> {
    try {
      const db = this.getDb(transaction);
      // Join through holdings → accounts to get all coverage rows for a
      // user's positions. Two joins because holding_coverage doesn't
      // carry user_id directly (it's derivable via the holding row).
      const results = await db
        .select({
          holdingId: schema.holdingCoverage.holdingId,
          firstTxAt: schema.holdingCoverage.firstTxAt,
          lastTxAt: schema.holdingCoverage.lastTxAt,
          firstObservationAt: schema.holdingCoverage.firstObservationAt,
          lastObservationAt: schema.holdingCoverage.lastObservationAt,
          txSources: schema.holdingCoverage.txSources,
          hasCompleteTxHistory: schema.holdingCoverage.hasCompleteTxHistory,
          lastReconciledAt: schema.holdingCoverage.lastReconciledAt,
          openingBalanceQuantity: schema.holdingCoverage.openingBalanceQuantity,
          reconciliationNotes: schema.holdingCoverage.reconciliationNotes,
          updatedAt: schema.holdingCoverage.updatedAt,
        })
        .from(schema.holdingCoverage)
        .innerJoin(schema.holdings, eq(schema.holdingCoverage.holdingId, schema.holdings.id))
        .where(eq(schema.holdings.userId, userId));
      return results as HoldingCoverage[];
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : error },
        'Failed to find holding_coverage by user'
      );
      throw error;
    }
  }
}
