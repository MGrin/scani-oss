import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import type { LedgerKind } from '../engine/types';
import { ledgerOrderBy } from '../lib/ledger-order';
import { PERSON_AUTHORED_SOURCES } from '../lib/person-authored-sources';
import { isSettlementLeg } from '../lib/transactions/trade-settlement';
import { ruleDecidablePredicate } from '../lib/transfer-review-queue';
import {
  mapLegacyEntry,
  UNDERIVABLE_KIND_ORIGINS,
} from '../services/foundation/legacy-ledger-kinds';
import { LABEL_BATCH_SIZE, MAPPED_ENTRY_LABELS } from './entry-labels';
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

/**
 * Sources that are neither a person's typing nor an importer's observation,
 * and so are evidence of neither in `findPersonAuthoredOverlaps`.
 *
 * Each is Scani writing into the ledger on the user's behalf, so counting one
 * as "an importer also recorded here" would report a doubt Scani itself
 * manufactured. `apy-payout` is a scheduled synthesis, `transfer-review` is
 * the arrival the queue writes when an outflow is answered `internal`
 * (`TransferReviewService`), and `user-balance-correction` is a restatement
 * of a figure rather than a movement — it writes `kind = 'correction'`, which
 * describes the record and not the money.
 */
const NEITHER_PERSON_NOR_IMPORTER_SOURCES = [
  ...SYNTHESIZED_SOURCES,
  'apy-payout',
  'transfer-review',
  'user-balance-correction',
] as const;

/**
 * A row a person authored on a holding an IMPORTER also writes to — the
 * precondition for the whole of SC-858, and deliberately not a claim that
 * anything is duplicated.
 *
 * ## Why this reports a region and not a pair
 *
 * The obvious detector is a matcher: same holding, same sign, amount within
 * a tolerance, time within a window. It was built as a query and measured
 * against a restored copy of production before this was written, and it is
 * the wrong instrument for four reasons that are facts about the data rather
 * than tuning problems:
 *
 * 1. **The correspondence is not one-to-one.** A hand-entered deposit can be
 *    the imported deposit MINUS its imported fee, and a hand-entered
 *    withdrawal the sum of two imported ones — a person reconciles to the
 *    NET, an importer records the legs. A pairwise matcher cannot express
 *    that at all, and the near-equality it reads instead is an arithmetic
 *    coincidence rather than a detection of the relation.
 * 2. **Amounts are not identifiers.** A recurring payment puts the same
 *    amount on the same holding month after month, so widening the net far
 *    enough to reach a real pair hands one hand-entered row a whole column of
 *    equally good candidates and no basis to choose among them.
 * 3. **There is no tight net to fall back on.** At zero tolerance and zero
 *    window the matcher finds NOTHING — not even pairs a human had already
 *    identified as exact duplicates, because a person types a DATE and an
 *    importer records an INSTANT.
 * 4. **Widening reaches the tax rows first.** The candidate carrying
 *    `transfer_review = 'left_control'` — the answer `isConfirmedDisposal`
 *    books as a real disposal — rested on the WEAKEST evidence of any pair
 *    found. A matcher that reaches it is a matcher that rewrites realized PnL
 *    on the thinnest thing it saw.
 *
 * So the machine's job stops at naming where two record-keepers both wrote,
 * which needs no tolerance and cannot be wrong about money. What the overlap
 * MEANS is a question for the person who typed the row. The measurements
 * behind each of the four are on SC-858; they are one portfolio's real
 * movements, so they stay on the board rather than travelling in a comment.
 *
 * ## The answer already on the row is part of the finding
 *
 * `transferReview` travels with each overlap because retiring an answered row
 * is never a neutral edit: `left_control` has booked a disposal,
 * `internal` has already written an arrival on ANOTHER holding, and `split`
 * has done both in portions. A reader deciding what to do needs to see what
 * the row has already caused.
 */
export interface PersonAuthoredOverlap {
  transactionId: string;
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: Date;
  source: string;
  /** The answer this row already carries, and therefore what retiring it undoes. */
  transferReview: string | null;
  transferReviewSource: string | null;
  /** Distinct importer sources writing to the same holding. Never empty. */
  importerSources: string[];
  /** How many rows those importers have put on this holding. */
  importedRowCount: number;
}

export interface BulkUpsertResult {
  /** As the upsert returned them: their label columns predate the re-label. */
  rows: HoldingTransaction[];
  /** Empty unless the batch carried the same dedup key twice. */
  merges: BulkUpsertMerge[];
  /**
   * The oldest date this batch actually moved in the ledger: a row inserted,
   * or one whose valuation fields changed (the earlier of its old and new
   * date). Null when every row was already stored as sent. A nightly sync
   * re-sends months of unchanged rows, and history before the first real
   * change is not stale (SC-1459).
   */
  earliestChangedAt: Date | null;
  /**
   * Events written onto a copy with no input on the holding they were placed
   * on, because the input states them on another holding (R58), each as the
   * input's own row there. The event is then on two holdings until A5 decides
   * between them, and classification reads that row, not the copy (R59).
   */
  duplicatePlacements: string[];
}

const VALUATION_FIELDS = [
  // Only the input arbiter can change it: a re-resolved row moves (A2 D-7).
  'holdingId',
  'kind',
  'tokenId',
  'feeTokenId',
  'counterTokenId',
  'priceNativeTokenId',
  'counterPriceNativeTokenId',
] as const;
const VALUATION_AMOUNTS = [
  'quantity',
  'feeQuantity',
  'counterQuantity',
  'priceNative',
  'counterPriceNative',
] as const;

function sameAmount(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return new Decimal(String(a)).eq(new Decimal(String(b)));
}

