import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Decimal } from '@scani/shared';
import { and, eq, getTableColumns, isNull, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { TokenIdentityService } from '../tokens/TokenIdentityService';
import type { BackupRecord } from './BackupWriter';
import {
  BACKED_UP_TABLES,
  BACKED_UP_USER_COLUMNS,
  BACKUP_CATALOG_TABLES,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from './backup-plan';
import { rewriteIds } from './id-rewrite';

type Row = Record<string, unknown>;
type Reader = DatabaseTransaction | ReturnType<typeof getDb>;

export type RestoreRefusal =
  | 'not-a-backup'
  | 'newer-version'
  | 'cut-short'
  | 'no-such-user'
  | 'not-empty'
  | 'unknown-catalog';

/** A file this restore will not load, or an account it will not load into. Nothing was written. */
export class RestoreRefused extends Error {
  constructor(
    readonly reason: RestoreRefusal,
    message: string
  ) {
    super(message);
    this.name = 'RestoreRefused';
  }
}

export interface RestoreReport {
  /** Rows written, by table. */
  rows: Record<string, number>;
  /** Holdings whose engine balance differs from the cache the file carried. Expected empty. */
  balanceDifferences: Array<{ holdingId: string; inFile: string; engine: string }>;
  /** Shared tokens this instance could not match, restored as the account's own and flagged. */
  unmatchedTokens: number;
  /** The earliest dated evidence restored: where a history rebuild has to start. */
  earliestEvidenceAt: Date | null;
  /** The tokens the restored holdings hold: what a history rebuild prices. */
  tokenIds: string[];
  /** Every id the file issued, to the id it was restored under. */
  ids: ReadonlyMap<string, string>;
}

export const RESTORE_NEEDS_EMPTY =
  'A backup is restored only into an empty account, and this one already has data.';

/** Marks a token restored in place of a shared one this instance lacks (SC-1649 Q3). */
export const UNMATCHED_TOKEN_MARKER = 'restoredUnmatched';

const CHUNK = 500;
const CACHE_CHUNK = 100;
/** Ledger columns that group rows by a shared id that is not a row's own. */
const GROUP_KEYS: Record<string, readonly string[]> = {
  holding_transactions: ['swapGroupId', 'transferGroupId', 'groupId', 'feeOf'],
};

const nameOf = (table: PgTable) => getTableConfig(table).name;
const TABLES = new Map(BACKED_UP_TABLES.map((e) => [nameOf(e.table), e.table]));
const CATALOG_NAMES = new Set(BACKUP_CATALOG_TABLES.map(nameOf));

interface Links {
  /** Property keys naming `users.id`. */
  users: string[];
  /** Property keys naming a table a backup leaves out: they come back empty. */
  leftOut: string[];
  /** Property keys naming another row of the same table: set once the table is in. */
  self: string[];
}

function linksOf(table: PgTable): Links {
  const keys = new Map(
    Object.entries(getTableColumns(table)).map(([key, col]) => [col as AnyPgColumn, key])
  );
  const out: Links = { users: [], leftOut: [], self: [] };
  for (const fk of getTableConfig(table).foreignKeys) {
    const ref = fk.reference();
    const column = ref.columns[0];
    const key = column ? keys.get(column) : undefined;
    if (!key || ref.columns.length !== 1) continue;
    const target = nameOf(ref.foreignTable);
    if (ref.foreignTable === table) out.self.push(key);
    else if (target === 'users') out.users.push(key);
    else if (!TABLES.has(target) && !CATALOG_NAMES.has(target)) out.leftOut.push(key);
  }
  return out;
}

const LINKS = new Map([...TABLES].map(([name, table]) => [name, linksOf(table)]));

/**
 * Loads a backup into an empty account (SC-1649 A2). Two passes over the
 * file: the first checks it is whole and gives every row a new id, the second
 * writes it in one transaction, with every id the file issued rewritten
 * wherever it appears. The engine then computes each holding's balance from
 * the restored evidence, and the report names any that differs from the
 * cache the file carried.
 */
@Service()
export class BackupRestorer {
  private readonly identity = Container.get(TokenIdentityService);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly coverage = Container.get(HoldingCoverageRepository);
  private readonly logger = createComponentLogger('service:BackupRestorer');

  /**
   * `open` is called twice and must yield the same records both times.
   * Without `tx`, shared tokens are created outside the restore's own
   * transaction, since a token's identity lookup may call a provider.
   */
  async restore(
    userId: string,
    open: () => AsyncIterable<BackupRecord>,
    tx?: DatabaseTransaction
  ): Promise<RestoreReport> {
    const scan = await this.scan(open);
    const ids = new Map(scan.ids);
    for (const sourceUser of scan.users) ids.set(sourceUser, userId);
    const fallbacks = await this.resolveCatalog(scan.catalog, ids, tx);
    const write = (t: DatabaseTransaction) => this.write(userId, open, ids, fallbacks, t);
    return tx ? write(tx) : getDb().transaction(write);
  }

  /** Pass one: the file is a whole backup, and every row it holds has a new id. */
  private async scan(open: () => AsyncIterable<BackupRecord>) {
    const ids = new Map<string, string>();
    const users = new Set<string>();
    const groups = new Set<string>();
    const catalog = new Map<string, Row[]>();
    const counts: Record<string, number> = {};
    let records = 0;
    let end: Extract<BackupRecord, { type: 'end' }> | undefined;

    for await (const record of open()) {
      if (records === 0) {
        if (record.type !== 'header' || record.format !== BACKUP_FORMAT) {
          throw new RestoreRefused('not-a-backup', 'This file is not a Scani backup.');
        }
        if (record.version > BACKUP_VERSION) {
          throw new RestoreRefused(
            'newer-version',
            `This backup is format version ${record.version}; this instance reads up to ${BACKUP_VERSION}.`
          );
        }
      }
      records++;
      if (record.type === 'catalog') {
        const rows = catalog.get(record.table) ?? [];
        rows.push(record.row);
        catalog.set(record.table, rows);
        counts[`catalog:${record.table}`] = (counts[`catalog:${record.table}`] ?? 0) + 1;
      } else if (record.type === 'row') {
        const links = LINKS.get(record.table);
        if (!links) {
          throw new RestoreRefused(
            'not-a-backup',
            `The backup carries an unknown table, ${record.table}.`
          );
        }
        counts[record.table] = (counts[record.table] ?? 0) + 1;
        const id = record.row.id;
        if (typeof id === 'string') ids.set(id.toLowerCase(), randomUUID());
        for (const key of links.users) {
          const value = record.row[key];
          if (typeof value === 'string') users.add(value.toLowerCase());
        }
        for (const key of GROUP_KEYS[record.table] ?? []) {
          const value = record.row[key];
          if (typeof value === 'string') groups.add(value.toLowerCase());
        }
      } else if (record.type === 'end') {
        end = record;
      }
    }

    const complete =
      end !== undefined &&
      end.records === records &&
      Object.entries(end.counts).every(([table, n]) => (counts[table] ?? 0) === n) &&
      Object.entries(counts).every(([table, n]) => end?.counts[table] === n);
    if (!complete) {
      throw new RestoreRefused(
        'cut-short',
        'The backup is incomplete: its records do not match the counts it ends with.'
      );
    }
    for (const group of groups) if (!ids.has(group)) ids.set(group, randomUUID());
    return { ids, users, catalog };
  }

  /**
   * Every shared row the file references, matched on this instance: by id
   * when this instance has the same row, otherwise by its natural key. A
   * token neither finds goes through token identity, and one identity cannot
   * resolve either is restored as the account's own, flagged (Q3).
   */
  private async resolveCatalog(
    catalog: Map<string, Row[]>,
    ids: Map<string, string>,
    tx: DatabaseTransaction | undefined
  ): Promise<{ tokens: Row[]; institutions: Row[] }> {
    const db: Reader = tx ?? getDb();
    for (const [table, name] of [
      [schema.tokenTypes, 'token_types'],
      [schema.institutionTypes, 'institution_types'],
      [schema.accountTypes, 'account_types'],
    ] as const) {
      for (const row of catalog.get(name) ?? []) {
        const [match] = await db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.code, String(row.code)));
        if (!match) {
          throw new RestoreRefused(
            'unknown-catalog',
            `The backup uses ${name} "${String(row.code)}", which this instance does not have.`
          );
        }
        ids.set(String(row.id), match.id);
      }
    }

    const institutions: Row[] = [];
    for (const row of catalog.get('institutions') ?? []) {
      const typeId = ids.get(String(row.typeId)) ?? String(row.typeId);
      const shared = isNull(schema.institutions.createdByUserId);
      const match =
        (await this.first(
          db,
          schema.institutions,
          and(shared, eq(schema.institutions.id, String(row.id)))
        )) ??
        (row.isVerified && row.website
          ? await this.first(
              db,
              schema.institutions,
              and(
                eq(schema.institutions.isVerified, true),
                eq(schema.institutions.website, String(row.website))
              )
            )
          : null) ??
        (await this.first(
          db,
          schema.institutions,
          and(
            shared,
            eq(schema.institutions.name, String(row.name)),
            eq(schema.institutions.typeId, typeId)
          )
        ));
      if (match) {
        ids.set(String(row.id), match);
      } else {
        ids.set(String(row.id), randomUUID());
        institutions.push(row);
      }
    }

    const tokens: Row[] = [];
    for (const row of catalog.get('tokens') ?? []) {
      const typeId = ids.get(String(row.typeId)) ?? String(row.typeId);
      const shared = isNull(schema.tokens.createdByUserId);
      const segment = row.marketSegment == null ? '' : String(row.marketSegment);
      const match =
        (await this.first(
          db,
          schema.tokens,
          and(
            shared,
            eq(schema.tokens.id, String(row.id)),
            eq(schema.tokens.symbol, String(row.symbol))
          )
        )) ??
        (await this.first(
          db,
          schema.tokens,
          and(
            shared,
            eq(schema.tokens.symbol, String(row.symbol)),
            eq(schema.tokens.typeId, typeId),
            sql`coalesce(${schema.tokens.marketSegment}, '') = ${segment}`
          )
        )) ??
        (await this.byIdentity(row, typeId, tx));
      if (match) {
        ids.set(String(row.id), match);
      } else {
        ids.set(String(row.id), randomUUID());
        tokens.push(row);
      }
    }
    return { tokens, institutions };
  }

  private async first(
    db: Reader,
    table: typeof schema.tokens | typeof schema.institutions,
    where: SQL | undefined
  ) {
    const [row] = await db.select({ id: table.id }).from(table).where(where).limit(1);
    return row?.id ?? null;
  }

  private async byIdentity(row: Row, typeId: string, tx: DatabaseTransaction | undefined) {
    try {
      const token = await this.identity.findOrCreateByIdentity(
        {
          symbol: String(row.symbol),
          name: row.name == null ? undefined : String(row.name),
          typeId,
          marketSegment: row.marketSegment == null ? null : String(row.marketSegment),
          providerMetadata: row.providerMetadata as never,
        },
        tx as Parameters<TokenIdentityService['findOrCreateByIdentity']>[1]
      );
      return token.createdByUserId == null ? token.id : null;
    } catch (error) {
      this.logger.info(
        { symbol: row.symbol, error: error instanceof Error ? error.message : String(error) },
        'token identity could not resolve a restored token'
      );
      return null;
    }
  }

  /** Pass two, in one transaction. */
  private async write(
    userId: string,
    open: () => AsyncIterable<BackupRecord>,
    ids: Map<string, string>,
    fallbacks: { tokens: Row[]; institutions: Row[] },
    tx: DatabaseTransaction
  ): Promise<RestoreReport> {
    await this.refuseUnlessEmpty(userId, tx);

    for (const row of fallbacks.institutions) {
      await insertRows(tx, schema.institutions, [
        rewriteIds({ ...row, createdByUserId: userId, isVerified: false }, ids),
      ]);
    }
    for (const row of fallbacks.tokens) {
      await insertRows(tx, schema.tokens, [
        rewriteIds(
          {
            id: row.id,
            symbol: row.symbol,
            name: row.name,
            typeId: row.typeId,
            marketSegment: row.marketSegment,
            decimals: row.decimals,
            isActive: true,
            createdByUserId: userId,
            providerMetadata: { provider: 'manual', [UNMATCHED_TOKEN_MARKER]: true },
          },
          ids
        ),
      ]);
    }

    const rows: Record<string, number> = {};
    const holdings: Array<{ id: string; balance: string; lastUpdated: unknown }> = [];
    const tokenIds = new Set<string>();
    let earliest: Date | null = null;
    const seen = (at: unknown) => {
      if (typeof at !== 'string' && !(at instanceof Date)) return;
      const d = new Date(at);
      if (!Number.isNaN(d.getTime()) && (earliest === null || d < earliest)) earliest = d;
    };

    let table: string | null = null;
    let buffer: Row[] = [];
    let selfLinks: Array<{ id: string; key: string; value: unknown }> = [];
    let settled: Row[] = [];
    const flush = async () => {
      if (!table || buffer.length === 0) return;
      const target = TABLES.get(table) as PgTable;
      if (table === 'holding_balance_observations') return;
      await insertRows(tx, target, buffer);
      rows[table] = (rows[table] ?? 0) + buffer.length;
      buffer = [];
    };
    const finish = async () => {
      if (!table) return;
      const target = TABLES.get(table) as PgTable;
      if (table === 'holding_balance_observations') {
        // In holding and time order, so the trigger that links each reading to
        // the one before it rewrites a short run per statement, not the chain.
        buffer.sort(
          (a, b) =>
            String(a.holdingId).localeCompare(String(b.holdingId)) ||
            new Date(String(a.observedAt)).getTime() - new Date(String(b.observedAt)).getTime() ||
            String(a.id).localeCompare(String(b.id))
        );
        for (let i = 0; i < buffer.length; i += CHUNK) {
          await insertRows(tx, target, buffer.slice(i, i + CHUNK));
        }
        rows[table] = buffer.length;
        buffer = [];
      } else {
        await flush();
      }
      await setSelfLinks(tx, target, selfLinks);
      if (table === 'payment_occurrences') await setSettledTerms(tx, settled);
      selfLinks = [];
      settled = [];
    };

    for await (const record of open()) {
      if (record.type === 'user') {
        await updateSettings(tx, userId, rewriteIds(record.row, ids));
        continue;
      }
      if (record.type !== 'row') continue;
      if (record.table !== table) {
        await finish();
        table = record.table;
      }
      const links = LINKS.get(record.table) as Links;
      const row: Row = rewriteIds(record.row, ids);
      for (const key of links.leftOut) row[key] = null;
      for (const key of links.self) {
        if (row[key] != null) selfLinks.push({ id: String(row.id), key, value: row[key] });
        row[key] = null;
      }
      if (record.table === 'holdings') {
        holdings.push({
          id: String(row.id),
          balance: String(row.balance),
          lastUpdated: row.lastUpdated,
        });
        tokenIds.add(String(row.tokenId));
        // The engine is the one writer of these (A5); it funds the holding
        // from its evidence once that is in.
        row.balance = '0';
        row.valueBase = null;
        row.valuePricedAt = null;
      }
      if (record.table === 'feed_input_windows') row.uploadRef = null;
      if (record.table === 'payment_occurrences' && row.settledVendorId != null) settled.push(row);
      if (record.table === 'holding_transactions') seen(row.occurredAt);
      if (record.table === 'holding_balance_observations') seen(row.observedAt);
      buffer.push(row);
      if (buffer.length >= CHUNK) await flush();
    }
    await finish();

    const holdingIds = holdings.map((h) => h.id);
    await this.coverage.syncTxBoundsFromLedger(holdingIds, tx);
    const balanceDifferences: RestoreReport['balanceDifferences'] = [];
    for (let i = 0; i < holdings.length; i += CACHE_CHUNK) {
      const chunk = holdings.slice(i, i + CACHE_CHUNK);
      const engine = await this.cacheWriter.apply(
        userId,
        chunk.map((h) => ({
          holdingId: h.id,
          balance: h.balance,
          lastUpdated: h.lastUpdated == null ? null : new Date(String(h.lastUpdated)),
        })),
        tx
      );
      for (const h of chunk) {
        const computed = engine.get(h.id) ?? '0';
        if (!new Decimal(computed).eq(h.balance)) {
          balanceDifferences.push({ holdingId: h.id, inFile: h.balance, engine: computed });
        }
      }
    }

    return {
      rows,
      balanceDifferences,
      unmatchedTokens: fallbacks.tokens.length,
      earliestEvidenceAt: earliest,
      tokenIds: [...tokenIds],
      ids,
    };
  }

  /** Whether the account holds any row a backup would restore: a restore needs it empty (Q1). */
  async hasData(userId: string, db: Reader = getDb()): Promise<boolean> {
    for (const entry of BACKED_UP_TABLES) {
      if (entry.owner.by !== 'user') continue;
      const [row] = await db
        .select({ one: sql<number>`1` })
        .from(entry.table)
        .where(eq(entry.owner.column, userId))
        .limit(1);
      if (row) return true;
    }
    return false;
  }

  private async refuseUnlessEmpty(userId: string, tx: DatabaseTransaction) {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update');
    if (!user) throw new RestoreRefused('no-such-user', `No account ${userId}.`);
    if (await this.hasData(userId, tx)) {
      throw new RestoreRefused('not-empty', RESTORE_NEEDS_EMPTY);
    }
  }
}

