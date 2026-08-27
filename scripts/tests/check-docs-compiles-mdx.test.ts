import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
 * SC-469. Nothing a developer runs compiled MDX. `docs:check` read Markdown as
 * text, `bun run test` did not build the site, and the only compiler behind
 * `apps/frontend/docs/src/content/**\/*.mdx` was the Starlight build in the OSS
 * deploy workflow — so on the private repo, where Actions is billing-blocked, an
 * MDX syntax error reached `main` and was found by the docs deploy after merge.
 *
 * SC-453 is the measured instance: two Markdown autolinks, valid Markdown and
 * invalid MDX, under a fully green local gate.
 *
 * The property under test is not "autolinks are rejected". It is that the check
 * runs the real MDX compiler over the tracked `.mdx` pages, so it covers the
 * class rather than the one failure we have already seen — and that it stays
 * silent on `.md`, where an autolink is correct and `contributing/how-to.md`
 * legitimately has two.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
// Every fixture is staged into a THROWAWAY git index rather than the real one.
// `check-docs.ts` derives its file list from `git ls-files` (SC-430), so a
// fixture has to be tracked to be seen — and staging it for real would leave a
// half-finished test run with somebody's index holding files they never added.
// `GIT_INDEX_FILE` gives `git` a scratch index for the duration and touches
// nothing in the checkout.
//
// OUTSIDE the repository (SC-609). `GIT_INDEX_FILE` takes any path, so this
// one never needed to be in the tree at all — and while it was, a killed run
// left an ordinary untracked file at the root for `git add -A` to commit. The
// pid keeps two concurrent runs off each other's index (SC-370).
const SCRATCH_INDEX = path.join(tmpdir(), `scani-sc469-index-${process.pid}`);

// Per-process, because a neighbour's cleanup mid-run is its own bug (SC-370).
const FIXTURES: string[] = [];

// The name carries the reserved prefix so one `.gitignore` rule keeps it out of
// `git add -A` (SC-609): these four sit in the DEPLOYED docs content root, where
// a stranded one is both committable and built by the site as a page.
function fixture(relDir: string, name: string, body: string): string {
  const rel = `apps/frontend/docs/src/content/docs/${relDir}scani-test-fixture-${name}`;
  assertRepoFixtureIsIgnored(REPO_ROOT, rel);
  const abs = path.join(REPO_ROOT, rel);
  writeFileSync(abs, body);
  FIXTURES.push(abs);
  return rel;
}

/** Runs `docs:check` against a scratch index holding HEAD plus `staged`. */
function runCheck(staged: string[] = [], unstage: string[] = []): { code: number; out: string } {
  const env = { ...process.env, GIT_INDEX_FILE: SCRATCH_INDEX };
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT, env });
  rmSync(SCRATCH_INDEX, { force: true });
  git(['read-tree', 'HEAD']);
  // `-f` because every fixture is deliberately gitignored (SC-609), and `git
  // add` refuses an ignored path without it. The status is checked rather than
  // discarded: an unstaged fixture makes `check-docs` green, which reads as the
  // page compiling rather than as the page never having been looked at.
  if (staged.length > 0) {
    const add = git(['add', '-f', '--', ...staged]);
    if (add.exitCode !== 0) {
      throw new Error(
        `staging the fixture into the scratch index failed (exit ${add.exitCode}): ` +
          `${add.stderr.toString().trim()}`
      );
    }
  }
  if (unstage.length > 0) git(['rm', '--cached', '-q', '--', ...unstage]);
  const run = Bun.spawnSync(['bun', 'scripts/check-docs.ts'], { cwd: REPO_ROOT, env });
  return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}` };
}

afterEach(() => {
  for (const f of FIXTURES.splice(0)) rmSync(f, { force: true });
  rmSync(SCRATCH_INDEX, { force: true });
});

describe('docs:check compiles every .mdx page', () => {
  test('the tree as committed is green — the baseline every other case needs', () => {
    const { code, out } = runCheck();
    expect(out).toMatch(/all \d+ checks passed/);
    expect(code).toBe(0);
  });

  test('the SC-453 autolink in an .mdx page is rejected, with its line', () => {
    const rel = fixture(
      '',
      `sc469-autolink-${process.pid}.mdx`,
      'Scani is on <http://localhost:8080>; sign in there.\n'
    );
    const { code, out } = runCheck([rel]);
    expect(out).toContain('[mdx-syntax]');
    expect(out).toContain(rel);
    expect(out).toMatch(/does not compile as MDX/);
    // The location, not just the file — the build reports 29:19 for the real
    // page and a check that cannot say where is a check you re-find by hand.
    expect(out).toMatch(new RegExp(`${rel}:1:\\d+`));
    expect(code).toBe(1);
  });

  test('the same autolink in a .md page is left alone', () => {
    // Not a nicety. Autolinks are correct Markdown, `contributing/how-to.md`
    // ships two, and a check that is red when nothing is wrong is the one
    // everybody learns to scroll past (SC-142, this script's own header).
    const rel = fixture(
      '',
      `sc469-autolink-${process.pid}.md`,
      'Scani is on <http://localhost:8080>; sign in there.\n'
    );
    const { code, out } = runCheck([rel]);
    expect(out).not.toContain('[mdx-syntax]');
    expect(out).toMatch(/all \d+ checks passed/);
    expect(code).toBe(0);
  });

  test('an unescaped brace is rejected too — this is the compiler, not a pattern', () => {
    // The whole reason the check compiles instead of matching `<scheme://`: a
    // pattern for the failure we have already seen reads as covering the class
    // and does not. Nothing about this fixture resembles an autolink.
    const rel = fixture(
      '',
      `sc469-brace-${process.pid}.mdx`,
      'Set it to {SCANI_PORT and restart.\n'
    );
    const { code, out } = runCheck([rel]);
    expect(out).toContain('[mdx-syntax]');
    expect(out).toContain(rel);
    expect(code).toBe(1);
  });

  test('a broken page in any content subdirectory is caught, not just the root', () => {
    const rel = fixture(
      'reference/',
      `sc469-nested-${process.pid}.mdx`,
      'Docs at <https://docs.scani.xyz>.\n'
    );
    const { code, out } = runCheck([rel]);
    expect(out).toContain(rel);
    expect(code).toBe(1);
  });

  test('NO .mdx pages at all is a failure, not a pass', () => {
    // This is the test a future reader will want to delete, so argue with the
    // reason rather than the assertion: an empty file list means this check
    // compiled nothing, and "nothing to look at" reported as "nothing wrong" is
    // exactly the SC-469 hole reopening — silently, and with a green tick over
    // it. The benign readings are all persuasive ("the content moved", "the
    // site was retired") and every one of them still leaves `.mdx` pages
    // uncompiled if it is wrong. If the docs site really is gone, delete this
    // check on purpose; do not soften it into a pass.
    const { code, out } = runCheck([], ['apps/frontend/docs/src/content/**/*.mdx']);
    expect(out).toContain('[mdx-syntax]');
    expect(out).toMatch(/no \.mdx pages found/);
    expect(code).toBe(1);
  });
});
