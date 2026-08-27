import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runCheckDocs } from '../lib/run-check-docs';

/**
 * SC-730. `Bun.spawnSync` reports a killed child as `exitCode: null` with empty
 * stdout and stderr, and six test files consumed that as a verdict. The guard
 * under test refuses it instead.
 *
 * Every arm drives a REAL spawn — one that really dies, really exits 0, really
 * exits 1 — through the `command` seam, rather than breaking `PATH` to make the
 * subprocess unreachable. `bun test` runs every file in one process, so a
 * `PATH` mutation is visible to every other file in the run; one such test once
 * took down two files it never touched by making `git ls-files` return empty.
 */
setDefaultTimeout(30_000);

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const TESTS_DIR = path.join(REPO_ROOT, 'scripts/tests');

describe('runCheckDocs refuses a killed subprocess', () => {
  test('a spawn that is killed throws, naming the signal', () => {
    expect(() => runCheckDocs(REPO_ROOT, { command: ['sh', '-c', 'kill -9 $$'] })).toThrow(
      /killed by SIGKILL/
    );
  });

  /**
   * The refusal has to say what the empty output would otherwise be read as.
   * A reader who arrives here on a loaded box is one step from concluding the
   * repository is missing routers, jobs and packages — that is the SC-694
   * signature, and it names nothing about a dead subprocess.
   */
  test('the refusal tells the reader the tree is not implicated', () => {
    expect(() => runCheckDocs(REPO_ROOT, { command: ['sh', '-c', 'kill -9 $$'] })).toThrow(
      /Nothing in this run is evidence about the repository/
    );
  });

  /**
   * CONTROL — proving the branch is reachable is half. This is the half that
   * protects every caller that was fine before: a guard that refused every run
   * would pass the arm above and break all six consumers.
   */
  test('CONTROL — a subprocess that exits 0 is returned, not refused', () => {
    const run = runCheckDocs(REPO_ROOT, { command: ['sh', '-c', 'echo all 14 checks passed'] });

    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('all 14 checks passed');
  });

  /**
   * CONTROL — the whole point is that "found a problem" stays distinguishable
   * from "never ran". Both were `false`/non-zero before; only one may throw.
   */
  test('CONTROL — a subprocess that exits 1 is returned as exit 1, not refused', () => {
    const run = runCheckDocs(REPO_ROOT, {
      // Quoted: unquoted `error(s)` is a shell syntax error, which exits 2 and
      // would have made this arm pass for a reason unrelated to the guard.
      command: ['sh', '-c', "echo 'docs:check — 1 error(s)' >&2; exit 1"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('1 error(s)');
  });

  /** The two scratch-index callers depend on `env` reaching the child. */
  test('env is passed through to the child', () => {
    const run = runCheckDocs(REPO_ROOT, {
      command: ['sh', '-c', 'echo "seen=$SC730_PROBE"'],
      env: { ...process.env, SC730_PROBE: 'reached-the-child' },
    });

    expect(run.output).toContain('seen=reached-the-child');
  });
});

/**
 * The fix is "one guard, not six", so a seventh hand-rolled copy has to fail
 * rather than quietly reintroduce the class. Each of the six carried its own
 * inline spawn of the check; none may now.
 *
 * NOTE THE SHAPE OF THE PATTERN, which is not the obvious one. Matching any
 * spawn whose argv merely mentions the path flags
 * `source-mutation-replay.test.ts`, where `git check-ignore scripts/check-docs.ts`
 * is a correct must-be-ABSENT control — and a failure telling its author to
 * route that through `runCheckDocs` reads exactly like a fix. Requiring `bun`
 * as argv[0] excludes it by construction rather than by an exemption list.
 */
describe('no test file spawns docs:check without the guard', () => {
  // Assembled from fragments so this file is not itself a violation of the
  // rule it enforces — a probe spelled as a plain literal would match its own
  // source, which is why `check-oss-internal-refs.ts` builds its probes the
  // same way. It also means this file stays IN the population below rather
  // than being excluded from it. The first draft assembled the probe and then
  // wrote the banned shape verbatim in the paragraph above; the guard caught
  // its own docblock.
  const DIRECT_SPAWN = new RegExp(`spawnSync\\(\\s*\\[\\s*['"]bun['"][^\\]]*check-${'docs'}\\.ts`);

  const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));

  test('CONTROL — the detector matches the shape it bans', () => {
    const banned = `Bun.spawn${'Sync'}(['bun', 'scripts/check-${'docs'}.ts'], { cwd: REPO_ROOT })`;

    expect(DIRECT_SPAWN.test(banned)).toBe(true);
    // ...and not the call it exists to permit.
    expect(DIRECT_SPAWN.test('runCheckDocs(REPO_ROOT, { env })')).toBe(false);
  });

  /**
   * MUST-BE-ABSENT, and the arm that stops the pattern being widened back. The
   * broad version flagged this line as an unguarded spawn; the remedy it
   * implied — route it through `runCheckDocs` — would have replaced a working
   * control with a call that does something else entirely.
   */
  test('CONTROL — passing the path to another program is not a spawn of it', () => {
    const notASpawn = `Bun.spawn${'Sync'}(['git', 'check-ignore', '-q', 'scripts/check-${'docs'}.ts'])`;

    expect(DIRECT_SPAWN.test(notASpawn)).toBe(false);
  });

  test('the population is the one intended, and non-empty', () => {
    // An absence assertion over an empty or wrong population is a coin that
    // only lands heads. These six are the files SC-730 was filed about; if a
    // rename drops one, this reddens here rather than going quietly vacuous.
    for (const name of [
      'check-docs-changelog-entries.test.ts',
      'check-docs-compiles-mdx.test.ts',
      'check-docs-package-inventory.test.ts',
      'check-docs-reads-the-repo.test.ts',
      'docs-site-repo-links.test.ts',
      'queue-store-claims.test.ts',
    ]) {
      expect(testFiles).toContain(name);
    }
    expect(testFiles.length).toBeGreaterThan(6);
  });

  test('every one of them goes through runCheckDocs', () => {
    const offenders = testFiles.filter((f) =>
      DIRECT_SPAWN.test(readFileSync(path.join(TESTS_DIR, f), 'utf8'))
    );

    expect(offenders).toEqual([]);
  });
});
