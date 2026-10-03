import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Holding, NewHolding, Token, TokenPrice } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, exists, getTableName, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import { compareText } from '../engine/order';
import { PRICE_GRANULARITIES, type PriceGranularity, type PriceReading } from '../engine/types';
import { includedInTotalSql } from '../lib/holding-inclusion';
// Type-only, so nothing links the repository to the classifier at runtime.
import type {
  EvidenceInput,
  EvidenceObservation,
  EvidenceTransaction,
  EvidenceWindow,
  HoldingLabels,
  LegacyHoldingEvidence,
} from '../services/foundation/legacy-classification';
import { LEGACY_ANCHOR_KEY } from '../services/foundation/legacy-ledger-kinds';
import { LABEL_BATCH_SIZE, MAPPED_ENTRY_LABELS } from './entry-labels';
import { TokenPriceRepository } from './TokenPriceRepository';

/**
 * Rows per read of observations or ledger rows. A heavy holding's history is
 * read in pages because, read as one result, the driver's and the mapper's
 * transient copies of it cost several times the rows themselves.
 */
const EVIDENCE_PAGE_ROWS = 5_000;

type LabelValue = string | Date | undefined;

interface LabelColumn<L> {
  column: PgColumn;
  value: (label: L) => LabelValue;
}

type HoldingLabel = HoldingLabels['holding'] & { id: string };
type ObservationLabel = HoldingLabels['observations'][number];
type EntryLabel = HoldingLabels['entries'][number];

const HOLDING_LABEL_COLUMNS: readonly LabelColumn<HoldingLabel>[] = [
  { column: schema.holdings.kind, value: (l) => l.kind },
  { column: schema.holdings.startsAt, value: (l) => l.startsAt },
];

const OBSERVATION_LABEL_COLUMNS: readonly LabelColumn<ObservationLabel>[] = [
  { column: schema.holdingBalanceObservations.role, value: (l) => l.role },
  { column: schema.holdingBalanceObservations.authority, value: (l) => l.authority },
  { column: schema.holdingBalanceObservations.inputId, value: (l) => l.inputId },
  { column: schema.holdingBalanceObservations.cause, value: (l) => l.cause },
];

const obs = schema.holdingBalanceObservations;
const ledger = schema.holdingTransactions;

/** `source_metadata ->> key` when that value is a string, else NULL. */
function metadataText(key: 'origin' | 'source' | typeof LEGACY_ANCHOR_KEY): SQL<string | null> {
  const value = sql`${obs.sourceMetadata} -> ${sql.raw(`'${key}'`)}`;
  return sql<string | null>`CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${value} #>> '{}' END`;
}

// What `LegacyHoldingEvidence` names, and nothing more.
const HOLDING_EVIDENCE = {
  id: schema.holdings.id,
  accountId: schema.holdings.accountId,
  tokenId: schema.holdings.tokenId,
  source: schema.holdings.source,
  externalId: schema.holdings.externalId,
  kind: schema.holdings.kind,
  startsAt: schema.holdings.startsAt,
  balance: schema.holdings.balance,
  lastUpdated: schema.holdings.lastUpdated,
  createdAt: schema.holdings.createdAt,
};

const OBSERVATION_EVIDENCE = {
  id: obs.id,
  holdingId: obs.holdingId,
  balance: obs.balance,
  observedAt: obs.observedAt,
  source: obs.source,
  gapReview: obs.gapReview,
  role: obs.role,
  authority: obs.authority,
  inputId: obs.inputId,
  cause: obs.cause,
  supersededAt: obs.supersededAt,
  createdAt: obs.createdAt,
  metadataOrigin: metadataText('origin'),
  metadataSource: metadataText('source'),
  metadataLegacyAnchor: metadataText(LEGACY_ANCHOR_KEY),
};

