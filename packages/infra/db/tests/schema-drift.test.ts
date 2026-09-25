import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import {
  checkIndexDrift,
  checkSchemaDrift,
  type DatabaseIndexRow,
  describeIndexDrift,
  describeSchemaDrift,
  diffIndexes,
  diffSchema,
  expectedIndexes,
  expectedSchema,
  INDEX_EXCEPTIONS,
  type IndexShape,
  normaliseSql,
  type SchemaDriftReport,
  truncateIdentifier,
} from '../src/schema-drift';

/**
 * SC-480. On 2026-08-20 a deploy omitted the `migrate` target, so the api
 * selected `users.cost_basis_method` against a database that did not have it
 * and sign-in failed for about six hours. `/health/deep` reported db, redis,
 * r2 and ai all ok throughout, because its db check is `SELECT 1` — a query
 * that names no column of any table a deploy can change, and is therefore
 * blind to this failure BY CONSTRUCTION.
 *
 * The negative case is the one worth having: a guard nobody has watched
 * refuse has not been tested. So `users` is rebuilt in a throwaway schema with
 * one column left out, generated from the drizzle column list itself — which
 * keeps the fixture honest as the table grows.
 */
const DATABASE_URL = process.env.DATABASE_URL;
/**
 * The column the fixtures leave out. `users.email` rather than the
 * `cost_basis_method` of the outage itself: this file is mirrored between two
 * repositories whose schemas are not at the same migration, and a fixture
 * keyed on a column only one of them has tests nothing in the other. The
 * mechanism is the same either way — the real-database test below compares
 * every column of every table, so the outage column is covered there, by name,
 * wherever it exists.
 */
const OMITTED_COLUMN = 'email';

let sql: postgres.Sql;
const schemas: string[] = [];

beforeAll(() => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for schema-drift tests');
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  for (const schema of schemas) {
    await sql.unsafe(`drop schema if exists "${schema}" cascade`);
  }
  await sql.end();
});

async function newSchema(): Promise<string> {
  const schema = `drift_${crypto.randomUUID().replace(/-/g, '')}`;
  schemas.push(schema);
  await sql.unsafe(`create schema "${schema}"`);
  return schema;
}

/**
 * Every table the code expects, with the named columns left out. Types are
 * irrelevant — `information_schema.columns` is being asked for names.
 */
async function materialise(schema: string, omit: readonly string[]): Promise<void> {
  for (const [table, columns] of expectedSchema()) {
    const kept = [...columns].filter((c) => !omit.includes(`${table}.${c}`));
    const body = kept.map((c) => `"${c}" text`).join(', ');
    await sql.unsafe(`create table "${schema}"."${table}" (${body})`);
  }
}

describe('diffSchema', () => {
  const expected = new Map([['users', new Set(['id', 'name', OMITTED_COLUMN])]]);

  test('a column the code selects and the database lacks is drift', () => {
    const result = diffSchema(expected, [
      { table_name: 'users', column_name: 'id' },
      { table_name: 'users', column_name: 'name' },
    ]);
    expect(result.missingColumns).toEqual([`users.${OMITTED_COLUMN}`]);
    expect(result.missingTables).toEqual([]);
  });

  test('a column the database has and the code does not is NOT drift', () => {
    // The ordinary state between an expand migration and the build that stops
    // reading the field. `migrate` runs first in the deploy chain on purpose,
    // so this direction is expected — reporting it would make the probe red on
    // every deploy, and a probe that is always red is one nobody reads.
    const result = diffSchema(expected, [
      { table_name: 'users', column_name: 'id' },
      { table_name: 'users', column_name: 'name' },
      { table_name: 'users', column_name: OMITTED_COLUMN },
      { table_name: 'users', column_name: 'legacy_field' },
    ]);
    expect(result.missingColumns).toEqual([]);
    expect(result.missingTables).toEqual([]);
  });

  test('a table with no counterpart is reported once, not column by column', () => {
    const result = diffSchema(expected, []);
    expect(result.missingTables).toEqual(['users']);
    expect(result.missingColumns).toEqual([]);
  });
});

