import { createHash } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, getTableColumns, gt, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Service } from 'typedi';
import { RETAINED_KEY_PREFIX } from '../documents/DocumentRetentionService';
import {
  BACKED_UP_TABLES,
  BACKED_UP_USER_COLUMNS,
  BACKUP_CATALOG_TABLES,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackedUpTable,
  NOT_BACKED_UP,
} from './backup-plan';

type Reader = DatabaseTransaction | ReturnType<typeof getDb>;
type Row = Record<string, unknown>;

/** Where a backup reads the account's stored files from. */
export interface BackupFileSource {
  exists(r2Key: string): Promise<boolean>;
  read(r2Key: string): Promise<Uint8Array>;
}

/**
 * An uploaded document a backup leaves out, with its rows (SC-1662).
 * `not-stored`: its file was never kept, or is gone, so it is already a broken
 * download. `too-large`: the files together would take the backup past what a
 * restore accepts, so the backup was built without any of them.
 */
interface OmittedFile {
  documentId: string;
  filename: string;
  byteSize: number;
  reason: 'not-stored' | 'too-large';
}

export type BackupRecord =
  | {
      type: 'header';
      format: typeof BACKUP_FORMAT;
      version: number;
      exportedAt: string;
      /** Every account table the file leaves out, and why. */
      notIncluded: Array<{ table: string; reason: string }>;
      /** Absent before format 2, which carried no document. */
      files?: { included: boolean; omitted: OmittedFile[] };
    }
  | { type: 'catalog'; table: string; row: Row }
  | { type: 'user'; row: Row }
  | { type: 'row'; table: string; row: Row }
  /** A document's stored file, after the document's row. */
  | { type: 'file'; documentId: string; mimeType: string; sha256: string; data: string }
  | { type: 'end'; counts: Record<string, number>; records: number };

/** Extra conditions narrowing which rows of a table the backup carries. */
type Scope = ReadonlyMap<PgTable, SQL>;

const PAGE = 1000;
const ID_CHUNK = 500;
const FLUSH_BYTES = 64 * 1024;

/** A finished backup file: gzipped NDJSON, and what its end record says. */
export interface BackupFile {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  records: number;
  counts: Record<string, number>;
  /** Stored files the backup carries. */
  filesIncluded: number;
  /** Documents left out because their files together were too large to carry. */
  filesLeftOut: number;
}

const nameOf = (table: PgTable) => getTableConfig(table).name;

/** One NDJSON line. A bigint column would make `JSON.stringify` throw. */
export function backupLine(record: BackupRecord): string {
  return `${JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  )}\n`;
}

/**
 * The account's data as backup records (SC-1649): a header, the shared catalog
 * rows its rows reference, its settings, every backed-up table in insert order,
 * and an end record whose counts let a restore tell a whole file from a cut one.
 * Rows are read a page at a time, so a large account never sits in memory.
 */
