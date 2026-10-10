import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { TRANSFER_REVIEW_CREATED_SOURCE } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, getTableColumns, gt, inArray, lte, sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import {
  GAP_ANSWER_ROW_SOURCES,
  type GapAnswerReceipt,
  gapAnswerOutflowDecision,
  gapAnswerRowIds,
  readGapAnswerReceipt,
} from '../../lib/balances/gap-answer-receipt';
import { unexplainedDrift } from '../../lib/balances/unexplained-drift';
import { readCreatedDestination, readMovedDestinationAnchor } from '../../lib/created-destination';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { type CacheWrite, HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { FoundationClassificationService } from '../foundation/FoundationClassificationService';
import { BalanceGapService } from './BalanceGapService';

type Database = DatabaseTransaction | ReturnType<typeof getDb>;

/** One answer imported trade settlements now explain, in whole or in part. */
interface SettlementAnswer {
  observationId: string;
  answeredAt: string | null;
  from: string;
  to: string;
  /** Signed sum of the rows the answer wrote on this holding. */
  amount: string;
  explained: 'full' | 'partial';
  /** What the interval still leaves unexplained once the answer is gone. */
  remainder: string;
  /** Retiring it also removes an arrival or a disposal it booked. */
  movesAnotherHolding: boolean;
}

/** A settlement row not written yet, which a dry run counts as if it were. */
export interface PlannedSettlement {
  holdingId: string;
  occurredAt: Date;
  quantity: string;
}

export interface SettlementAnswerHolding {
  holdingId: string;
  tokenSymbol: string;
  tokenTypeCode: string;
  accountName: string | null;
  answers: SettlementAnswer[];
}

type SettlementRetireRefusal =
  | 'gone'
  | 'not-redundant'
  | 'moves-another-holding'
  | 'linked-elsewhere';

type SettlementUndoRefusal = 'gone' | 'already-restored' | 'answered-since' | 'holding-gone';

/** What became of the observation the retired answer was given on. */
type RestoredObservation = 'restamped' | 'rewritten' | 'gone';

const RETIRED_MARKER = 'retiredGapAnswerId';
const MOVING_DECISIONS = new Set(['internal', 'left_control']);

interface Assessed {
  item: SettlementAnswer;
  holdingId: string;
  tokenSymbol: string;
  tokenTypeCode: string;
  accountName: string | null;
}

interface RemovedHolding {
  holding: Record<string, unknown>;
  observations: Record<string, unknown>[];
  coverage: Record<string, unknown>[];
}

interface ObservationSnapshot {
  gapReview: string | null;
  gapReviewedAt: string | null;
  gapReviewSource: string | null;
  sourceMetadata: Record<string, unknown>;
}

/**
 * Answers that imported trade settlements have made redundant (SC-1453).
 *
 * Not a matcher (SC-858): nothing here decides that a settlement IS the money
 * an answer described. Every answer already carries the interval it was given
 * for, so the only question asked is arithmetic — with the answer's own rows
 * left out, does the interval still drift? The owner then retires or keeps it.
 *
 * Retiring removes the rows through `BalanceGapService.removeAnswerRows`, the
 * same path as undoing an answer, after writing a full copy to
 * `retired_gap_answers`. That table is the only record of what was removed, so
 * nothing here ever deletes from it.
 */
@Service()
export class SettlementAnswerReviewService {
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly gaps = Container.get(BalanceGapService);
  private readonly coverage = Container.get(HoldingCoverageRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly classification = Container.get(FoundationClassificationService);
  private readonly cache = Container.get(HoldingCacheWriter);

  async listPending(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<SettlementAnswerHolding[]> {
    return group(await this.assess(userId, transaction));
  }

  /**
   * What `listPending` would return once `planned` is written. The backfill's
   * dry run reads this so its projection is this service's arithmetic rather
   * than a copy of it.
   */
  async listPendingWith(
    userId: string,
    planned: readonly PlannedSettlement[],
    transaction?: DatabaseTransaction
  ): Promise<SettlementAnswerHolding[]> {
    return group(await this.assess(userId, transaction, undefined, planned));
  }

  /**
   * Take a redundant answer out of the ledger, keeping everything it removes.
   *
   * The assessment is repeated under the observation's row lock rather than
   * trusted from the page, because an import between the two can change it.
   * A `partial` answer's remainder is an ordinary balance gap again afterwards,
   * since the observation's answer is cleared exactly as `undo` clears it.
   *
   * `linked-elsewhere` refuses the one shape a copy of the rows could not put
   * back: a withdrawal whose transfer group reaches a row this removal would
   * leave standing, or an arrival that moved a destination's balance.
   */
  async retire(
    userId: string,
    observationId: string,
    opts: { confirmOtherHolding?: boolean } = {},
    transaction?: DatabaseTransaction
  ): Promise<
    | { retired: { id: string; explained: 'full' | 'partial'; remainder: string } }
    | { refusal: SettlementRetireRefusal }
  > {
    if (!transaction)
      return getDb().transaction((tx) => this.retire(userId, observationId, opts, tx));
    const observation = await this.observations.lockForGapAnswer(
      observationId,
      userId,
      transaction
    );
    if (!observation?.gapReview) return { refusal: 'gone' };
    const [assessed] = await this.assess(userId, transaction, observationId);
    if (!assessed) return { refusal: 'not-redundant' };
    if (assessed.item.movesAnotherHolding && !opts.confirmOtherHolding)
      return { refusal: 'moves-another-holding' };

    const receipt = (await answerReceipts(transaction, userId, [observation])).get(observationId);
    const answerRows = await transaction
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.id, gapAnswerRowIds(receipt)),
          inArray(schema.holdingTransactions.source, [...GAP_ANSWER_ROW_SOURCES])
        )
      );
    const arrivals = receipt?.transactionId
      ? await transaction
          .select()
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              eq(schema.holdingTransactions.source, TRANSFER_REVIEW_CREATED_SOURCE),
              eq(schema.holdingTransactions.externalId, receipt.transactionId)
            )
          )
      : [];
    const removed = [...answerRows, ...arrivals];
    const removedIds = new Set(removed.map((row) => row.id));
    const withdrawal = answerRows.find((row) => row.id === receipt?.transactionId);
    if (withdrawal?.transferGroupId) {
      const group = await transaction
        .select({ id: schema.holdingTransactions.id })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            eq(schema.holdingTransactions.transferGroupId, withdrawal.transferGroupId)
          )
        );
      if (group.some((row) => !removedIds.has(row.id))) return { refusal: 'linked-elsewhere' };
    }
    if (arrivals.some((row) => readMovedDestinationAnchor(row.sourceMetadata) === 'moved'))
      return { refusal: 'linked-elsewhere' };

    const rows = await snapshotRows(transaction, schema.holdingTransactions, [...removedIds]);
    const removedHoldings: RemovedHolding[] = [];
    for (const arrival of arrivals) {
      if (readCreatedDestination(arrival.sourceMetadata) !== 'created') continue;
      removedHoldings.push(await snapshotHolding(transaction, arrival.holdingId));
    }
    const answer = await snapshotObservation(transaction, observationId);
    const [retired] = await transaction
      .insert(schema.retiredGapAnswers)
      .values({
        userId,
        holdingId: assessed.holdingId,
        observationId,
        gapFrom: new Date(assessed.item.from),
        gapTo: new Date(assessed.item.to),
        answer,
        rows,
        removedHoldings,
        reason: 'settlements',
      })
      .returning({ id: schema.retiredGapAnswers.id });
    if (!retired) throw new Error('Retired answer was not recorded');

    await this.gaps.removeAnswerRows(userId, receipt, transaction);
    const { gapAnswer: _retired, ...rest } = answer.sourceMetadata;
    await transaction
      .update(schema.holdingBalanceObservations)
      .set({
        gapReview: null,
        gapReviewedAt: null,
        gapReviewSource: null,
        sourceMetadata: { ...rest, [RETIRED_MARKER]: retired.id },
      })
      .where(eq(schema.holdingBalanceObservations.id, observationId));
    return {
      retired: {
        id: retired.id,
        explained: assessed.item.explained,
        remainder: assessed.item.remainder,
      },
    };
  }

  /** The owner keeps the answer; it leaves this review for good. */
  async keep(
    userId: string,
    observationId: string,
    now: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    if (!transaction) return getDb().transaction((tx) => this.keep(userId, observationId, now, tx));
    const observation = await this.observations.lockForGapAnswer(
      observationId,
      userId,
      transaction
    );
    if (!observation?.gapReview) return false;
    const metadata = (observation.sourceMetadata ?? {}) as Record<string, unknown>;
    const receipt = (await answerReceipts(transaction, userId, [observation])).get(observationId);
    if (!receipt) return false;
    if (receipt.keptAfterSettlementsAt) return true;
    await transaction
      .update(schema.holdingBalanceObservations)
      .set({
        sourceMetadata: {
          ...metadata,
          gapAnswer: { ...receipt, keptAfterSettlementsAt: now.toISOString() },
        },
      })
      .where(eq(schema.holdingBalanceObservations.id, observationId));
    return true;
  }

  /**
   * Put a retired answer back: its rows with their original ids, any holding
   * its arrival had opened, and the answer on its observation.
   *
   * The rows come back even when the observation has been deleted, or its
   * metadata changed since (an answer given and undone on the remainder), and
   * the result says which. It refuses only where restoring would book the
   * interval twice — the remainder is answered right now — or where a row's
   * holding no longer exists to hold it.
   */
  async undoRetire(
    userId: string,
    retiredId: string,
    now: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<
    | { restored: { rows: number; observation: RestoredObservation } }
    | { refusal: SettlementUndoRefusal }
  > {
    if (!transaction)
      return getDb().transaction((tx) => this.undoRetire(userId, retiredId, now, tx));
    const [retired] = await transaction
      .select()
      .from(schema.retiredGapAnswers)
      .where(
        and(eq(schema.retiredGapAnswers.id, retiredId), eq(schema.retiredGapAnswers.userId, userId))
      )
      .for('update');
    if (!retired) return { refusal: 'gone' };
    if (retired.restoredAt) return { refusal: 'already-restored' };

    const observation = retired.observationId
      ? await this.observations.lockForGapAnswer(retired.observationId, userId, transaction)
      : null;
    if (observation?.gapReview) return { refusal: 'answered-since' };

    const rows = retired.rows as Record<string, unknown>[];
    const bundles = retired.removedHoldings as RemovedHolding[];
    const bundled = new Set(bundles.map((bundle) => String(bundle.holding.id)));
    const needed = [...new Set(rows.map((row) => String(row.holding_id)))].filter(
      (id) => !bundled.has(id)
    );
    if (needed.length) {
      const present = await transaction
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.userId, userId), inArray(schema.holdings.id, needed)));
      if (present.length !== needed.length) return { refusal: 'holding-gone' };
    }

    const unclassified: string[] = [];
    const funded: CacheWrite[] = [];
    for (const bundle of bundles) {
      const [exists] = await transaction
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, String(bundle.holding.id)));
      if (exists) continue;
      // The copy comes back unfunded and the calculator funds it once its
      // evidence is back, as the one writer of the cache (A5 D-4).
      await restoreRows(transaction, schema.holdings, [
        { ...bundle.holding, balance: '0', value_base: null, value_priced_at: null },
      ]);
      funded.push({
        holdingId: String(bundle.holding.id),
        balance: String(bundle.holding.balance),
        lastUpdated: null,
      });
      await restoreRows(transaction, schema.holdingBalanceObservations, bundle.observations);
      await restoreRows(transaction, schema.holdingCoverage, bundle.coverage);
      if (bundle.holding.kind == null || bundle.holding.starts_at == null) {
        unclassified.push(String(bundle.holding.id));
      }
    }
    await restoreRows(transaction, schema.holdingTransactions, rows);
    await this.coverage.syncTxBoundsFromLedger(needed, transaction);
    // A copy taken before A1 carries no label, and a row comes back as it was
    // copied. The ledger rows are labelled as any written row is (D-5), and a
    // holding that came back with no kind or start is classified as the
    // backfill would, once its rows are all in place for the classifier to read.
    await this.ledger.relabelEntries(
      userId,
      rows.map((row) => String(row.id)),
      transaction
    );
    await this.classification.labelHoldings(userId, unclassified, transaction);
    if (funded.length) await this.cache.apply(userId, funded, transaction);

    let outcome: RestoredObservation = 'gone';
    if (observation) {
      const answer = retired.answer as ObservationSnapshot;
      const current = (observation.sourceMetadata ?? {}) as Record<string, unknown>;
      const { [RETIRED_MARKER]: _marker, ...unmarked } = current;
      const { gapAnswer, ...before } = answer.sourceMetadata;
      outcome = JSON.stringify(unmarked) === JSON.stringify(before) ? 'restamped' : 'rewritten';
      await transaction
        .update(schema.holdingBalanceObservations)
        .set({
          gapReview: answer.gapReview,
          gapReviewedAt: answer.gapReviewedAt ? sql`${answer.gapReviewedAt}::timestamptz` : null,
          gapReviewSource: answer.gapReviewSource,
          sourceMetadata: { ...unmarked, gapAnswer },
        })
        .where(eq(schema.holdingBalanceObservations.id, observation.id));
    }
    await transaction
      .update(schema.retiredGapAnswers)
      .set({ restoredAt: now })
      .where(eq(schema.retiredGapAnswers.id, retired.id));
    return { restored: { rows: rows.length, observation: outcome } };
  }

  /**
   * Every answered interval on this user's holdings, judged without the
   * answer's own rows. Only intervals that still drift can be here: an answer
   * that settlements duplicate makes its interval drift by what they added.
   */
  private async assess(
    userId: string,
    transaction: DatabaseTransaction | undefined,
    onlyObservationId?: string,
    planned: readonly PlannedSettlement[] = []
  ): Promise<Assessed[]> {
    const database = transaction ?? getDb();
    const candidates = (
      await this.observations.findGapCandidatesForUser(userId, transaction, {
        includeExplained: planned.length > 0,
      })
    ).filter(
      (candidate) =>
        candidate.gapReview !== null &&
        (!onlyObservationId || candidate.observationId === onlyObservationId)
    );
    if (candidates.length === 0) return [];

    const observed = await database
      .select({
        id: schema.holdingBalanceObservations.id,
        holdingId: schema.holdingBalanceObservations.holdingId,
        observedAt: schema.holdingBalanceObservations.observedAt,
        sourceMetadata: schema.holdingBalanceObservations.sourceMetadata,
        gapReviewedAt: schema.holdingBalanceObservations.gapReviewedAt,
      })
      .from(schema.holdingBalanceObservations)
      .where(
        inArray(
          schema.holdingBalanceObservations.id,
          candidates.map((candidate) => candidate.observationId)
        )
      );
    const receipts = new Map<string, { receipt: GapAnswerReceipt; reviewedAt: Date | null }>();
    const found = await answerReceipts(database, userId, observed);
    for (const row of observed) {
      const receipt = found.get(row.id);
      if (receipt && !receipt.keptAfterSettlementsAt)
        receipts.set(row.id, { receipt, reviewedAt: row.gapReviewedAt });
    }

    const rowIds = [...receipts.values()].flatMap(({ receipt }) => gapAnswerRowIds(receipt));
    const answerRows = rowIds.length
      ? await database
          .select({
            id: schema.holdingTransactions.id,
            holdingId: schema.holdingTransactions.holdingId,
            quantity: schema.holdingTransactions.quantity,
            occurredAt: schema.holdingTransactions.occurredAt,
            transferReview: schema.holdingTransactions.transferReview,
          })
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.userId, userId),
              inArray(schema.holdingTransactions.id, rowIds),
              inArray(schema.holdingTransactions.source, [...GAP_ANSWER_ROW_SOURCES])
            )
          )
      : [];

    const out: Assessed[] = [];
    for (const candidate of candidates) {
      const answered = receipts.get(candidate.observationId);
      if (!answered) continue;
      const ids = new Set(gapAnswerRowIds(answered.receipt));
      const own = answerRows.filter(
        (row) =>
          ids.has(row.id) &&
          row.holdingId === candidate.holdingId &&
          row.occurredAt > candidate.from &&
          row.occurredAt <= candidate.to
      );
      if (own.length === 0) continue;
      const amount = own.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
      if (amount.isZero()) continue;
      const plannedIn = planned.filter(
        (leg) =>
          leg.holdingId === candidate.holdingId &&
          leg.occurredAt > candidate.from &&
          leg.occurredAt <= candidate.to
      );
      if (
        plannedIn.length === 0 &&
        !(await this.hasSettlementIn(database, candidate.holdingId, candidate.from, candidate.to))
      )
        continue;
      const added = plannedIn.reduce((sum, leg) => sum.add(leg.quantity), new Decimal(0));

      const withoutAnswer = unexplainedDrift(candidate.previousBalance, candidate.balance, [
        new Decimal(candidate.explained).add(added).sub(amount).toString(),
      ]);
      let explained: 'full' | 'partial';
      if (withoutAnswer.isZero()) explained = 'full';
      else if (withoutAnswer.abs().lt(amount.abs())) explained = 'partial';
      else continue;

      const withdrawal = own.find((row) => row.id === answered.receipt.transactionId);
      const decision = withdrawal?.transferReview ?? gapAnswerOutflowDecision(answered.receipt);
      out.push({
        holdingId: candidate.holdingId,
        tokenSymbol: candidate.tokenSymbol,
        tokenTypeCode: candidate.tokenTypeCode,
        accountName: candidate.accountName,
        item: {
          observationId: candidate.observationId,
          answeredAt: answered.receipt.answeredAt ?? answered.reviewedAt?.toISOString() ?? null,
          from: candidate.from.toISOString(),
          to: candidate.to.toISOString(),
          amount: amount.toString(),
          explained,
          remainder: withoutAnswer.toString(),
          movesAnotherHolding: decision !== null && MOVING_DECISIONS.has(decision),
        },
      });
    }
    return out;
  }

  private async hasSettlementIn(
    database: Database,
    holdingId: string,
    from: Date,
    to: Date
  ): Promise<boolean> {
    const [row] = await database
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.holdingId, holdingId),
          gt(schema.holdingTransactions.occurredAt, from),
          lte(schema.holdingTransactions.occurredAt, to),
          sql`${schema.holdingTransactions.sourceMetadata} ? 'settles'`
        )
      )
      .limit(1);
    return !!row;
  }
}