/** Whether an upsert would move this row's value, or its date, in the ledger. */
function changesValuation(stored: Record<string, unknown>, sent: Record<string, unknown>): boolean {
  if (new Date(stored.occurredAt as Date).getTime() !== new Date(sent.occurredAt as Date).getTime())
    return true;
  for (const f of VALUATION_FIELDS) if ((stored[f] ?? null) !== (sent[f] ?? null)) return true;
  for (const f of VALUATION_AMOUNTS) if (!sameAmount(stored[f], sent[f])) return true;
  return false;
}

/**
 * The oldest date a batch moves in the ledger: each row with nothing stored
 * under its key, and both dates of one whose valuation it changes.
 */
function earliestChangeIn(
  rows: readonly NewHoldingTransaction[],
  stored: ReadonlyMap<string, HoldingTransaction>,
  keyOf: (row: NewHoldingTransaction) => string
): Date | null {
  let earliest: Date | null = null;
  const consider = (d: Date) => {
    if (!earliest || d < earliest) earliest = d;
  };
  for (const row of rows) {
    const sentAt = new Date(row.occurredAt);
    const prior = row.externalId ? stored.get(keyOf(row)) : undefined;
    if (!prior) {
      consider(sentAt);
      continue;
    }
    if (
      !changesValuation(
        prior as unknown as Record<string, unknown>,
        row as unknown as Record<string, unknown>
      )
    )
      continue;
    consider(sentAt);
    consider(new Date(prior.occurredAt));
  }
  return earliest;
}

/**
 * What a re-import overwrites on a row it already holds. Re-parsing after a
 * normalizer improvement should overwrite derived fields but preserve
 * ingest/created_at.
 */
const REIMPORTED = {
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
  // Derived by the ingester from the transaction itself, so the re-import is
  // authoritative — unlike `transfer_group_id` and `transfer_review`, which
  // belong to the matcher and to a person and are absent from this list on
  // purpose. Without it a re-import that recognises a swap for the first time
  // would update `kind` to `swap_out` and leave the row linked to nothing,
  // which is the shape SC-332 exists to remove (a swap leg that reads as
  // answered while its partner is unreachable).
  swapGroupId: sql`EXCLUDED.swap_group_id`,
  sourceMetadata: sql`${schema.holdingTransactions.sourceMetadata} || EXCLUDED.source_metadata`,
  rawPayload: sql`EXCLUDED.raw_payload`,
  counterparty: sql`EXCLUDED.counterparty`,
  description: sql`EXCLUDED.description`,
};

type Overwrites = Partial<Record<keyof NewHoldingTransaction, SQL>>;

/**
 * Whether a re-import moves any column of its SET. A replay of rows already
 * held as sent bumps no `updated_at` (A2 D-7), so a re-import that changed
 * nothing reads as one.
 */
function reimportChanges(set: Overwrites): SQL {
  const columns = Object.keys(set) as Array<keyof NewHoldingTransaction>;
  return sql`(${sql.join(
    columns.map((key) => schema.holdingTransactions[key]),
    sql`, `
  )}) IS DISTINCT FROM (${sql.join(
    columns.map((key) => set[key] as SQL),
    sql`, `
  )})`;
}

type KeyedRow = Pick<NewHoldingTransaction, 'holdingId' | 'source' | 'externalId' | 'inputId'>;

/**
 * Which row a written one is, and what a re-import of it overwrites.
 *
 * `holding-source` is `holding_tx_dedup`, the key every person and system
 * writer still upserts on. `input` is ingest's (A2 D-7): one input states an
 * event once, so a re-import that places it on another holding or token moves
 * the row there instead of writing a second. `source` stays out of its SET:
 * one input can state an event under two sources, a statement uploaded again
 * in another format, and the row keeps the one it was first written under.
 */
const ARBITERS = {
  'holding-source': {
    target: [
      schema.holdingTransactions.holdingId,
      schema.holdingTransactions.source,
      schema.holdingTransactions.externalId,
    ],
    set: REIMPORTED as Overwrites,
    keyOf: (row: KeyedRow) => JSON.stringify([row.holdingId, row.source, row.externalId]),
  },
  input: {
    target: [schema.holdingTransactions.inputId, schema.holdingTransactions.externalId],
    set: {
      ...REIMPORTED,
      holdingId: sql`EXCLUDED.holding_id`,
      tokenId: sql`EXCLUDED.token_id`,
    } as Overwrites,
    keyOf: (row: KeyedRow) => JSON.stringify([row.inputId ?? null, row.externalId]),
  },
};

type BulkUpsertArbiter = keyof typeof ARBITERS;

// postgres.js binds at most 65,534 parameters per statement, and an inserted
// ledger row can bind one per column (SC-1528).
const ROWS_PER_STATEMENT = Math.floor(
  65_534 / Object.keys(getTableColumns(schema.holdingTransactions)).length
);

type ArrivalKey = Pick<NewHoldingTransaction, 'holdingId' | 'source' | 'externalId' | 'inputId'>;

const heldKey = (row: ArrivalKey) =>
  JSON.stringify(['holding', row.holdingId, row.source, row.externalId]);
const statedKey = (row: ArrivalKey) => JSON.stringify(['input', row.inputId, row.externalId]);

function inStatements<T>(rows: readonly T[]): T[][] {
  const parts: T[][] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    parts.push(rows.slice(start, start + ROWS_PER_STATEMENT));
  }
  return parts;
}

