import { type DatabaseTransaction, getDb } from '@scani/db';
import type { HoldingCoverage, NewHoldingCoverage } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { describeMergedBatch, type MergedRowSubject } from './merged-rows';

/**
 * One holding named more than once in a single `upsertManyFromIngester`
 * batch. `dropped` is how many rows were discarded onto it — occurrences
 * minus the one that survived.
 */
export interface CoverageUpsertMerge {
  holdingId: string;
  dropped: number;
}

export interface CoverageUpsertResult {
  /** Rows the statement actually wrote — deduped, so `<= rows.length`. */
  written: number;
  /** Empty unless the batch named the same holding twice. */
  merges: CoverageUpsertMerge[];
}

const COVERAGE_ROWS: MergedRowSubject = { row: 'coverage', dedupKey: '(holding)' };

/**
 * The audit line a caller records in its user-visible `warnings` when a
 * coverage batch collapsed. Binds the same sentence the ledger's
 * `describeMergedRows` does — one wording, two sets of nouns, so a reader
 * meeting both can tell they are one defect (SC-349, SC-366).
 */
export function describeMergedCoverageRows(merges: readonly CoverageUpsertMerge[]): string | null {
  return describeMergedBatch(
    merges.map((m) => ({ key: m.holdingId, dropped: m.dropped })),
    COVERAGE_ROWS
  );
}

