import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingBalanceObservation, NewHoldingBalanceObservation } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class HoldingBalanceObservationRepository extends BaseRepository<
  HoldingBalanceObservation,
  NewHoldingBalanceObservation
> {
  protected readonly table = schema.holdingBalanceObservations;
  protected readonly tableName = 'holding_balance_observations';

  // Append a new observation. Idempotent via the
  // (holding, observed_at, source) unique constraint — conflicts become
  // no-ops, which matches the append-only semantics we want (never
  // update an observation we already had).
  async append(
    row: NewHoldingBalanceObservation,
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .insert(schema.holdingBalanceObservations)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle insert type constraint
        .values(row as any)
        .onConflictDoNothing({
          target: [
            schema.holdingBalanceObservations.holdingId,
            schema.holdingBalanceObservations.observedAt,
            schema.holdingBalanceObservations.source,
          ],
        })
        .returning();
      return (results[0] as HoldingBalanceObservation) ?? null;
    } catch (error) {
      this.logger.error(
        { row, error: error instanceof Error ? error.message : error },
        'Failed to append balance observation'
      );
      throw error;
    }
  }

  async bulkAppend(
    rows: NewHoldingBalanceObservation[],
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation[]> {
    try {
      if (rows.length === 0) return [];
      const database = this.getDb(transaction);
      const results = await database
        .insert(schema.holdingBalanceObservations)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values(rows as any[])
        .onConflictDoNothing({
          target: [
            schema.holdingBalanceObservations.holdingId,
            schema.holdingBalanceObservations.observedAt,
            schema.holdingBalanceObservations.source,
          ],
        })
        .returning();
      return results as HoldingBalanceObservation[];
    } catch (error) {
      this.logger.error(
        { count: rows.length, error: error instanceof Error ? error.message : error },
        'Failed to bulk append balance observations'
      );
      throw error;
    }
  }

  // Nearest observation at or after `at` for a given holding. Preferred
  // anchor when computing balance at a past `at` — more trustworthy than
  // walking txs from "now" all the way back.
  async findLatestAtOrAfter(
    holdingId: string,
    at: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingBalanceObservations)
        .where(
          and(
            eq(schema.holdingBalanceObservations.holdingId, holdingId),
            gte(schema.holdingBalanceObservations.observedAt, at)
          )
        )
        .orderBy(asc(schema.holdingBalanceObservations.observedAt))
        .limit(1);
      return (results[0] as HoldingBalanceObservation) ?? null;
    } catch (error) {
      this.logger.error(
        { holdingId, at, error: error instanceof Error ? error.message : error },
        'Failed to find observation at or after'
      );
      throw error;
    }
  }

  async findLatestAtOrBefore(
    holdingId: string,
    at: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingBalanceObservations)
        .where(
          and(
            eq(schema.holdingBalanceObservations.holdingId, holdingId),
            lte(schema.holdingBalanceObservations.observedAt, at)
          )
        )
        .orderBy(desc(schema.holdingBalanceObservations.observedAt))
        .limit(1);
      return (results[0] as HoldingBalanceObservation) ?? null;
    } catch (error) {
      this.logger.error(
        { holdingId, at, error: error instanceof Error ? error.message : error },
        'Failed to find observation at or before'
      );
      throw error;
    }
  }

  async findForHoldingBetween(
    holdingId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingBalanceObservations)
        .where(
          and(
            eq(schema.holdingBalanceObservations.holdingId, holdingId),
            gte(schema.holdingBalanceObservations.observedAt, from),
            lte(schema.holdingBalanceObservations.observedAt, to)
          )
        )
        .orderBy(asc(schema.holdingBalanceObservations.observedAt));
      return results as HoldingBalanceObservation[];
    } catch (error) {
      this.logger.error(
        { holdingId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find observations in range'
      );
      throw error;
    }
  }

  async findExtremesForHolding(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ first: Date | null; last: Date | null }> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          first: sql<Date | null>`MIN(${schema.holdingBalanceObservations.observedAt})`,
          last: sql<Date | null>`MAX(${schema.holdingBalanceObservations.observedAt})`,
        })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
      return {
        first: rows[0]?.first ? new Date(rows[0].first) : null,
        last: rows[0]?.last ? new Date(rows[0].last) : null,
      };
    } catch (error) {
      this.logger.error(
        { holdingId, error: error instanceof Error ? error.message : error },
        'Failed to find observation extremes'
      );
      throw error;
    }
  }
}
