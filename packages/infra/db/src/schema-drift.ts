import { getTableName, is, SQL } from 'drizzle-orm';
import { getTableConfig, type IndexedColumn, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { client } from './connection';
import * as schema from './schema/index';

/**
 * Does the database this process is talking to actually have the columns this
 * build's code selects? (SC-480)
 *
 * `awaitSchemaReady` asks whether three canary TABLES exist, which is the
 * question a fresh boot has. It is not the question a deploy has. On
 * 2026-08-20 `deploy-local.sh backend worker` shipped SC-462's api without its
 * migration: every table existed, `/health/deep` reported db/redis/r2/ai all
 * ok, the deploy printed DEPLOY_COMPLETE and exited 0 — and the first query of
 * the sign-in path failed on `column "cost_basis_method" does not exist`
 * (42703). Production could not log in for about six hours, and the only
 * signal that reached a human was a person failing to sign in.
 *
 * A `SELECT 1` cannot see that by construction: it names no column of any
 * table the deploy changed. So the probe has to compare the two things that
 * disagreed — the column list drizzle compiles into this binary, and the
 * column list the database has.
 *
 * It catches the drift regardless of cause: a forgotten `migrate` target, a
 * migration that ran against the wrong database, an apply that reported
 * success and did not take. Any of those, one probe.
 *
 * **Direction matters.** Columns the code expects and the database lacks are a
 * fault — that is the outage. Columns the database has and the code does not
 * are NOT: that is the ordinary state between an expand migration and the
 * build that drops the field, and the deploy chain runs `migrate` first on
 * purpose. Reporting those would make this red on every deploy, and a probe
 * that is always red is one nobody reads.
 */

export interface SchemaDriftReport {
  ok: boolean;
  /** Tables in the code's schema with no counterpart in the database. */
  missingTables: string[];
  /** `table.column` the code selects and the database does not have. */
  missingColumns: string[];
  /** How many tables were compared — 0 means the comparison did not happen. */
  checkedTables: number;
  latencyMs: number;
}

export class SchemaDriftTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`schema drift check timed out after ${timeoutMs}ms`);
    this.name = 'SchemaDriftTimeoutError';
  }
}

/**
 * The bound exists for the same reason `pingWithin` does (SC-294): the deploy
 * smoke fetches this body with `curl --max-time 10`, and Fly's proxy gives up
 * at ~31s with a bodyless 502 — so an unbounded probe fails to deliver the
 * diagnosis during the exact outage it describes. One `information_schema`
 * scan is single-digit milliseconds against a warm Neon compute; two seconds
 * is the same allowance the Redis ping gets.
 */
export const SCHEMA_DRIFT_TIMEOUT_MS = 2_000;

/** Rows as `information_schema.columns` returns them. */
export interface DatabaseColumnRow {
  table_name: string;
  column_name: string;
}

export interface SchemaDriftOptions {
  timeoutMs?: number;
  /** Postgres schema to compare against. Only tests pass anything else. */
  pgSchema?: string;
}

let expectedCache: Map<string, Set<string>> | null = null;

/**
 * The column list this build will actually select, read off the drizzle table
 * objects rather than restated here. Restating it would make the probe agree
 * with whatever a hand-maintained list got wrong, which is the failure it
 * exists to catch — the next `users` column has to appear here for free.
 */
export function expectedSchema(): Map<string, Set<string>> {
  if (expectedCache) return expectedCache;
  const expected = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    // Tables drizzle places in a non-default postgres schema are compared
    // separately or not at all; every table in this repo is in `public`.
    if (config.schema && config.schema !== 'public') continue;
    expected.set(getTableName(value), new Set(config.columns.map((column) => column.name)));
  }
  expectedCache = expected;
  return expected;
}

/**
 * Pure half: what the code wants vs what the database reported. Separated so
 * the comparison can be tested without a database, and so the query below has
 * nothing in it but the query.
 */
