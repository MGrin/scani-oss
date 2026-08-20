import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { ledgerOrderBy } from '../lib/ledger-order';
import { HoldingCoverageRepository } from './HoldingCoverageRepository';
import { describeMergedBatch, type MergedRowSubject } from './merged-rows';

export interface TransactionRangeOptions {
  // Direct holding anchor — preferred primary filter when listing the tx
  // history for a holding-detail page.
  holdingId?: string;
  // Joins through holdings — the repository expands this into a subquery
  // so callers don't need to manage the JOIN themselves. Useful for
  // "all tx in this account" / "all BTC tx ever" style aggregations
  // where we don't care about the lot granularity.
  accountId?: string;
  tokenId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  kinds?: string[];
  source?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/**
 * One dedup key that appeared more than once in a single `bulkUpsert`
 * batch. `dropped` is how many rows were discarded onto it — occurrences
 * minus the one that survived.
 */
export interface BulkUpsertMerge {
  holdingId: string;
  source: string;
  externalId: string | null;
  dropped: number;
}

/**
 * One upstream event that landed on more than one holding of the SAME
 * (account, token) — the damage shape `holding_tx_dedup` cannot prevent,
 * because it is UNIQUE(holding_id, source, external_id) and therefore
 * per HOLDING. Two rows for one position each carry the key legitimately,
 * so an ingester that resolves to the other one re-ingests the whole
 * history instead of deduping against it (SC-193 / SC-239 / SC-367).
 */
export interface CrossHoldingDuplicate {
  accountId: string;
  tokenId: string;
  source: string;
  externalId: string;
  holdingIds: string[];
}

/**
 * `reconciliation-opening` writes a CONSTANT `external_id` of
 * 'opening_balance', and `OpeningBalanceReconciliationService` synthesizes
 * one anchor PER HOLDING on purpose — so two holdings of one position both
 * carrying it is the design, not the defect. Counting it would make the
 * probe fire on every legitimately split position forever, which is how a
 * detector stops being read.
 */
const SYNTHESIZED_SOURCES = ['reconciliation-opening'] as const;

export interface BulkUpsertResult {
  rows: HoldingTransaction[];
  /** Empty unless the batch carried the same dedup key twice. */
  merges: BulkUpsertMerge[];
}

const TRANSACTION_ROWS: MergedRowSubject = {
  row: 'transaction',
  dedupKey: '(holding, source, externalId)',
};

/**
 * The audit line a caller records in its user-visible `warnings` when a
 * `bulkUpsert` batch collapsed. Shared so the transaction-import coordinator
 * and the file-import processor cannot drift into describing the same event
 * two different ways; the sentence itself lives in `describeMergedBatch`,
 * which every writer that has to dedupe a batch binds.
 */
export function describeMergedRows(merges: readonly BulkUpsertMerge[]): string | null {
  return describeMergedBatch(
    merges.map((m) => ({ key: `${m.holdingId}/${m.externalId}`, dropped: m.dropped })),
    TRANSACTION_ROWS
  );
}

@Service()
export class HoldingTransactionRepository extends BaseRepository<
  HoldingTransaction,
  NewHoldingTransaction
> {
  protected readonly table = schema.holdingTransactions;
  protected readonly tableName = 'holding_transactions';
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);

