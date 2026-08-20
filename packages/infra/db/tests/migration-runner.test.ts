import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { sha256 } from '../src/migration-files';
import {
  applyMigrations,
  driftRefusalMessage,
  parseAssumeAppliedThrough,
} from '../src/migration-runner';

/**
 * The failure this replaces is not "two migrations had the same number". It is
 * that drizzle decides what is pending by comparing against ONE row — the
 * newest `created_at` — so a migration whose `when` lands at or below that
 * mark is skipped, nothing is recorded, and `db:migrate` exits 0.
 *
 * That makes merge ORDER the thing that breaks, not name collision, and the
 * only honest test of it is the real thing: apply one branch's migration to a
 * real Postgres, then apply the other branch's on top, in both orders. Under
 * the old runner one of the two orders silently lost a migration; both cases
 * are below, and both now apply.
 *
 * Every test works inside its own schema, so the suite can run against the
 * same database as everything else — including the already-migrated scratch
 * database `scripts/gate-db.ts` hands it.
 */
const DATABASE_URL = process.env.DATABASE_URL;

let sql: postgres.Sql;
const schemas: string[] = [];

beforeAll(() => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for migration-runner tests');
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  for (const schema of schemas) {
    await sql.unsafe(`drop schema if exists "${schema}" cascade`);
  }
  await sql.end();
});

function newSchema(): string {
  const schema = `mig_${crypto.randomUUID().replace(/-/g, '')}`;
  schemas.push(schema);
  return schema;
}

async function folder(files: Record<string, string>): Promise<string> {
  const dir = path.join(process.env.TMPDIR ?? '/tmp', `scani-runner-${crypto.randomUUID()}`);
  for (const [name, body] of Object.entries(files)) await Bun.write(path.join(dir, name), body);
  return dir;
}

/** A migration whose effect is observable and which fails loudly if re-run. */
function creates(schema: string, table: string): string {
  return `create table "${schema}"."${table}" (id int primary key)`;
}

function run(dir: string, schema: string, assumeAppliedThrough: string | null = null) {
  return applyMigrations(sql, {
    folder: dir,
    schema,
    table: 'applied',
    legacyTable: 'legacy_drizzle',
    assumeAppliedThrough,
  });
}

async function tables(schema: string): Promise<string[]> {
  const rows = (await sql.unsafe(
    'select table_name from information_schema.tables where table_schema = $1 order by table_name',
    [schema]
  )) as Array<{ table_name: string }>;
  return rows.map((row) => row.table_name);
}

