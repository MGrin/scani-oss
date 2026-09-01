#!/usr/bin/env bun

/**
 * Three subcommands. The first two exist so that nobody has to type a number.
 *
 *   bun run db:new "<what it does>"
 *     Creates `src/migrations/<UTC stamp>_<slug>.sql` and prints the path.
 *     Adds one file and touches nothing else, which is the whole point: two
 *     of these, run in two worktrees a second apart, merge clean in either
 *     order (SC-335).
 *
 *   bun run db:journal
 *     Writes `src/migrations/meta/_journal.json` from the folder. The journal
 *     is gitignored — it is drizzle-kit's input, not our source of truth, and
 *     as a tracked file it was the one thing every concurrent migration had
 *     to edit, so it conflicted on every pair of branches and on every OSS
 *     sync. `db:generate` regenerates it first; `db:migrate` never reads it.
 *
 *   bun run db:declare-drift [--against <ref>] [<tag> …]
 *     Prints the `DRIFT_DECLARATIONS` entry for a migration you have EDITED
 *     after it already ran somewhere (SC-914). `--against` defaults to `HEAD`,
 *     which is the working-tree case; name a release ref for an edit that has
 *     already merged. This is the only place the old
 *     text exists, so it is the only place the safety claim can be checked:
 *     it reads the old blob out of git, compares the two with comments
 *     stripped, and emits a `comment-only` entry only when they are identical.
 *     When they are not it refuses and prints the `sql-changed` template
 *     instead, with the reason left blank for a human to fill in.
 *
 *     Deriving that hash any other way — from the file you just edited, say —
 *     produces a value that satisfies the runner and asserts nothing. That is
 *     the whole reason this subcommand exists rather than a documented
 *     `sha256sum` one-liner.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatStamp, newMigrationTag, readMigrationFiles, sha256 } from './migration-files';
import { sqlWithoutComments } from './migration-reconciliation';

const MIGRATIONS = path.join(import.meta.dir, 'migrations');

/**
 * `when` has no meaning to us any more — the runner keys on the tag — but
 * drizzle-kit still wants a strictly increasing number per entry, so it is
 * derived from position. Deriving it means it can never disagree with the
 * folder, which was the other half of the old failure.
 */
function journalFor(tags: string[]): string {
  return `${JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx,
        version: '7',
        when: idx + 1,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2
  )}\n`;
}

function writeJournal(): string {
  const tags = readMigrationFiles(MIGRATIONS).map((file) => file.tag);
  const target = path.join(MIGRATIONS, 'meta', '_journal.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, journalFor(tags));
  return target;
}

function createMigration(slug: string, now: Date): string {
  const tag = newMigrationTag(slug, now);
  const target = path.join(MIGRATIONS, `${tag}.sql`);
  writeFileSync(
    target,
    `-- ${formatStamp(now)} — ${slug}\n-- Write the SQL here. It runs once, in one transaction,\n-- and is identified by this filename forever.\n`,
    { flag: 'wx' }
  );
  return target;
}

/**
 * The migration as `<ref>` has it, or null when that ref does not carry the
 * file. Failure is never softened into "unchanged": a git that could not
 * answer must not read as a file that did not move.
 */
function fileAtRef(ref: string, tag: string): string | null {
  const spec = `${ref}:packages/infra/db/src/migrations/${tag}.sql`;
  const result = Bun.spawnSync(['git', 'show', spec], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString();
}

function declarationFor(tag: string, ref: string, current: string): string {
  const before = fileAtRef(ref, tag);
  if (before === null) {
    return (
      `  // ${tag}: ${ref} does not carry this migration — nothing to declare.\n` +
      '  //   A migration that has never shipped cannot have drifted; if it HAS\n' +
      '  //   shipped, name the ref that carries it with --against.\n'
    );
  }
  if (before === current) return `  // ${tag}: unchanged since ${ref}.\n`;

  const recorded = sha256(before);
  if (sqlWithoutComments(before) === sqlWithoutComments(current)) {
    return [
      '  {',
      "    kind: 'comment-only',",
      `    tag: '${tag}',`,
      `    recorded: '${recorded}',`,
      `    sqlSha256: '${sha256(sqlWithoutComments(before))}',`,
      "    why: '<ticket> — what was rewritten, and that it was comments only>',",
      '  },',
      '',
    ].join('\n');
  }

  return [
    `  // ${tag}: THE EXECUTABLE SQL CHANGED. No comment-only declaration is`,
    '  //   writable for this one. Fill in `why` with what makes re-recording it',
    '  //   safe on a database that already ran the old text — and if you cannot',
    '  //   write that sentence, the answer is a new migration, not this.',
    '  {',
    "    kind: 'sql-changed',",
    `    tag: '${tag}',`,
    `    recorded: '${recorded}',`,
    `    becomes: '${sha256(current)}',`,
    "    why: '<ticket> — why this is safe on a database that ran the old text>',",
    '  },',
    '',
  ].join('\n');
}

function declareDrift(argv: readonly string[]): void {
  const args = [...argv];
  let ref = 'HEAD';
  const againstAt = args.indexOf('--against');
  if (againstAt !== -1) {
    const value = args[againstAt + 1];
    if (!value) {
      console.error('usage: bun run db:declare-drift [--against <ref>] [<tag> …]');
      process.exit(1);
    }
    ref = value;
    args.splice(againstAt, 2);
  }

  const files = readMigrationFiles(MIGRATIONS);
  const wanted = args.length > 0 ? args : files.map((file) => file.tag);
  const byTag = new Map(files.map((file) => [file.tag, file]));

  const blocks: string[] = [];
  for (const tag of wanted) {
    const file = byTag.get(tag);
    if (!file) {
      console.error(`no such migration in this tree: ${tag}`);
      process.exit(1);
    }
    const block = declarationFor(tag, ref, file.sql);
    // With no tags named this walks all of them; the unchanged ones are the
    // overwhelming majority and saying so for each would bury the answer.
    if (args.length > 0 || !block.endsWith(`unchanged since ${ref}.\n`)) blocks.push(block);
  }

  console.log(
    `// Paste into DRIFT_DECLARATIONS in packages/infra/db/src/migration-reconciliation.ts\n` +
      `// Compared against ${ref}.\n`
  );
  console.log(blocks.join('\n'));
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;

  if (command === 'declare-drift') {
    declareDrift(rest);
    return;
  }

  if (command === 'journal') {
    console.log(`wrote ${writeJournal()}`);
    return;
  }

  if (command === 'new') {
    const slug = rest.join(' ').trim();
    if (!slug) {
      console.error('usage: bun run db:new "<what it does>"');
      process.exit(1);
    }
    console.log(createMigration(slug, new Date()));
    return;
  }

  console.error(
    'usage: bun src/migration-cli.ts new "<what it does>" | journal | ' +
      'declare-drift [--against <ref>] [<tag> …]'
  );
  process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
