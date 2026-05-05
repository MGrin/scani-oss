import { type DatabaseTransaction, getDb } from '@scani/db';
import type {
  CoverageQuality,
  NewPortfolioValueDaily,
  PortfolioValueDaily,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

export interface PortfolioValueDailyRow {
  userId: string;
  snapshotDate: string; // 'YYYY-MM-DD' — Postgres `date` round-trips as string
  baseCurrencyId: string;
  totalValue: string;
  coverageQuality: CoverageQuality;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  computedAt: Date;
}

// Composite primary key (user_id, snapshot_date, base_currency_id); can't use
// BaseRepository.
@Service()
export class PortfolioValueDailyRepository {
  private readonly logger = createComponentLogger('repository:PortfolioValueDailyRepository');

  private getDb(transaction?: DatabaseTransaction) {
    return transaction || getDb();
  }

  async findRange(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily[]> {
    try {
      const db = this.getDb(transaction);
      // Cast the Date boundaries to 'YYYY-MM-DD' to match the `date` column type.
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId),
            gte(schema.portfolioValueDaily.snapshotDate, fromStr),
            lte(schema.portfolioValueDaily.snapshotDate, toStr)
          )
        )
        .orderBy(asc(schema.portfolioValueDaily.snapshotDate));
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find portfolio_value_daily range'
      );
      throw error;
    }
  }

  // Fetch only the rows whose snapshot_date is in `dates`. Used by the
  // bucketed chart query: we compute bucket-end dates client-side, then
  // pull just those rows from the cache instead of loading every day in
  // the range and filtering in memory.
  async findByDates(
    userId: string,
    baseCurrencyId: string,
    dates: Date[],
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily[]> {
    if (dates.length === 0) return [];
    try {
      const db = this.getDb(transaction);
      const dateStrs = dates.map((d) => d.toISOString().slice(0, 10));
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId),
            inArray(schema.portfolioValueDaily.snapshotDate, dateStrs)
          )
        )
        .orderBy(asc(schema.portfolioValueDaily.snapshotDate));
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        {
          userId,
          baseCurrencyId,
          dateCount: dates.length,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to find portfolio_value_daily by dates'
      );
      throw error;
    }
  }

  async findLatest(
    userId: string,
    baseCurrencyId: string,
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily | null> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId)
          )
        )
        .orderBy(desc(schema.portfolioValueDaily.snapshotDate))
        .limit(1);
      return (results[0] as PortfolioValueDaily) ?? null;
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, error: error instanceof Error ? error.message : error },
        'Failed to find latest portfolio_value_daily'
      );
      throw error;
    }
  }

  // Most recent snapshot the rollup has *any* row for, regardless of
  // base currency. Used by the tx-import path to size `lookbackDays`
  // adaptively — most days, the gap is 0–1, so we don't recompute a
  // full year of history on every transaction-import.
  async findLatestSnapshotDate(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<string | null> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .select({ snapshotDate: schema.portfolioValueDaily.snapshotDate })
        .from(schema.portfolioValueDaily)
        .where(eq(schema.portfolioValueDaily.userId, userId))
        .orderBy(desc(schema.portfolioValueDaily.snapshotDate))
        .limit(1);
      return results[0]?.snapshotDate ?? null;
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : error },
        'Failed to find latest portfolio_value_daily snapshot date'
      );
      throw error;
    }
  }

  async upsert(
    row: NewPortfolioValueDaily,
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .insert(schema.portfolioValueDaily)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle insert type constraint
        .values(row as any)
        .onConflictDoUpdate({
          target: [
            schema.portfolioValueDaily.userId,
            schema.portfolioValueDaily.snapshotDate,
            schema.portfolioValueDaily.baseCurrencyId,
          ],
          set: {
            totalValue: sql`EXCLUDED.total_value`,
            coverageQuality: sql`EXCLUDED.coverage_quality`,
            holdingsWithKnownValue: sql`EXCLUDED.holdings_with_known_value`,
            holdingsTotal: sql`EXCLUDED.holdings_total`,
            computedAt: sql`now()`,
          },
        })
        .returning();
      if (!results[0]) {
        throw new Error(
          `Upsert of portfolio_value_daily (${row.userId}, ${String(row.snapshotDate)}, ${row.baseCurrencyId}) returned no row`
        );
      }
      return results[0] as PortfolioValueDaily;
    } catch (error) {
      this.logger.error(
        { row, error: error instanceof Error ? error.message : error },
        'Failed to upsert portfolio_value_daily'
      );
      throw error;
    }
  }

  async bulkUpsert(
    rows: NewPortfolioValueDaily[],
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily[]> {
    try {
      if (rows.length === 0) return [];
      const db = this.getDb(transaction);
      const results = await db
        .insert(schema.portfolioValueDaily)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values(rows as any[])
        .onConflictDoUpdate({
          target: [
            schema.portfolioValueDaily.userId,
            schema.portfolioValueDaily.snapshotDate,
            schema.portfolioValueDaily.baseCurrencyId,
          ],
          set: {
            totalValue: sql`EXCLUDED.total_value`,
            coverageQuality: sql`EXCLUDED.coverage_quality`,
            holdingsWithKnownValue: sql`EXCLUDED.holdings_with_known_value`,
            holdingsTotal: sql`EXCLUDED.holdings_total`,
            computedAt: sql`now()`,
          },
        })
        .returning();
      this.logger.debug({ count: results.length }, 'Bulk upserted portfolio_value_daily');
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        { count: rows.length, error: error instanceof Error ? error.message : error },
        'Failed to bulk upsert portfolio_value_daily'
      );
      throw error;
    }
  }

  // Drop all rollup rows for a user — used when re-computing from scratch.
  // Fast + safe because rollup is derived cache.
  async deleteForUser(
    userId: string,
    baseCurrencyId?: string,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      const db = this.getDb(transaction);
      const conditions = [eq(schema.portfolioValueDaily.userId, userId)];
      if (baseCurrencyId) {
        conditions.push(eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId));
      }
      const results = await db
        .delete(schema.portfolioValueDaily)
        .where(and(...conditions))
        .returning({ userId: schema.portfolioValueDaily.userId });
      return results.length;
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, error: error instanceof Error ? error.message : error },
        'Failed to delete portfolio_value_daily for user'
      );
      throw error;
    }
  }
}