  // Idempotent bulk insert. Ingesters re-run safely because dedup unique
  // constraint (holding_id, source, external_id) rejects duplicates.
  // For rows without an external_id (some manual entries, screenshot
  // extractions), callers should provide a stable synthetic external_id
  // before passing to this method — otherwise every re-ingest creates
  // duplicates.
  async bulkUpsert(
    rows: NewHoldingTransaction[],
    transaction?: DatabaseTransaction
  ): Promise<BulkUpsertResult> {
    try {
      if (rows.length === 0) return { rows: [], merges: [] };
      const database = this.getDb(transaction);

      // Dedupe by the conflict target `(holding_id, source, external_id)`
      // before sending to Postgres. ON CONFLICT DO UPDATE rejects a
      // single statement with two rows that share the conflict key
      // ("cannot affect row a second time", SQLSTATE 21000) — and EVM
      // providers occasionally emit two events sharing the same
      // (hash, contract): a self-transfer where the wallet is both
      // sender and receiver, or a token-transfer plus a internal-tx
      // shadow row. The last occurrence wins, matching the upstream
      // ordering semantics that "later events overwrite earlier".
      //
      // What each key cost is carried alongside it, because that count is
      // the only evidence a leg ever existed. A source whose `externalId`
      // is not unique per event loses rows right here, and every signal
      // downstream — the job's `status`, its `warnings`,
      // `has_complete_tx_history` — reads exactly as it does after a clean
      // import (SC-341, SC-349). A genuine re-send of one event inside one
      // batch is legitimate, so this is an audit trail, not a refusal.
      const deduped = new Map<string, { row: NewHoldingTransaction; dropped: number }>();
      for (const row of rows) {
        const key = `${row.holdingId}|${row.source}|${row.externalId}`;
        const seen = deduped.get(key);
        deduped.set(key, { row, dropped: seen ? seen.dropped + 1 : 0 });
      }
      const inputRows = [...deduped.values()].map((entry) => entry.row);
      const merges: BulkUpsertMerge[] = [...deduped.values()]
        .filter((entry) => entry.dropped > 0)
        .map(({ row, dropped }) => ({
          holdingId: row.holdingId,
          source: row.source,
          externalId: row.externalId ?? null,
          dropped,
        }));
      if (merges.length > 0) {
        this.logger.warn(
          {
            batchSize: rows.length,
            keysMerged: merges.length,
            rowsDropped: merges.reduce((sum, m) => sum + m.dropped, 0),
            merges,
          },
          'bulkUpsert collapsed rows sharing a dedup key — a leg may have been lost'
        );
      }

      const results = await database
        .insert(schema.holdingTransactions)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values(inputRows as any[])
        .onConflictDoUpdate({
          target: [
            schema.holdingTransactions.holdingId,
            schema.holdingTransactions.source,
            schema.holdingTransactions.externalId,
          ],
          // Re-parsing after a normalizer improvement should overwrite
          // derived fields but preserve ingest/created_at.
          set: {
            kind: sql`EXCLUDED.kind`,
            quantity: sql`EXCLUDED.quantity`,
            priceNative: sql`EXCLUDED.price_native`,
            priceNativeTokenId: sql`EXCLUDED.price_native_token_id`,
            counterTokenId: sql`EXCLUDED.counter_token_id`,
            counterQuantity: sql`EXCLUDED.counter_quantity`,
            counterPriceNative: sql`EXCLUDED.counter_price_native`,
            counterPriceNativeTokenId: sql`EXCLUDED.counter_price_native_token_id`,
            feeQuantity: sql`EXCLUDED.fee_quantity`,
            feeTokenId: sql`EXCLUDED.fee_token_id`,
            occurredAt: sql`EXCLUDED.occurred_at`,
            // Derived by the ingester from the transaction itself, so the
            // re-import is authoritative — unlike `transfer_group_id` and
            // `transfer_review`, which belong to the matcher and to a person
            // and are absent from this list on purpose. Without it a
            // re-import that recognises a swap for the first time would
            // update `kind` to `swap_out` and leave the row linked to
            // nothing, which is the shape SC-332 exists to remove (a swap
            // leg that reads as answered while its partner is unreachable).
            swapGroupId: sql`EXCLUDED.swap_group_id`,
            sourceMetadata: sql`EXCLUDED.source_metadata`,
            rawPayload: sql`EXCLUDED.raw_payload`,
            counterparty: sql`EXCLUDED.counterparty`,
            description: sql`EXCLUDED.description`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      // `holding_coverage.first_tx_at` / `last_tx_at` summarize this
      // table, so they are re-derived here rather than reported by each
      // caller. Seven call sites write this ledger and six of them used
      // to write no coverage at all (SC-307); the seventh reported the
      // whole run's bounds to every holding it touched (SC-308). Doing
      // it at the write is what makes the summary unable to drift from
      // what it summarizes.
      await this.coverageRepository.syncTxBoundsFromLedger(
        inputRows.map((r) => r.holdingId),
        transaction
      );

      this.logger.debug({ count: results.length }, 'Bulk upserted holding transactions');
      return { rows: results as HoldingTransaction[], merges };
    } catch (error) {
      // postgres-js error shape varies: sometimes plain Error with
      // pg fields siblings, sometimes `cause` wraps the actual DB
      // error, sometimes neither — depending on how Drizzle bubbles
      // it. Log everything we can pull out so the next FK / NOT NULL
      // violation isn't another round of log-improvement work.
      const pg = error as Record<string, unknown> | null;
      const cause = (pg?.cause as Record<string, unknown> | undefined) ?? undefined;
      const ownProps = pg ? Object.getOwnPropertyNames(pg) : [];
      this.logger.error(
        {
          count: rows.length,
          message: error instanceof Error ? error.message : (pg?.message ?? String(error)),
          ownProps,
          pgCode: pg?.code ?? cause?.code,
          pgDetail: pg?.detail ?? cause?.detail,
          pgHint: pg?.hint ?? cause?.hint,
          pgSchema: pg?.schema_name ?? cause?.schema_name,
          pgTable: pg?.table_name ?? cause?.table_name,
          pgColumn: pg?.column_name ?? cause?.column_name,
          pgConstraint: pg?.constraint_name ?? cause?.constraint_name,
          pgRoutine: pg?.routine ?? cause?.routine,
          pgWhere: pg?.where ?? cause?.where,
          stack: error instanceof Error ? error.stack : undefined,
          sampleRow: rows[0],
        },
        'Failed to bulk upsert holding transactions'
      );
      throw error;
    }
  }

  // Returns every tx for a given holding in (from, to] ordered by time.
  // Used by BalanceAtTimeService.getBalance to walk backward from an anchor.
  // All transactions for a holding occurring on or before `until`,
  // chronologically ordered. The cost-basis FIFO walker reads this
  // (the `from` parameter on findForHoldingInRange is `gt`-exclusive,
  // which would skip a tx at exactly the lower bound).
  async findForHoldingUpTo(
    holdingId: string,
    until: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, holdingId),
            lte(schema.holdingTransactions.occurredAt, until)
          )
        )
        .orderBy(...ledgerOrderBy());
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        { holdingId, until, error: error instanceof Error ? error.message : error },
        'Failed to find transactions for holding up to date'
      );
      throw error;
    }
  }

  // Bulk fetch — every transaction for ANY of `holdingIds`, all times,
  // chronologically ordered, grouped by holdingId. Used by the rollup
  // pre-fetch so the inner per-(scope, day) loop can call walkLots on
  // already-loaded txs instead of one DB read per (holding, day).
  async findForHoldingsAll(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, HoldingTransaction[]>> {
    const out = new Map<string, HoldingTransaction[]>();
    if (holdingIds.length === 0) return out;
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingTransactions)
        .where(inArray(schema.holdingTransactions.holdingId, holdingIds))
        .orderBy(...ledgerOrderBy());
      for (const id of holdingIds) out.set(id, []);
      for (const row of results as HoldingTransaction[]) {
        const bucket = out.get(row.holdingId);
        if (bucket) bucket.push(row);
      }
      return out;
    } catch (error) {
      this.logger.error(
        { count: holdingIds.length, error: error instanceof Error ? error.message : error },
        'Failed bulk-fetch transactions for holdings'
      );
      throw error;
    }
  }

  /**
   * Every holding reachable from `holdingIds` through a shared
   * `transfer_group_id`, including the seeds themselves (SC-152).
   *
   * Cost basis for a transfer-linked holding cannot be computed in isolation —
   * a transfer carries lots across accounts intact, so a lot sold on a Ledger
   * may have been bought on Kraken. `PnLAtTimeService` gets this by
   * partitioning the user's *whole* portfolio, which is right when it is about
   * to walk all of it anyway. Asking about one holding should not read every
   * transaction the user has, so this expands outward from the seeds instead.
   *
   * A fixpoint rather than one join because the relation is transitive: A pairs
   * with B on one group and B with C on another, and C's acquisitions are still
   * part of A's answer. In practice it converges in one or two rounds — the
   * loop exists for correctness, not because portfolios are deep.
   */
  async findTransferLinkedHoldingIds(
    userId: string,
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    const reached = new Set(holdingIds);
    if (holdingIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      let frontier = holdingIds;
      const seenGroups = new Set<string>();
      while (frontier.length > 0) {
        const groupRows = await database
          .selectDistinct({ groupId: schema.holdingTransactions.transferGroupId })
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              inArray(schema.holdingTransactions.holdingId, frontier),
              isNotNull(schema.holdingTransactions.transferGroupId)
            )
          );
        const groupIds = groupRows
          .map((r) => r.groupId)
          .filter((g): g is string => g !== null && !seenGroups.has(g));
        if (groupIds.length === 0) break;
        for (const g of groupIds) seenGroups.add(g);

        const holdingRows = await database
          .selectDistinct({ holdingId: schema.holdingTransactions.holdingId })
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              inArray(schema.holdingTransactions.transferGroupId, groupIds)
            )
          );
        frontier = holdingRows.map((r) => r.holdingId).filter((h) => !reached.has(h));
        for (const h of frontier) reached.add(h);
      }
      return [...reached];
    } catch (error) {
      this.logger.error(
        { count: holdingIds.length, error: error instanceof Error ? error.message : error },
        'Failed to expand transfer-linked holdings'
      );
      throw error;
    }
  }

  async findForHoldingInRange(
    holdingId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, holdingId),
            gt(schema.holdingTransactions.occurredAt, from),
            lte(schema.holdingTransactions.occurredAt, to)
          )
        )
        .orderBy(...ledgerOrderBy());
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        { holdingId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find transactions for holding in range'
      );
      throw error;
    }
  }

  /**
   * Every transaction on ANY of `holdingIds` inside `(from, to]`, in ledger
   * order (SC-457).
   *
   * The bulk twin of `findForHoldingInRange`, and the same half-open interval
   * on purpose: a return window's sub-period runs from the END of one measured
   * day to the END of the next, so a transaction stamped exactly at a
   * boundary belongs to the earlier side and must not be counted twice.
   *
   * One query rather than a loop because the returns engine asks for a whole
   * portfolio at once — 60 holdings on a 365-day window is 60 round trips the
   * other way.
   */
  async findForHoldingsInRange(
    holdingIds: readonly string[],
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    if (holdingIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            inArray(schema.holdingTransactions.holdingId, [...holdingIds]),
            gt(schema.holdingTransactions.occurredAt, from),
            lte(schema.holdingTransactions.occurredAt, to)
          )
        )
        .orderBy(...ledgerOrderBy());
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        {
          count: holdingIds.length,
          from,
          to,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to find transactions for holdings in range'
      );
      throw error;
    }
  }

  // Sum of signed `quantity` values in (from, to] for a holding.
  // Used heavily by balance-at-time computation; pushed to SQL so we don't
  // round-trip entire tx lists just to sum them.
  async sumQuantityInRange(
    holdingId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<string> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          total: sql<string>`COALESCE(SUM(${schema.holdingTransactions.quantity}::numeric), 0)::text`,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, holdingId),
            gt(schema.holdingTransactions.occurredAt, from),
            lte(schema.holdingTransactions.occurredAt, to)
          )
        );
      return rows[0]?.total ?? '0';
    } catch (error) {
      this.logger.error(
        { holdingId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to sum transaction quantity in range'
      );
      throw error;
    }
  }

  // Earliest / latest occurrence for a holding. Used for coverage
  // metadata updates (first_tx_at / last_tx_at).
  /**
   * `opts.excludeReconciliationOpening` leaves the reconciler's own synthetic
   * row out of the bounds (SC-199).
   *
   * Without it the reconciler asks "when does real history begin", is handed
   * the answer including the row it wrote last time, and places the next one a
   * millisecond before THAT. The row does not duplicate — `holding_tx_dedup`
   * on (holding_id, source, external_id) holds, and the upsert rewrites
   * `occurred_at` — but it walks one millisecond earlier on every run, so the
   * date drifts away from the history it is supposed to sit against. Same
   * reasoning as `sumQuantityForHoldingUntil`'s flag, and the same defect
   * class: a computation that reads its own previous output.
   */
  async findExtremesForHolding(
    holdingId: string,
    transaction?: DatabaseTransaction,
    opts?: { excludeReconciliationOpening?: boolean }
  ): Promise<{ first: Date | null; last: Date | null }> {
    try {
      const database = this.getDb(transaction);
      const conditions = [eq(schema.holdingTransactions.holdingId, holdingId)];
      if (opts?.excludeReconciliationOpening) {
        conditions.push(ne(schema.holdingTransactions.source, 'reconciliation-opening'));
      }
      const rows = await database
        .select({
          first: sql<Date | null>`MIN(${schema.holdingTransactions.occurredAt})`,
          last: sql<Date | null>`MAX(${schema.holdingTransactions.occurredAt})`,
        })
        .from(schema.holdingTransactions)
        .where(and(...conditions));
      return {
        first: rows[0]?.first ? new Date(rows[0].first) : null,
        last: rows[0]?.last ? new Date(rows[0].last) : null,
      };
    } catch (error) {
      this.logger.error(
        { holdingId, error: error instanceof Error ? error.message : error },
        'Failed to find tx extremes for holding'
      );
      throw error;
    }
  }

  // Full sum over all-time (or up to a cutoff). Used by
  // OpeningBalanceReconciliationService to compute sum(txs) vs current
  // holdings.balance.
  //
  // When `excludeReconciliationOpening` is true, the synthesized
  // `source='reconciliation-opening'` rows are filtered out. The
  // reconciler MUST pass true — including its own past synthesis in
  // the sum makes computedOpening oscillate (a +N opening on one run
  // becomes a 0 sum on the next, regenerating an opposite-signed N
  // every other reconcile pass). All other callers default to the
  // raw sum because they want every ledger row.
  async sumQuantityForHoldingUntil(
    holdingId: string,
    until: Date,
    transactionOrOptions?: DatabaseTransaction | { excludeReconciliationOpening?: boolean },
    options?: { excludeReconciliationOpening?: boolean }
  ): Promise<string> {
    // Preserve the (holdingId, until, transaction?) call shape every
    // existing caller uses; a fourth arg adds the new options. Detect
    // the third positional via duck-typing — Drizzle transaction objects
    // expose a `.transaction()` method, plain options never do.
    let transaction: DatabaseTransaction | undefined;
    let opts: { excludeReconciliationOpening?: boolean } = {};
    if (transactionOrOptions && 'transaction' in transactionOrOptions) {
      transaction = transactionOrOptions as DatabaseTransaction;
      if (options) opts = options;
    } else if (transactionOrOptions) {
      opts = transactionOrOptions as { excludeReconciliationOpening?: boolean };
    }
    try {
      const database = this.getDb(transaction);
      const conditions = [
        eq(schema.holdingTransactions.holdingId, holdingId),
        lte(schema.holdingTransactions.occurredAt, until),
      ];
      if (opts.excludeReconciliationOpening) {
        conditions.push(ne(schema.holdingTransactions.source, 'reconciliation-opening'));
      }
      const rows = await database
        .select({
          total: sql<string>`COALESCE(SUM(${schema.holdingTransactions.quantity}::numeric), 0)::text`,
        })
        .from(schema.holdingTransactions)
        .where(and(...conditions));
      return rows[0]?.total ?? '0';
    } catch (error) {
      this.logger.error(
        { holdingId, until, error: error instanceof Error ? error.message : error },
        'Failed to sum transaction quantity until date'
      );
      throw error;
    }
  }

  // Generic range query for listing UIs (transaction list in holding detail,
  // etc). Accepts holdingId as a direct filter, or accountId/tokenId as
  // indirect filters applied via subquery on holdings.
  async findByRange(
    opts: TransactionRangeOptions,
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [] as ReturnType<typeof eq>[];
      if (opts.holdingId) {
        conditions.push(eq(schema.holdingTransactions.holdingId, opts.holdingId));
      }
      if (opts.accountId) {
        // Indirect: join through holdings. Subquery keeps the caller from
        // having to write the join themselves.
        conditions.push(
          inArray(
            schema.holdingTransactions.holdingId,
            database
              .select({ id: schema.holdings.id })
              .from(schema.holdings)
              .where(eq(schema.holdings.accountId, opts.accountId))
          )
        );
      }
      if (opts.tokenId) {
        // Denormalized — we kept holding_transactions.token_id precisely
        // to avoid a JOIN here. Ingesters MUST keep it consistent with
        // the holding's token.
        conditions.push(eq(schema.holdingTransactions.tokenId, opts.tokenId));
      }
      if (opts.userId) {
        conditions.push(eq(schema.holdingTransactions.userId, opts.userId));
      }
      if (opts.from) {
        conditions.push(gte(schema.holdingTransactions.occurredAt, opts.from));
      }
      if (opts.to) {
        conditions.push(lt(schema.holdingTransactions.occurredAt, opts.to));
      }
      if (opts.kinds && opts.kinds.length > 0) {
        conditions.push(inArray(schema.holdingTransactions.kind, opts.kinds));
      }
      if (opts.source) {
        conditions.push(eq(schema.holdingTransactions.source, opts.source));
      }

      // Total, not just chronological — this is the paginated read, and
      // `limit`/`offset` over a partial order can show one row on two pages
      // and another on none (SC-342).
      let query = database
        .select()
        .from(schema.holdingTransactions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...ledgerOrderBy(opts.order === 'asc' ? 'asc' : 'desc'));

      if (opts.limit !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle fluent builder type
        query = query.limit(opts.limit) as any;
      }
      if (opts.offset !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle fluent builder type
        query = query.offset(opts.offset) as any;
      }

      const results = await query;
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        { opts, error: error instanceof Error ? error.message : error },
        'Failed to find transactions by range'
      );
      throw error;
    }
  }

  /**
   * Statement rows that could still be hiding a fee (SC-159).
   *
   * A row imported before SC-136 dropped its statement fee, so the ledger is
   * short by it and the derived opening balance with it. The candidates are
   * the statement rows that have no `<external_id>:fee` sibling — that suffix
   * is the ingester's own idempotency key, so its absence is exactly "not
   * backfilled and not imported with a fee", and its presence is the reason a
   * second run of the backfill finds nothing.
   *
   * Whether a candidate *actually* carries a fee is a question about the CSV
   * cell inside `raw_payload`, and the column it lives in is bank-specific —
   * that is `statementFeeFromRawPayload`'s job, not SQL's. This returns the
   * superset and keeps the reading in one place.
   *
   * Keyset-paginated by `id` so a long backfill neither holds a cursor open
   * nor pays a growing OFFSET.
   */
  async findStatementRowsWithoutFeeSibling(
    opts: { limit: number; afterId?: string; userId?: string },
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    try {
      const database = this.getDb(transaction);
      const parent = schema.holdingTransactions;
      const conditions = [
        sql`${parent.source} like 'statement-%'`,
        ne(parent.kind, 'fee'),
        sql`${parent.rawPayload} is not null`,
        sql`not exists (
          select 1 from ${parent} sibling
          where sibling.holding_id = ${parent.holdingId}
            and sibling.source = ${parent.source}
            and sibling.external_id = ${parent.externalId} || ':fee'
        )`,
      ];
      if (opts.afterId) conditions.push(gt(parent.id, opts.afterId));
      if (opts.userId) conditions.push(eq(parent.userId, opts.userId));

      const results = await database
        .select()
        .from(parent)
        .where(and(...conditions))
        .orderBy(asc(parent.id))
        .limit(opts.limit);
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        { opts, error: error instanceof Error ? error.message : error },
        'Failed to find statement rows without a fee sibling'
      );
      throw error;
    }
  }

  // Drop the synthesized `reconciliation-opening` row for a holding.
  // OpeningBalanceReconciliationService calls this when the real tx
  // chain perfectly explains the current balance, so a stale opening
  // row from a previous reconciliation pass (or inherited from a
  // duplicate that was merged into this canonical holding by migration
  // 0006/0007) doesn't keep distorting cost basis. Returns the count
  // deleted; 0 means there was nothing to clean up.
  async deleteReconciliationOpening(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    return this.deleteForHoldingBySource(holdingId, 'reconciliation-opening', transaction);
  }

  /**
   * Which of `accountIds` already hold at least one row written by `source`.
   *
   * The recurring transaction sync asks this to tell a re-sync from a first
   * read. An incremental `since` over an EMPTY ledger imports nothing but
   * the window — and a wallet's movements are mostly older than any window
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   */
  async findAccountsWithLedgerFor(
    accountIds: readonly string[],
    source: string,
    transaction?: DatabaseTransaction
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const database = this.getDb(transaction);
    const rows = await database
      .selectDistinct({ accountId: schema.holdings.accountId })
      .from(schema.holdingTransactions)
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .where(
        and(
          inArray(schema.holdings.accountId, [...accountIds]),
          eq(schema.holdingTransactions.source, source)
        )
      );
    return new Set(rows.map((r) => r.accountId));
  }

  // Delete all txs from a given source for a holding. Used when re-running
  // an ingester from scratch. Never deletes `reconciliation-opening` rows
  // implicitly — OpeningBalanceReconciliationService owns those.
  async deleteForHoldingBySource(
    holdingId: string,
    source: string,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .delete(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, holdingId),
            eq(schema.holdingTransactions.source, source)
          )
        )
        .returning({ id: schema.holdingTransactions.id });
      // A removal narrows the ledger, so the summary of it has to narrow
      // too — the old `LEAST`/`GREATEST` upsert could only ever widen.
      if (results.length > 0) {
        await this.coverageRepository.syncTxBoundsFromLedger([holdingId], transaction);
      }
      return results.length;
    } catch (error) {
      this.logger.error(
        { holdingId, source, error: error instanceof Error ? error.message : error },
        'Failed to delete transactions by source'
      );
      throw error;
    }
  }

  /**
   * Every upstream event recorded against more than one holding of the same
   * (account, token). Empty is the healthy answer.
   *
   * This is the check nothing performed for the months SC-239 went unnoticed.
   * Per-holding reconciliation actively hides the condition: each holding
   * reconciles to its own synthesized opening anchor, so a ledger inspected
   * one holding at a time balances on both sides while the position is
   * counted twice. It is only visible by grouping ACROSS holdings, which is
   * what this does.
   */
  async findCrossHoldingDuplicates(
    transaction?: DatabaseTransaction
  ): Promise<CrossHoldingDuplicate[]> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          accountId: schema.holdings.accountId,
          tokenId: schema.holdings.tokenId,
          source: schema.holdingTransactions.source,
          externalId: schema.holdingTransactions.externalId,
          holdingIds: sql<
            string[]
          >`array_agg(distinct ${schema.holdingTransactions.holdingId}::text)`,
        })
        .from(schema.holdingTransactions)
        .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
        .where(
          and(
            isNotNull(schema.holdingTransactions.externalId),
            notInArray(schema.holdingTransactions.source, [...SYNTHESIZED_SOURCES])
          )
        )
        .groupBy(
          schema.holdings.accountId,
          schema.holdings.tokenId,
          schema.holdingTransactions.source,
          schema.holdingTransactions.externalId
        )
        .having(sql`count(distinct ${schema.holdingTransactions.holdingId}) > 1`);

      return rows.map((r) => ({
        accountId: r.accountId,
        tokenId: r.tokenId,
        source: r.source,
        // Narrowed by the `isNotNull` filter above; the column type stays
        // nullable because the schema allows NULL for rows nothing dedupes.
        externalId: r.externalId ?? '',
        holdingIds: r.holdingIds,
      }));
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to find cross-holding duplicate transactions'
      );
      throw error;
    }
  }
}