/** The external id a balance edit gave its row before answers kept a receipt. */
const legacyAnswerExternalId = (observedAt: Date) => `manual-edit:${observedAt.toISOString()}`;

/**
 * Each answered observation's receipt. An answer given through
 * `BalanceGapService.answer` carries one in `source_metadata.gapAnswer`; one
 * given as a balance edit before that existed carries none, and its row is
 * found by the external id the edit stamped from the observation's own time.
 * Production's answers are all of the second kind, so without this the review
 * never lists them.
 */
async function answerReceipts(
  database: Database,
  userId: string,
  observations: ReadonlyArray<{
    id: string;
    holdingId: string;
    observedAt: Date;
    sourceMetadata: unknown;
    gapReviewedAt: Date | null;
  }>
): Promise<Map<string, GapAnswerReceipt>> {
  const receipts = new Map<string, GapAnswerReceipt>();
  const legacy = observations.filter((observation) => {
    const receipt = readGapAnswerReceipt(observation.sourceMetadata);
    if (receipt) receipts.set(observation.id, receipt);
    return !receipt;
  });
  if (legacy.length === 0) return receipts;
  const rows = await database
    .select({
      id: schema.holdingTransactions.id,
      holdingId: schema.holdingTransactions.holdingId,
      externalId: schema.holdingTransactions.externalId,
    })
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.userId, userId),
        inArray(schema.holdingTransactions.source, [...GAP_ANSWER_ROW_SOURCES]),
        inArray(
          schema.holdingTransactions.externalId,
          legacy.map((observation) => legacyAnswerExternalId(observation.observedAt))
        )
      )
    );
  for (const observation of legacy) {
    const row = rows.find(
      (candidate) =>
        candidate.holdingId === observation.holdingId &&
        candidate.externalId === legacyAnswerExternalId(observation.observedAt)
    );
    if (row)
      receipts.set(observation.id, {
        transactionId: row.id,
        answeredAt: observation.gapReviewedAt?.toISOString(),
      });
  }
  return receipts;
}