describe('describeSchemaDrift', () => {
  test('names a column and the command that repairs it', () => {
    const report: SchemaDriftReport = {
      ok: false,
      missingTables: [],
      missingColumns: [`users.${OMITTED_COLUMN}`],
      checkedTables: 50,
      latencyMs: 3,
    };
    const message = describeSchemaDrift(report);
    expect(message).toContain(`users.${OMITTED_COLUMN}`);
    // "schema drift" alone does not tell the reader which target was omitted,
    // and the line has to say a MIGRATION is what is missing.
    expect(message).toContain('an unapplied migration');
    // SC-729: it must not prescribe one deployment's script to every reader.
    expect(message).not.toContain('deploy-local.sh');
  });

  test('summarises rather than printing every name', () => {
    const report: SchemaDriftReport = {
      ok: false,
      missingTables: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      missingColumns: [],
      checkedTables: 50,
      latencyMs: 3,
    };
    expect(describeSchemaDrift(report)).toContain('+2 more');
  });
});

describe('checkSchemaDrift against a real database', () => {
  test('the migrated schema this suite runs on matches the code', async () => {
    const report = await checkSchemaDrift();
    expect(report.checkedTables).toBeGreaterThan(0);
    expect({ tables: report.missingTables, columns: report.missingColumns }).toEqual({
      tables: [],
      columns: [],
    });
    expect(report.ok).toBe(true);
  });

  test('the SC-462 shape: a users table missing one column is reported', async () => {
    const schema = await newSchema();
    await materialise(schema, [`users.${OMITTED_COLUMN}`]);

    const report = await checkSchemaDrift({ pgSchema: schema });

    expect(report.ok).toBe(false);
    expect(report.missingColumns).toEqual([`users.${OMITTED_COLUMN}`]);
    expect(report.missingTables).toEqual([]);
    expect(describeSchemaDrift(report)).toContain(`users.${OMITTED_COLUMN}`);
  });

  test('an empty database reports every table rather than passing', async () => {
    const schema = await newSchema();
    const report = await checkSchemaDrift({ pgSchema: schema });
    expect(report.ok).toBe(false);
    expect(report.missingTables).toContain('users');
    expect(report.missingTables.length).toBe(report.checkedTables);
  });
});

describe('expectedSchema', () => {
  test('reads the drizzle tables rather than a hand-written list', () => {
    const expected = expectedSchema();
    // Non-vacuous: if drizzle stops exposing the column list, this fails
    // rather than the probe silently comparing nothing against nothing.
    expect(expected.size).toBeGreaterThanOrEqual(10);
    expect([...(expected.get('users') ?? [])]).toContain(OMITTED_COLUMN);
  });
});

/**
 * SC-946. SC-938's index was in every deployed database and declared nowhere
 * for 15 days, and the column probe above cannot see an index by
 * construction. The direction that bit was the DECLARATION missing, so the
 * comparison runs both ways and compares full definitions.
 */