const TRANSACTION_EVIDENCE = {
  id: ledger.id,
  holdingId: ledger.holdingId,
  kind: ledger.kind,
  quantity: ledger.quantity,
  occurredAt: ledger.occurredAt,
  externalId: ledger.externalId,
  source: ledger.source,
  transferGroupId: ledger.transferGroupId,
  swapGroupId: ledger.swapGroupId,
  settlesTransactionId: ledger.settlesTransactionId,
  priceNative: ledger.priceNative,
  priceNativeTokenId: ledger.priceNativeTokenId,
  ledgerKind: ledger.ledgerKind,
  kindSubtype: ledger.kindSubtype,
  groupId: ledger.groupId,
  feeOf: ledger.feeOf,
  inputId: ledger.inputId,
  executionPrice: ledger.executionPrice,
  executionPriceTokenId: ledger.executionPriceTokenId,
  kindOrigin: ledger.kindOrigin,
  decisionId: ledger.decisionId,
  createdAt: ledger.createdAt,
};

const ENTRY_LABEL_COLUMNS: readonly LabelColumn<EntryLabel>[] = [
  ...MAPPED_ENTRY_LABELS.map(({ key, column }) => ({ column, value: (l: EntryLabel) => l[key] })),
  { column: schema.holdingTransactions.inputId, value: (l) => l.inputId },
];

/**
 * What the engine and the legacy classifier read, and the one write the
 * classification backfill makes: labels into columns that are still NULL.
 */
@Service()
export class EngineEvidenceRepository extends BaseRepository<Holding, NewHolding> {
  protected readonly table = schema.holdings;
  protected readonly tableName = 'holdings';
  private readonly tokenPrices = Container.get(TokenPriceRepository);

