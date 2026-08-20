import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import {
  checkSchemaDrift,
  describeSchemaDrift,
  diffSchema,
  expectedSchema,
  type SchemaDriftReport,
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
    // "schema drift" alone does not tell the reader which target was omitted.
    expect(message).toContain('scripts/deploy-local.sh migrate');
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
