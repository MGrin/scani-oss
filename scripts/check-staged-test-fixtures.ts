#!/usr/bin/env bun
/**
 * SC-596. Refuses a commit carrying debris a killed test run left behind. The
 * sweeps the tests themselves do repair it at the START of the next run; this
 * closes the window between the kill and that run, which is where the damage
 * actually happens — a worker whose gate was killed then commits normally, and
 * `git add -A` takes files they never wrote.
 *
 * Two shapes, because a killed run leaves two:
 *
 *   FIXTURES — a file that should not exist, recorded in the index. Any path
 *   matching one of the globs is a corpse whatever its state: nothing
 *   legitimately carries a name a test built from `process.pid`. The docs one
 *   also sits in the content root, so the site builds it as a page.
 *
 *   SOURCE MUTATIONS (SC-601) — a TRACKED file rewritten in place. No glob can
 *   find it: the name is legitimate and only the contents are wrong, so what is
 *   detected instead is the journal `withMutatedSources` writes before the first
 *   mutation and deletes after the last restore. A journal on disk means one or
 *   more tracked files are stranded, and the journal names them.
 *
 * Exit 0 clean, exit 1 naming every one, exit 9 when the index could not be
 * read at all. `--sweep` repairs them instead.
 */
import path from 'node:path';
import { EXIT_REFUSED, EXIT_UNKNOWN } from './lib/check-verdict';
import { stagedFixtureCorpses, sweepFixtureCorpses } from './lib/test-fixture-corpses';
import { replayStrandedMutations, strandedMutationJournals } from './lib/test-source-mutations';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

/**
 * The denominator names TRACKED PATHS READ, not patterns compiled (SC-780).
 *
 * It read `2 fixture patterns checked, 1 journal pattern` — a real, specific
 * number about a different question. `FIXTURE_CORPSE_GLOBS.length` is a
 * constant: it is 2 over a full index, 2 over an empty one, and 2 when git
 * failed and nothing was read at all. A figure that cannot move is a figure
 * that cannot report, and putting one on the line makes it LOOK instrumented,
 * which is worse than printing nothing.
 */
function denominator(read: number): string {
  return `${read} tracked path(s) read, 1 journal pattern`;
}

if (process.argv.includes('--sweep')) {
  const removed = sweepFixtureCorpses(REPO_ROOT);
  const restored = replayStrandedMutations(REPO_ROOT);
  console.log(`staged-test-fixtures: swept ${removed.length}, restored ${restored.length}`);
  for (const p of removed) console.log(`  removed ${p}`);
  for (const p of restored) console.log(`  restored ${p}`);
  process.exit(0);
}

const scan = stagedFixtureCorpses(REPO_ROOT);
const journals = strandedMutationJournals(REPO_ROOT);

// Before the clean branch, never after it: this is the reading that used to
// arrive as an empty list and be indistinguishable from a clean index.
if (scan.kind === 'blind') {
  console.error(`staged-test-fixtures: UNKNOWN · exit ${EXIT_UNKNOWN} · ${scan.why}`);
  console.error('  The index was NOT read, so nothing here says the tree is clean.');
  process.exit(EXIT_UNKNOWN);
}

const staged = scan.corpses;

if (staged.length === 0 && journals.length === 0) {
  console.log(`staged-test-fixtures: clean · ${denominator(scan.read)}`);
  process.exit(0);
}

if (staged.length > 0) {
  console.error('staged-test-fixtures: a test fixture is recorded in the index');
  for (const p of staged) console.error(`  ${p}`);
  console.error('');
  console.error('scripts/tests/ writes these and removes them in `afterEach`, which does not run');
  console.error('when the process is killed (SC-596). Nothing wrote them on purpose.');
}

if (journals.length > 0) {
  console.error('staged-test-fixtures: a killed run left tracked source files rewritten');
  for (const p of journals) console.error(`  ${p}`);
  console.error('');
  console.error('scripts/tests/ mutates real source to prove a docs:check guard can fail, and');
  console.error('restores it in a `finally` that SIGKILL skips (SC-601). Those files type-check');
  console.error('and read as an ordinary edit, so `git add -A` commits them silently.');
}

console.error('  Repair them: bun scripts/check-staged-test-fixtures.ts --sweep');
process.exit(EXIT_REFUSED);
