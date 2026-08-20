import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
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
 * "schema drift" alone does not tell anyone which target was omitted — and
 * the recovery is `scripts/deploy-local.sh migrate`, which only helps if the
 * reader knows a migration is what is missing.
 */
export function describeSchemaDrift(report: SchemaDriftReport): string {
  const names = [...report.missingTables, ...report.missingColumns];
  const shown = names.slice(0, NAMES_IN_MESSAGE).join(', ');
  const rest = names.length > NAMES_IN_MESSAGE ? ` (+${names.length - NAMES_IN_MESSAGE} more)` : '';
  return `database is behind this build: ${shown}${rest} — an unapplied migration; run: scripts/deploy-local.sh migrate`;
}
