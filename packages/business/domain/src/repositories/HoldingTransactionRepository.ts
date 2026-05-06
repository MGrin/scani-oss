import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

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

@Service()
export class HoldingTransactionRepository extends BaseRepository<
  HoldingTransaction,
  NewHoldingTransaction
> {
  protected readonly table = schema.holdingTransactions;
  protected readonly tableName = 'holding_transactions';

  // Idempotent bulk insert. Ingesters re-run safely because dedup unique
  // constraint (holding_id, source, external_id) rejects duplicates.
  // For rows without an external_id (some manual entries, screenshot
  // extractions), callers should provide a stable synthetic external_id
  // before passing to this method — otherwise every re-ingest creates
  // duplicates.
  async bulkUpsert(
    rows: NewHoldingTransaction[],
    transaction?: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    try {
      if (rows.length === 0) return [];
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
      const deduped = new Map<string, NewHoldingTransaction>();
      for (const row of rows) {
        const key = `${row.holdingId}|${row.source}|${row.externalId}`;
        deduped.set(key, row);
      }
      const inputRows = [...deduped.values()];

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
            sourceMetadata: sql`EXCLUDED.source_metadata`,
            rawPayload: sql`EXCLUDED.raw_payload`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      this.logger.debug({ count: results.length }, 'Bulk upserted holding transactions');
      return results as HoldingTransaction[];
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
        .orderBy(asc(schema.holdingTransactions.occurredAt));
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
        .orderBy(asc(schema.holdingTransactions.occurredAt));
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
        .orderBy(asc(schema.holdingTransactions.occurredAt));
      return results as HoldingTransaction[];
    } catch (error) {
      this.logger.error(
        { holdingId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find transactions for holding in range'
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
  async findExtremesForHolding(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ first: Date | null; last: Date | null }> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          first: sql<Date | null>`MIN(${schema.holdingTransactions.occurredAt})`,
          last: sql<Date | null>`MAX(${schema.holdingTransactions.occurredAt})`,
        })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.holdingId, holdingId));
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
  async sumQuantityForHoldingUntil(
    holdingId: string,
    until: Date,
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
            lte(schema.holdingTransactions.occurredAt, until)
          )
        );
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

      const orderer =
        opts.order === 'asc'
          ? asc(schema.holdingTransactions.occurredAt)
          : desc(schema.holdingTransactions.occurredAt);

      let query = database
        .select()
        .from(schema.holdingTransactions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderer);

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
      return results.length;
    } catch (error) {
      this.logger.error(
        { holdingId, source, error: error instanceof Error ? error.message : error },
        'Failed to delete transactions by source'
      );
      throw error;
    }
  }
}