function group(assessed: Assessed[]): SettlementAnswerHolding[] {
  const byHolding = new Map<string, SettlementAnswerHolding>();
  for (const one of assessed) {
    const holding = byHolding.get(one.holdingId) ?? {
      holdingId: one.holdingId,
      tokenSymbol: one.tokenSymbol,
      tokenTypeCode: one.tokenTypeCode,
      accountName: one.accountName,
      answers: [],
    };
    holding.answers.push(one.item);
    byHolding.set(one.holdingId, holding);
  }
  return [...byHolding.values()];
}

/** Every column of each row, as Postgres renders it, so a restore is exact. */
async function snapshotRows(
  transaction: DatabaseTransaction,
  table: typeof schema.holdingTransactions,
  ids: string[]
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const rows = await transaction
    .select({ row: sql<Record<string, unknown>>`to_jsonb(${table})` })
    .from(table)
    .where(inArray(table.id, ids));
  return rows.map(({ row }) => row);
}

async function snapshotHolding(
  transaction: DatabaseTransaction,
  holdingId: string
): Promise<RemovedHolding> {
  const [holding] = await transaction
    .select({ row: sql<Record<string, unknown>>`to_jsonb(${schema.holdings})` })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!holding) throw new Error(`Destination holding ${holdingId} is not there to keep`);
  const observations = await transaction
    .select({
      row: sql<Record<string, unknown>>`to_jsonb(${schema.holdingBalanceObservations})`,
    })
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
  const coverage = await transaction
    .select({ row: sql<Record<string, unknown>>`to_jsonb(${schema.holdingCoverage})` })
    .from(schema.holdingCoverage)
    .where(eq(schema.holdingCoverage.holdingId, holdingId));
  return {
    holding: holding.row,
    observations: observations.map(({ row }) => row),
    coverage: coverage.map(({ row }) => row),
  };
}

