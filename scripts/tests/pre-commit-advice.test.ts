/**
 * SC-715. `.githooks/pre-commit`'s refusal names a way around itself, and that
 * way is destructive in one specific state.
 *
 * A refusal that names a bypass gets taken (SC-639). Mid-merge, taking it
 * commits WHATEVER IS STAGED — which mid-merge routinely means conflict
 * markers — and produces a real merge commit containing `<<<<<<< HEAD`. After
 * it, `MERGE_HEAD` is gone, so git no longer considers a merge to be in
 * progress and nothing downstream flags the markers either.
 *
 * The distinction is available because `MERGE_HEAD` is STILL PRESENT when the
 * hook runs: a hook-refused commit never happens, so nothing clears it.
 * Measured, and asserted below as a precondition rather than assumed — if a
 * future git cleared it earlier, the mid-merge branch would silently stop
 * being reachable and this file would still pass on the control alone.
 *
 * WHY IT SOURCES `fail` RATHER THAN RUNNING THE HOOK. The hook's other steps
 * need biome, a bun install and a full workspace; none of them bear on which
 * advice is printed. Extracting the one function keeps the test to the one
 * predicate, at the cost of depending on `fail` staying a shell function —
 * which the extraction itself asserts, since a rename makes these tests fail
 * loudly rather than vacuously pass.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = new URL('../../.githooks/pre-commit', import.meta.url).pathname;

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A repo whose only commit path bypasses hooks, so setup cannot trip the hook. */
function commit(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);
}

/** A scratch repo left mid-merge with a genuine both-modified conflict. */
function conflictedRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hook-advice-'));
  // Not `main`: a scratch branch of that name is indistinguishable from the
  // real one to a text-matching guard, and this machine has one that refuses.
  git(dir, 'init', '-q', '--initial-branch=trunk');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  commit(dir, 'base');
  git(dir, 'switch', '-q', '-c', 'other');
  writeFileSync(path.join(dir, 'f.txt'), 'THEIRS\n');
  commit(dir, 'theirs');
  git(dir, 'switch', '-q', 'trunk');
  writeFileSync(path.join(dir, 'f.txt'), 'OURS\n');
  commit(dir, 'ours');
  git(dir, 'merge', '--no-ff', 'other', '-m', 'merge');
  git(dir, 'add', 'f.txt');
  return dir;
}

/** Whatever `fail` prints, with the hook's own definition of it. */
function advice(cwd: string): string {
  const script = `RED=""; RESET=""; source <(sed -n '/^fail() {/,/^}/p' "${HOOK}"); fail "a test failure"`;
  const r = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

describe('the hook does not recommend a bypass that would commit markers (SC-715)', () => {
  test('MERGE_HEAD survives a hook-refused commit — the precondition', () => {
    // Without this the mid-merge branch below could become unreachable and
    // every other test here would still pass, on the control path alone.
    const dir = conflictedRepo();
    expect(existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);

    mkdirSync(path.join(dir, '.githooks'));
    writeFileSync(path.join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    git(dir, 'config', 'core.hooksPath', '.githooks');
    expect(git(dir, 'commit', '-m', 'refused').code).not.toBe(0);
    expect(existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test('mid-merge, it refuses to offer --no-verify and says why', () => {
    const dir = conflictedRepo();
    const out = advice(dir);
    expect(out).toContain('MID-MERGE');
    expect(out).toContain('conflict markers');
    rmSync(dir, { recursive: true, force: true });
  });

  test('mid-merge, the command it tells you to run actually finds the markers', () => {
    // Advice nobody can execute is advice nobody follows. The hook prints this
    // exact pipeline, so the test runs that rather than a paraphrase of it.
    const dir = conflictedRepo();
    const r = spawnSync('bash', ['-c', "git diff --cached -U0 | grep -c '^+<<<<<<<'"], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(Number((r.stdout ?? '0').trim())).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('NOT mid-merge, the ordinary advice is unchanged', () => {
    // The control. `--no-verify` is a legitimate escape hatch everywhere else,
    // and a fix that removed it everywhere would be wider than the defect.
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-advice-clean-'));
    git(dir, 'init', '-q', '--initial-branch=trunk');
    expect(existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);

    const out = advice(dir);
    expect(out).toContain('--no-verify');
    expect(out).not.toContain('MID-MERGE');
    rmSync(dir, { recursive: true, force: true });
  });
});
