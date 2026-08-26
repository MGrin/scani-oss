import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_CORPSE_GLOBS, sweepFixtureCorpses } from '../lib/test-fixture-corpses';

/**
 * SC-596. Two tests under this directory write a fixture inside the repository
 * and record it with `git add -N`, because `check-docs.ts` only reads files git
 * tracks (SC-430). Both remove it in `afterEach` — which does not run when the
 * process is killed. A killed gate, an interrupted run, an OOM and a docker
 * daemon dying under a running suite all happened in one night, and each leaves the
 * fixture in the INDEX, where `git add -A` sweeps it into a commit. The docs
 * one also sits in the content root, so the site builds it as a page.
 *
 * The name carries `process.pid`, so no later run ever cleans a predecessor's:
 * corpses accumulate. The repair is a sweep of the PATTERN at test start, and
 * what is tested here is the property that makes it worth having — it works on
 * a corpse this process did not create, which is the only kind that exists.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const TEST_DIR = path.join(REPO_ROOT, 'scripts/tests');

/** Pids this process cannot be, so nothing here can collide with a live run. */
const DOCS_CORPSE = 'apps/frontend/docs/src/content/docs/sc589-fixture-999999.md';
const QUEUE_CORPSE_DIR = 'scripts/.sc546-fixture-999998';
const QUEUE_CORPSE = `${QUEUE_CORPSE_DIR}/README.md`;

function git(...args: string[]): string {
  return Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT }).stdout.toString();
}

function plantCorpses(): void {
  mkdirSync(path.dirname(path.join(REPO_ROOT, DOCS_CORPSE)), { recursive: true });
  writeFileSync(path.join(REPO_ROOT, DOCS_CORPSE), '# corpse\n');
  mkdirSync(path.join(REPO_ROOT, QUEUE_CORPSE_DIR), { recursive: true });
  writeFileSync(path.join(REPO_ROOT, QUEUE_CORPSE), '# corpse\n');
  git('add', '-N', DOCS_CORPSE, QUEUE_CORPSE);
}

function tracked(rel: string): boolean {
  return git('ls-files', '--', rel).trim() === rel;
}

afterEach(() => {
  git('rm', '--cached', '--quiet', '--force', '--', DOCS_CORPSE, QUEUE_CORPSE);
  rmSync(path.join(REPO_ROOT, DOCS_CORPSE), { force: true });
  rmSync(path.join(REPO_ROOT, QUEUE_CORPSE_DIR), { recursive: true, force: true });
});

describe('a killed run leaves a fixture in the index, and the next run repairs it', () => {
  test('MUST-BE-FOUND CONTROL — a planted corpse really is in the index and on disk', () => {
    plantCorpses();

    // Without this the sweep passing and the corpses never having existed
    // print the same thing — the silent-success shape SC-596 is made of.
    expect(tracked(DOCS_CORPSE)).toBe(true);
    expect(tracked(QUEUE_CORPSE)).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, DOCS_CORPSE))).toBe(true);
  });

  test('the sweep clears a corpse from another pid, out of the index AND the tree', () => {
    plantCorpses();

    const removed = sweepFixtureCorpses(REPO_ROOT);

    expect(removed).toContain(DOCS_CORPSE);
    expect(removed).toContain(QUEUE_CORPSE);
    expect(tracked(DOCS_CORPSE)).toBe(false);
    expect(tracked(QUEUE_CORPSE)).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, DOCS_CORPSE))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, QUEUE_CORPSE_DIR))).toBe(false);
  });

  /**
   * MUST-BE-ABSENT CONTROL. A sweep that over-matched would delete real docs
   * pages out of the working tree of whoever ran the gate — a far worse
   * failure than the one being fixed, and one that would look like a clean
   * run right up to the commit.
   */
  test('and it touches nothing else — a real docs page survives it', () => {
    const realPage = 'apps/frontend/docs/src/content/docs/index.mdx';
    expect(tracked(realPage)).toBe(true);

    sweepFixtureCorpses(REPO_ROOT);

    expect(tracked(realPage)).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, realPage))).toBe(true);
  });

  test('sweeping a clean tree removes nothing and does not fail', () => {
    expect(sweepFixtureCorpses(REPO_ROOT)).toEqual([]);
  });
});

describe('the pre-commit guard refuses a corpse the sweep has not reached yet', () => {
  function runGuard(...args: string[]): { exitCode: number; output: string } {
    const run = Bun.spawnSync(['bun', 'scripts/check-staged-test-fixtures.ts', ...args], {
      cwd: REPO_ROOT,
    });
    return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
  }

  test('clean tree passes', () => {
    const { exitCode, output } = runGuard();
    expect(output).toContain(`${FIXTURE_CORPSE_GLOBS.length} fixture patterns checked`);
    expect(exitCode).toBe(0);
  });

  test('a staged corpse is refused and named', () => {
    plantCorpses();

    const { exitCode, output } = runGuard();
    expect(exitCode).toBe(1);
    expect(output).toContain(DOCS_CORPSE);
    expect(output).toContain(QUEUE_CORPSE);
  });

  test('--sweep removes it', () => {
    plantCorpses();

    expect(runGuard('--sweep').exitCode).toBe(0);
    expect(tracked(DOCS_CORPSE)).toBe(false);
  });
});

/**
 * THE RULE, not the site. The two fixtures fixed here are the two that exist
 * today; the hazard belongs to the shape — a test that records intent-to-add
 * on a path inside this repository. A third one written next month gets the
 * same corpse for free unless something asks.
 */
describe('every test that stages a path in this repo sweeps stale ones first', () => {
  const RECORDS_INTENT_TO_ADD = /['"]add['"]\s*,\s*['"]-N['"]|git add -N(?!`)/;

  function testFiles(): string[] {
    return Array.from(new Bun.Glob('*.test.ts').scanSync({ cwd: TEST_DIR })).sort();
  }

  test('the rule can see the sites it is about, and they all sweep', () => {
    const files = testFiles();
    const stagers: string[] = [];

    for (const name of files) {
      const text = readFileSync(path.join(TEST_DIR, name), 'utf8');
      // Fixtures built in a scratch repo under TMPDIR cannot strand anything
      // in this index, so the rule is about REPO_ROOT sites only.
      if (!RECORDS_INTENT_TO_ADD.test(text)) continue;
      if (!text.includes('REPO_ROOT')) continue;
      stagers.push(name);
    }

    // Denominator, and the must-be-FOUND control: a detector that silently
    // stopped matching would report a clean sweep over every file forever.
    console.log(`test files scanned: ${files.length} · staging into this repo: ${stagers.length}`);
    expect(files.length).toBeGreaterThan(50);
    expect(stagers).toContain('docs-site-repo-links.test.ts');
    expect(stagers).toContain('queue-store-claims.test.ts');

    const notSweeping = stagers.filter((name) => {
      const text = readFileSync(path.join(TEST_DIR, name), 'utf8');
      return !text.includes('sweepFixtureCorpses(');
    });
    expect(notSweeping).toEqual([]);
  });

  test('MUST-BE-ABSENT CONTROL — the detector does not fire on an ordinary add', () => {
    expect(RECORDS_INTENT_TO_ADD.test("await git(root, 'add', '-A');")).toBe(false);
    expect(RECORDS_INTENT_TO_ADD.test("git(['add', '--', ...staged]);")).toBe(false);
    expect(RECORDS_INTENT_TO_ADD.test("git('add', '-N', FIXTURE_REL);")).toBe(true);
  });
});