async function snapshotObservation(
  transaction: DatabaseTransaction,
  observationId: string
): Promise<ObservationSnapshot> {
  const table = schema.holdingBalanceObservations;
  const [row] = await transaction
    .select({
      snapshot: sql<ObservationSnapshot>`jsonb_build_object(
        'gapReview', ${table.gapReview},
        'gapReviewedAt', ${table.gapReviewedAt},
        'gapReviewSource', ${table.gapReviewSource},
        'sourceMetadata', ${table.sourceMetadata}
      )`,
    })
    .from(table)
    .where(eq(table.id, observationId));
  if (!row) throw new Error(`Observation ${observationId} disappeared under its lock`);
  return row.snapshot;
}

/**
 * Insert rows captured by `to_jsonb`, every stored column by name. A generated
 * column is skipped, since Postgres computes it again.
 */
async function restoreRows(
  transaction: DatabaseTransaction,
  table: PgTable,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const name = sql.identifier(getTableConfig(table).name);
  const columns = sql.join(
    Object.values(getTableColumns(table))
      .filter((column) => !column.generated)
      .map((column) => sql.identifier(column.name)),
    sql`, `
  );
  await transaction.execute(sql`
    INSERT INTO ${name} (${columns})
    SELECT ${columns} FROM jsonb_populate_recordset(NULL::${name}, ${JSON.stringify(rows)}::jsonb)
  `);
}