// Primary key is holding_id since migration 0054. We don't extend
// BaseRepository because its `findById` assumes the column is literally
// named `id`; the `holdings`-FK PK is named `holding_id` here.
//
// COVERAGE IS READ BY HOLDING ID, and by nothing else (SC-432). `findByAccount`
// and `findByUser` used to sit here — plain reads scoped the way an admin view
// would want, called by nothing, and reachable by nothing dynamic either. What
// made them worth deleting rather than leaving is that they were the only two
// places in this file listing coverage columns one by one; every live reader
// takes the whole row. So each new column on `holding_coverage` cost an edit in
// two methods nobody called, and SC-393 paid it — #1033 removed the observation
// bounds from both select lists and from nowhere else.
//
// If the ops surface they were shaped for is ever built, it wants a different
// method anyway: `findByUser` returned every coverage row a user has, unbounded
// and unordered. `git revert` brings them back if that is wrong.
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

  // The one ingester write path. A run states its source and its
  // completeness once for every holding it touched, so this takes the whole
  // batch: N round trips to say the same thing N times is N-1 more than the
  // statement needs.
  //
  // Touches only fields an ingester knows about (first/last tx times,
  // sources, completeness flag) and deliberately does NOT overwrite
  // reconciliation state, which is owned by `upsertReconciliation` below.
  // That split is why a finishing ingester does not silently wipe
  // reconciliation output.
  //
  // `hasCompleteTxHistory` is written through from the incoming row rather
  // than OR'd with the existing value: a subsequent narrower re-run (revoked
  // API key, corrupted statement) MUST be able to downgrade the flag so the
  // data-quality UI reflects reality. What it may not do is downgrade it
  // merely for having been asked a narrow question, which is what
  // `completenessIsClaimed` below separates.
  /**
   * `completenessIsClaimed` says whether this run is entitled to state
   * anything about `has_complete_tx_history` at all.
   *
   * An incremental (`since`) run read a window, so it knows nothing about
   * the whole ledger — and `TransactionRouter.claimsCompleteHistory`
   * returns false for exactly that reason, not because the history is
   * incomplete. Writing that false through would let a nightly window
   * retract a standing claim that a full import earned: 39 of production's
   * 41 complete-coverage holdings are `etherscan` wallets, and every one of
   * them would have flipped on the first nightly run after SC-360 wired
   * wallets into it. `has_complete_tx_history` drives cost basis (SC-149),
   * so that is a silent downgrade of every wallet's cost basis. Retraction
   * on failure has its own path — `retractCompleteHistoryClaim`.
   */
  async upsertManyFromIngester(
    rows: readonly NewHoldingCoverage[],
    { completenessIsClaimed = true }: { completenessIsClaimed?: boolean } = {},
    transaction?: DatabaseTransaction
  ): Promise<CoverageUpsertResult> {
    if (rows.length === 0) return { written: 0, merges: [] };
    try {
      const db = this.getDb(transaction);
      // `ON CONFLICT DO UPDATE` refuses a statement that touches one row
      // twice (SQLSTATE 21000), so the conflict target has to be unique
      // within the batch before Postgres sees it. Last occurrence wins,
      // whole: the discarded row's `txSources` and completeness claim never
      // reach the `ON CONFLICT` merge, because the row never reaches the
      // statement.
      //
      // What that costs is carried out with the result. No caller can
      // repeat a holding today — the one there is builds its input from a
      // `Set` — but that is a property of the CALLER, and this method
      // promises nothing. A second producer would otherwise lose a claim
      // about a holding here with no count, no warning and nothing
      // downstream reading differently (SC-349, SC-366).
      const deduped = new Map<string, { row: NewHoldingCoverage; dropped: number }>();
      for (const row of rows) {
        const seen = deduped.get(row.holdingId);
        deduped.set(row.holdingId, { row, dropped: seen ? seen.dropped + 1 : 0 });
      }
      const merges: CoverageUpsertMerge[] = [...deduped.values()]
        .filter((entry) => entry.dropped > 0)
        .map(({ row, dropped }) => ({ holdingId: row.holdingId, dropped }));
      if (merges.length > 0) {
        // Logged whatever the caller does with the return value, so a
        // producer that ignores it is still visible to an operator.
        this.logger.warn(
          {
            batchSize: rows.length,
            keysMerged: merges.length,
            rowsDropped: merges.reduce((sum, m) => sum + m.dropped, 0),
            merges,
          },
          'upsertManyFromIngester collapsed rows naming the same holding — a coverage claim may have been lost'
        );
      }
      const results = await db
        .insert(schema.holdingCoverage)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values([...deduped.values()].map((entry) => entry.row) as any[])
        .onConflictDoUpdate({
          target: schema.holdingCoverage.holdingId,
          set: {
            firstTxAt: sql`LEAST(${schema.holdingCoverage.firstTxAt}, EXCLUDED.first_tx_at)`,
            lastTxAt: sql`GREATEST(${schema.holdingCoverage.lastTxAt}, EXCLUDED.last_tx_at)`,
            // LEAST, so the column means the furthest back ANY run has reached
            // for this holding rather than the last one to state a window
            // (SC-900). A saved query whose range slides forward would
            // otherwise move the boundary past rows the ledger still holds,
            // and the boundary is read as "money that moved before this has no
            // row here" — a sentence that must never reach forward over rows
            // we have. Postgres `LEAST` ignores NULLs, so a run that states
            // nothing leaves a stored bound standing, and the first run to
            // state one on a NULL row writes it.
            historyStartsAt: sql`LEAST(${schema.holdingCoverage.historyStartsAt}, EXCLUDED.history_starts_at)`,
            txSources: sql`ARRAY(SELECT DISTINCT UNNEST(${schema.holdingCoverage.txSources} || EXCLUDED.tx_sources))`,
            hasCompleteTxHistory: completenessIsClaimed
              ? sql`EXCLUDED.has_complete_tx_history`
              : sql`${schema.holdingCoverage.hasCompleteTxHistory}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ holdingId: schema.holdingCoverage.holdingId });
      return { written: results.length, merges };
    } catch (error) {
      this.logger.error(
        { count: rows.length, error: error instanceof Error ? error.message : error },
        'Failed to bulk upsert holding_coverage from ingester'
      );
      throw error;
    }
  }

  // Re-derive `first_tx_at` / `last_tx_at` for the given holdings from
  // `holding_transactions`, which is the only thing that knows them.
  //
  // Before SC-307/SC-308 these two columns were *reported* by whichever
  // path had just written the ledger. Six of the seven writers reported
  // nothing, so the row was absent; the seventh reported the whole run's
  // oldest and newest event to every holding it touched, so a holding
  // first seen last week inherited the 2021 start of the BTC position
  // imported alongside it. A summary of a table has one correct source,
  // and it is the table.
  //
  // One statement for the whole set: `LEFT JOIN` so a holding whose last
  // transaction was just deleted has its bounds moved back to NULL rather
  // than left standing at a value nothing supports. `LEAST`/`GREATEST` is
  // deliberately gone with it — a ratchet cannot narrow, and the derived
  // value has to be able to.
  //
  // Deliberately does not touch `tx_sources`, `has_complete_tx_history`
  // or reconciliation state. Those are claims their own writers make;
  // this method only mirrors the ledger.
  async syncTxBoundsFromLedger(
    holdingIds: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<number> {
    if (holdingIds.length === 0) return 0;
    const unique = [...new Set(holdingIds)];
    try {
      const db = this.getDb(transaction);
      const ids = sql.join(
        unique.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      const rows = (await db.execute(sql`
        insert into holding_coverage (holding_id, first_tx_at, last_tx_at, updated_at)
        select h.id, min(ht.occurred_at), max(ht.occurred_at), now()
        from holdings h
        left join holding_transactions ht on ht.holding_id = h.id
        where h.id in (${ids})
        group by h.id
        on conflict (holding_id) do update set
          first_tx_at = excluded.first_tx_at,
          last_tx_at = excluded.last_tx_at,
          updated_at = now()
        returning holding_id
      `)) as unknown as Array<{ holding_id: string }>;
      return rows.length;
    } catch (error) {
      this.logger.error(
        { holdingIds: unique.length, error: error instanceof Error ? error.message : error },
        'Failed to sync holding_coverage tx bounds from the ledger'
      );
      throw error;
    }
  }

  // Retract the "we have the whole ledger" claim for one (account,
  // source) — what a run that FAILED is entitled to say (SC-168).
  //
  // `upsertManyFromIngester` above is reached only on the success path, so
  // a failed run left the previous run's claim standing. Since SC-149 that
  // flag drives cost basis, which turned a stale note into a confident
  // figure derived from data we know we could not read.
  //
  // The scope is the scope a failed run actually has, and it is also
  // exactly the set of rows that can be holding the lie: the flag is only
  // `true` because an earlier run of THIS source wrote it, and that same
  // write appended the source to `tx_sources`. A holding under the same
  // account that only ever heard from another source keeps its claim.
  //
  // Retraction does not touch the ledger — the transactions already
  // imported stay. It says only that we no longer know the ledger is
  // whole, which stands until a run succeeds and writes the claim back.
  async retractCompleteHistoryClaim(
    accountId: string,
    source: string,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      const db = this.getDb(transaction);
      const updated = await db
        .update(schema.holdingCoverage)
        .set({ hasCompleteTxHistory: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.holdingCoverage.hasCompleteTxHistory, true),
            sql`${source}::text = ANY(${schema.holdingCoverage.txSources})`,
            inArray(
              schema.holdingCoverage.holdingId,
              db
                .select({ id: schema.holdings.id })
                .from(schema.holdings)
                .where(eq(schema.holdings.accountId, accountId))
            )
          )
        )
        .returning({ holdingId: schema.holdingCoverage.holdingId });
      return updated.length;
    } catch (error) {
      this.logger.error(
        { accountId, source, error: error instanceof Error ? error.message : error },
        'Failed to retract holding_coverage complete-history claim'
      );
      throw error;
    }
  }

  // Upsert from the reconciliation path. Only touches reconciliation-
  // owned fields. Paired with `upsertManyFromIngester`; the two don't step
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

  // Bulk fetch keyed by the holdingIds the caller already has in hand.
  // Used by the holdings list view to surface a "missing earlier
  // history" badge for holdings whose import couldn't reach back far
  // enough (Helius truncation, mid-history CSV exports). Returns a Map
  // keyed by holding_id; missing keys mean no coverage row was written
  // for that holding (a sizeable minority of prod holdings as of 2026-05).
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
}
