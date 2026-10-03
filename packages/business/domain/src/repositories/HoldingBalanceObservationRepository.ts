import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingBalanceObservation, NewHoldingBalanceObservation } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

export type BalanceReading = Pick<
  HoldingBalanceObservation,
  'observedAt' | 'balance' | 'gapReview'
>;

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
  /** `token_types.code` — `fiat`, `crypto`, `stock`, … The card needs it to
   *  know whether this balance is an amount of money or a count of things
   *  (SC-576); `balanceDecimals` owns the rule. */
  tokenTypeCode: string;
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
  token_type_code: string;
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

/**
 * Where a row sits for gap purposes. A balance edit may date its money to an
 * earlier day (SC-607), but the balance it changed is the one observed at the
 * edit, so it explains that interval and not the one its date falls in.
 * Bucketing it by `occurred_at` left the edited interval unexplained, and
 * answering that gap wrote a second copy of the edit (SC-1474).
 */
const LEDGER_INSTANT = sql.raw(
  `(CASE WHEN tx.source = 'user-balance-edit' AND tx.source_metadata ? 'editedAt'
     THEN GREATEST(tx.occurred_at, (tx.source_metadata->>'editedAt')::timestamptz)
     ELSE tx.occurred_at END)`
);

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

  /**
   * The live person values with role `snapshot` at exactly `at`, locked: a
   * value recorded at the same instant replaces them (A1 carry-forward 2).
   *
   * This and the two methods after it are scoped by `userId` in the WHERE, as
   * `lockForGapAnswer` below is: superseding a row removes an anchor, and a
   * caller must not be able to do that by holding somebody else's ids.
   */
  async findLivePersonSnapshotsAt(
    userId: string,
    holdingId: string,
    at: Date,
    transaction: DatabaseTransaction
  ): Promise<Array<Pick<HoldingBalanceObservation, 'id' | 'cause'>>> {
    const obs = schema.holdingBalanceObservations;
    return await transaction
      .select({ id: obs.id, cause: obs.cause })
      .from(obs)
      .where(
        and(
          eq(obs.userId, userId),
          eq(obs.holdingId, holdingId),
          eq(obs.observedAt, at),
          isNull(obs.supersededAt),
          eq(obs.role, 'snapshot'),
          eq(obs.authority, 'person')
        )
      )
      .for('update');
  }

  /**
   * The latest live person value with role `snapshot` at or before `at`,
   * locked: the value a correction replaces. Rows at one instant are ranked as
   * the engine ranks them, the later `created_at` first and then the higher id.
   * `created_at` is the transaction's start, so two rows one transaction wrote
   * are told apart by id alone, not by which was written last.
   */
  async findLatestLiveSnapshotAtOrBefore(
    userId: string,
    holdingId: string,
    at: Date,
    transaction: DatabaseTransaction
  ): Promise<Pick<HoldingBalanceObservation, 'id' | 'observedAt'> | null> {
    const obs = schema.holdingBalanceObservations;
    const [row] = await transaction
      .select({ id: obs.id, observedAt: obs.observedAt })
      .from(obs)
      .where(
        and(
          eq(obs.userId, userId),
          eq(obs.holdingId, holdingId),
          lte(obs.observedAt, at),
          isNull(obs.supersededAt),
          eq(obs.role, 'snapshot'),
          eq(obs.authority, 'person')
        )
      )
      .orderBy(desc(obs.observedAt), desc(obs.createdAt), desc(obs.id))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** Marks values replaced, at the transaction's `now()`. A row already superseded keeps its time. */
  async supersede(
    userId: string,
    ids: readonly string[],
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (ids.length === 0) return;
    const obs = schema.holdingBalanceObservations;
    await transaction
      .update(obs)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(obs.userId, userId), inArray(obs.id, [...ids]), isNull(obs.supersededAt)));
  }

  /**
   * Re-labels person values as verifications once their holding is a feed one
   * (A2 D-6, A1 Rule P). Only a `snapshot` role moves, and only to
   * `verification`; the value, its instant and its cause stay as they are.
   */
  async markVerifications(
    userId: string,
    ids: readonly string[],
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (ids.length === 0) return;
    const obs = schema.holdingBalanceObservations;
    await transaction
      .update(obs)
      .set({ role: 'verification' })
      .where(and(eq(obs.userId, userId), inArray(obs.id, [...ids]), eq(obs.role, 'snapshot')));
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

  // Every observation BalanceAtTimeService can read for these instants, per
  // holding and time-ordered: the first one, and the nearest at-or-before and
  // at-or-after each instant, with any rows tied on a chosen timestamp. Its
  // scans answer the same over this as over the whole history, which the
  // rollup used to prefetch for every 30-day chunk: 112k rows on the portfolio
  // that took the worker's memory to zero (SC-1283).
  async findAnchorsForInstants(
    holdingIds: string[],
    instants: Date[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, HoldingBalanceObservation[]>> {
    const out = new Map<string, HoldingBalanceObservation[]>();
    if (holdingIds.length === 0) return out;
    for (const id of holdingIds) out.set(id, []);
    try {
      const database = this.getDb(transaction);
      const obs = schema.holdingBalanceObservations;
      const ids = sql`ARRAY[${sql.join(
        holdingIds.map((id) => sql`${id}`),
        sql`, `
      )}]::uuid[]`;
      const ats =
        instants.length === 0
          ? sql`ARRAY[]::timestamptz[]`
          : sql`ARRAY[${sql.join(
              instants.map((at) => sql`${at.toISOString()}`),
              sql`, `
            )}]::timestamptz[]`;
      // Each lateral returns the chosen rows themselves, ties included (WITH
      // TIES), so nothing is looked up a second time. Re-finding them through
      // `(holding_id, observed_at) IN (...)` cost 578 ms and 22k buffers for
      // 60 holdings x 31 instants in production (SC-1516).
      const raw = await database.execute(sql`
        WITH h AS (SELECT unnest(${ids}) AS id), d AS (SELECT unnest(${ats}) AS at),
        picked AS (
          SELECT f.* FROM h CROSS JOIN LATERAL (
            SELECT o.* FROM holding_balance_observations o
            WHERE o.holding_id = h.id
            ORDER BY o.observed_at ASC FETCH FIRST 1 ROWS WITH TIES) f
          UNION ALL
          SELECT a.* FROM h CROSS JOIN d CROSS JOIN LATERAL (
            SELECT o.* FROM holding_balance_observations o
            WHERE o.holding_id = h.id AND o.observed_at >= d.at
            ORDER BY o.observed_at ASC FETCH FIRST 1 ROWS WITH TIES) a
          UNION ALL
          SELECT b.* FROM h CROSS JOIN d CROSS JOIN LATERAL (
            SELECT o.* FROM holding_balance_observations o
            WHERE o.holding_id = h.id AND o.observed_at <= d.at
            ORDER BY o.observed_at DESC FETCH FIRST 1 ROWS WITH TIES) b
        )
        SELECT DISTINCT ON (observed_at, id) * FROM picked ORDER BY observed_at, id`);
      const columns = Object.entries(getTableColumns(obs));
      for (const r of raw as unknown as Record<string, unknown>[]) {
        const row = Object.fromEntries(
          columns.map(([key, column]) => {
            const value = r[column.name];
            return [
              key,
              value === null || value === undefined ? null : column.mapFromDriverValue(value),
            ];
          })
        ) as HoldingBalanceObservation;
        out.get(row.holdingId)?.push(row);
      }
      return out;
    } catch (error) {
      this.logger.error(
        {
          count: holdingIds.length,
          instants: instants.length,
          error: error instanceof Error ? error.message : error,
        },
        'Failed anchor-fetch observations for holdings'
      );
      throw error;
    }
  }

  /**
   * Every reading for any of `holdingIds`, oldest first, grouped by holding,
   * carrying only what a balance-change row is built from. Every reading, not
   * the rollup's anchors: a chunk that saw fewer readings saw different gaps
   * (SC-1470). Three columns, not the row, because this is the full history
   * SC-1283 stopped the rollup from holding.
   */
  async findReadingsForHoldings(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, BalanceReading[]>> {
    const out = new Map<string, BalanceReading[]>();
    if (holdingIds.length === 0) return out;
    try {
      const database = this.getDb(transaction);
      const t = schema.holdingBalanceObservations;
      const results = await database
        .select({
          holdingId: t.holdingId,
          observedAt: t.observedAt,
          balance: t.balance,
          gapReview: t.gapReview,
        })
        .from(t)
        .where(inArray(t.holdingId, holdingIds))
        .orderBy(asc(t.observedAt));
      for (const id of holdingIds) out.set(id, []);
      for (const { holdingId, ...reading } of results) out.get(holdingId)?.push(reading);
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
   * `includeExplained` also returns intervals the ledger already explains. Only
   * a projection wants those: the SC-1453 dry run asks which answers settlement
   * legs that are not written yet would make redundant, and until they are
   * written an answered interval drifts by nothing.
   */
  async findGapCandidatesForUser(
    userId: string,
    transaction?: DatabaseTransaction,
    options: { includeExplained?: boolean } = {}
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
            o.previous_observed_at,
            o.previous_balance
          FROM holding_balance_observations o
          WHERE o.user_id = ${userId}
            AND o.balance_moved
          UNION
          SELECT first_after.*
          FROM holding_transactions tx
          CROSS JOIN LATERAL (
            SELECT
              o.id,
              o.holding_id,
              o.observed_at,
              o.balance,
              o.source,
              o.gap_review,
              o.previous_observed_at,
              o.previous_balance
            FROM holding_balance_observations o
            WHERE o.holding_id = tx.holding_id
              AND o.observed_at >= ${LEDGER_INSTANT}
            ORDER BY o.observed_at, o.id
            LIMIT 1
          ) AS first_after
          WHERE tx.user_id = ${userId}
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
          token_types.code             AS token_type_code,
          accounts.name                AS account_name
        FROM paired
        JOIN holdings ON holdings.id = paired.holding_id
        JOIN tokens   ON tokens.id   = holdings.token_id
        JOIN token_types ON token_types.id = tokens.type_id
        LEFT JOIN accounts ON accounts.id = holdings.account_id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(tx.quantity::numeric), 0) AS explained,
            COUNT(*)                               AS tx_count
          FROM holding_transactions tx
          WHERE tx.holding_id  = paired.holding_id
            AND ${LEDGER_INSTANT} >  paired.previous_observed_at
            AND ${LEDGER_INSTANT} <= paired.observed_at
        ) AS bridge ON TRUE
        WHERE paired.previous_observed_at IS NOT NULL
          AND paired.observed_at > paired.previous_observed_at
          ${options.includeExplained ? sql`` : sql`AND (paired.balance::numeric - paired.previous_balance::numeric - bridge.explained) <> 0`}
        ORDER BY paired.holding_id, paired.observed_at
      `);

      return (rows as unknown as RawGapCandidate[]).map((row) => ({
        observationId: row.observation_id,
        holdingId: row.holding_id,
        tokenId: row.token_id,
        tokenSymbol: row.token_symbol,
        tokenTypeCode: row.token_type_code,
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
  async lockForGapAnswer(observationId: string, userId: string, transaction: DatabaseTransaction) {
    const [row] = await transaction
      .select()
      .from(schema.holdingBalanceObservations)
      .where(
        and(
          eq(schema.holdingBalanceObservations.id, observationId),
          eq(schema.holdingBalanceObservations.userId, userId)
        )
      )
      .for('update');
    return row ?? null;
  }

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

  /** The lowest balance the source ever reported for this holding (SC-1462). */
  async findLowestBalance(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<string | null> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          lowest: sql<
            string | null
          >`MIN(${schema.holdingBalanceObservations.balance}::numeric)::text`,
        })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
      return rows[0]?.lowest ?? null;
    } catch (error) {
      this.logger.error(
        { holdingId, error: error instanceof Error ? error.message : error },
        'Failed to find the lowest observed balance'
      );
      throw error;
    }
  }
}