@Service()
export class BackupWriter {
  /**
   * The whole account as one gzipped NDJSON file. Lines go through gzip as they
   * are read, so memory holds the compressed bytes and one page of rows, never
   * the uncompressed file: the largest account measured is about 99 MB of row
   * JSON (2026-10-09).
   */
  async file(
    userId: string,
    db: Reader = getDb(),
    files: BackupFileSource | null = null
  ): Promise<BackupFile> {
    const gzip = new CompressionStream('gzip');
    const writer = gzip.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const drained = (async () => {
      const reader = gzip.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
      }
    })();
    const encoder = new TextEncoder();
    let pending = '';
    let end: Extract<BackupRecord, { type: 'end' }> | undefined;
    let leftOut = 0;
    for await (const record of this.records(userId, db, PAGE, files)) {
      pending += backupLine(record);
      if (pending.length >= FLUSH_BYTES) {
        await writer.write(encoder.encode(pending));
        pending = '';
      }
      if (record.type === 'header') {
        leftOut = (record.files?.omitted ?? []).filter((o) => o.reason === 'too-large').length;
      }
      if (record.type === 'end') end = record;
    }
    if (pending) await writer.write(encoder.encode(pending));
    await writer.close();
    await drained;
    if (!end) throw new Error('BackupWriter: the records ended without an end record');
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      bytes,
      sha256,
      records: end.records,
      counts: end.counts,
      filesIncluded: end.counts.files ?? 0,
      filesLeftOut: leftOut,
    };
  }

  /**
   * Without `files`, no document is carried and every one is named as too
   * large: that is the build a backup falls back to when its files would not
   * fit (SC-1662).
   */
  async *records(
    userId: string,
    db: Reader = getDb(),
    page = PAGE,
    files: BackupFileSource | null = null
  ): AsyncGenerator<BackupRecord> {
    const counts: Record<string, number> = {};
    let records = 0;
    const documents = await this.documentsOf(userId, db, files);
    const included = documents.carried.map((d) => d.id);
    const carried = new Set(included);
    const scope: Scope = new Map([
      [schema.documents, included.length > 0 ? inArray(schema.documents.id, included) : sql`false`],
    ]);
    const extractions = new Set(
      included.length === 0
        ? []
        : (
            await db
              .select({ id: schema.documentExtractions.id })
              .from(schema.documentExtractions)
              .where(inArray(schema.documentExtractions.documentId, included))
          ).map((e) => e.id)
    );
    yield {
      type: 'header',
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      notIncluded: NOT_BACKED_UP.map(({ table, reason }) => ({ table: nameOf(table), reason })),
      files: { included: files !== null, omitted: documents.omitted },
    };
    records++;

    for (const [table, rows] of await this.catalog(userId, db, scope)) {
      for (const row of rows) {
        yield { type: 'catalog', table: nameOf(table), row };
        records++;
      }
      counts[`catalog:${nameOf(table)}`] = rows.length;
    }

    const selection = Object.fromEntries(
      BACKED_UP_USER_COLUMNS.map((key) => [key, schema.users[key]])
    );
    const [user] = await db.select(selection).from(schema.users).where(eq(schema.users.id, userId));
    if (!user) throw new Error(`BackupWriter: no user ${userId}`);
    yield { type: 'user', row: user };
    records++;

    for (const entry of BACKED_UP_TABLES) {
      const name = nameOf(entry.table);
      let n = 0;
      for await (const row of this.rowsOf(entry, userId, db, page, scope)) {
        // A bill matched to an extraction this file leaves out keeps the match
        // on the source only: the restore has nothing to point it at.
        if (
          entry.table === schema.paymentOccurrences &&
          typeof row.matchedExtractionId === 'string' &&
          !extractions.has(row.matchedExtractionId)
        ) {
          row.matchedExtractionId = null;
        }
        // Likewise a statement window naming a document this file leaves out.
        if (
          entry.table === schema.feedInputWindows &&
          typeof row.documentId === 'string' &&
          !carried.has(row.documentId)
        ) {
          row.documentId = null;
        }
        yield { type: 'row', table: name, row };
        n++;
      }
      counts[name] = n;
      records += n;
      if (entry.table === schema.documents && files) {
        let carried = 0;
        for (const document of documents.carried) {
          const bytes = await files.read(document.r2Key);
          yield {
            type: 'file',
            documentId: document.id,
            mimeType: document.mimeType,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            data: Buffer.from(bytes).toString('base64'),
          };
          carried++;
        }
        counts.files = carried;
        records += carried;
      }
    }

    records++;
    yield { type: 'end', counts, records };
  }

  /**
   * The account's documents split into the ones this file carries with their
   * files and the ones it names as left out. A document is carried only when
   * its file is stored under the retained prefix and is still there.
   */
  private async documentsOf(userId: string, db: Reader, files: BackupFileSource | null) {
    const rows = await db
      .select({
        id: schema.documents.id,
        r2Key: schema.documents.r2Key,
        mimeType: schema.documents.mimeType,
        filename: schema.documents.originalFilename,
        byteSize: schema.documents.byteSize,
      })
      .from(schema.documents)
      .where(eq(schema.documents.userId, userId))
      .orderBy(asc(schema.documents.id));
    const carried: typeof rows = [];
    const omitted: OmittedFile[] = [];
    for (const row of rows) {
      const stored =
        files !== null &&
        row.r2Key.startsWith(RETAINED_KEY_PREFIX) &&
        (await files.exists(row.r2Key));
      if (stored) {
        carried.push(row);
      } else {
        omitted.push({
          documentId: row.id,
          filename: row.filename,
          byteSize: row.byteSize,
          reason: files === null ? 'too-large' : 'not-stored',
        });
      }
    }
    return { carried, omitted };
  }

  private async *rowsOf(
    entry: BackedUpTable,
    userId: string,
    db: Reader,
    page: number,
    scope: Scope
  ): AsyncGenerator<Row> {
    const owned = this.ownedBy(entry, userId, db, scope);
    const id = getTableColumns(entry.table).id as AnyPgColumn | undefined;
    if (!id) {
      yield* (await db.select().from(entry.table).where(owned)) as Row[];
      return;
    }
    let after: unknown = null;
    for (;;) {
      const rows = (await db
        .select()
        .from(entry.table)
        .where(after === null ? owned : and(owned, gt(id, after)))
        .orderBy(asc(id))
        .limit(page)) as Row[];
      yield* rows;
      if (rows.length < page) return;
      after = rows[rows.length - 1]?.id;
    }
  }

  private ownedBy(entry: BackedUpTable, userId: string, db: Reader, scope: Scope): SQL {
    const narrowed = scope.get(entry.table);
    const owned = this.ownerOf(entry, userId, db, scope);
    return narrowed ? (and(owned, narrowed) as SQL) : owned;
  }

  private ownerOf(entry: BackedUpTable, userId: string, db: Reader, scope: Scope): SQL {
    if (entry.owner.by === 'user') return eq(entry.owner.column, userId);
    const parentTable = entry.owner.parent;
    const parent = BACKED_UP_TABLES.find((e) => e.table === parentTable);
    if (!parent) throw new Error(`BackupWriter: ${nameOf(parentTable)} is not backed up`);
    const parentId = getTableColumns(parent.table).id as AnyPgColumn;
    return inArray(
      entry.owner.column,
      db
        .select({ id: parentId })
        .from(parent.table)
        .where(this.ownedBy(parent, userId, db, scope))
    );
  }

  /**
   * The shared rows the account's rows reference, by catalog table. A catalog
   * table the account also owns rows in (`tokens`, `institutions`) contributes
   * only the rows it does not own: those travel as rows.
   */
  private async catalog(userId: string, db: Reader, scope: Scope): Promise<Map<PgTable, Row[]>> {
    const wanted = new Map<PgTable, Set<string>>(BACKUP_CATALOG_TABLES.map((t) => [t, new Set()]));
    const add = (table: PgTable, id: unknown) => {
      if (typeof id === 'string') wanted.get(table)?.add(id);
    };
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    add(schema.tokens, user?.baseCurrencyId);

    for (const entry of BACKED_UP_TABLES) {
      for (const { column, target } of catalogLinks(entry.table)) {
        const ids = await db
          .selectDistinct({ id: column })
          .from(entry.table)
          .where(and(this.ownedBy(entry, userId, db, scope), isNotNull(column)));
        for (const { id } of ids) add(target, id);
      }
    }
    // A wallet names the networks it is on in a JSON list, which no foreign
    // key follows.
    const wallets = await db
      .select({ ids: schema.userWallets.institutionIds })
      .from(schema.userWallets)
      .where(eq(schema.userWallets.userId, userId));
    for (const { ids } of wallets) {
      if (Array.isArray(ids)) for (const id of ids) add(schema.institutions, id);
    }

    const out = new Map<PgTable, Row[]>();
    for (const table of BACKUP_CATALOG_TABLES) {
      const ids = [...(wanted.get(table) ?? [])];
      const id = getTableColumns(table).id as AnyPgColumn;
      const ownedHere = BACKED_UP_TABLES.find((e) => e.table === table);
      const rows: Row[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const notOwned =
          ownedHere?.owner.by === 'user'
            ? sql`${ownedHere.owner.column} is distinct from ${userId}`
            : undefined;
        rows.push(
          ...((await db
            .select()
            .from(table)
            .where(and(inArray(id, chunk), notOwned))
            .orderBy(asc(id))) as Row[])
        );
      }
      for (const row of rows) {
        for (const { key, target } of catalogLinksByKey(table)) add(target, row[key]);
      }
      out.set(table, rows);
    }
    return new Map([...out].sort(([a], [b]) => catalogDepth(a) - catalogDepth(b)));
  }
}

/** A table's references to catalog tables, as the referencing column. */
function catalogLinks(table: PgTable): Array<{ column: AnyPgColumn; target: PgTable }> {
  const links: Array<{ column: AnyPgColumn; target: PgTable }> = [];
  for (const fk of getTableConfig(table).foreignKeys) {
    const ref = fk.reference();
    const target = BACKUP_CATALOG_TABLES.find((t) => t === ref.foreignTable);
    const column = ref.columns[0];
    if (target && column && ref.columns.length === 1) links.push({ column, target });
  }
  return links;
}

/** The same links, keyed by the property name a selected row carries. */
function catalogLinksByKey(table: PgTable): Array<{ key: string; target: PgTable }> {
  const keys = new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col, key]));
  return catalogLinks(table).flatMap(({ column, target }) => {
    const key = keys.get(column as never);
    return key ? [{ key, target }] : [];
  });
}

/** A catalog table is emitted after the catalog tables it references. */
function catalogDepth(table: PgTable): number {
  return catalogLinks(table).length === 0
    ? 0
    : 1 +
        Math.max(
          ...catalogLinks(table).map(({ target }) => (target === table ? 0 : catalogDepth(target)))
        );
}