describe('index drift (SC-946)', () => {
  test('the migrated schema this suite runs on matches every declared index', async () => {
    const report = await checkIndexDrift({ timeoutMs: 10_000 });
    // Non-vacuous: a drizzle that stopped exposing indexes would compare nothing.
    expect(report.checkedIndexes).toBeGreaterThan(50);
    expect({
      undeclared: report.undeclared,
      missing: report.missing,
      differing: report.differing.map((d) => d.name),
      staleExceptions: report.staleExceptions,
    }).toEqual({ undeclared: [], missing: [], differing: [], staleExceptions: [] });
    expect(report.ok).toBe(true);
  });

  test('an undeclared index is named, and constraint-backed ones are excluded by rule', async () => {
    const schema = await newSchema();
    await sql.unsafe(
      `create table "${schema}"."users" (id text primary key, email text, handle text unique)`
    );
    await sql.unsafe(`create index zz_undeclared_idx on "${schema}"."users" (handle)`);
    const report = await checkIndexDrift({ pgSchema: schema, timeoutMs: 10_000 });
    expect(report.undeclared).toEqual(['users.zz_undeclared_idx']);
    // The control: the primary key and the UNIQUE constraint each own an index
    // that no drizzle `index()` can declare, and neither may be flagged.
    expect(report.undeclared.join()).not.toContain('users_pkey');
    expect(report.undeclared.join()).not.toContain('users_handle_key');
  });

  test('a definition that differs only in its expression is drift; the same name on the right one is not', async () => {
    const schema = await newSchema();
    await sql.unsafe(`create table "${schema}"."users" (id text primary key, email text)`);
    await sql.unsafe(`create unique index users_email_lower_unique on "${schema}"."users" (email)`);
    const wrong = await checkIndexDrift({ pgSchema: schema, timeoutMs: 10_000 });
    expect(wrong.differing.map((d) => d.name)).toEqual(['users_email_lower_unique']);

    await sql.unsafe(`drop index "${schema}".users_email_lower_unique`);
    await sql.unsafe(
      `create unique index users_email_lower_unique on "${schema}"."users" (lower(email))`
    );
    const right = await checkIndexDrift({ pgSchema: schema, timeoutMs: 10_000 });
    expect(right.differing.map((d) => d.name)).toEqual([]);
    expect(right.missing).not.toContain('users.users_email_lower_unique');
  });

  test('the message names each kind of disagreement', () => {
    const shape: IndexShape = {
      table: 't',
      unique: false,
      method: 'btree',
      keys: ['a'],
      where: null,
    };
    const message = describeIndexDrift({
      ok: false,
      undeclared: ['t.u_idx'],
      missing: ['t.m_idx'],
      differing: [{ name: 'd_idx', database: shape, declared: { ...shape, keys: ['b'] } }],
      staleExceptions: ['s_idx'],
      checkedIndexes: 4,
      latencyMs: 1,
    });
    for (const part of [
      'undeclared t.u_idx',
      'missing t.m_idx',
      'definition d_idx',
      'stale exception s_idx',
    ]) {
      expect(message).toContain(part);
    }
  });

  test('a declared index the database lacks is named', () => {
    const declared: IndexShape = {
      table: 't',
      unique: false,
      method: 'btree',
      keys: ['a'],
      where: null,
    };
    const result = diffIndexes(new Map([['t_a_idx', declared]]), [], {});
    expect(result.missing).toEqual(['t.t_a_idx']);
  });

  test('an exception whose index is gone goes red, so the list cannot rot', () => {
    const row: DatabaseIndexRow = {
      index_name: 'kept_idx',
      table_name: 't',
      is_unique: false,
      method: 'btree',
      keys: ['a'],
      where: null,
    };
    const exceptions = {
      kept_idx: { reason: 'r', migration: 'm' },
      gone_idx: { reason: 'r', migration: 'm' },
    };
    const result = diffIndexes(new Map(), [row], exceptions);
    expect(result.undeclared).toEqual([]);
    expect(result.staleExceptions).toEqual(['gone_idx']);
  });

  test('every exception names a reason and a migration that exists', async () => {
    for (const [name, entry] of Object.entries(INDEX_EXCEPTIONS)) {
      expect(entry.reason.length).toBeGreaterThan(20);
      const file = Bun.file(new URL(`../src/migrations/${entry.migration}`, import.meta.url));
      expect(await file.text()).toContain(name);
    }
  });

  test('a name drizzle declares longer than Postgres stores is compared as Postgres stores it', () => {
    const long =
      'portfolio_value_daily_user_id_scope_kind_scope_id_snapshot_date_base_currency_id_pk';
    expect(truncateIdentifier(long)).toBe(
      'portfolio_value_daily_user_id_scope_kind_scope_id_snapshot_date'
    );
    expect(truncateIdentifier('short_idx')).toBe('short_idx');
    for (const name of expectedIndexes().keys()) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
    }
  });

  describe('normaliseSql — each rule is one a real sweep needed', () => {
    test('drizzle qualifies columns with the table and Postgres does not', () => {
      expect(normaliseSql('"users"."email" IS NOT NULL')).toBe(normaliseSql('email IS NOT NULL'));
    });

    test('Postgres rewrites IN (…) as = ANY (ARRAY[…]) with casts', () => {
      expect(normaliseSql("kind IN ('withdraw', 'transfer_out')")).toBe(
        normaliseSql("(kind = ANY (ARRAY['withdraw'::text, 'transfer_out'::text]))")
      );
    });

    test('a cast is dropped without swallowing the clause after it', () => {
      expect(
        normaliseSql('"holdings"."balance"::numeric > 0 AND "holdings"."is_hidden" = false')
      ).toBe(normaliseSql('((balance)::numeric > (0)::numeric) AND (is_hidden = false)'));
      expect(normaliseSql('a::numeric > 0 AND b = 1')).toContain('andb=1');
      expect(normaliseSql('x::timestamp with time zone > now() AND y')).toContain('andy');
    });

    test('the control: a real difference survives normalisation', () => {
      expect(normaliseSql('email')).not.toBe(normaliseSql('lower(email)'));
      expect(normaliseSql('a > 0')).not.toBe(normaliseSql('a = 0'));
    });
  });
});
