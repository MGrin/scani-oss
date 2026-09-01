import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addedLines,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_SELF_TEST_FAILED,
  findFigures,
  isScannable,
  PROBE_COUNT,
  type Probe,
  selfTest,
  verifyProbes,
} from '../check-oss-figures';
import { replayStrandedMutations, withMutatedSources } from '../lib/test-source-mutations';

/**
 * SC-887. A production balance reached `MGrin/scani-oss` inside a test fixture
 * and no check saw it: `secret-scan` looks for credentials and a balance is not
 * one; `oss-classify` answers *may this FILE be public*, and every file in the
 * SC-856 leak was correctly `oss-eligible`; review does not catch it because a
 * decimal in a fixture looks like a decimal in a fixture.
 *
 * EVERY FIGURE BELOW IS INVENTED — `98765.43210987` is a descending keyboard
 * run — and that is load-bearing rather than tidiness. The first draft of this
 * file used the balance that actually leaked, reasoning that a test which
 * cannot name the value it exists to catch is testing something else. That
 * value is inert only BECAUSE it was scrubbed from `upstream/main`, and this
 * file is published: writing it back in commits the leak a second time, inside
 * the guard against it, permanently. Same conclusion as
 * `check-oss-internal-refs.test.ts` reaches by splitting its probes across a
 * `${}` boundary, reached from the opposite direction.
 *
 * The shape is what the guard reads, and the shape is reproduced exactly: five
 * fraction digits or more, in a fixture, on an added line.
 */

/**
 * Every process test spawns `bun scripts/check-oss-figures.ts`, which spawns
 * several `git` calls of its own — so the cost is subprocess startup, which
 * amplifies under load far harder than CPU work. `bun run test` passes
 * `--timeout 30000`; a bare `bun test <path>` gets 5000ms and `bunfig.toml`
 * cannot raise it, because bun drops a `timeout` key from `[test]` silently
 * (SC-694). This call is the only budget that survives both invocations.
 */
setDefaultTimeout(30_000);

/**
 * SC-601. The gutting arm below rewrites tracked source in place. A `kill -9`
 * between the write and the restore skips `finally`, stranding it — so the
 * journal a previous killed run left is replayed here, before anything else.
 */
replayStrandedMutations(path.resolve(import.meta.dir, '..', '..'));

describe('what counts as a figure', () => {
  test('finds the literal that actually leaked', () => {
    expect(findFigures("await setBalance(h, '98765.43210987');")).toEqual(['98765.43210987']);
  });

  test('finds every figure on one line, not just the first', () => {
    expect(findFigures('from 1000.12345678 to 3000.12345678')).toEqual([
      '1000.12345678',
      '3000.12345678',
    ]);
  });

  /**
   * The threshold is a CALIBRATION, not a claim that two-digit figures are
   * safe. Measured over the last 60 merges on `origin/main`, added lines only:
   * a two-fraction-digit rule is 140 hits firing on 17 of 60 PRs, against 18
   * hits on 8 of 60 at three digits — and 4 hits on 3 of 60 once ISO-8601
   * timestamps come out. `6500.32` and `172.85`, two of the three figures
   * SC-887 names, have two fraction digits and this rule does NOT see them.
   * Both are already public and out of scope by mgrin's ruling; the point of
   * this test is that the limit is deliberate and recorded, so the next reader
   * does not take a green run as *no production figure was added*.
   */
  test('a two-fraction-digit figure is BELOW the threshold and is not reported', () => {
    expect(findFigures("expect(total).toBe('6500.32');")).toEqual([]);
    expect(findFigures("expect(row.amount).toBe('172.85');")).toEqual([]);
  });

  test('a semver is not a figure', () => {
    expect(findFigures("import x from 'pkg@2.4.12';")).toEqual([]);
    expect(findFigures('bunx @biomejs/biome@2.4.12 check')).toEqual([]);
  });

  test('an integer is not a figure', () => {
    expect(findFigures('const CAP = 98765;')).toEqual([]);
  });
});

/**
 * THE ONE EXCLUSION, AND WHY IT EARNS ITS PLACE. Of the 18 added figures across
 * the last 60 merges on `origin/main`, 14 are the milliseconds field of an
 * ISO-8601 timestamp — `2026-08-03T09:00:00.000Z` matching as `00.000`. One
 * source, 78% of the noise, and it carries no financial quantity at any time.
 * Without this the guard fires on 13% of PRs and is mostly wrong; with it, on
 * 5%, and every one of the four survivors is balance-shaped.
 */
