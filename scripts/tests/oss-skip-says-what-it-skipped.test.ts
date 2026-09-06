import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countUnread } from '../check-oss-figures';
import { EXIT_OK, EXIT_UNKNOWN, unreadClause } from '../lib/check-verdict';

setDefaultTimeout(60_000);

/**
 * SC-972. A CONTENT SCANNER'S SKIP HAS TO SAY WHAT IT DID NOT READ.
 *
 * Four guards printed `SKIPPED · exit 0 · HEAD's tree carries 0/9 mirror-only
 * and 602/602 private-only path(s) — the private repo's share is the larger`:
 * one sentence, identical on every private commit, standing where a reader was
 * looking for a fact about their change. Under it, a denominator of zero — not
 * one line of the commit read, for figures, for production prose, for opaque
 * identifiers, for internal references. SC-835 fixed the fifth, which routes
 * PATHS, and left these four because the missing half is not something the
 * shared classifier can supply.
 *
 * ONE SENTENCE, FOUR PRINTERS, AND THE FIX IS STILL FOUR CALL SITES. The
 * wording comes from `classifyBranch` through `scanScope`, so it looked like
 * one repair in one place. It is not: `scanScope` is handed `BranchFacts` and
 * has no access to the population, and the populations differ — whole staged
 * files for `check-oss-internal-refs`, added lines for the other three, and
 * `check-oss-data-shapes` narrows even those. What is shared is the RENDERER
 * (`unreadClause`) and, for the three that read a diff, the COUNTER
 * (`countUnread`).
 *
 * ONE FILE RATHER THAN FOUR because the property under test is one property of
 * four guards, and a shared fixture that runs all four is less code than four
 * copies of it — which is also what makes a guard that regresses in only one
 * of them visible here.
 */

const SCRIPTS = path.resolve(import.meta.dir, '..');

/** The four guards, and the unit each reports its skip in. */
const GUARDS = [
  { name: 'oss-figures', script: 'check-oss-figures.ts', reads: 'lines' },
  { name: 'oss-data-shapes', script: 'check-oss-data-shapes.ts', reads: 'lines' },
  { name: 'oss-prose', script: 'check-oss-prose.ts', reads: 'lines' },
  { name: 'oss-internal-refs', script: 'check-oss-internal-refs.ts', reads: 'files' },
] as const;

describe('unreadClause — the four readings are four different sentences (SC-972)', () => {
  /**
   * EVERY WAY OF NOT KNOWING READS DIFFERENTLY FROM A ZERO. `routingClause`
   * has the same block for the same reason (SC-808, SC-865): a check that
   * could not look and one that looked at an empty index are different facts,
   * and printing them alike is the defect this whole family is about.
   */
  test('a blind read never reads as an empty index', () => {
    const blind = unreadClause(null, 'staged');
    const empty = unreadClause({ paths: 0, addedLines: 0 }, 'staged');

    expect(blind).toContain('NOTHING WAS SCANNED');
    expect(blind).toContain('not a count of zero');
    expect(empty).toContain('there was nothing to scan');

    // MUST-BE-RED both ways. Either assertion alone passes if the two
    // sentences were merged into one.
    expect(blind).not.toContain('there was nothing to scan');
    expect(empty).not.toContain('NOTHING WAS SCANNED');
  });

  test('a whole-file scanner counts files and a diff scanner counts lines', () => {
    expect(unreadClause({ paths: 3, addedLines: null }, 'staged')).toBe(
      '3 staged path(s) went UNSCANNED'
    );
    expect(unreadClause({ paths: 3, addedLines: 12 }, 'staged')).toBe(
      '12 added line(s) across 3 staged path(s) went UNSCANNED'
    );
  });

  test('the noun travels, so a pushed range never reads as an index', () => {
    expect(unreadClause({ paths: 2, addedLines: 5 }, 'pushed')).toContain('2 pushed path(s)');
    expect(unreadClause({ paths: 2, addedLines: 5 }, 'pushed')).not.toContain('staged');
    expect(unreadClause(null, 'pushed')).toContain('pushed change');
  });
});

