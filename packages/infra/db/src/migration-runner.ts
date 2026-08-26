import type { Sql, TransactionSql } from 'postgres';
import { advisoryLockKey } from './advisory-lock-key';
import { type MigrationFile, readMigrationFiles } from './migration-files';

/**
 * Applies migrations by NAME, one row per migration, instead of by drizzle's
 * high-water mark. This is the root fix for SC-335; the naming scheme in
 * `migration-files.ts` is only the half of it that a human sees.
 *
 * drizzle's own migrator decides what is pending like this:
 *
 *     select created_at from drizzle.__drizzle_migrations
 *       order by created_at desc limit 1        -- one row: the high-water mark
 *     ...
 *     if (mark < migration.when) { apply }
 *
 * So `when` is not required to be unique. It is required to be **greater than
 * every `when` already applied in production** — and that value cannot be
 * computed on a branch, because it depends on which of the open PRs merges
 * first. Every "pick a number that cannot collide" scheme fails on this and
 * fails the same way: a uuid, a content hash and an authoring timestamp are
 * all perfectly unique and all able to land BELOW the mark, at which point
 * drizzle skips the migration, records nothing, and exits 0. That is how
 * SC-290 lost 0040 on every deployed database while a fresh one looked fine.
 *
 * Tracking each migration individually retires the whole class:
 *
 *   - order stops being a shared resource, so two branches never contend;
 *   - a migration that has not run is pending no matter what it is called or
 *     what else has run since;
 *   - nothing is ever skipped silently, because "skip" is now only ever
 *     "this exact name is already recorded".
 *
 * The cost, stated plainly: two migrations merged from two branches apply in
 * name order on a fresh database and in merge order on a database that was
 * already up to date. If one depends on the other, the second fails LOUDLY
 * with a Postgres error naming the missing object — which is the trade this
 * task asked for, against a green deploy that silently did nothing.
 */

const LOCK_KEY = 'scani:db:migrations';

/** Same marker drizzle splits on, so existing migrations behave identically. */
const BREAKPOINT = '--> statement-breakpoint';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export interface MigrationRunnerOptions {
  folder: string;
  schema?: string;
  table?: string;
  /** drizzle's own table, read once to adopt migrations applied before SC-335. */
  legacyTable?: string;
  /**
   * Escape hatch for a database whose applied set cannot be read from the
   * legacy table (it was dropped, or the schema was restored from a dump).
   * Adopts every migration up to and including this tag without running it.
   */
  assumeAppliedThrough?: string | null;
  log?: (line: string) => void;
}

export interface MigrationRunResult {
  /** Recorded as already-applied from the legacy table (or the escape hatch). */
  adopted: string[];
  applied: string[];
  alreadyApplied: string[];
  /**
   * Adopted migrations whose file no longer hashes to what drizzle recorded —
   * the file was edited after it had already run somewhere. Reported, never
   * fixed: the database is the record of what ran, and re-running is not the
   * safe assumption.
   */
  legacyDrift: string[];
}

/**
 * `--assume-applied-through <tag>`. Whole-argv scan for the same reason
 * `parseAllowRemote` does it: under `bun --compile` the leading entries differ
 * from a source run, and neither form can produce this literal by accident.
 */
export function parseAssumeAppliedThrough(argv: readonly string[]): string | null {
  const flag = '--assume-applied-through';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1] ?? '';
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