describe('ISO-8601 timestamps are not figures', () => {
  test('extended form', () => {
    expect(findFigures("externalId: 'manual-edit:2026-08-03T09:00:00.000Z',")).toEqual([]);
  });

  test('space-separated form', () => {
    expect(findFigures("'2026-08-03 09:00:00.000'")).toEqual([]);
  });

  test('basic form, no separators', () => {
    expect(findFigures("expect('scani-20260829T060000.123Z.dump')")).toEqual([]);
  });

  /**
   * The exclusion removes the TIMESTAMP, never the line. A fixture that dates a
   * balance is the commonest shape in this repository's tests, so an exclusion
   * that blanked the whole line would switch the guard off for exactly the
   * lines it exists to read.
   */
  test('a balance on the same line as a timestamp is still reported', () => {
    expect(
      findFigures("{ capturedAt: '2026-08-31T03:01:00.000Z', balance: '98765.43210987' }")
    ).toEqual(['98765.43210987']);
  });
});

describe('which paths are read', () => {
  test('source and fixtures are read', () => {
    expect(isScannable('packages/business/domain/tests/services/X.test.ts')).toBe(true);
    expect(isScannable('apps/frontend/app/src/v3/lib/holdings.tsx')).toBe(true);
    expect(isScannable('docs/features/returns.md')).toBe(true);
  });

  /**
   * Vector art and a lockfile are the two big stock populations and neither can
   * carry a balance: the logo alone holds 1046 path coordinates, and `bun.lock`
   * 47 resolved versions. Measured against `upstream/main` 2026-09-01.
   */
  test('vector art and lockfiles are not read', () => {
    expect(isScannable('apps/frontend/app/public/icons/svg/scani-logo.svg')).toBe(false);
    expect(isScannable('bun.lock')).toBe(false);
    expect(isScannable('apps/frontend/app/src/index.css')).toBe(false);
  });
});

describe('added lines', () => {
  const DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -10,0 +11,2 @@',
    "+const a = '1.2345';",
    "+const b = '2.3456';",
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -3,1 +3,1 @@',
    "-const gone = '9.8765';",
    "+const kept = '8.7654';",
  ].join('\n');

  test('reads only added lines, with their path and new-file line number', () => {
    expect(addedLines(DIFF)).toEqual([
      { path: 'a.ts', line: 11, text: "const a = '1.2345';" },
      { path: 'a.ts', line: 12, text: "const b = '2.3456';" },
      { path: 'b.ts', line: 3, text: "const kept = '8.7654';" },
    ]);
  });

  /**
   * A REMOVED line is what makes this guard survivable at all. The stock in
   * `upstream/main` is 858 figures across 176 files after exclusions, so a
   * check that read file CONTENT rather than added lines would refuse 176 files
   * on its first run and be switched off inside a week — which is the outcome
   * SC-887 asks to be designed against.
   */
  test('a removed line is not an added line', () => {
    expect(addedLines(DIFF).map((l) => l.text)).not.toContain("const gone = '9.8765';");
  });

  test('the `+++ b/path` header is not mistaken for an added line', () => {
    expect(addedLines(DIFF).map((l) => l.text)).not.toContain('b/a.ts');
  });

  test('a rename with no hunk contributes nothing', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    expect(addedLines(diff)).toEqual([]);
  });
});

/**
 * MUST-BE-FOUND, not merely must-be-absent. Every rule in this file reads zero
 * against a clean branch, so a green run and a pattern that has silently
 * stopped matching produce identical output — the exact failure the guard is
 * about, sitting inside the guard. `check-oss-internal-refs.ts` closes it with
 * a probe and an anti-probe per rule and refuses to scan when either has
 * stopped behaving; this does the same.
 */
describe('the guard verifies itself before it scans', () => {
  test('every probe still behaves as written', () => {
    expect(selfTest()).toEqual([]);
  });

  test('there is more than one probe, so a green is not one lucky pattern', () => {
    expect(PROBE_COUNT).toBeGreaterThan(3);
  });

  test('a probe that stopped matching is reported', () => {
    const broken: Probe = { name: 'x', mustFind: ['9.8765'], mustNotFind: [] };
    expect(verifyProbes([{ ...broken, mustFind: ['no digits here'] }])).toEqual([
      'x: no longer finds "no digits here"',
    ]);
  });

  test('a probe that started matching something it must not is reported', () => {
    const broken: Probe = { name: 'y', mustFind: [], mustNotFind: ['1.2345'] };
    expect(verifyProbes([broken])).toEqual([
      'y: now finds a figure in "1.2345", which it must not',
    ]);
  });
});