describe('applyMigrations', () => {
  test('applies every migration in filename order on an empty database', async () => {
    const schema = newSchema();
    const dir = await folder({
      '20260817100000_first.sql': creates(schema, 'a_first'),
      '20260817110000_second.sql': creates(schema, 'b_second'),
    });

    const result = await run(dir, schema);

    expect(result.applied).toEqual(['20260817100000_first', '20260817110000_second']);
    expect(await tables(schema)).toEqual(['a_first', 'applied', 'b_second']);
  });

  test('a second run applies nothing', async () => {
    const schema = newSchema();
    const dir = await folder({ '20260817100000_first.sql': creates(schema, 'a_first') });

    await run(dir, schema);
    const second = await run(dir, schema);

    // `create table` without IF NOT EXISTS: if this re-ran, it would throw
    // rather than return an empty list, so the assertion cannot pass for the
    // wrong reason.
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['20260817100000_first']);
  });

  test('merge order A then B: a migration authored EARLIER still applies', async () => {
    // The exact silent loss. Branch A stamped 12:00, branch B stamped 11:00,
    // B merged second. Under a high-water mark B is at or below the mark and
    // is skipped with a green exit code; here it is simply not recorded yet,
    // so it runs.
    const schema = newSchema();
    const first = await folder({ '20260817120000_branch_a.sql': creates(schema, 'branch_a') });
    await run(first, schema);

    const merged = await folder({
      '20260817120000_branch_a.sql': creates(schema, 'branch_a'),
      '20260817110000_branch_b.sql': creates(schema, 'branch_b'),
    });
    const result = await run(merged, schema);

    expect(result.applied).toEqual(['20260817110000_branch_b']);
    expect(await tables(schema)).toContain('branch_b');
  });

  test('merge order B then A: a migration authored LATER still applies', async () => {
    const schema = newSchema();
    const first = await folder({ '20260817110000_branch_b.sql': creates(schema, 'branch_b') });
    await run(first, schema);

    const merged = await folder({
      '20260817120000_branch_a.sql': creates(schema, 'branch_a'),
      '20260817110000_branch_b.sql': creates(schema, 'branch_b'),
    });
    const result = await run(merged, schema);

    expect(result.applied).toEqual(['20260817120000_branch_a']);
    expect(await tables(schema)).toContain('branch_a');
  });

  test('both merge orders reach the same schema', async () => {
    const [left, right] = [newSchema(), newSchema()];
    const a = (schema: string) => creates(schema, 'branch_a');
    const b = (schema: string) => creates(schema, 'branch_b');

    for (const [schema, firstIn] of [
      [left, 'a'],
      [right, 'b'],
    ] as const) {
      const solo = await folder(
        firstIn === 'a'
          ? { '20260817120000_branch_a.sql': a(schema) }
          : { '20260817110000_branch_b.sql': b(schema) }
      );
      await run(solo, schema);
      const merged = await folder({
        '20260817120000_branch_a.sql': a(schema),
        '20260817110000_branch_b.sql': b(schema),
      });
      await run(merged, schema);
    }

    expect(await tables(left)).toEqual(await tables(right));
    expect(await tables(left)).toEqual(['applied', 'branch_a', 'branch_b']);
  });

  test('adopts what drizzle already applied, by count, without re-running it', async () => {
    const schema = newSchema();
    const firstSql = creates(schema, 'already_there');
    const dir = await folder({
      '0001_already_there.sql': firstSql,
      '20260817120000_new_one.sql': creates(schema, 'new_one'),
    });

    // Stand in for a database drizzle migrated: the effect is present and its
    // hash is recorded in drizzle's own table.
    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(firstSql);
    await sql.unsafe(
      `create table "${schema}"."legacy_drizzle" (id serial primary key, hash text not null, created_at bigint)`
    );
    await sql.unsafe(`insert into "${schema}"."legacy_drizzle" (hash, created_at) values ($1, 1)`, [
      sha256(firstSql),
    ]);

    const result = await run(dir, schema);

    expect(result.adopted).toEqual(['0001_already_there']);
    expect(result.applied).toEqual(['20260817120000_new_one']);
    expect(result.legacyDrift).toEqual([]);
  });

  test('reports — and does not re-run — a migration edited after it shipped', async () => {
    // 0014 and 0040 were both edited after they had already run somewhere, so
    // production records a hash no file in the tree produces. Refusing there
    // would block a deploy over something no deploy can put right; the honest
    // move is to say so and leave the database as the record of what ran.
    const schema = newSchema();
    const shipped = creates(schema, 'shipped');
    const dir = await folder({ '0001_shipped.sql': `${shipped};\n-- corrected afterwards` });

    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(shipped);
    await sql.unsafe(
      `create table "${schema}"."legacy_drizzle" (id serial primary key, hash text not null, created_at bigint)`
    );
    await sql.unsafe(`insert into "${schema}"."legacy_drizzle" (hash, created_at) values ($1, 1)`, [
      sha256(shipped),
    ]);

    const result = await run(dir, schema);

    expect(result.adopted).toEqual(['0001_shipped']);
    expect(result.legacyDrift).toEqual(['0001_shipped']);
    expect(result.applied).toEqual([]);
  });

  test('refuses when the database has applied more migrations than the tree has', async () => {
    const schema = newSchema();
    const dir = await folder({ '0001_only_one.sql': creates(schema, 'only_one') });

    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(
      `create table "${schema}"."legacy_drizzle" (id serial primary key, hash text not null, created_at bigint)`
    );
    await sql.unsafe(
      `insert into "${schema}"."legacy_drizzle" (hash, created_at) values ('x', 1), ('y', 2)`
    );

    await expect(run(dir, schema)).rejects.toThrow(/older than the schema/);
  });

  test('refuses when an applied migration has been edited', async () => {
    const schema = newSchema();
    const dir = await folder({ '20260817120000_edited.sql': creates(schema, 'edited') });
    await run(dir, schema);

    await Bun.write(
      path.join(dir, '20260817120000_edited.sql'),
      `${creates(schema, 'edited')};\nselect 1`
    );

    await expect(run(dir, schema)).rejects.toThrow(/edited after they ran/);
  });

  test('the refusal names the pending migrations it is holding back (SC-401)', async () => {
    // The reported shape: one migration edited on main after it had already
    // run here, and unrelated migrations that have never run. Refusing them
    // all is the decision; not SAYING so is what read as a broken migrator
    // and sent two threads to psql.
    const schema = newSchema();
    const dir = await folder({ '20260817120000_edited.sql': creates(schema, 'edited') });
    await run(dir, schema);

    await Bun.write(
      path.join(dir, '20260817120000_edited.sql'),
      `${creates(schema, 'edited')};\nselect 1`
    );
    await Bun.write(path.join(dir, '20260818090000_unrelated.sql'), creates(schema, 'unrelated'));
    await Bun.write(path.join(dir, '20260818100000_also.sql'), creates(schema, 'also'));

    const error = await run(dir, schema).catch((e: Error) => e);
    const message = (error as Error).message;

    expect(message).toContain('20260817120000_edited');
    expect(message).toContain('holds back 2 migration(s)');
    expect(message).toContain('20260818090000_unrelated');
    expect(message).toContain('20260818100000_also');

    // And it held them back — the point of the check, not just of the message.
    expect(await tables(schema)).toEqual(['applied', 'edited']);
  });

  test('editing a migration that has NOT been applied yet is not drift', async () => {
    // The negative control for the check's scope. Drift is a claim about what
    // this database already ran; a pending file is still being authored, and
    // rewriting it must stay free.
    const schema = newSchema();
    const dir = await folder({ '20260817120000_first.sql': creates(schema, 'first') });
    await run(dir, schema);

    await Bun.write(path.join(dir, '20260818090000_second.sql'), 'select 1');
    await Bun.write(path.join(dir, '20260818090000_second.sql'), creates(schema, 'second'));

    const result = await run(dir, schema);
    expect(result.applied).toEqual(['20260818090000_second']);
    expect(await tables(schema)).toEqual(['applied', 'first', 'second']);
  });

  test('refuses when an applied migration has been deleted or renamed', async () => {
    const schema = newSchema();
    const dir = await folder({
      '20260817120000_kept.sql': creates(schema, 'kept'),
      '20260817130000_removed.sql': creates(schema, 'removed'),
    });
    await run(dir, schema);

    unlinkSync(path.join(dir, '20260817130000_removed.sql'));

    await expect(run(dir, schema)).rejects.toThrow(/missing from this tree/);
  });

  test('--assume-applied-through adopts up to a named tag', async () => {
    // The one recovery path for a database restored from a dump, where the
    // effects are present and no record of them is.
    const schema = newSchema();
    const alreadyThere = creates(schema, 'restored');
    const dir = await folder({
      '20260817120000_restored.sql': alreadyThere,
      '20260817130000_next.sql': creates(schema, 'next_one'),
    });
    await sql.unsafe(`create schema if not exists "${schema}"`);
    await sql.unsafe(alreadyThere);

    const result = await run(dir, schema, '20260817120000_restored');

    expect(result.adopted).toEqual(['20260817120000_restored']);
    expect(result.applied).toEqual(['20260817130000_next']);
  });

  test('--assume-applied-through refuses a tag that is not in the tree', async () => {
    const schema = newSchema();
    const dir = await folder({ '20260817120000_only.sql': creates(schema, 'only_one') });

    await expect(run(dir, schema, '20260817999999_typo')).rejects.toThrow(/no such migration/);
  });

  test('splits on the same breakpoint marker drizzle does', async () => {
    const schema = newSchema();
    const dir = await folder({
      '20260817120000_two_statements.sql': `${creates(schema, 'one')};\n--> statement-breakpoint\n${creates(schema, 'two')};`,
    });

    await run(dir, schema);

    expect(await tables(schema)).toEqual(['applied', 'one', 'two']);
  });
});