function quote(identifier: string, what: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error(`unusable ${what} name: ${identifier}`);
  return `"${identifier}"`;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

async function tableExists(sql: Sql | TransactionSql, qualified: string): Promise<boolean> {
  const rows = (await sql.unsafe('select to_regclass($1) as oid', [qualified])) as Array<{
    oid: string | null;
  }>;
  return rows[0]?.oid != null;
}

/**
 * Which files the legacy table says already ran.
 *
 * By COUNT, in name order — not by matching hashes. drizzle applied the
 * journal in ascending index order and the filename prefix carries that
 * index, so the first N files are exactly the N it recorded. Hashes are
 * checked afterwards and only reported, because a migration edited after it
 * shipped (0014 and 0040 both were) would otherwise refuse a deploy over
 * something no deploy can put right.
 */
function adoptFromLegacy(files: MigrationFile[], legacyHashes: string[]): MigrationFile[] {
  if (legacyHashes.length > files.length) {
    throw new Error(
      `the database records ${legacyHashes.length} applied migrations but this tree has ` +
        `${files.length}. Refusing: that means the deploy is older than the schema it is ` +
        'migrating, and applying it would run nothing while reporting success.'
    );
  }
  return files.slice(0, legacyHashes.length);
}

export interface AppliedDrift {
  tag: string;
  /** The sha256 this database recorded when the migration ran. */
  recorded: string;
  /** What the file in this tree hashes to now. */
  found: string;
}

/**
 * Why an edited migration refuses the WHOLE run and not just itself (SC-401).
 *
 * "Refuse only the edited one" is already the behaviour, and it is not the
 * question: a migration that has run is never in `pending`, so nothing would
 * re-run it either way. The real choice is whether the OTHER migrations — the
 * ones legitimately pending, whose names have nothing to do with the edit —
 * get applied on top. They do not, for two reasons.
 *
 * The first is that the runner cannot tell whether they are independent. It
 * knows their filenames and their SQL; it does not know whether the edited
 * migration's changed content is what they build on. Applying them lands DDL
 * on a base this tree can no longer describe, which is the one outcome this
 * file exists to prevent. Reporting it instead does not help: everything here
 * runs inside one `sql.begin`, so continuing means committing, and a warning
 * on a run that exits 0 is read by nobody — that is exactly how SC-290 lost a
 * migration on every deployed database while the deploy went green.
 *
 * The second is that "it is only my dev box" cannot be established from here.
 * The obvious proxy, a loopback host, is not one: `fly proxy` and Neon's proxy
 * both present production on 127.0.0.1, and this repo uses that pattern.
 * `migrate-target.ts` may lean on loopback because it is gating FRICTION; a
 * correctness check cannot borrow the same signal.
 *
 * What was actually wrong was the blast radius of the MESSAGE. The old one
 * named the edited tag and told the reader to add a new migration — advice
 * that does nothing for the person hitting this, because on the machine where
 * it was reported the edit was on `main` and the stale side was their local
 * database. It never said that four unrelated migrations were being held
 * back, so the run read as "the migrator is broken", and two threads went and
 * hand-inserted rows into `drizzle.__scani_migrations` with psql to get a
 * working stack. A guard with no stated remedy does not stop that; it just
 * stops seeing it. So the message now carries the evidence, what is being
 * held back, and the recovery that replaces the database rather than editing
 * its record of what ran.
 *
 * **What SC-431 changed, and it is the remedy and not the refusal.** The
 * refusal stays total for the reasons above; a hash-only drift is not
 * distinguishable from a schema-diverging one from inside this function, which
 * is the whole reason it cannot soften. What was wrong is that the remedy it
 * named was one the reader is often not entitled to take. It led with
 * `drop database scani` — a claim about everyone connected to a database
 * several people share — and it predated the give-the-run-its-own-database
 * recovery by one merge, so the recovery that IS unilateral was not in it. It
 * also named only one cause. The instance that produced SC-429 and SC-431 is
 * the OTHER one: the recorded hash
 * for `20260818021506` appears in no commit on any ref, so nobody edited
 * shipped history — the shared database ran a draft while the file was still
 * being written. "Undo the edit" is advice with no edit to undo.
 *
 * Deliberately still absent: a flag that re-records the hash after an operator
 * asserts the schemas match. It cannot tell the two causes apart either, so it
 * would let a divergent schema apply silently in exactly the case this check
 * exists for — and it is the `psql` hand-edit of the migrations table that this
 * message was written to displace, with a blessing attached.
 */
export function driftRefusalMessage(
  drifted: readonly AppliedDrift[],
  pending: readonly string[]
): string {
  const short = (hash: string) => (hash ? `${hash.slice(0, 12)}…` : '<no file>');
  const lines = [
    `applied migration(s) edited after they ran: ${drifted.length}`,
    ...drifted.flatMap((entry) => [
      `  ${entry.tag}`,
      `    ran with sha256 ${short(entry.recorded)}  ·  file now hashes to ${short(entry.found)}`,
    ]),
    '',
    '  Editing a migration that has already run changes nothing in a database that',
    '  already has it, so this tree and this database no longer describe the same',
    '  schema.',
  ];

  if (pending.length > 0) {
    lines.push(
      '',
      `  Refusing the whole run, which holds back ${pending.length} migration(s) that have`,
      '  not been applied here yet:',
      ...pending.map((tag) => `    ${tag}`),
      '',
      '  Their names have nothing to do with the edit; whether their SQL does cannot be',
      '  known from here, and applying them onto a base this tree can no longer describe',
      '  is the failure this check exists to prevent.'
    );
  }

  lines.push(
    '',
    '  TWO different things produce this, and which one you are in cannot be known',
    '  from here — the runner sees two hashes, not the history that made them differ:',
    '',
    '    1. A migration that had already shipped was EDITED in the tree. The edit is',
    '       what to undo: restore the file to what actually ran, and put the change',
    '       in a new migration (`cd packages/infra/db && bun run db:new "<what it does>"`).',
    '    2. This database ran a DRAFT — a migration applied while it was still being',
    '       written, then edited before it merged. Nothing is wrong with the tree and',
    '       there is no edit to undo; this database is the stale side, and replacing',
    '       it is the only honest repair.',
    '',
    '  For (2), replace the database rather than its record of what ran. Give the run',
    '  a database of its own, migrated from empty — it never meets this at all:',
    '',
    '        docker compose exec -T postgres createdb -U scani scani_test_$$',
    '        DATABASE_URL=postgres://scani:scani@localhost:5433/scani_test_$$ \\',
    '          bun run db:migrate && bun run test',
    '',
    '  Any empty database reachable from here will do; the two commands above are',
    '  just the compose route this repo ships.',
    '',
    '  The shared compose database `scani` is a third thing and is NOT yours to',
    '  replace: dropping one several people are connected to is a claim about all of',
    '  them. A database of your own costs one `createdb`, so the answer there is to',
    '  stop using the shared one, not to drop it.'
  );

  return lines.join('\n');
}

export async function applyMigrations(
  sql: Sql,
  options: MigrationRunnerOptions
): Promise<MigrationRunResult> {
  const schema = options.schema ?? 'drizzle';
  const table = options.table ?? '__scani_migrations';
  const legacyTable = options.legacyTable ?? '__drizzle_migrations';
  const log = options.log ?? (() => {});

  const files = readMigrationFiles(options.folder);
  const byTag = new Map(files.map((file) => [file.tag, file]));

  const schemaId = quote(schema, 'schema');
  const tableId = `${schemaId}.${quote(table, 'table')}`;
  const legacyId = `${schemaId}.${quote(legacyTable, 'table')}`;

  await sql.unsafe(`create schema if not exists ${schemaId}`);
  await sql.unsafe(`
    create table if not exists ${tableId} (
      tag text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);

  return await sql.begin(async (tx) => {
    // Blocking, not try-and-skip: two deploys overlapping must queue, because
    // the loser of a race that "skipped" would report a successful migration
    // run having applied nothing — the exact silence this file exists to end.
    await tx.unsafe('select pg_advisory_xact_lock($1::bigint)', [
      advisoryLockKey(LOCK_KEY).toString(),
    ]);

    const recorded = (await tx.unsafe(`select tag, sha256 from ${tableId} order by tag`)) as Array<{
      tag: string;
      sha256: string;
    }>;

    const adopted: string[] = [];
    const legacyDrift: string[] = [];

    if (recorded.length === 0) {
      const assume = options.assumeAppliedThrough;
      let toAdopt: MigrationFile[] = [];
      let legacyHashes: string[] = [];

      if (assume) {
        const cut = files.findIndex((file) => file.tag === assume);
        if (cut === -1) {
          throw new Error(`--assume-applied-through ${assume}: no such migration in this tree`);
        }
        toAdopt = files.slice(0, cut + 1);
      } else if (await tableExists(tx, `${schema}.${legacyTable}`)) {
        const rows = (await tx.unsafe(
          `select hash from ${legacyId} order by created_at, id`
        )) as Array<{ hash: string }>;
        legacyHashes = rows.map((row) => row.hash);
        toAdopt = adoptFromLegacy(files, legacyHashes);
      }

      if (toAdopt.length > 0) {
        const known = new Set(legacyHashes);
        for (const file of toAdopt) {
          await tx.unsafe(`insert into ${tableId} (tag, sha256) values ($1, $2)`, [
            file.tag,
            file.sha256,
          ]);
          adopted.push(file.tag);
          if (legacyHashes.length > 0 && !known.has(file.sha256)) legacyDrift.push(file.tag);
        }
        log(
          `📖 Adopted ${adopted.length} migration(s) already applied here` +
            (assume ? ' (named on the command line)' : ` from ${schema}.${legacyTable}`)
        );
        for (const tag of legacyDrift) {
          log(
            `⚠️  ${tag}.sql has changed since it ran on this database. The version that ran ` +
              'is the one that counts; the change is NOT applied.'
          );
        }
      }
    }

    // Both directions of "the tree and the database disagree" are hard stops.
    // Neither is recoverable by guessing, and both used to be invisible.
    const vanished = recorded.map((row) => row.tag).filter((tag) => !byTag.has(tag));
    if (vanished.length > 0) {
      throw new Error(
        `applied migration(s) missing from this tree: ${vanished.join(', ')}.\n` +
          '  A migration that has run cannot be renamed or deleted — the database is the ' +
          'record of what ran, and this tree no longer contains it.'
      );
    }

    const applied = new Set([...recorded.map((row) => row.tag), ...adopted]);
    const pending = files.filter((file) => !applied.has(file.tag));

    const drifted = recorded
      .filter((row) => byTag.get(row.tag)?.sha256 !== row.sha256)
      .map((row) => ({
        tag: row.tag,
        recorded: row.sha256,
        found: byTag.get(row.tag)?.sha256 ?? '',
      }));
    if (drifted.length > 0) {
      throw new Error(
        driftRefusalMessage(
          drifted,
          pending.map((file) => file.tag)
        )
      );
    }
    if (pending.length === 0) {
      log(`✓ Schema up to date — ${applied.size} migration(s) applied`);
      return { adopted, applied: [], alreadyApplied: [...applied], legacyDrift };
    }

    log(`▶ ${pending.length} pending migration(s): ${pending.map((f) => f.tag).join(', ')}`);

    const justApplied: string[] = [];
    for (const file of pending) {
      for (const statement of splitStatements(file.sql)) {
        await tx.unsafe(statement);
      }
      // Recorded immediately after its own statements rather than at the end:
      // a migration carrying its own COMMIT (three do) ends this transaction
      // early, and the row has to be as durable as the effect it describes.
      await tx.unsafe(`insert into ${tableId} (tag, sha256) values ($1, $2)`, [
        file.tag,
        file.sha256,
      ]);
      justApplied.push(file.tag);
      log(`  ✓ ${file.tag}`);
    }

    return { adopted, applied: justApplied, alreadyApplied: [...applied], legacyDrift };
  });
}