/**
 * END TO END, THROUGH THE REAL SCRIPT AND A REAL GIT INDEX, because everything
 * above tests pure functions and none of it proves the process refuses. The
 * repository is built to look like the public mirror — no `upstream` remote and
 * no `.private-repo` marker — which is `scanScope`'s *this checkout IS the
 * mirror, so everything committed here is public* arm, and the arm an upstream
 * PR is actually made from.
 */
describe('the process', () => {
  const root = path.resolve(import.meta.dir, '..', '..');
  const SCRIPT = path.resolve(import.meta.dir, '..', 'check-oss-figures.ts');

  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-figures-'));
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir });
      if (!r.success) throw new Error(`git ${args[0]} failed`);
    }
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    Bun.spawnSync(['git', 'commit', '-qm', 'seed'], { cwd: dir });
    return dir;
  }

  function stage(dir: string, file: string, body: string): void {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
    const r = Bun.spawnSync(['git', 'add', file], { cwd: dir });
    if (!r.success) throw new Error(`git add ${file} failed`);
  }

  function run(dir: string, env: Record<string, string> = {}): { code: number; out: string } {
    const r = Bun.spawnSync(['bun', SCRIPT], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const dec = new TextDecoder();
    return { code: r.exitCode ?? -1, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
  }

  test('refuses a staged fixture carrying the value that leaked', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', "const balance = '98765.43210987';\n");
      const { code, out } = run(dir);
      expect(out).toContain('98765.43210987');
      expect(out).toContain('tests/x.test.ts:1');
      expect(code).toBe(EXIT_REFUSED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The half the guard cannot do has to be in the REFUSAL, not only in a
   * ticket. Prose was half of SC-856 — the live account was named in two
   * docblocks, a test comment and both PR descriptions — and a guard that
   * silently covers one half is one somebody will trust for both.
   */
  test('the refusal states that it cannot read prose', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', "const balance = '98765.43210987';\n");
      expect(run(dir).out).toMatch(/prose/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes a staged fixture whose figures are all timestamps', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', "const at = '2026-08-03T09:00:00.000Z';\n");
      const { code, out } = run(dir);
      expect(out).toContain('PASS');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The denominator, on every outcome. A `0 figure(s)` with no count beside it
   * cannot be told from a run that read nothing at all — the SC-771/SC-780
   * family, restated in `scripts/lib/check-verdict.ts`.
   */
  test('a pass prints how many added lines were read', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', 'const n = 1;\n');
      expect(run(dir).out).toMatch(/1 added line\(s\) read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unscannable path is counted as skipped, not silently dropped', () => {
    const dir = repo();
    try {
      stage(dir, 'logo.svg', '<path d="M1.2345 6.7890"/>\n');
      const { code, out } = run(dir);
      expect(out).toContain('1 path(s) not read');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The escape is the `OSS_ALLOW_NEW_FILES` shape: cheap to clear, and clearing
   * it means asserting something. It is only a safety property while that
   * assertion is real, so the line it prints says what was asserted rather than
   * just that a variable was set (CLAUDE.md, "An escape hatch is safe only
   * while using it means asserting something you believe").
   */
  test('OSS_ALLOW_FIGURES=1 admits it and records what was asserted', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', "const balance = '98765.43210987';\n");
      const { code, out } = run(dir, { OSS_ALLOW_FIGURES: '1' });
      expect(out).toContain('OSS_ALLOW_FIGURES=1');
      expect(out).toContain('not drawn from production');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The escape ADMITS, and admitting nothing is worth saying out loud: a run
   * that set it and had no figures to admit looks identical to one where it
   * worked, and that is how a variable stays set in a shell for a week.
   */
  test('OSS_ALLOW_FIGURES=1 with nothing to admit says so', () => {
    const dir = repo();
    try {
      stage(dir, 'tests/x.test.ts', 'const n = 1;\n');
      const { code, out } = run(dir, { OSS_ALLOW_FIGURES: '1' });
      expect(out).toContain('admitted nothing');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A guard that cannot demonstrate it still works has not checked anything, so
   * a broken probe is neither a pass nor a refusal. `EXIT_SELF_TEST_FAILED`
   * matches `check-oss-internal-refs.ts`.
   *
   * PROVED BY GUTTING THE REAL SCRIPT, not by an env-var seam: a production
   * flag that exists only so a test can break the guard is test-only code in
   * production, and it also proves the seam works rather than that the probes
   * do. `withMutatedSources` journals the original bytes before writing, so a
   * `kill -9` between here and the restore is repaired by the replay at the top
   * of this file rather than committed by the next `git add -A` (SC-601).
   */
  test('a broken probe stops the scan rather than passing it', () => {
    const dir = repo();
    const original = readFileSync(SCRIPT, 'utf8');
    // The pattern is widened to need only ONE fraction digit, which makes
    // `2.4.12` match and the `dotted version` probe's `mustNotFind` fail.
    const gutted = original.replace(
      'const FIGURE = /(?<![\\d.])\\d+\\.\\d{3,}(?![\\d])/g;',
      'const FIGURE = /(?<![\\d.])\\d+\\.\\d{1,}(?![\\d])/g;'
    );
    try {
      stage(dir, 'tests/x.test.ts', 'const n = 1;\n');
      const { exitCode, output } = withMutatedSources(root, { [SCRIPT]: gutted }, () => {
        const r = run(dir);
        return { exitCode: r.code, output: r.out };
      });
      expect(output).toContain('NOTHING WAS SCANNED');
      expect(output).toContain('no longer behave as written');
      expect(exitCode).toBe(EXIT_SELF_TEST_FAILED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Restoration is asserted, not assumed: a stranded mutation here turns
    // every later file in this single-process run red with no connection to
    // what it names.
    expect(readFileSync(SCRIPT, 'utf8')).toBe(original);
  });

  /**
   * On a PRIVATE branch there is nothing to leak to, and a guard that fired
   * there would fire on every commit in the repository. `.private-repo` plus no
   * `upstream` remote is the private-clone arm of `scanScope`.
   */
  test('skips when the checkout is the private repo with no mirror to push to', () => {
    const dir = repo();
    try {
      writeFileSync(path.join(dir, '.private-repo'), '');
      stage(dir, 'tests/x.test.ts', "const balance = '98765.43210987';\n");
      const { code, out } = run(dir);
      expect(out).toContain('SKIPPED');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * PROOF THE POPULATION IS REACHABLE FROM A COMMIT LIST, which is the mode the
 * pre-push hook uses and the only one the documented port flow reaches.
 * SC-813 measured `cherry-pick` and `rebase` firing pre-commit ZERO times
 * against a control of 4 firings for 4 ordinary commits — so a figure ported by
 * cherry-pick is invisible to the staged-diff mode above.
 */
describe('the commit-list mode', () => {
  const SCRIPT = path.resolve(import.meta.dir, '..', 'check-oss-figures.ts');

  test('refuses a figure introduced by a commit named on stdin', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-figures-push-'));
    try {
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['config', 'user.email', 't@example.com'],
        ['config', 'user.name', 'T'],
        ['config', 'commit.gpgsign', 'false'],
      ])
        Bun.spawnSync(['git', ...args], { cwd: dir });
      writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'seed'], { cwd: dir });

      writeFileSync(path.join(dir, 'x.test.ts'), "const balance = '98765.43210987';\n");
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add fixture'], { cwd: dir });
      const sha = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout)
        .trim();

      const r = Bun.spawnSync(['bun', SCRIPT, '--stdin-commits'], {
        cwd: dir,
        stdin: new TextEncoder().encode(`${sha}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const dec = new TextDecoder();
      const out = dec.decode(r.stdout) + dec.decode(r.stderr);
      expect(out).toContain('98765.43210987');
      expect(r.exitCode).toBe(EXIT_REFUSED);
      // The denominator has to READ, not just be present. Interpolating the
      // commit count into the slot the word `staged` occupies produced
      // `across 4 1 pushed commit(s) path(s)`, which is the one line a reader
      // is asked to quote as evidence a check ran.
      expect(out).toMatch(/1 added line\(s\) read across 1 path\(s\) in 1 pushed commit\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The guard is wired into BOTH hooks, and neither is optional for a different
 * reason. Pre-commit is the earliest point and the shape SC-856 actually took —
 * a worker authoring a test. Pre-push is the only one a cherry-picked port
 * reaches, and it is the last gate before the content is public.
 */
describe('the hooks call it', () => {
  const root = path.resolve(import.meta.dir, '..', '..');

  test('pre-commit runs the figures check', async () => {
    const hook = await Bun.file(path.join(root, '.githooks', 'pre-commit')).text();
    expect(hook).toContain('scripts/check-oss-figures.ts');
  });

  test('pre-push runs the figures check', async () => {
    const hook = await Bun.file(path.join(root, '.githooks', 'pre-push')).text();
    expect(hook).toContain('scripts/check-oss-figures.ts');
  });
});