/**
 * The records of a gzipped backup file, one line at a time, so the file is
 * never held decompressed. A file that is not gzip, or a line that is not
 * JSON, is refused as not a backup.
 */
export async function* backupRecords(gz: Uint8Array): AsyncGenerator<BackupRecord> {
  // Copied into a plain ArrayBuffer, which is what a Blob part may be.
  const text = new Blob([new Uint8Array(gz)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());
  let pending = '';
  const parse = (line: string): BackupRecord => {
    try {
      return JSON.parse(line) as BackupRecord;
    } catch {
      throw new RestoreRefused('not-a-backup', 'This file is not a Scani backup.');
    }
  };
  try {
    for await (const chunk of text) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) yield parse(line);
        newline = pending.indexOf('\n');
      }
    }
  } catch (error) {
    if (error instanceof RestoreRefused) throw error;
    throw new RestoreRefused('not-a-backup', 'This file is not a Scani backup.');
  }
  if (pending) yield parse(pending);
}

/**
 * Rows by property key, inserted by column name through
 * `jsonb_populate_recordset`, so Postgres casts each value as it stores it.
 * Only the columns the rows carry are named, so a column added since the
 * backup was written takes its default. A generated column is never named.
 */
async function insertRows(tx: DatabaseTransaction, table: PgTable, rows: Row[]): Promise<void> {
  const first = rows[0];
  if (!first) return;
  const columns = Object.entries(getTableColumns(table)).filter(
    ([key, column]) => !column.generated && key in first
  );
  const name = sql.identifier(getTableConfig(table).name);
  const list = sql.join(
    columns.map(([, column]) => sql.identifier(column.name)),
    sql`, `
  );
  const json = rows.map((row) =>
    Object.fromEntries(columns.map(([key, column]) => [column.name, row[key] ?? null]))
  );
  await tx.execute(sql`
    INSERT INTO ${name} (${list})
    SELECT ${list} FROM jsonb_populate_recordset(NULL::${name}, ${stringify(json)}::jsonb)
  `);
}