describe('countUnread — the denominator covers paths this check does not read (SC-972)', () => {
  /** A minimal `--unified=0` diff, in the shape `population()` produces. */
  function diff(...files: { path: string; added: string[] }[]): string {
    return files
      .map(
        (f) =>
          `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n` +
          `@@ -0,0 +1,${f.added.length} @@\n${f.added.map((l) => `+${l}`).join('\n')}`
      )
      .join('\n');
  }

  const scannable = (p: string) => !p.endsWith('.svg');

  /**
   * THE TRAP THIS EXISTS FOR. Counting paths through the scannable filter
   * would report `0 staged path(s), so there was nothing to scan` over a
   * commit that staged a `.svg` — which is the reading an EMPTY INDEX gives,
   * and a different fact entirely.
   */
  test('an unscannable staged path still appears in the denominator', () => {
    const counted = countUnread(diff({ path: 'logo.svg', added: ['<svg/>'] }), scannable);
    expect(counted).toEqual({ paths: 1, addedLines: 0 });
    expect(unreadClause(counted, 'staged')).not.toContain('there was nothing to scan');
  });

  /**
   * The control for the test above. Without it, a `countUnread` that always
   * returned `addedLines: 0` would pass it — so the zero has to come from a
   * comparison that has just been shown able to come back non-zero.
   */
  test('a scannable path contributes its added lines', () => {
    expect(countUnread(diff({ path: 'a.ts', added: ['x', 'y'] }), scannable)).toEqual({
      paths: 1,
      addedLines: 2,
    });
  });

  test('an empty diff is zero paths, which is what makes the empty reading reachable', () => {
    expect(countUnread('', scannable)).toEqual({ paths: 0, addedLines: 0 });
  });
});