export function diffSchema(
  expected: Map<string, Set<string>>,
  actualRows: readonly DatabaseColumnRow[]
): Pick<SchemaDriftReport, 'missingTables' | 'missingColumns'> {
  const actual = new Map<string, Set<string>>();
  for (const row of actualRows) {
    let columns = actual.get(row.table_name);
    if (!columns) {
      columns = new Set<string>();
      actual.set(row.table_name, columns);
    }
    columns.add(row.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, columns] of expected) {
    const present = actual.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  missingTables.sort();
  missingColumns.sort();
  return { missingTables, missingColumns };
}

export async function checkSchemaDrift(
  options: SchemaDriftOptions = {}
): Promise<SchemaDriftReport> {
  const timeoutMs = options.timeoutMs ?? SCHEMA_DRIFT_TIMEOUT_MS;
  const pgSchema = options.pgSchema ?? 'public';
  const started = performance.now();

  const query = client<DatabaseColumnRow[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = ${pgSchema}
  `;
  // The losing promise gets a no-op catch rather than being left unhandled:
  // postgres.js settles it eventually, and a rejection arriving minutes later
  // attributed to nothing is its own debugging problem.
  query.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rows: DatabaseColumnRow[];
  try {
    rows = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SchemaDriftTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const expected = expectedSchema();
  const { missingTables, missingColumns } = diffSchema(expected, rows);
  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    checkedTables: expected.size,
    latencyMs: Math.round(performance.now() - started),
  };
}

/** How many names a failure message spells out before it summarises. */
const NAMES_IN_MESSAGE = 5;

/**
 * The one line an operator reads at 2am. It must name a column, because
 * "schema drift" alone does not tell anyone which target was omitted, and it
 * must say that a MIGRATION is what is missing — the recovery is whatever
 * runs migrations for this deployment, and that only helps if the reader
 * knows which step was skipped.
 *
 * It names no script on purpose (SC-729). The deploy path differs by who is
 * running this, and a message that prescribes one of them is wrong for
 * everybody else at the moment they are least able to check.
 */
export function describeSchemaDrift(report: SchemaDriftReport): string {
  const names = [...report.missingTables, ...report.missingColumns];
  const shown = names.slice(0, NAMES_IN_MESSAGE).join(', ');
  const rest = names.length > NAMES_IN_MESSAGE ? ` (+${names.length - NAMES_IN_MESSAGE} more)` : '';
  return `database is behind this build: ${shown}${rest} — an unapplied migration; run this deployment's migrate step against it`;
}

/**
 * Indexes, both directions, full definitions (SC-946).
 *
 * The column probe above cannot see an index by construction, and SC-938 is
 * what that cost: `idx_users_email_unsubscribe_token` was in every deployed
 * database and declared nowhere in drizzle for 15 days, and nothing went red.
 * The direction that bit was the DECLARATION missing, so both directions are
 * compared, and a declared index whose definition differs is drift too.
 *
 * Constraint-backed indexes — primary keys, `UNIQUE` and exclusion
 * constraints — are excluded by RULE, read off `pg_constraint`, not listed:
 * `users_pkey` comes from `.primaryKey()` and can never be declared as an
 * index, and a list would start full of that noise on day one.
 *
 * Definitions are compared in a normal form, and every rule in `normaliseSql`
 * is one a sweep of a migrated database needed: drizzle qualifies columns with
 * the table and Postgres does not; Postgres rewrites `IN (…)` as
 * `= ANY (ARRAY[…])` and adds `::type` casts and parentheses. NULLS order is
 * compared only on a nullable key: on a NOT NULL column it orders nothing.
 */

/** Postgres truncates identifiers to NAMEDATALEN - 1 bytes. */
const PG_IDENTIFIER_BYTES = 63;

export interface IndexShape {
  table: string;
  unique: boolean;
  method: string;
  /** One entry per key column: `expr[ opclass][ desc][ nulls first|last]`, normalised. */
  keys: string[];
  /** Normalised predicate of a partial index, or null. */
  where: string | null;
}

export interface IndexException {
  /** Why this index cannot or should not be declared in drizzle. */
  reason: string;
  /** The migration that created it. */
  migration: string;
}

/**
 * One entry per index NAME, never per table: a table-level exception would
 * hide every future index on that table, which is the SC-938 shape. An entry
 * whose index no longer exists is reported, so the list cannot outlive its
 * reasons.
 */
export const INDEX_EXCEPTIONS: Readonly<Record<string, IndexException>> = {
  queue_resource_locks_expires_at_idx: {
    reason:
      '`queue_resource_locks` is created and read by `@scani/queue` in raw SQL; the table is not a drizzle table, so neither is its index',
    migration: '20260821152612_queue_resource_locks_for_the_postgres_resource_lock.sql',
  },
  idx_holding_obs_user_holding_observed: {
    reason:
      'the index carries `INCLUDE (balance)`, which drizzle 0.45 cannot express; it is declared, and its definition is exempt from comparison',
    migration: '20260822064054_sc501_balance_observation_gap_review.sql',
  },
};

export interface DatabaseIndexRow {
  index_name: string;
  table_name: string;
  is_unique: boolean;
  method: string;
  keys: string[];
  where: string | null;
}

export interface IndexDriftReport {
  ok: boolean;
  /** Plain indexes in the database that drizzle does not declare. */
  undeclared: string[];
  /** Indexes drizzle declares that the database does not have. */
  missing: string[];
  /** Declared and present, with a different definition. */
  differing: { name: string; database: IndexShape; declared: IndexShape }[];
  /** Exception entries whose index is not in the database. */
  staleExceptions: string[];
  /** How many declared indexes were compared — 0 means nothing was. */
  checkedIndexes: number;
  latencyMs: number;
}

export function truncateIdentifier(name: string): string {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= PG_IDENTIFIER_BYTES) return name;
  return new TextDecoder().decode(bytes.slice(0, PG_IDENTIFIER_BYTES));
}

/** The normal form both sides of a definition are compared in. */
export function normaliseSql(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/"/g, '')
      .replace(/\b[a-z_][a-z0-9_]*\.(?=[a-z_])/g, '')
      // Multi-word types are named: a general `( [a-z_]+)*` also eats the
      // `and next_column` that follows a cast.
      .replace(
        /::(?:double precision|character varying|timestamp with(?:out)? time zone|time with(?:out)? time zone|[a-z_]+)(?:\[\])?/g,
        ''
      )
      .replace(/=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/g, ' in ($1)')
      .replace(/[()]/g, '')
      .replace(/\s+/g, '')
  );
}

