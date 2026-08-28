import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { EXIT_OK, EXIT_UNKNOWN } from '../lib/check-verdict';
import { FIXTURE_CORPSE_GLOBS, stagedFixtureCorpses } from '../lib/test-fixture-corpses';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

/**
 * SC-780. `stagedFixtureCorpses` built its whole population from a `git` call
 * whose status it never read, so a failed git produced `''`, which split to no
 * paths, which read as *no fixture corpses are staged* — exactly what a clean
 * tree produces, from the guard standing between a killed run's debris and a
 * commit.
 *
 * Every assertion here is PAIRED with its opposite arm. A blind read and a
 * clean read both returning "nothing" is the entire defect, so a test that
 * checked only the blind arm would have passed on the broken code — which is
 * how this survived: the repository genuinely has no corpses, so both arms read
 * 0 and the pair proved nothing.
 */
describe('a git that could not run is UNKNOWN, never a clean index', () => {
  function guard(env: Record<string, string> = {}): { exitCode: number; output: string } {
    const run = Bun.spawnSync([process.execPath, 'scripts/check-staged-test-fixtures.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
  }

  test('the API reports blindness rather than an empty list', () => {
    // `/` is not a git repository, so `git ls-files` exits 128 there.
    const blind = stagedFixtureCorpses('/');
    const seeing = stagedFixtureCorpses(REPO_ROOT);

    expect(blind.kind).toBe('blind');
    expect(seeing.kind).toBe('scanned');
    if (seeing.kind !== 'scanned') throw new Error('unreachable');
    expect(seeing.read).toBeGreaterThan(1000);
  });

  /**
   * `REPO_ROOT` inside the guard is resolved from `import.meta.dir`, so it
   * always names the real checkout and the not-a-repository route cannot reach
   * the CLI. Removing `git` from the child's PATH does — and writing this
   * control found a second defect: `Bun.spawnSync` THROWS on a missing binary
   * rather than returning a failed subprocess, so the uncaught throw exited 1,
   * which in this guard means REFUSED. A claim about the tree, from a run that
   * never read it.
   */
  test('git absent from PATH exits UNKNOWN, and never REFUSED', () => {
    const blind = guard({ PATH: '/var/empty' });
    const seeing = guard();

    expect(blind.exitCode).toBe(EXIT_UNKNOWN);
    expect(blind.output).toContain('UNKNOWN');
    // The VERDICT, not the word: the unknown message itself ends "nothing here
    // says the tree is clean", so a bare `not.toContain('clean')` fails on its
    // own explanation.
    expect(blind.output).not.toContain('staged-test-fixtures: clean');
    // 1 is REFUSED here — "a fixture is recorded in the index".
    expect(blind.exitCode).not.toBe(1);

    // The control, in the same test so the two cannot drift apart.
    expect(seeing.exitCode).toBe(EXIT_OK);
    expect(seeing.output).toContain('staged-test-fixtures: clean');
    expect(seeing.output).not.toContain('UNKNOWN');
  });

  /**
   * The line read `2 fixture patterns checked` — a real, specific number about
   * a different question. `FIXTURE_CORPSE_GLOBS.length` is a constant: 2 over a
   * full index, 2 over an empty one, and 2 when git failed and nothing was read
   * at all. A figure that cannot move cannot report, and printing one makes the
   * line LOOK instrumented, which is worse than printing nothing.
   */
  test('the printed denominator counts paths READ, not patterns compiled', () => {
    const read = Number(/(\d+) tracked path\(s\) read/.exec(guard().output)?.[1] ?? '-1');

    expect(read).toBeGreaterThan(FIXTURE_CORPSE_GLOBS.length);
    // Not a bare `> 0`: this repository tracks thousands of files, so a figure
    // in the single digits would mean the read collapsed and the line reported
    // the collapse as a number.
    expect(read).toBeGreaterThan(1000);
  });

  test('the three verdicts are three different exit codes', () => {
    expect(new Set([EXIT_OK, 1, EXIT_UNKNOWN]).size).toBe(3);
  });
});