// What `mapLegacyEntry` reads, and nothing more.
const LEGACY_ENTRY_FACTS = {
  id: schema.holdingTransactions.id,
  kind: schema.holdingTransactions.kind,
  source: schema.holdingTransactions.source,
  transferGroupId: schema.holdingTransactions.transferGroupId,
  swapGroupId: schema.holdingTransactions.swapGroupId,
  settlesTransactionId: schema.holdingTransactions.settlesTransactionId,
  priceNative: schema.holdingTransactions.priceNative,
  priceNativeTokenId: schema.holdingTransactions.priceNativeTokenId,
};

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

  /** The rows already stored under `rows`' keys: what an upsert of each overwrites. */
  private async storedUnderKeys(
    rows: readonly NewHoldingTransaction[],
    arbiter: BulkUpsertArbiter,
    database: DatabaseTransaction
  ): Promise<Map<string, HoldingTransaction>> {
    const t = schema.holdingTransactions;
    const distinct = <T>(values: T[]) => [...new Set(values)];
    const { keyOf } = ARBITERS[arbiter];
    const found = new Map<string, HoldingTransaction>();
    for (const keyed of inStatements(rows.filter((r) => r.externalId))) {
      const externalIds = inArray(t.externalId, distinct(keyed.map((r) => r.externalId)));
      const stored = await database
        .select()
        .from(t)
        .where(
          arbiter === 'input'
            ? and(inArray(t.inputId, distinct(keyed.map((r) => r.inputId as string))), externalIds)
            : and(
                inArray(t.holdingId, distinct(keyed.map((r) => r.holdingId))),
                inArray(t.source, distinct(keyed.map((r) => r.source))),
                externalIds
              )
        );
      for (const r of stored) found.set(keyOf(r), r);
    }
    return found;
  }

  /**
   * The `heldKey` and, under the input arbiter, the `statedKey` of every row
   * already stored under one of `rows`' keys.
   */
  private async keysAlreadyStored(
    rows: readonly NewHoldingTransaction[],
    arbiter: BulkUpsertArbiter,
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (const part of inStatements(rows)) {
      const onHolding = sql.join(
        part.map((r) => sql`(${r.holdingId}::uuid, ${r.source}::text, ${r.externalId}::text)`),
        sql`, `
      );
      const held = (await tx.execute(sql`
        SELECT t.holding_id, t.source, t.external_id
        FROM holding_transactions t
        JOIN (VALUES ${onHolding}) AS v (holding_id, source, external_id)
          ON t.holding_id = v.holding_id AND t.source = v.source AND t.external_id = v.external_id
      `)) as unknown as Array<{ holding_id: string; source: string; external_id: string }>;
      for (const r of held) {
        found.add(
          heldKey({ holdingId: r.holding_id, source: r.source, externalId: r.external_id })
        );
      }
      const withInput = part.filter((r) => r.inputId);
      if (arbiter !== 'input' || withInput.length === 0) continue;
      const onInput = sql.join(
        withInput.map((r) => sql`(${r.inputId}::uuid, ${r.externalId}::text)`),
        sql`, `
      );
      const stated = (await tx.execute(sql`
        SELECT t.input_id, t.external_id
        FROM holding_transactions t
        JOIN (VALUES ${onInput}) AS v (input_id, external_id)
          ON t.input_id = v.input_id AND t.external_id = v.external_id
      `)) as unknown as Array<{ input_id: string; external_id: string }>;
      for (const r of stated) {
        found.add(
          statedKey({ holdingId: '', source: '', inputId: r.input_id, externalId: r.external_id })
        );
      }
    }
    return found;
  }

  /**
   * The holdings among `rows`' that hold an answer an arrival could take over:
   * a person's gap balance edit or a transfer review's row. Most hold none, and
   * a row on one of those needs no search for its candidate.
   */
  private async holdingsWithAnswers(
    rows: readonly NewHoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const t = schema.holdingTransactions;
    const found = new Set<string>();
    for (const part of inStatements([...new Set(rows.map((row) => row.holdingId))])) {
      const holding = await tx
        .selectDistinct({ id: t.holdingId })
        .from(t)
        .where(
          and(
            inArray(t.holdingId, part),
            or(
              eq(t.source, 'transfer-review'),
              and(
                eq(t.source, 'user-balance-edit'),
                sql`${t.sourceMetadata}->>'gapObservationId' IS NOT NULL`
              )
            )
          )
        );
      for (const { id } of holding) found.add(id);
    }
    return found;
  }

  /**
   * Stamps the batch's input on the account's feed rows that carry none
   * (ruling R55): one written before inputs existed, or taken over by a writer
   * that stamped none. The input arbiter meets a re-sent event only on
   * (input, external_id), so without the stamp the re-send would insert beside
   * that row and `holding_tx_dedup` would refuse it.
   *
   * A row answers a batch row by (user, account, source, external_id). One
   * event takes one stamp, on its copy in the holding the batch writes into
   * when there is one, else on its oldest copy, which the upsert then moves;
   * and none where the input already states the event, since the key would
   * refuse a second. Only `input_id` is written: the upsert after it decides
   * whether the row changed, so `updated_at` and the labels move only if it did.
   */
  private async stampInputOnFeedRows(
    rows: readonly NewHoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<void> {
    for (const part of inStatements(rows)) {
      await this.stampInputPart(part, tx);
    }
  }

  private async stampInputPart(
    rows: readonly NewHoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<void> {
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${r.inputId}::uuid, ${r.userId}::uuid, ${r.holdingId}::uuid, ${r.source}::text, ${r.externalId}::text)`
      ),
      sql`, `
    );
    await tx.execute(sql`
      UPDATE holding_transactions t
      SET input_id = c.input_id
      FROM (
        SELECT DISTINCT ON (v.input_id, v.external_id) o.id, v.input_id
        FROM (VALUES ${values}) AS v (input_id, user_id, holding_id, source, external_id)
        JOIN holdings vh ON vh.id = v.holding_id
        JOIN holdings oh ON oh.account_id = vh.account_id
        JOIN holding_transactions o
          ON o.holding_id = oh.id AND o.source = v.source AND o.external_id = v.external_id
        WHERE o.input_id IS NULL
          AND o.user_id = v.user_id
          AND NOT EXISTS (
            SELECT 1 FROM holding_transactions x
            WHERE x.input_id = v.input_id AND x.external_id = v.external_id
          )
        ORDER BY v.input_id, v.external_id, (o.holding_id = v.holding_id) DESC, o.created_at, o.id
      ) c
      WHERE t.id = c.id
    `);
  }

  /**
   * The batch rows whose move `holding_tx_dedup` would refuse (ruling R58):
   * the input states the event on another holding, and the holding the batch
   * places it on holds a copy with no input. Each is returned with the
   * input's row and the source of that copy, which is the source the input's
   * row keeps and so the key the move collides on. Run after the stamp, which
   * settles which row is the input's.
   */
  private async placedOntoCopies(
    rows: readonly NewHoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<Map<NewHoldingTransaction, { source: string; inputRowId: string }>> {
    const placed = new Map<NewHoldingTransaction, { source: string; inputRowId: string }>();
    for (const part of inStatements(rows)) {
      for (const [row, copy] of await this.placedOntoCopiesIn(part, tx)) placed.set(row, copy);
    }
    return placed;
  }

  private async placedOntoCopiesIn(
    rows: readonly NewHoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<Map<NewHoldingTransaction, { source: string; inputRowId: string }>> {
    const values = sql.join(
      rows.map(
        (r, i) => sql`(${i}::int, ${r.inputId}::uuid, ${r.holdingId}::uuid, ${r.externalId}::text)`
      ),
      sql`, `
    );
    const found = (await tx.execute(sql`
      SELECT v.i, own.source, own.id
      FROM (VALUES ${values}) AS v (i, input_id, holding_id, external_id)
      JOIN holding_transactions own
        ON own.input_id = v.input_id AND own.external_id = v.external_id
      JOIN holding_transactions copied
        ON copied.holding_id = v.holding_id
        AND copied.source = own.source
        AND copied.external_id = v.external_id
      WHERE copied.input_id IS NULL
    `)) as unknown as Array<{ i: number; source: string; id: string }>;
    return new Map(found.map(({ i, source, id }) => [rows[i]!, { source, inputRowId: id }]));
  }

  /**
   * Writes `rows`, re-imports included, idempotently: a row the arbiter's key
   * already holds is overwritten with the re-import's derived fields, never
   * inserted twice (see `ARBITERS`). Every row needs a stable `external_id`;
   * a source without one must synthesize it, or each re-run duplicates.
   * Under the input arbiter every row carries its input.
   */
  async bulkUpsert(
    rows: NewHoldingTransaction[],
    transaction?: DatabaseTransaction,
    options: { arbiter?: BulkUpsertArbiter } = {}
  ): Promise<BulkUpsertResult> {
    const arbiterName = options.arbiter ?? 'holding-source';
    const arbiter = ARBITERS[arbiterName];
    try {
      if (rows.length === 0) {
        return { rows: [], merges: [], earliestChangedAt: null, duplicatePlacements: [] };
      }
      if (!transaction) {
        return this.getDb().transaction((tx) => this.bulkUpsert(rows, tx, options));
      }
      const database = transaction;
      if (arbiterName === 'input' && rows.some((row) => !row.inputId)) {
        throw new Error('bulkUpsert: the input arbiter needs every row to carry its input_id');
      }

      // Dedupe by the arbiter's conflict target before sending to Postgres.
      // ON CONFLICT DO UPDATE rejects a single statement with two rows that
      // share the conflict key ("cannot affect row a second time", SQLSTATE
      // 21000) — and EVM providers occasionally emit two events sharing the
      // same (hash, contract): a self-transfer where the wallet is both
      // sender and receiver, or a token-transfer plus a internal-tx shadow
      // row. The last occurrence wins, matching the upstream ordering
      // semantics that "later events overwrite earlier". Under the input
      // arbiter that includes one external id sent for two holdings, which
      // the key cannot hold twice.
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
        const key = arbiter.keyOf(row);
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

      // A batch can carry several users' rows, and a re-label is per user.
      const toRelabel = new Map<string, Set<string>>();
      const relabelLater = (userId: string, id: string) => {
        const ids = toRelabel.get(userId);
        if (ids) ids.add(id);
        else toRelabel.set(userId, new Set([id]));
      };

      // Serialize reconciliation with imports for these holdings. Only a unique exact
      // observation-backed explanation can stand in for an authoritative arrival.
      await database
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(
          inArray(schema.holdings.id, [...new Set(inputRows.map((row) => row.holdingId))].sort())
        )
        .orderBy(schema.holdings.id)
        .for('update');
      if (arbiterName === 'input') await this.stampInputOnFeedRows(inputRows, database);
      const arrivals = inputRows.filter(
        (row) =>
          row.externalId &&
          !row.source.startsWith('user-') &&
          row.source !== 'transfer-review' &&
          // A settlement leg is derived, not reported, so an equal amount is no
          // evidence it is the money a person's answer described. Retiring that
          // answer is the person's call, through the settlement review (SC-858,
          // SC-1453).
          !isSettlementLeg(row)
      );
      // Read once per statement rather than once per row: a 7,182-row history
      // spent most of its write here, two round trips a row (SC-1528). A
      // takeover below adds its row's keys, so each row still sees what the
      // rows before it wrote.
      const stored = await this.keysAlreadyStored(arrivals, arbiterName, database);
      const answered = await this.holdingsWithAnswers(arrivals, database);
      for (const row of arrivals) {
        // A row the upsert will update is no arrival to take over: one on
        // this holding's key, or, under the input arbiter, one its input
        // already states anywhere.
        if (
          stored.has(heldKey(row)) ||
          (arbiterName === 'input' && row.inputId && stored.has(statedKey(row)))
        ) {
          continue;
        }
        if (!answered.has(row.holdingId)) continue;
        const kinds = ['deposit', 'transfer_in'].includes(row.kind)
          ? ['deposit', 'transfer_in']
          : ['withdraw', 'transfer_out'].includes(row.kind)
            ? ['withdraw', 'transfer_out']
            : [row.kind];
        const candidates = await database
          .select()
          .from(schema.holdingTransactions)
          .where(
            and(
              eq(schema.holdingTransactions.holdingId, row.holdingId),
              eq(schema.holdingTransactions.userId, row.userId),
              inArray(schema.holdingTransactions.kind, kinds),
              sql`${schema.holdingTransactions.quantity}::numeric = ${row.quantity}::numeric`,
              sql`((${schema.holdingTransactions.source} = 'user-balance-edit' AND ${schema.holdingTransactions.sourceMetadata}->>'gapObservationId' IS NOT NULL AND ${new Date(row.occurredAt).toISOString()} > (${schema.holdingTransactions.sourceMetadata}->>'gapFrom')::timestamptz AND ${new Date(row.occurredAt).toISOString()} <= (${schema.holdingTransactions.sourceMetadata}->>'gapTo')::timestamptz)
            OR (${schema.holdingTransactions.source} = 'transfer-review' AND CASE WHEN ${schema.holdingTransactions.sourceMetadata}->>'arrivalFrom' IS NOT NULL THEN ${new Date(row.occurredAt).toISOString()} >= (${schema.holdingTransactions.sourceMetadata}->>'arrivalFrom')::timestamptz AND ${new Date(row.occurredAt).toISOString()} <= (${schema.holdingTransactions.sourceMetadata}->>'arrivalTo')::timestamptz ELSE ${schema.holdingTransactions.occurredAt} = ${new Date(row.occurredAt).toISOString()} END))`
            )
          )
          .for('update');
        if (candidates.length !== 1) continue;
        const candidate = candidates[0]!;
        // Only rows that could be this same arrival compete for it. Equal amounts at
        // other times are different money: three 1,000 USDT deposits on three days
        // each own their own answer (SC-1468).
        const competing = inputRows.filter(
          (other) =>
            other.holdingId === row.holdingId &&
            other.kind === row.kind &&
            other.quantity === row.quantity &&
            fallsInArrivalWindow(candidate, other.occurredAt)
        );
        if (competing.length !== 1) continue;
        // The row becomes the feed's, so it carries the feed's input (R54).
        const takenOver = await database
          .update(schema.holdingTransactions)
          .set({
            source: row.source,
            externalId: row.externalId,
            ...(row.inputId ? { inputId: row.inputId } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.holdingTransactions.id, candidate.id))
          .returning({ id: schema.holdingTransactions.id });
        for (const { id } of takenOver) relabelLater(row.userId, id);
        stored.add(heldKey(row));
        if (row.inputId) stored.add(statedKey(row));
      }

      // R58: where the input's row cannot move onto the holding the batch
      // places it on, the run writes what the (holding, source, external_id)
      // arbiter wrote, onto the copy already there, and leaves the input's row
      // where it is. Which of the two is the event is A5's figure decision.
      const ontoCopies =
        arbiterName === 'input'
          ? await this.placedOntoCopies(inputRows, database)
          : new Map<NewHoldingTransaction, { source: string; inputRowId: string }>();
      const writes = [
        { arbiter: arbiterName, rows: inputRows.filter((row) => !ontoCopies.has(row)) },
        {
          arbiter: 'holding-source' as const,
          rows: [...ontoCopies].map(([row, { source }]) => ({ ...row, source })),
        },
      ].filter((write) => write.rows.length > 0);

      let earliestChangedAt: Date | null = null;
      const storedRows: HoldingTransaction[] = [];
      for (const write of writes) {
        const stored = await this.storedUnderKeys(write.rows, write.arbiter, database);
        const earliest = earliestChangeIn(write.rows, stored, ARBITERS[write.arbiter].keyOf);
        if (earliest && (!earliestChangedAt || earliest < earliestChangedAt)) {
          earliestChangedAt = earliest;
        }
        storedRows.push(...stored.values());
      }

      const results: HoldingTransaction[] = [];
      // One transaction, the holdings already locked above: a batch too large
      // for one statement is written in parts, and lands or fails whole.
      for (const write of writes) {
        const { target, set } = ARBITERS[write.arbiter];
        for (const part of inStatements(write.rows)) {
          results.push(
            ...(await database
              .insert(schema.holdingTransactions)
              .values(part)
              .onConflictDoUpdate({
                target,
                set: {
                  ...set,
                  updatedAt: sql`CASE WHEN ${reimportChanges(set)} THEN now() ELSE ${schema.holdingTransactions.updatedAt} END`,
                },
              })
              .returning())
          );
        }
      }

      // A re-import can rewrite a row's kind or swap group, and a takeover its
      // source, so every row written here is re-labelled from what it now holds.
      for (const r of results) relabelLater(r.userId, r.id);
      for (const [userId, ids] of toRelabel) {
        await this.relabelEntries(userId, [...ids], database);
      }

      // `holding_coverage.first_tx_at` / `last_tx_at` summarize this
      // table, so they are re-derived here rather than reported by each
      // caller. Seven call sites write this ledger and six of them used
      // to write no coverage at all (SC-307); the seventh reported the
      // whole run's bounds to every holding it touched (SC-308). Doing
      // it at the write is what makes the summary unable to drift from
      // what it summarizes. A holding a row moved out of is one of them.
      await this.coverageRepository.syncTxBoundsFromLedger(
        [...inputRows, ...storedRows].map((r) => r.holdingId),
        transaction
      );

      this.logger.debug({ count: results.length }, 'Bulk upserted holding transactions');
      return {
        rows: results,
        merges,
        earliestChangedAt,
        duplicatePlacements: [...ontoCopies.values()].map((copy) => copy.inputRowId),
      };
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

  /**
   * Point each unlinked settlement row at the trade it was derived from
   * (SC-1453), wherever it was written: ingest links a leg to its batch's one
   * row of that external id (`linkLegs`), and this sweep takes the rest. Scoped
   * to the settlement's own account, since an external id is only unique per
   * source within one account. Where two trades match, `UPDATE … FROM` links
   * whichever row Postgres reaches first.
   */
  async linkSettlements(userId: string, transaction?: DatabaseTransaction): Promise<number> {
    if (!transaction) return this.getDb().transaction((tx) => this.linkSettlements(userId, tx));
    const linked = (await transaction.execute(sql`
      UPDATE holding_transactions s
      SET settles_transaction_id = t.id
      FROM holding_transactions t, holdings th, holdings sh
      WHERE s.user_id = ${userId}
        AND s.kind IN ('settle_in', 'settle_out', 'fee')
        AND s.settles_transaction_id IS NULL
        AND s.source_metadata ? 'settles'
        AND sh.id = s.holding_id
        AND t.user_id = s.user_id
        AND t.source = s.source
        AND (t.kind IN ('buy', 'sell') OR (s.kind = 'fee' AND t.holding_id = s.holding_id))
        AND t.kind NOT IN ('settle_in', 'settle_out', 'fee')
        AND t.external_id = s.source_metadata->>'settles'
        AND th.id = t.holding_id
        AND th.account_id = sh.account_id
      RETURNING s.id
    `)) as unknown as Array<{ id: string }>;
    // The trade is a settle leg's group and a fee's `fee_of` (D-5).
    await this.relabelEntries(
      userId,
      linked.map((r) => r.id),
      transaction
    );
    return linked.length;
  }

  /**
   * Points each leg at the row it settles where it points at none yet, both
   * rows of one feed batch, then re-labels the legs it linked: a settle leg's
   * group and a fee's `fee_of` are that row (D-5). A leg's row is always in its
   * batch, since `validateBatch` refuses one that is not. A leg two of the
   * batch's rows answer to is not passed here: it stays unlinked unless a
   * caller runs `linkSettlements`, which reads `source_metadata.settles`.
   */
  async linkLegs(
    userId: string,
    links: ReadonlyArray<{ legId: string; parentId: string }>,
    tx: DatabaseTransaction
  ): Promise<number> {
    if (links.length === 0) return 0;
    const values = sql.join(
      links.map(({ legId, parentId }) => sql`(${legId}::uuid, ${parentId}::uuid)`),
      sql`, `
    );
    const linked = (await tx.execute(sql`
      UPDATE holding_transactions s
      SET settles_transaction_id = v.parent_id
      FROM (VALUES ${values}) AS v (leg_id, parent_id)
      WHERE s.id = v.leg_id
        AND s.user_id = ${userId}
        AND s.settles_transaction_id IS NULL
      RETURNING s.id
    `)) as unknown as Array<{ id: string }>;
    await this.relabelEntries(
      userId,
      linked.map((r) => r.id),
      tx
    );
    return linked.length;
  }

  /**
   * Takes every one of `userId`'s rows out of transfer group `groupId` and
   * re-labels them, since D-5 maps an unpaired leg differently from a paired
   * one.
   */
  async releaseTransferGroup(
    userId: string,
    groupId: string,
    tx: DatabaseTransaction
  ): Promise<void> {
    const t = schema.holdingTransactions;
    const released = await tx
      .update(t)
      .set({ transferGroupId: null, updatedAt: sql`now()` })
      .where(and(eq(t.userId, userId), eq(t.transferGroupId, groupId)))
      .returning({ id: t.id });
    await this.relabelEntries(
      userId,
      released.map((r) => r.id),
      tx
    );
  }

  /**
   * The user's ledger rows, each locked until the transaction ends. NO KEY
   * UPDATE is the lock a label's UPDATE takes: it is how a caller that did not
   * write the rows holds them for `relabelEntries`.
   *
   * They are taken in ascending id order, which keeps two callers of this
   * method from deadlocking on each other and does nothing more: no other
   * ledger writer takes its rows in id order, so one that takes two of these
   * rows in another order can still deadlock with this, and Postgres aborts
   * one of the two.
   */
  async lockInIdOrder(
    userId: string,
    rowIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<void> {
    const t = schema.holdingTransactions;
    const ids = [...new Set(rowIds)].sort();
    for (let start = 0; start < ids.length; start += LABEL_BATCH_SIZE) {
      await tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, userId), inArray(t.id, ids.slice(start, start + LABEL_BATCH_SIZE))))
        .orderBy(asc(t.id))
        .for('no key update');
    }
  }

  /**
   * Overwrites every label with `mapLegacyEntry` of the row as stored, so a
   * label follows its row when a re-import or a linker changes the facts it
   * was mapped from (A2 D-5). An excluded row has every label cleared.
   *
   * A row with a `decision_id`, or labelled by a rule, a mirror leg or Jev, is
   * left alone: today's legacy facts cannot re-derive that label. Only
   * `userId`'s rows are written, whatever ids are passed, and `input_id` never
   * is. Returns the rows whose labels changed.
   *
   * The facts are read without a lock, so the caller must already hold every
   * row it passes, by having written it in `tx` or through `lockInIdOrder`;
   * otherwise a write committed between the read and this UPDATE is labelled
   * from the facts it replaced.
   */
  async relabelEntries(
    userId: string,
    rowIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<number> {
    const t = schema.holdingTransactions;
    const relabellable = and(
      eq(t.userId, userId),
      isNull(t.decisionId),
      or(isNull(t.kindOrigin), notInArray(t.kindOrigin, [...UNDERIVABLE_KIND_ORIGINS]))
    );
    const name = (c: PgColumn) => sql.identifier(c.name);
    const columns = MAPPED_ENTRY_LABELS.map((c) => c.column);
    const set = sql.join(
      columns.map((c) => sql`${name(c)} = v.${name(c)}`),
      sql`, `
    );
    const changes = sql`(${sql.join(columns, sql`, `)}) IS DISTINCT FROM (${sql.join(
      columns.map((c) => sql`v.${name(c)}`),
      sql`, `
    )})`;
    const valueNames = sql.join([sql`id`, ...columns.map(name)], sql`, `);

    const ids = [...new Set(rowIds)];
    let changed = 0;
    for (let start = 0; start < ids.length; start += LABEL_BATCH_SIZE) {
      const rows = await tx
        .select(LEGACY_ENTRY_FACTS)
        .from(t)
        .where(and(inArray(t.id, ids.slice(start, start + LABEL_BATCH_SIZE)), relabellable));
      if (rows.length === 0) continue;
      const values = rows.map((row) => {
        const mapping = mapLegacyEntry(row);
        const cells = MAPPED_ENTRY_LABELS.map(
          ({ key, column }) =>
            sql`${mapping.excluded === null ? mapping[key] : null}::${sql.raw(column.getSQLType())}`
        );
        return sql`(${sql.join([sql`${row.id}::uuid`, ...cells], sql`, `)})`;
      });
      // The guard is re-asserted here, so a decision committed since the read still wins.
      const updated = (await tx.execute(sql`
        UPDATE ${t} SET ${set}
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v (${valueNames})
        WHERE ${t.id} = v.id AND ${relabellable} AND ${changes}
        RETURNING ${t.id}
      `)) as unknown as unknown[];
      changed += updated.length;
    }
    return changed;
  }

  /**
   * Of `rowIds`, the user's rows classification may still decide (A2 D-10):
   * `ruleDecidablePredicate` (unpaired, unanswered, non-zero, not taken back
   * from a rule), with a ledger kind that names no destination, and no
   * decision and no rule, mirror or Jev label on them already. Only a row
   * that carries an input: a copy with none (R58) is never decided, so it can
   * neither get a mirror leg nor re-point the input row's (R59).
   */
  async findUnclassified(
    userId: string,
    rowIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<HoldingTransaction[]> {
    const t = schema.holdingTransactions;
    const ids = [...new Set(rowIds)];
    const found: HoldingTransaction[] = [];
    for (let start = 0; start < ids.length; start += LABEL_BATCH_SIZE) {
      const rows = await tx
        .select()
        .from(t)
        .where(
          and(
            inArray(t.id, ids.slice(start, start + LABEL_BATCH_SIZE)),
            isNotNull(t.inputId),
            ruleDecidablePredicate(userId),
            isNull(t.decisionId),
            or(isNull(t.kindOrigin), notInArray(t.kindOrigin, [...UNDERIVABLE_KIND_ORIGINS])),
            inArray(t.ledgerKind, ['outflow', 'inflow', 'transfer_in', 'transfer_out'])
          )
        )
        .orderBy(asc(t.occurredAt), asc(t.id));
      found.push(...rows);
    }
    return found;
  }

  /**
   * A rule's ledger kind on one row, with `kind_origin 'rule'`, which
   * `relabelEntries` then leaves (D-10). A label only: no legacy fact moves,
   * so neither does `updated_at`.
   */
  async labelByRule(
    userId: string,
    rowId: string,
    ledgerKind: LedgerKind,
    tx: DatabaseTransaction
  ): Promise<void> {
    const t = schema.holdingTransactions;
    await tx
      .update(t)
      .set({ ledgerKind, kindOrigin: 'rule' })
      .where(and(eq(t.id, rowId), eq(t.userId, userId), isNull(t.decisionId)));
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

  /**
   * Every user with a base currency whose ledger carries a trade fee — the
   * users whose stored history SC-1142's fee treatment moves.
   *
   * A superset on purpose. The walk treats a fee as absent when it is blank or
   * reads as zero; this leaves out only literal zeros (`0`, `-0.00`), so a fee
   * the walk cannot read — free text, `0e3` — is still selected. Selecting a
   * user whose figures do not move costs one idempotent recompute; missing one
   * whose figures DO move leaves their stored history wrong with nothing to
   * say so. No base currency means the rollup skips the user anyway.
   */
  async findUserIdsWithTradeFees(
    opts: { userId?: string } = {},
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const ht = schema.holdingTransactions;
      const conditions = [
        isNotNull(ht.feeQuantity),
        sql`${ht.feeQuantity} !~ '^\\s*[-+]?0*\\.?0*\\s*$'`,
        isNotNull(schema.users.baseCurrencyId),
      ];
      if (opts.userId) conditions.push(eq(ht.userId, opts.userId));
      const rows = await database
        .selectDistinct({ userId: ht.userId })
        .from(ht)
        .innerJoin(schema.users, eq(schema.users.id, ht.userId))
        .where(and(...conditions))
        .orderBy(asc(ht.userId));
      return rows.map((r) => r.userId);
    } catch (error) {
      this.logger.error(
        { opts, error: error instanceof Error ? error.message : error },
        'Failed to find users with trade fees'
      );
      throw error;
    }
  }

  /**
   * Every user with a base currency whose ledger carries a `fee` row the
   * cost-basis walk takes out of the pool (SC-1561, `feeLeavingPool`): a
   * negative fee that settles nothing, or settles a trade on its own holding.
   * A fee settling a trade on another holding is that trade's and moved
   * nothing, so it does not select.
   */
  async findUserIdsWithPoolLeavingFees(
    opts: { userId?: string } = {},
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const ht = schema.holdingTransactions;
      const settled = alias(schema.holdingTransactions, 'settled');
      const conditions = [
        eq(ht.kind, 'fee'),
        sql`${ht.quantity} ~ '^\\s*-'`,
        sql`${ht.quantity} !~ '^\\s*-0*\\.?0*\\s*$'`,
        isNotNull(schema.users.baseCurrencyId),
        or(isNull(ht.settlesTransactionId), eq(settled.holdingId, ht.holdingId)),
      ];
      if (opts.userId) conditions.push(eq(ht.userId, opts.userId));
      const rows = await database
        .selectDistinct({ userId: ht.userId })
        .from(ht)
        .innerJoin(schema.users, eq(schema.users.id, ht.userId))
        .leftJoin(settled, eq(settled.id, ht.settlesTransactionId))
        .where(and(...conditions))
        .orderBy(asc(ht.userId));
      return rows.map((r) => r.userId);
    } catch (error) {
      this.logger.error(
        { opts, error: error instanceof Error ? error.message : error },
        'Failed to find users with pool-leaving fees'
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
   * worth running nightly. Production's Solana ledger spans years and has
   * zero rows inside the last 30 days, so a 30-day sync of it would have
   * restored exactly nothing (SC-360).
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

  /**
   * Every person-authored row sitting on a holding an importer also writes to
   * (SC-858). Empty is the healthy answer, and a non-empty answer is a list of
   * QUESTIONS rather than a list of defects.
   *
   * The complement of `findCrossHoldingDuplicates`, which is the other half of
   * what `holding_tx_dedup` cannot see. That constraint is
   * UNIQUE(holding_id, source, external_id), so it misses in two directions:
   * one source across two holdings, which the sibling above finds, and two
   * SOURCES on one holding, which is this. Neither can be closed by tightening
   * the constraint — a person's row and an importer's row carry different
   * sources by construction, which is exactly what `PERSON_AUTHORED_SOURCES`
   * is a fact about.
   *
   * Read-only, and it stays read-only. See `PersonAuthoredOverlap` for the
   * measurements that rule a matcher out.
   */
  async findPersonAuthoredOverlaps(
    transaction?: DatabaseTransaction
  ): Promise<PersonAuthoredOverlap[]> {
    try {
      const database = this.getDb(transaction);
      const importerRows = database
        .select({
          holdingId: schema.holdingTransactions.holdingId,
          sources: sql<string[]>`array_agg(distinct ${schema.holdingTransactions.source})`.as(
            'sources'
          ),
          rowCount: sql<number>`count(*)::int`.as('row_count'),
        })
        .from(schema.holdingTransactions)
        .where(
          notInArray(schema.holdingTransactions.source, [
            ...PERSON_AUTHORED_SOURCES,
            ...NEITHER_PERSON_NOR_IMPORTER_SOURCES,
          ])
        )
        .groupBy(schema.holdingTransactions.holdingId)
        .as('importer_rows');

      const rows = await database
        .select({
          transactionId: schema.holdingTransactions.id,
          holdingId: schema.holdingTransactions.holdingId,
          kind: schema.holdingTransactions.kind,
          quantity: schema.holdingTransactions.quantity,
          occurredAt: schema.holdingTransactions.occurredAt,
          source: schema.holdingTransactions.source,
          transferReview: schema.holdingTransactions.transferReview,
          transferReviewSource: schema.holdingTransactions.transferReviewSource,
          importerSources: importerRows.sources,
          importedRowCount: importerRows.rowCount,
        })
        .from(schema.holdingTransactions)
        .innerJoin(importerRows, eq(importerRows.holdingId, schema.holdingTransactions.holdingId))
        .where(inArray(schema.holdingTransactions.source, [...PERSON_AUTHORED_SOURCES]))
        .orderBy(asc(schema.holdingTransactions.occurredAt));

      return rows.map((r) => ({
        transactionId: r.transactionId,
        holdingId: r.holdingId,
        kind: r.kind,
        quantity: r.quantity,
        occurredAt: r.occurredAt,
        source: r.source,
        transferReview: r.transferReview,
        transferReviewSource: r.transferReviewSource,
        importerSources: r.importerSources,
        importedRowCount: r.importedRowCount,
      }));
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to find person-authored rows overlapping an importer'
      );
      throw error;
    }
  }
}

function fallsInArrivalWindow(
  candidate: { source: string; occurredAt: Date | string; sourceMetadata: unknown },
  occurredAt: Date | string
): boolean {
  const at = new Date(occurredAt).getTime();
  const meta = (candidate.sourceMetadata ?? {}) as Record<string, unknown>;
  if (candidate.source === 'user-balance-edit') {
    const from = new Date(String(meta.gapFrom)).getTime();
    const to = new Date(String(meta.gapTo)).getTime();
    return at > from && at <= to;
  }
  if (typeof meta.arrivalFrom === 'string' && typeof meta.arrivalTo === 'string') {
    return at >= new Date(meta.arrivalFrom).getTime() && at <= new Date(meta.arrivalTo).getTime();
  }
  return at === new Date(candidate.occurredAt).getTime();
}