function keyForm(
  expr: string,
  opclass: string | null,
  desc: boolean,
  nullsFirst: boolean,
  nullable: boolean
): string {
  const parts = [normaliseSql(expr)];
  if (opclass) parts.push(opclass);
  if (desc) parts.push('desc');
  // Postgres's default is NULLS LAST ascending and NULLS FIRST descending.
  if (nullable && nullsFirst !== desc) parts.push(nullsFirst ? 'nullsfirst' : 'nullslast');
  return parts.join(' ');
}

let expectedIndexCache: Map<string, IndexShape> | null = null;

/** Every plain index drizzle declares, keyed by the name Postgres will store. */
export function expectedIndexes(): Map<string, IndexShape> {
  if (expectedIndexCache) return expectedIndexCache;
  const dialect = new PgDialect();
  const expected = new Map<string, IndexShape>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (config.schema && config.schema !== 'public') continue;
    for (const index of config.indexes) {
      const { name, unique, method, where, columns } = index.config;
      if (!name) continue;
      const keys = columns.map((column) => {
        if (is(column, SQL)) {
          return keyForm(dialect.sqlToQuery(column).sql, null, false, false, true);
        }
        const indexed = column as IndexedColumn;
        const order = indexed.indexConfig?.order ?? 'asc';
        const nulls = indexed.indexConfig?.nulls ?? (order === 'desc' ? 'first' : 'last');
        const opclass = indexed.indexConfig?.opClass ?? null;
        const nullable = !config.columns.find((c) => c.name === indexed.name)?.notNull;
        return keyForm(indexed.name ?? '', opclass, order === 'desc', nulls === 'first', nullable);
      });
      expected.set(truncateIdentifier(name), {
        table: config.name,
        unique,
        method: method ?? 'btree',
        keys,
        where: where ? normaliseSql(dialect.sqlToQuery(where).sql) : null,
      });
    }
  }
  expectedIndexCache = expected;
  return expected;
}

/** Pure half of the index comparison, so it can be tested without a database. */
export function diffIndexes(
  expected: Map<string, IndexShape>,
  actual: readonly DatabaseIndexRow[],
  exceptions: Readonly<Record<string, IndexException>> = INDEX_EXCEPTIONS
): Pick<IndexDriftReport, 'undeclared' | 'missing' | 'differing' | 'staleExceptions'> {
  const present = new Map(actual.map((row) => [row.index_name, row]));
  const undeclared: string[] = [];
  const missing: string[] = [];
  const differing: IndexDriftReport['differing'] = [];

  for (const row of actual) {
    if (!expected.has(row.index_name) && !(row.index_name in exceptions)) {
      undeclared.push(`${row.table_name}.${row.index_name}`);
    }
  }
  for (const [name, declared] of expected) {
    const row = present.get(name);
    if (!row) {
      missing.push(`${declared.table}.${name}`);
      continue;
    }
    if (name in exceptions) continue;
    const database: IndexShape = {
      table: row.table_name,
      unique: row.is_unique,
      method: row.method,
      keys: row.keys,
      where: row.where,
    };
    if (JSON.stringify(database) !== JSON.stringify(declared)) {
      differing.push({ name, database, declared });
    }
  }
  const staleExceptions = Object.keys(exceptions).filter((name) => !present.has(name));
  undeclared.sort();
  missing.sort();
  return { undeclared, missing, differing, staleExceptions };
}

