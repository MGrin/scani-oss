import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

/**
 * SC-694. The per-test timeout budget, and the three ways it silently is not
 * what this repo says it is.
 *
 * `bunfig.toml` declared `[test] timeout = 30000` for months. Bun reads that
 * section — `preload` beside it works — and DROPS the `timeout` key without a
 * word, so every ad-hoc `bun test <path>` ran on 5000ms while the config, and
 * the comment above it, promised 30s. `bun run test` was unaffected because it
 * passes `--timeout 30000` on argv, so the gate was green the whole time and
 * only hand-run subsets flaked.
 *
 * That is why the assertions here are behavioural rather than textual. A test
 * that greps `bunfig.toml` for the absent key proves the line is gone; it
 * cannot notice bun starting or stopping to honour it. Each probe below runs a
 * real `bun test` in a scratch directory and reads the outcome.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

/** A sleep comfortably longer than the budget under test, and short enough
 *  that the whole file costs under a second. */
const SLEEP_MS = 400;
const BUDGET_MS = 200;

type Run = { readonly passed: number; readonly failed: number; readonly output: string };

function runInScratch(bunfig: string, testBody: string, args: string[] = []): Run {
  const dir = mkdtempSync(join(tmpdir(), 'sc694-budget-'));
  try {
    writeFileSync(join(dir, 'bunfig.toml'), bunfig);
    writeFileSync(join(dir, 'probe.test.ts'), testBody);

    const run = Bun.spawnSync(['bun', 'test', 'probe.test.ts', ...args], { cwd: dir });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;

    // A spawn that never ran reports 0 pass / 0 fail, which reads exactly like
    // a clean run of nothing. Refuse it rather than returning zeros.
    if (run.exitCode === null) {
      throw new Error(
        `the probe subprocess was killed by ${run.signalCode ?? 'an unknown signal'} and produced no verdict`
      );
    }
    const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? -1);
    const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? -1);
    if (passed < 0) throw new Error(`the probe produced no summary line:\n${output}`);

    return { passed, failed, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SLOW_TEST = `import { expect, test } from 'bun:test';
test('sleeps ${SLEEP_MS}ms', async () => {
  await new Promise((r) => setTimeout(r, ${SLEEP_MS}));
  expect(1).toBe(1);
});
`;

const SLOW_TEST_RAISING_ITS_OWN_BUDGET = `import { expect, setDefaultTimeout, test } from 'bun:test';
setDefaultTimeout(3000);
test('sleeps ${SLEEP_MS}ms', async () => {
  await new Promise((r) => setTimeout(r, ${SLEEP_MS}));
  expect(1).toBe(1);
});
`;

describe('the per-test budget comes from argv or setDefaultTimeout — never from bunfig', () => {
  /**
   * MUST-BE-ABSENT and MUST-BE-FOUND in one pair, and the second is what makes
   * the first mean anything: a sleep that no budget can fail would satisfy the
   * inertness probe for the wrong reason.
   */
  test('CONTROL — the budget under test really can fail this sleep', () => {
    const run = runInScratch('[test]\n', SLOW_TEST, ['--timeout', String(BUDGET_MS)]);

    expect(run.output).toContain(`timed out after ${BUDGET_MS}ms`);
    expect(run.failed).toBe(1);
  });

  test('a `timeout` key in bunfig [test] is IGNORED — the SC-694 defect', () => {
    const run = runInScratch(`[test]\ntimeout = ${BUDGET_MS}\n`, SLOW_TEST);

    // Passing means the ${BUDGET_MS}ms in bunfig did nothing — the control
    // above proves that same budget on argv kills this exact sleep.
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(0);
  });

  test('CONTROL — bun does read that section, so the key is dropped and not the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc694-preload-'));
    try {
      writeFileSync(join(dir, 'preloaded.ts'), 'globalThis.__SC694__ = true;\n');
      writeFileSync(join(dir, 'bunfig.toml'), '[test]\npreload = ["./preloaded.ts"]\n');
      writeFileSync(
        join(dir, 'probe.test.ts'),
        `import { expect, test } from 'bun:test';
test('preload from bunfig took effect', () => {
  expect((globalThis as Record<string, unknown>).__SC694__).toBe(true);
});
`
      );

      const run = Bun.spawnSync(['bun', 'test', 'probe.test.ts'], { cwd: dir });
      const output = `${run.stdout.toString()}${run.stderr.toString()}`;

      expect(output).toContain('1 pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setDefaultTimeout raises the budget, and outranks argv', () => {
    const run = runInScratch('[test]\n', SLOW_TEST_RAISING_ITS_OWN_BUDGET, [
      '--timeout',
      String(BUDGET_MS),
    ]);

    expect(run.passed).toBe(1);
    expect(run.failed).toBe(0);
  });
});

describe('the two working homes for the budget stay wired up', () => {
  test('bunfig.toml does not declare a `timeout` — it would be inert', () => {
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8');
    const declarations = bunfig.split('\n').filter((line) => /^\s*timeout\s*=/.test(line));

    expect(declarations).toEqual([]);
  });

  test('package.json passes --timeout, the only thing that gives the gate 30s', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.test).toContain('--timeout');
  });

  /**
   * The flake this ticket is about was a subprocess-spawning test on a 5000ms
   * budget. Spawning `bun scripts/check-docs.ts` costs 536ms at rest and
   * crossed 5000ms at load 30 — so any file doing it needs a budget that
   * survives a bare `bun test <path>`, which only `setDefaultTimeout` gives.
   */
  test('every test file that spawns check-docs raises its own budget', () => {
    // `scanSync` yields an iterator, not an array — `.length` on the iterator
    // helper chain is `undefined`, which reads as "no spawners" rather than
    // as a type error.
    // Matched on the path appearing inside a spawn's ARGV rather than on one
    // exact literal. Keying on `"'bun', 'scripts/check-docs.ts'"` means a file
    // that changes its quoting leaves this census silently and stops being
    // guarded while the census still reports clean; keying on the bare path
    // pulls in files that only mention it in a comment or a fixture. `bun` as
    // argv[0] is what separates running the checker from `git check-ignore`
    // on its path, which is cheap and needs no budget.
    //
    // SINCE SC-730 THE SPAWN LIVES BEHIND `scripts/lib/run-check-docs.ts`, so a
    // caller pays the identical subprocess cost with no inline spawn to match.
    // Keyed on either shape: the census went to ZERO when those six moved to the
    // helper, and the control below is what caught it rather than the file going
    // quietly vacuous — the first time this guard has been observed to fire,
    // which is what makes it known to work rather than merely never red.
    const SPAWNS_CHECK_DOCS = /spawnSync\(\s*\[\s*['"]bun['"][^\]]*check-docs\.ts|\brunCheckDocs\(/;

    const spawners = Array.from(new Bun.Glob('scripts/tests/*.test.ts').scanSync(REPO_ROOT))
      .map((rel) => ({ rel, source: readFileSync(join(REPO_ROOT, rel), 'utf8') }))
      .filter(({ source }) => SPAWNS_CHECK_DOCS.test(source));

    // Control: a rename would empty this list and every assertion would hold
    // vacuously, which is the failure mode this whole file exists to catch.
    expect(spawners.length).toBeGreaterThan(0);

    const unguarded = spawners
      .filter(({ source }) => !source.includes('setDefaultTimeout('))
      .map(({ rel }) => rel);

    expect(unguarded).toEqual([]);
  });
});