describe('the skip line is about the diff, on all four guards (SC-972)', () => {
  /**
   * `.private-repo` with no `upstream` remote is `scanScope`'s private-clone
   * arm. It is used here rather than the tree-marker arm because it makes the
   * BRANCH CLAUSE A CONSTANT — it reads no tree — which is what lets the pair
   * below isolate the diff clause as the only thing that moves.
   *
   * WHERE THIS IS NARROWER THAN THE FIX, stated rather than left to be
   * discovered: the live shape in the ticket is the tree-marker arm
   * (`HEAD's tree carries 0/9 mirror-only …`), and no fixture here builds two
   * remotes to reach it. That is admissible because `scope.kind === 'skip'` is
   * ONE code path whichever arm produced it — the clause is computed after the
   * branch question is already answered — but it does mean a regression in
   * `classifyBranch`'s wording would not be caught here. It is caught by
   * `check-oss-bound-paths.test.ts`, which owns that arm.
   *
   * It is also narrower in a second way: the `--stdin-commits` (pushed) mode
   * is asserted only through `unreadClause`'s noun above, not end to end.
   */
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'sc972-'));
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir });
      if (!r.success) throw new Error(`git ${args[0]} failed`);
    }
    writeFileSync(path.join(dir, '.private-repo'), '');
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    Bun.spawnSync(['git', 'commit', '-qm', 'seed'], { cwd: dir });
    return dir;
  }

  function stage(dir: string, file: string, body: string): void {
    writeFileSync(path.join(dir, file), body);
    const r = Bun.spawnSync(['git', 'add', file], { cwd: dir });
    if (!r.success) throw new Error(`git add ${file} failed`);
  }

  function run(
    dir: string,
    script: string,
    env: Record<string, string> = {}
  ): { code: number; out: string } {
    const r = Bun.spawnSync(['bun', path.join(SCRIPTS, script)], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const dec = new TextDecoder();
    return { code: r.exitCode ?? -1, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
  }

  /** What the branch clause says on this fixture. Constant across every run below. */
  const BRANCH_CLAUSE = '`.private-repo` marks this as the private repo';

  /**
   * THE PAIR IS WHAT PROVES IT, and either half alone proves nothing. One
   * repository, one branch, one tree, two indexes: if the clause were still
   * computed from the branch both readings would be identical, and if it were
   * computed from nothing both would read zero. Only a clause read off the
   * index moves while the branch clause holds still.
   */
  for (const guard of GUARDS) {
    test(`${guard.name}: the clause moves with the index while the branch clause holds`, () => {
      const dir = repo();
      try {
        stage(dir, 'a.ts', 'const a = 1;\n');
        const one = run(dir, guard.script);
        expect(one.code).toBe(EXIT_OK);
        expect(one.out).toContain('SKIPPED');
        expect(one.out).toContain(BRANCH_CLAUSE);
        expect(one.out).toContain(
          guard.reads === 'files'
            ? '1 staged path(s) went UNSCANNED'
            : '1 added line(s) across 1 staged path(s) went UNSCANNED'
        );

        stage(dir, 'b.ts', 'const b = 1;\nconst c = 2;\nconst d = 3;\n');
        const two = run(dir, guard.script);
        expect(two.code).toBe(EXIT_OK);
        // The constant, against which the clause above is the variable.
        expect(two.out).toContain(BRANCH_CLAUSE);
        expect(two.out).toContain(
          guard.reads === 'files'
            ? '2 staged path(s) went UNSCANNED'
            : '4 added line(s) across 2 staged path(s) went UNSCANNED'
        );

        // The defect itself: the branch sentence standing alone where the
        // reader was looking for their change.
        expect(two.out).not.toMatch(/SKIPPED · exit 0 · (HEAD's tree carries|no `upstream`)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  /**
   * An empty index is a real answer and must not read like the pair above with
   * the numbers happening to be zero.
   */
  for (const guard of GUARDS) {
    test(`${guard.name}: an empty index says there was nothing to scan`, () => {
      const dir = repo();
      try {
        const { code, out } = run(dir, guard.script);
        expect(code).toBe(EXIT_OK);
        expect(out).toContain('0 staged path(s), so there was nothing to scan');
        expect(out).not.toContain('went UNSCANNED');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  /**
   * MUST-BE-RED. `git diff --cached` dying cannot be answered with a refusal
   * on this path: the skip is a conclusion about the BRANCH, which is still
   * readable. So the clause degrades and the exit code does not move — and the
   * one thing it must never do is report the zero a genuinely empty index
   * reports.
   *
   * This is the arm the whole design turns on. `check-oss-internal-refs`
   * answers the SAME failed read with EXIT_UNKNOWN one branch further down,
   * where the read IS the scan; asserting both directions is what keeps the
   * asymmetry deliberate rather than accidental.
   */
  for (const guard of GUARDS) {
    test(`${guard.name}: a dead \`git diff --cached\` degrades the clause, not the verdict`, () => {
      const dir = repo();
      const shimDir = mkdtempSync(path.join(tmpdir(), 'sc972-shim-'));
      try {
        stage(dir, 'a.ts', 'const a = 1;\n');
        writeFileSync(
          path.join(shimDir, 'git'),
          '#!/bin/sh\nif [ "$1" = "diff" ]; then for a in "$@"; do [ "$a" = "--cached" ] && exit 1; done; fi\nexec /usr/bin/git "$@"\n',
          { mode: 0o755 }
        );
        const { code, out } = run(dir, guard.script, {
          PATH: `${shimDir}:${process.env.PATH}`,
        });

        expect(code).toBe(EXIT_OK);
        expect(code).not.toBe(EXIT_UNKNOWN);
        expect(out).toContain('SKIPPED');
        expect(out).toContain('NOTHING WAS SCANNED');
        // The reading it must never be confusable with.
        expect(out).not.toContain('0 staged path(s), so there was nothing to scan');
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