async function setSelfLinks(
  tx: DatabaseTransaction,
  table: PgTable,
  links: Array<{ id: string; key: string; value: unknown }>
): Promise<void> {
  const columns = getTableColumns(table);
  const byKey = new Map<string, Array<{ id: string; value: unknown }>>();
  for (const link of links) byKey.set(link.key, [...(byKey.get(link.key) ?? []), link]);
  for (const [key, pairs] of byKey) {
    const column = sql.identifier((columns[key] as AnyPgColumn).name);
    const name = sql.identifier(getTableConfig(table).name);
    for (let i = 0; i < pairs.length; i += CHUNK) {
      await tx.execute(sql`
        UPDATE ${name} t SET ${column} = j.value
        FROM jsonb_to_recordset(${stringify(pairs.slice(i, i + CHUNK))}::jsonb) AS j(id uuid, value uuid)
        WHERE t.id = j.id
      `);
    }
  }
}

/**
 * A settled occurrence keeps the terms it settled on. The insert trigger
 * copies the bill's CURRENT terms over them, so they are put back after it.
 */
async function setSettledTerms(tx: DatabaseTransaction, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const terms = rows.slice(i, i + CHUNK).map((r) => ({
      id: r.id,
      vendor: r.settledVendorId,
      currency: r.settledCurrencyTokenId,
      direction: r.settledDirection,
    }));
    await tx.execute(sql`
      UPDATE payment_occurrences o
      SET settled_vendor_id = j.vendor, settled_currency_token_id = j.currency, settled_direction = j.direction
      FROM jsonb_to_recordset(${stringify(terms)}::jsonb) AS j(id uuid, vendor uuid, currency uuid, direction text)
      WHERE o.id = j.id
    `);
  }
}

/** The account's settings from the file; sign-in and consent columns stay the target's. */
async function updateSettings(tx: DatabaseTransaction, userId: string, row: Row): Promise<void> {
  const columns = Object.entries(getTableColumns(schema.users)).filter(
    ([key]) => (BACKED_UP_USER_COLUMNS as readonly string[]).includes(key) && key in row
  );
  if (columns.length === 0) return;
  const list = sql.join(
    columns.map(([, column]) => sql.identifier(column.name)),
    sql`, `
  );
  const json = Object.fromEntries(columns.map(([key, column]) => [column.name, row[key] ?? null]));
  await tx.execute(sql`
    UPDATE users SET (${list}) = (
      SELECT ${list} FROM jsonb_populate_record(NULL::users, ${stringify(json)}::jsonb)
    )
    WHERE id = ${userId}
  `);
}

const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
