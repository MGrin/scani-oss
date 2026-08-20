#!/usr/bin/env bun

/**
 * Two subcommands, both of which exist so that nobody has to type a number.
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
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatStamp, newMigrationTag, readMigrationFiles } from './migration-files';

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

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;

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

  console.error('usage: bun src/migration-cli.ts new "<what it does>" | journal');
  process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