  /**
   * Hidden and inactive holdings included: the engine derives every holding.
   * Only the columns `LegacyHoldingEvidence` names are read.
   */
  async findHoldingEvidence(
    scope: { userId: string; holdingIds?: readonly string[] },
    tx?: DatabaseTransaction
  ): Promise<LegacyHoldingEvidence[]> {
    if (scope.holdingIds?.length === 0) return [];
    const database = this.getDb(tx);
    const inScope = and(
      eq(schema.holdings.userId, scope.userId),
      scope.holdingIds ? inArray(schema.holdings.id, [...scope.holdingIds]) : undefined
    );
    const scopedHoldings = () =>
      database.select({ id: schema.holdings.id }).from(schema.holdings).where(inScope);
    const scopedAccounts = () =>
      database.select({ id: schema.holdings.accountId }).from(schema.holdings).where(inScope);
    const inputs = schema.feedInputs;
    const windows = schema.feedInputWindows;

    const [holdingRows, inputRows] = await Promise.all([
      database
        .select(HOLDING_EVIDENCE)
        .from(schema.holdings)
        .where(inScope)
        .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id)),
      database
        .select({
          input: { id: inputs.id, accountId: inputs.accountId, source: inputs.source },
          window: {
            id: windows.id,
            inputId: windows.inputId,
            fromAt: windows.fromAt,
            toAt: windows.toAt,
          },
        })
        .from(inputs)
        .leftJoin(windows, eq(windows.inputId, inputs.id))
        .where(and(eq(inputs.userId, scope.userId), inArray(inputs.accountId, scopedAccounts())))
        .orderBy(asc(inputs.accountId), asc(inputs.source), asc(windows.toAt), asc(windows.id)),
    ]);
    const intern = interner();
    const observationRows = await this.readInPages<EvidenceObservation>(
      obs,
      obs.observedAt,
      (after) =>
        database
          .select(OBSERVATION_EVIDENCE)
          .from(obs)
          .where(and(inArray(obs.holdingId, scopedHoldings()), after))
          .orderBy(asc(obs.observedAt), asc(obs.id))
          .limit(EVIDENCE_PAGE_ROWS),
      (row) => internObservation(row, intern),
      tx
    );
    const transactionRows = await this.readInPages<EvidenceTransaction>(
      ledger,
      ledger.occurredAt,
      (after) =>
        database
          .select(TRANSACTION_EVIDENCE)
          .from(ledger)
          .where(and(inArray(ledger.holdingId, scopedHoldings()), after))
          .orderBy(asc(ledger.occurredAt), asc(ledger.id))
          .limit(EVIDENCE_PAGE_ROWS),
      (row) => internTransaction(row, intern),
      tx
    );

    const observationsOf = groupBy(observationRows, (o) => o.holdingId);
    const transactionsOf = groupBy(transactionRows, (t) => t.holdingId);
    const inputsOf = new Map<string, EvidenceInput[]>();
    const windowsOf = new Map<string, EvidenceWindow[]>();
    for (const { input, window } of inputRows) {
      const accountInputs = inputsOf.get(input.accountId) ?? [];
      // One row per window, so an input repeats; its rows are adjacent.
      if (accountInputs.at(-1)?.id !== input.id) accountInputs.push(input);
      inputsOf.set(input.accountId, accountInputs);
      if (window === null) continue;
      const accountWindows = windowsOf.get(input.accountId) ?? [];
      accountWindows.push(window);
      windowsOf.set(input.accountId, accountWindows);
    }

    return holdingRows.map((holding) => ({
      holding,
      observations: observationsOf.get(holding.id) ?? [],
      transactions: transactionsOf.get(holding.id) ?? [],
      inputs: [...(inputsOf.get(holding.accountId) ?? [])],
      windows: [...(windowsOf.get(holding.accountId) ?? [])],
    }));
  }

  /**
   * Every row `read` gives, a page at a time, in (`at`, id) order. A page
   * starts after the exact key the previous one ended on, read back as text,
   * since a JS Date keeps milliseconds and the column keeps microseconds.
   * Inside a snapshot the pages are one consistent read; under READ COMMITTED
   * a boundary row deleted between two pages fails the read rather than
   * ending it early.
   */
  private async readInPages<T extends { id: string }>(
    table: PgTable & { id: PgColumn },
    at: PgColumn,
    read: (after: SQL | undefined) => Promise<T[]>,
    each: (row: T) => void,
    tx?: DatabaseTransaction
  ): Promise<T[]> {
    const rows: T[] = [];
    let after: SQL | undefined;
    for (;;) {
      const page = await read(after);
      for (const row of page) {
        each(row);
        rows.push(row);
      }
      const last = page.at(-1);
      if (page.length < EVIDENCE_PAGE_ROWS || last === undefined) return rows;
      const [boundary] = await this.getDb(tx)
        .select({ at: sql<string>`${at}::text` })
        .from(table)
        .where(eq(table.id, last.id));
      if (boundary === undefined) {
        throw new Error(
          `${getTableName(table)} row ${last.id} was deleted while its holding's evidence was read`
        );
      }
      after = sql`(${at}, ${table.id}) > (${boundary.at}::timestamptz, ${last.id}::uuid)`;
    }
  }

  /**
   * The user's holdings, hidden and inactive included, in `findHoldingEvidence`'s
   * order: what a caller reads that evidence for one holding at a time.
   */
  async findHoldingIds(userId: string, tx?: DatabaseTransaction): Promise<string[]> {
    const rows = await this.getDb(tx)
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, userId))
      .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));
    return rows.map((r) => r.id);
  }

  /** Per pair and granularity, the latest row at or before `at`. */
  async findPriceReadings(
    pairs: ReadonlyArray<{ tokenId: string; baseTokenId: string }>,
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<PriceReading[]> {
    // `since = at` keeps only rows AT `at`, plus each pair and granularity's
    // latest row before it; the newer of the two wins below.
    const rows = await this.tokenPrices.findManyForPairsUpTo(pairs, at, tx, at);
    const latest = new Map<string, PriceReading>();
    for (const reading of this.readingsOf(rows)) {
      const key = `${reading.tokenId}|${reading.baseTokenId}|${reading.granularity}`;
      const held = latest.get(key);
      if (held !== undefined && held.at >= reading.at) continue;
      latest.set(key, reading);
    }
    return [...latest.values()].sort(compareReadings);
  }

  /**
   * Per token and base, whatever the base, the latest row at or before `at`:
   * the rows the live resolver chooses a token's price among.
   */
  async findLatestReadingsInAnyBase(
    tokenIds: readonly string[],
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<PriceReading[]> {
    if (tokenIds.length === 0) return [];
    const prices = schema.tokenPrices;
    const rows = await this.getDb(tx)
      .selectDistinctOn([prices.tokenId, prices.baseTokenId])
      .from(prices)
      .where(and(inArray(prices.tokenId, [...tokenIds]), lte(prices.timestamp, at)))
      .orderBy(
        asc(prices.tokenId),
        asc(prices.baseTokenId),
        desc(prices.timestamp),
        asc(prices.id)
      );
    return this.readingsOf(rows);
  }

  /** `token_prices.granularity` is text: a value the engine does not rank is skipped and logged, never cast. */
  private readingsOf(rows: readonly TokenPrice[]): PriceReading[] {
    const readings: PriceReading[] = [];
    const unknown = new Set<string>();
    for (const row of rows) {
      if (!isPriceGranularity(row.granularity)) {
        unknown.add(row.granularity);
        continue;
      }
      readings.push({
        tokenId: row.tokenId,
        baseTokenId: row.baseTokenId,
        price: row.price,
        at: row.timestamp,
        granularity: row.granularity,
      });
    }
    if (unknown.size > 0) {
      this.logger.warn(
        { granularities: [...unknown] },
        'token_prices rows with a granularity the engine does not rank were not read'
      );
    }
    return readings;
  }

  /** The distinct tokens of the user's holdings that count in a portfolio total. */
  async findPricedAssets(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Array<{ token: Token; typeCode: string | null }>> {
    return this.getDb(tx)
      .selectDistinctOn([schema.tokens.id], {
        token: schema.tokens,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .leftJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
      .where(and(eq(schema.holdings.userId, userId), includedInTotalSql()))
      .orderBy(asc(schema.tokens.id));
  }

  /** Users with at least one holding. */
  async findUsersWithHoldings(
    tx?: DatabaseTransaction
  ): Promise<Array<{ userId: string; baseCurrencyId: string | null }>> {
    const database = this.getDb(tx);
    return database
      .select({ userId: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(
        exists(
          database
            .select({ one: sql`1` })
            .from(schema.holdings)
            .where(eq(schema.holdings.userId, schema.users.id))
        )
      )
      .orderBy(asc(schema.users.id));
  }

  /** When each of these ledger rows of the user was last written. */
  async findEntryUpdatedAt(
    userId: string,
    entryIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<Map<string, Date>> {
    const updatedAt = new Map<string, Date>();
    for (let start = 0; start < entryIds.length; start += LABEL_BATCH_SIZE) {
      const rows = await this.getDb(tx)
        .select({ id: ledger.id, updatedAt: ledger.updatedAt })
        .from(ledger)
        .where(
          and(
            eq(ledger.userId, userId),
            inArray(ledger.id, entryIds.slice(start, start + LABEL_BATCH_SIZE))
          )
        );
      for (const row of rows) updatedAt.set(row.id, row.updatedAt);
    }
    return updatedAt;
  }

  /**
   * Writes each label only where its column is NULL (D-4), and counts the rows
   * where some column went from NULL to a value. It names no other column, so
   * `balance`, `last_updated` and the observation chain are never written. Only
   * `userId`'s rows are written, whatever ids the labels carry.
   *
   * Holdings go last. Their row locks last until the caller commits, and an
   * hourly sync's balance write or a person's edit waits on them, so they are
   * taken after the long observation batches rather than before.
   */
  async fillMissingLabels(
    userId: string,
    labels: readonly HoldingLabels[],
    tx: DatabaseTransaction
  ): Promise<{ holdings: number; observations: number; entries: number }> {
    const observations = await this.fillNulls(
      userId,
      schema.holdingBalanceObservations,
      OBSERVATION_LABEL_COLUMNS,
      labels.flatMap((l) => l.observations),
      tx
    );
    const entries = await this.fillNulls(
      userId,
      schema.holdingTransactions,
      ENTRY_LABEL_COLUMNS,
      labels.flatMap((l) => l.entries),
      tx
    );
    const holdings = await this.fillNulls(
      userId,
      schema.holdings,
      HOLDING_LABEL_COLUMNS,
      labels.map((l) => ({ id: l.holdingId, ...l.holding })),
      tx
    );
    return { holdings, observations, entries };
  }

  private async fillNulls<L extends { id: string }>(
    userId: string,
    table: PgTable & { id: PgColumn; userId: PgColumn },
    columns: readonly LabelColumn<L>[],
    labels: readonly L[],
    tx: DatabaseTransaction
  ): Promise<number> {
    const writes = labels.filter((l) => columns.some((c) => c.value(l) !== undefined));
    const name = (c: LabelColumn<L>) => sql.identifier(c.column.name);
    const set = sql.join(
      columns.map((c) => sql`${name(c)} = COALESCE(${c.column}, v.${name(c)})`),
      sql`, `
    );
    const fillsANull = sql.join(
      columns.map((c) => sql`(${c.column} IS NULL AND v.${name(c)} IS NOT NULL)`),
      sql` OR `
    );
    const valueNames = sql.join([sql`id`, ...columns.map(name)], sql`, `);

    let filled = 0;
    for (let start = 0; start < writes.length; start += LABEL_BATCH_SIZE) {
      const rows = writes.slice(start, start + LABEL_BATCH_SIZE).map((label) => {
        const cells = columns.map(
          (c) => sql`${parameter(c.value(label))}::${sql.raw(c.column.getSQLType())}`
        );
        return sql`(${sql.join([sql`${label.id}::uuid`, ...cells], sql`, `)})`;
      });
      const updated = (await tx.execute(sql`
        UPDATE ${table} SET ${set}
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v (${valueNames})
        WHERE ${table.id} = v.id AND ${table.userId} = ${userId} AND (${fillsANull})
        RETURNING ${table.id}
      `)) as unknown as unknown[];
      filled += updated.length;
    }
    return filled;
  }
}

// Not `Map.groupBy`: the frontends type-check this graph under ES2022.
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

type Intern = <V extends string | null>(value: V) => V;

/**
 * One copy of each repeated value — a holding or input id, a source, a role —
 * where the driver hands back one per row.
 */
function interner(): Intern {
  const seen = new Map<string, string>();
  return <V extends string | null>(value: V): V => {
    if (value === null) return value;
    const held = seen.get(value);
    if (held !== undefined) return held as V;
    seen.set(value, value);
    return value;
  };
}

function internObservation(row: EvidenceObservation, intern: Intern): void {
  row.holdingId = intern(row.holdingId);
  row.source = intern(row.source);
  row.gapReview = intern(row.gapReview);
  row.role = intern(row.role);
  row.authority = intern(row.authority);
  row.inputId = intern(row.inputId);
  row.cause = intern(row.cause);
  row.metadataOrigin = intern(row.metadataOrigin);
  row.metadataSource = intern(row.metadataSource);
  row.metadataLegacyAnchor = intern(row.metadataLegacyAnchor);
}

function internTransaction(row: EvidenceTransaction, intern: Intern): void {
  row.holdingId = intern(row.holdingId);
  row.kind = intern(row.kind);
  row.source = intern(row.source);
  row.priceNativeTokenId = intern(row.priceNativeTokenId);
  row.ledgerKind = intern(row.ledgerKind);
  row.kindSubtype = intern(row.kindSubtype);
  row.inputId = intern(row.inputId);
  row.executionPriceTokenId = intern(row.executionPriceTokenId);
  row.kindOrigin = intern(row.kindOrigin);
}

function parameter(value: LabelValue): string | null {
  if (value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isPriceGranularity(value: string): value is PriceGranularity {
  return (PRICE_GRANULARITIES as readonly string[]).includes(value);
}

function compareReadings(a: PriceReading, b: PriceReading): number {
  return (
    compareText(a.tokenId, b.tokenId) ||
    compareText(a.baseTokenId, b.baseTokenId) ||
    PRICE_GRANULARITIES.indexOf(a.granularity) - PRICE_GRANULARITIES.indexOf(b.granularity)
  );
}