interface RawIndexRow {
  index_name: string;
  table_name: string;
  is_unique: boolean;
  method: string;
  exprs: string[];
  opclasses: string[];
  descs: boolean[];
  nulls_firsts: boolean[];
  nullables: boolean[];
  where: string | null;
}

/** Plain indexes only: a constraint-backed index has a `pg_constraint` row. */
export async function checkIndexDrift(options: SchemaDriftOptions = {}): Promise<IndexDriftReport> {
  const timeoutMs = options.timeoutMs ?? SCHEMA_DRIFT_TIMEOUT_MS;
  const pgSchema = options.pgSchema ?? 'public';
  const started = performance.now();

  const query = client<RawIndexRow[]>`
    SELECT i.relname AS index_name,
           t.relname AS table_name,
           ix.indisunique AS is_unique,
           am.amname AS method,
           array(SELECT pg_get_indexdef(ix.indexrelid, k, true)
                 FROM generate_series(1, ix.indnkeyatts) k ORDER BY k) AS exprs,
           -- '' for the default operator class, not NULL: postgres.js decodes a
           -- NULL inside a text array as the string "NULL".
           array(SELECT CASE WHEN oc.opcdefault THEN '' ELSE oc.opcname::text END
                 FROM generate_series(0, ix.indnkeyatts - 1) k
                 JOIN pg_opclass oc ON oc.oid = ix.indclass[k] ORDER BY k) AS opclasses,
           array(SELECT (ix.indoption[k] & 1) = 1
                 FROM generate_series(0, ix.indnkeyatts - 1) k ORDER BY k) AS descs,
           array(SELECT (ix.indoption[k] & 2) = 2
                 FROM generate_series(0, ix.indnkeyatts - 1) k ORDER BY k) AS nulls_firsts,
           array(SELECT coalesce(NOT a.attnotnull, true)
                 FROM generate_series(0, ix.indnkeyatts - 1) k
                 LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[k]
                   AND ix.indkey[k] <> 0
                 ORDER BY k) AS nullables,
           pg_get_expr(ix.indpred, ix.indrelid, true) AS "where"
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = ${pgSchema}
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
  `;
  query.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: RawIndexRow[];
  try {
    raw = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SchemaDriftTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const rows: DatabaseIndexRow[] = raw.map((row) => ({
    index_name: row.index_name,
    table_name: row.table_name,
    is_unique: row.is_unique,
    method: row.method,
    keys: row.exprs.map((expr, k) =>
      keyForm(
        expr,
        row.opclasses[k] || null,
        row.descs[k] ?? false,
        row.nulls_firsts[k] ?? false,
        row.nullables[k] ?? true
      )
    ),
    where: row.where === null ? null : normaliseSql(row.where),
  }));

  const expected = expectedIndexes();
  const diff = diffIndexes(expected, rows);
  return {
    ok:
      diff.undeclared.length === 0 &&
      diff.missing.length === 0 &&
      diff.differing.length === 0 &&
      diff.staleExceptions.length === 0,
    ...diff,
    checkedIndexes: expected.size,
    latencyMs: Math.round(performance.now() - started),
  };
}

export function describeIndexDrift(report: IndexDriftReport): string {
  const names = [
    ...report.undeclared.map((n) => `undeclared ${n}`),
    ...report.missing.map((n) => `missing ${n}`),
    ...report.differing.map((d) => `definition ${d.name}`),
    ...report.staleExceptions.map((n) => `stale exception ${n}`),
  ];
  const shown = names.slice(0, NAMES_IN_MESSAGE).join(', ');
  const rest = names.length > NAMES_IN_MESSAGE ? ` (+${names.length - NAMES_IN_MESSAGE} more)` : '';
  return `indexes disagree with the drizzle declarations: ${shown}${rest}`;
}
