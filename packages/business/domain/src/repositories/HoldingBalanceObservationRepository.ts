import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingBalanceObservation, NewHoldingBalanceObservation } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * One consecutive observation pair, with everything needed to decide whether
 * to ask the owner about it (SC-501). Quantities stay decimal strings; the
 * arithmetic is `unexplainedDrift`'s, not this row's.
 */
export interface BalanceGapCandidate {
  /** The CLOSING observation — the pair's identity. */
  observationId: string;
  holdingId: string;
  tokenId: string;
  tokenSymbol: string;
  accountName: string | null;
  from: Date;
  to: Date;
  previousBalance: string;
  balance: string;
  /** Signed sum of the transactions in `(from, to]`. */
  explained: string;
  transactionsApplied: number;
  /** The closing observation's `source` — `sync-capture`, `manual`, … */
  source: string;
  /** This interval's existing answer, or null when never asked. */
  gapReview: string | null;
}

/** The shape `database.execute` hands back for the query above. */
interface RawGapCandidate {
  observation_id: string;
  holding_id: string;
  token_id: string;
  token_symbol: string;
  account_name: string | null;
  observed_at: string;
  previous_observed_at: string;
  balance: string;
  previous_balance: string;
  explained: string;
  tx_count: string | number;
  source: string;
  gap_review: string | null;
}

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

  // Bulk fetch — every observation for ANY of `holdingIds`, all times,
  // chronologically ordered, grouped by holdingId. Used by the rollup
  // pre-fetch so BalanceAtTimeService can do its anchor lookups
  // in-memory instead of one DB query per (holding, day, scope).
  async findForHoldingsAll(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, HoldingBalanceObservation[]>> {
    const out = new Map<string, HoldingBalanceObservation[]>();
    if (holdingIds.length === 0) return out;
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdingBalanceObservations)
        .where(inArray(schema.holdingBalanceObservations.holdingId, holdingIds))
        .orderBy(asc(schema.holdingBalanceObservations.observedAt));
      for (const id of holdingIds) out.set(id, []);
      for (const row of results as HoldingBalanceObservation[]) {
        const bucket = out.get(row.holdingId);
        if (bucket) bucket.push(row);
      }
      return out;
    } catch (error) {
      this.logger.error(
        { count: holdingIds.length, error: error instanceof Error ? error.message : error },
        'Failed bulk-fetch observations for holdings'
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

  /**
   * Every interval on this user's holdings whose balance change the ledger
   * does not fully explain (SC-501).
   *
   * One row per consecutive observation pair, carrying both balances, the
   * transactions found in `(previous, this]` and this observation's own
   * review state. The arithmetic that decides what is unexplained lives in
   * `unexplainedDrift`, in TypeScript, and is applied by `BalanceGapService`;
   * the `<> 0` here is a PRE-FILTER over the same numbers, not a second
   * definition — Postgres `numeric` and the project's 28-digit `Decimal` are
   * both exact decimal, so it can only ever agree with the authority.
   *
   * ## Answered rows are returned too, and that is not an oversight
   *
   * The reversal suppression asks whether the NEXT interval on the same
   * holding carries the exact opposite drift, and the next interval may
   * already have been answered. Filtering answered rows out here would make
   * a gap's suppression depend on whether its neighbour had been dealt with
   * yet, which is a queue whose contents change when you answer something
   * else. The caller filters; this returns the sequence.
   *
   * Ordered by `(holding_id, observed_at)` so the caller can read neighbours
   * without a second pass. That is also the order of the covering index the
   * SC-501 migration adds, so the window neither sorts nor touches the heap.
   */
  async findGapCandidatesForUser(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<BalanceGapCandidate[]> {
    try {
      const database = this.getDb(transaction);
      const rows = await database.execute(sql`
        WITH paired AS (
          SELECT
            o.id,
            o.holding_id,
            o.observed_at,
            o.balance,
            o.source,
            o.gap_review,
            LAG(o.observed_at) OVER w AS previous_observed_at,
            LAG(o.balance)     OVER w AS previous_balance
          FROM holding_balance_observations o
          WHERE o.user_id = ${userId}
          WINDOW w AS (PARTITION BY o.holding_id ORDER BY o.observed_at)
        )
        SELECT
          paired.id                    AS observation_id,
          paired.holding_id            AS holding_id,
          paired.observed_at           AS observed_at,
          paired.previous_observed_at  AS previous_observed_at,
          paired.balance               AS balance,
          paired.previous_balance      AS previous_balance,
          paired.source                AS source,
          paired.gap_review            AS gap_review,
          bridge.explained             AS explained,
          bridge.tx_count              AS tx_count,
          holdings.token_id            AS token_id,
          tokens.symbol                AS token_symbol,
          accounts.name                AS account_name
        FROM paired
        JOIN holdings ON holdings.id = paired.holding_id
        JOIN tokens   ON tokens.id   = holdings.token_id
        LEFT JOIN accounts ON accounts.id = holdings.account_id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(tx.quantity::numeric), 0) AS explained,
            COUNT(*)                               AS tx_count
          FROM holding_transactions tx
          WHERE tx.holding_id  = paired.holding_id
            AND tx.occurred_at >  paired.previous_observed_at
            AND tx.occurred_at <= paired.observed_at
        ) AS bridge ON TRUE
        WHERE paired.previous_observed_at IS NOT NULL
          AND paired.observed_at > paired.previous_observed_at
          AND (paired.balance::numeric - paired.previous_balance::numeric - bridge.explained) <> 0
        ORDER BY paired.holding_id, paired.observed_at
      `);

      return (rows as unknown as RawGapCandidate[]).map((row) => ({
        observationId: row.observation_id,
        holdingId: row.holding_id,
        tokenId: row.token_id,
        tokenSymbol: row.token_symbol,
        accountName: row.account_name,
        from: new Date(row.previous_observed_at),
        to: new Date(row.observed_at),
        previousBalance: String(row.previous_balance),
        balance: String(row.balance),
        explained: String(row.explained),
        transactionsApplied: Number(row.tx_count),
        source: row.source,
        gapReview: row.gap_review,
      }));
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : error },
        'Failed to find balance-gap candidates'
      );
      throw error;
    }
  }

  /**
   * Record (or clear) the owner's answer for the interval this observation
   * closes.
   *
   * Scoped by `userId` in the WHERE clause rather than checked beforehand:
   * one statement, and a caller cannot answer somebody else's gap by holding
   * its id. Returns the row when it wrote and `null` when nothing matched,
   * which is how the router tells "already gone" from "done".
   *
   * `answer: null` clears the review. Nothing calls it today; it exists
   * because the column must stay reopenable — an answer that can only be
   * given once is how a guess becomes permanent — and a repository that
   * cannot express the undo makes the next person add a second write path.
   */
  async setGapReview(
    args: {
      observationId: string;
      userId: string;
      answer: string | null;
      source: string | null;
      reviewedAt: Date | null;
    },
    transaction?: DatabaseTransaction
  ): Promise<HoldingBalanceObservation | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .update(schema.holdingBalanceObservations)
        .set({
          gapReview: args.answer,
          gapReviewedAt: args.reviewedAt,
          gapReviewSource: args.source,
        })
        .where(
          and(
            eq(schema.holdingBalanceObservations.id, args.observationId),
            eq(schema.holdingBalanceObservations.userId, args.userId)
          )
        )
        .returning();
      return (results[0] as HoldingBalanceObservation) ?? null;
    } catch (error) {
      this.logger.error(
        {
          observationId: args.observationId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to set balance-gap review'
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
