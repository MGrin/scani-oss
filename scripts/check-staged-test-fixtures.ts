#!/usr/bin/env bun
/**
 * SC-596. Refuses a commit carrying a test fixture that a killed run left in
 * the index. The sweep the tests themselves do repairs a corpse at the START
 * of the next run; this closes the window between the kill and that run, which
 * is where the damage actually happens — a worker whose gate was killed then
 * commits normally, and `git add -A` takes a file they never wrote into a
 * directory the docs site deploys.
 *
 * Any path matching one of these globs is a corpse whatever its state: nothing
 * legitimately carries a name a test built from `process.pid`.
 *
 * Exit 0 clean, exit 1 naming every one. `--sweep` removes them instead.
 */
import path from 'node:path';
import {
  FIXTURE_CORPSE_GLOBS,
  stagedFixtureCorpses,
  sweepFixtureCorpses,
} from './lib/test-fixture-corpses';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const DENOMINATOR = `${FIXTURE_CORPSE_GLOBS.length} fixture patterns checked`;

if (process.argv.includes('--sweep')) {
  const removed = sweepFixtureCorpses(REPO_ROOT);
  console.log(`staged-test-fixtures: swept ${removed.length} · ${DENOMINATOR}`);
  for (const p of removed) console.log(`  removed ${p}`);
  process.exit(0);
}

const staged = stagedFixtureCorpses(REPO_ROOT);

if (staged.length === 0) {
  console.log(`staged-test-fixtures: clean · ${DENOMINATOR}`);
  process.exit(0);
}

console.error('staged-test-fixtures: a test fixture is recorded in the index');
for (const p of staged) console.error(`  ${p}`);
console.error('');
console.error('scripts/tests/ writes these and removes them in `afterEach`, which does not run');
console.error('when the process is killed (SC-596). Nothing wrote them on purpose.');
console.error('  Remove them: bun scripts/check-staged-test-fixtures.ts --sweep');
process.exit(1);