describe('parseAssumeAppliedThrough', () => {
  test('reads both argument forms', () => {
    expect(
      parseAssumeAppliedThrough(['bun', 'migrate', '--assume-applied-through', '0049_x'])
    ).toBe('0049_x');
    expect(parseAssumeAppliedThrough(['bun', '--assume-applied-through=0049_x'])).toBe('0049_x');
  });

  test('is absent by default and empty when the value is missing', () => {
    expect(parseAssumeAppliedThrough(['bun', 'migrate'])).toBeNull();
    expect(parseAssumeAppliedThrough(['bun', '--assume-applied-through'])).toBe('');
  });
});

describe('driftRefusalMessage', () => {
  const drift = [
    { tag: '20260818021506_keyed_on_address', recorded: 'a'.repeat(64), found: 'b'.repeat(64) },
  ];

  test('carries the evidence, not just the tag', () => {
    const message = driftRefusalMessage(drift, []);
    expect(message).toContain('20260818021506_keyed_on_address');
    expect(message).toContain('aaaaaaaaaaaa');
    expect(message).toContain('bbbbbbbbbbbb');
  });

  test('names a remedy that replaces the database rather than its record', () => {
    const message = driftRefusalMessage(drift, []);
    expect(message).toContain('bun scripts/gate-db.ts');
    expect(message).toContain('bun run db:new');
    // Never suggest editing what the database recorded — that is the thing
    // this check measures, and the workaround it has to displace.
    expect(message).not.toContain('__scani_migrations');
  });

  test('leads with the recovery the reader can take alone (SC-431)', () => {
    const message = driftRefusalMessage(drift, []);
    expect(message).toContain('bun run db:dev -- --reset');
    // The shared compose database is named so the reader knows which one they
    // are on, but dropping it is never offered as a command to run: it is a
    // claim about everyone connected to it, and since SC-429 nothing needs it.
    expect(message).not.toContain('drop database scani');
    expect(message).toContain('not to drop it');
  });

  test('names BOTH causes, because it cannot tell them apart (SC-431)', () => {
    // The instance that produced SC-429 and SC-431 is the second one: the
    // recorded hash appears in no commit, so there is no edit to undo. A
    // message that names only the first sends that reader looking for a change
    // nobody made.
    const message = driftRefusalMessage(drift, []);
    expect(message).toContain('EDITED in the tree');
    expect(message).toContain('ran a DRAFT');
    expect(message).toContain('cannot be known');
  });

  test('says nothing about held-back work when there is none', () => {
    // The shared database in the SC-401 report reaches this branch: the three
    // pending migrations had already been applied by hand. "holds back 0" is
    // the kind of line that makes a reader distrust the rest of the message.
    const message = driftRefusalMessage(drift, []);
    expect(message).not.toContain('holds back');
    expect(message).not.toContain('0 migration(s)');
  });
});
