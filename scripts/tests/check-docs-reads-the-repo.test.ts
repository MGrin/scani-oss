import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCheckDocs } from '../lib/run-check-docs';
import { assertRepoFixtureIsIgnored } from '../lib/test-fixture-corpses';

/**
 * SC-694. Every test here spawns `bun scripts/check-docs.ts`, which itself
 * spawns many `git` calls — so the cost is subprocess startup, which amplifies
 * under load far harder than CPU work does. At rest the slowest is 536ms; at
 * load 30 one crossed 5000ms and died, and WHICH one crossed varied per run,
 * which is what "alternating" in the report was.
 *
 * `bun run test` passes `--timeout 30000`, so the gate never saw it. A bare
 * `bun test <path>` gets 5000ms and `bunfig.toml` cannot raise it — bun drops
 * a `timeout` key from `[test]` silently. This call is the only budget that
 * survives both invocations.
 */
setDefaultTimeout(30_000);

/**
 * SC-430. `docs:check` derived its lists by reading the working DIRECTORY, so
 * its verdict depended on what happened to be sitting there. The same commit
 * was green in a fresh worktree and red in a checkout someone had built a
 * frontend app in: a stray `.claude/` under `providers/` was reported as an
 * undocumented provider, and a framework's build output under `apps/frontend/`
 * contributed three of that framework's own internal variables to the
 * undocumented-env warning. None of the four exists anywhere in the repo.
 *
 * That is disqualifying for a gate check specifically: the failure mode is
 * red-when-nothing-is-wrong, which is how the one real finding gets waved
 * through as "the known one" (the argument `check-docs.ts` opens with, citing
 * SC-142). So the property under test is not "these particular names are handled" —
 * it is that an untracked file cannot reach any finding at all.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PROVIDERS = path.join(REPO_ROOT, 'packages/clients/providers/src/providers');

// Per-process, because a neighbour's `rm -rf` mid-run is its own bug (SC-370),
// and under the reserved prefix, because these three sit in the working tree
// with nothing ignoring them otherwise — a killed run leaves them where
// `git add -A` takes them (SC-609). The assertion runs at module load, so a
// path renamed out of the family fails before any test does.
function strayFixture(rel: string): string {
  assertRepoFixtureIsIgnored(REPO_ROOT, rel);
  return path.join(REPO_ROOT, rel);
}

const STRAY_PROVIDER = strayFixture(
  `packages/clients/providers/src/providers/scani-test-fixture-sc430-${process.pid}`
);
const STRAY_BUILD = strayFixture(`apps/frontend/app/scani-test-fixture-sc430-out-${process.pid}`);
const PHANTOM_VAR = `SC430_PHANTOM_${process.pid}`;
const STRAY_DOC = strayFixture(
  `packages/business/domain/src/scani-test-fixture-sc444-notes-${process.pid}`
);

function cleanup(): void {
  rmSync(STRAY_PROVIDER, { recursive: true, force: true });
  rmSync(STRAY_BUILD, { recursive: true, force: true });
  rmSync(STRAY_DOC, { recursive: true, force: true });
}

afterEach(cleanup);

function runCheck(): { exitCode: number; output: string } {
  return runCheckDocs(REPO_ROOT);
}

describe('docs:check reads the repository, not the working directory', () => {
  test('a clean tree is green — the baseline every other assertion needs', () => {
    const { exitCode, output } = runCheck();
    // The count is deliberately not pinned. Pinning it made adding a check a
    // two-file change where the second file's failure said nothing about the
    // property under test — this test is about strays, not arithmetic.
    expect(output).toMatch(/all \d+ checks passed/);
    expect(exitCode).toBe(0);
  });

  test('an untracked directory under providers/ is not a provider', () => {
    mkdirSync(STRAY_PROVIDER, { recursive: true });
    writeFileSync(path.join(STRAY_PROVIDER, 'index.ts'), 'export const stray = 1;\n');

    // Negative control: the fixture is real and a directory read WOULD see it.
    // Without this the test would also pass if mkdir had silently failed.
    expect(readdirSync(PROVIDERS)).toContain(path.basename(STRAY_PROVIDER));

    const { exitCode, output } = runCheck();
    expect(output).not.toContain(path.basename(STRAY_PROVIDER));
    expect(exitCode).toBe(0);
  });

  test('an env var that exists only in untracked build output is not undocumented', () => {
    mkdirSync(STRAY_BUILD, { recursive: true });
    writeFileSync(path.join(STRAY_BUILD, 'launcher.cjs'), `process.env.${PHANTOM_VAR} = '1';\n`);

    expect(readdirSync(STRAY_BUILD)).toContain('launcher.cjs');

    const { exitCode, output } = runCheck();
    expect(output).not.toContain(PHANTOM_VAR);
    expect(exitCode).toBe(0);
  });

  // SC-444's placement check is the newest list derived from the tree, and it
  // is the one most exposed to this: scratch notes are exactly what an agent
  // leaves under `src/` mid-task, and reporting them would make the gate red
  // for a file that is not in the repo.
  test('an untracked scratch .md under a package src/ is not a misplaced doc', () => {
    mkdirSync(STRAY_DOC, { recursive: true });
    writeFileSync(path.join(STRAY_DOC, 'NOTES.md'), '# scratch\n');

    expect(readdirSync(STRAY_DOC)).toContain('NOTES.md');

    const { exitCode, output } = runCheck();
    expect(output).not.toContain('NOTES.md');
    expect(output).not.toContain('md-placement');
    expect(exitCode).toBe(0);
  });
});
