import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { VIEWPORTS } from '../../apps/e2e/fixtures/devices';

/**
 * SC-745. Where GitHub Actions is this checkout's CI, its Playwright job runs
 * the suite through `apps/e2e/scripts/run.ts` (its `test:e2e` script, the name
 * SC-925's budget test recognises) and names EVERY viewport, because a bare run
 * of the runner takes only the desktop pair (`DEFAULT_SPEC_PROJECTS`) and the
 * mobile projects are the ones that caught an iPhone-only regression on
 * 2026-09-19. Keeping mobile in CI was a maintainer decision that day, so
 * dropping it must be a visible edit to this file rather than a quiet edit to a
 * YAML list.
 *
 * ONE FILE, TWO CHECKOUTS. `.github/workflows/ci.yml` is `merge=ours`, so the
 * two repositories keep different copies of it, and this file travels between
 * them. Which CI a checkout runs is decided the way `ci-inputs.test.ts` decides
 * it: a Buildkite pipeline of record means Actions is not CI there (SC-1169).
 * Each branch asserts something real about the `ci.yml` it read, and names it,
 * so neither can pass by reading nothing.
 *
 * It resolves the job by what it runs, never by its id or its name, for the
 * reason `e2e-timeout-is-legible.test.ts` gives.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const WORKFLOW = '.github/workflows/ci.yml';
const E2E_ROOT = `${ROOT}apps/e2e/`;
const E2E_SCRIPTS =
  (
    JSON.parse(readFileSync(`${E2E_ROOT}package.json`, 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts ?? {};

/**
 * What CI ran on 2026-09-19 (`Running 160 tests`): 40 tests on each of four
 * viewports. A spec deleted on purpose lowers it, and that edit belongs here
 * beside the reason.
 */
const MIN_CI_TESTS = 160;

const TRACKED = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .stdout.split('\n')
  .filter(Boolean);
const ACTIONS_IS_CI = !TRACKED.some(
  (f) =>
    /^docs\/ci\/[^/]+\.pipeline\.yml$/.test(f) ||
    /^infra\/buildkite\/pipelines\/[^/]+\.yml$/.test(f)
);

type Step = { name?: string; run?: string };
type Job = { steps?: Step[] };

const JOBS_ALL = Object.values(
  (Bun.YAML.parse(readFileSync(`${ROOT}${WORKFLOW}`, 'utf8')) as { jobs?: Record<string, Job> })
    .jobs ?? {}
);
const PLAYWRIGHT_JOBS = JOBS_ALL.filter((job) =>
  (job.steps ?? []).some((s) => (s.run ?? '').includes('playwright install'))
);
/** A step that runs the WHOLE spec suite: `test:e2e` itself rather than a
 *  `test:e2e:<subset>` script, or a bare Playwright invocation. */
const isFullSuite = (run: string): boolean =>
  /\btest:e2e\b(?!:)/.test(run) || /playwright test/.test(run);
const SUITE_STEPS = PLAYWRIGHT_JOBS.flatMap((job) =>
  (job.steps ?? []).filter((s) => isFullSuite(s.run ?? ''))
);
const SUITE_RUN = SUITE_STEPS[0]?.run ?? '';
const PROJECTS = [...SUITE_RUN.matchAll(/--project[= ](\S+)/g)].map((m) => m[1] ?? '');

/** `playwright test --list` over the given projects: how many tests it would run. */
function listedTests(projects: readonly string[]): number {
  const proc = Bun.spawnSync(
    ['bunx', 'playwright', 'test', '--list', ...projects.map((p) => `--project=${p}`)],
    { cwd: E2E_ROOT }
  );
  const out = new TextDecoder().decode(proc.stdout);
  const total = /Total: (\d+) tests? in/.exec(out)?.[1];
  if (proc.exitCode !== 0 || total === undefined) {
    throw new Error(
      `playwright --list did not answer (exit ${proc.exitCode}):\n${out}${new TextDecoder().decode(proc.stderr)}`
    );
  }
  return Number(total);
}

describe(`SC-745 · ${WORKFLOW} and the Playwright suite`, () => {
  /** THE CONTROL for both branches: the workflow parsed and has a Playwright job. */
  test(`${WORKFLOW} parses and exactly one job installs Playwright`, () => {
    expect(JOBS_ALL.length).toBeGreaterThan(0);
    expect(PLAYWRIGHT_JOBS.length).toBe(1);
  });

  test('test:e2e is the runner, in both checkouts', () => {
    expect(E2E_SCRIPTS['test:e2e']).toBe('bun scripts/run.ts');
  });

  // Only the branch for THIS checkout is registered, rather than the other
  // one skipped: bun's reporter prints a skip as a bare count, so a skipped
  // test could not say which file it did not check. Each checkout instead runs
  // a test whose title names the file and the CI it found.
  if (ACTIONS_IS_CI) {
    test(`Actions is CI here: ${WORKFLOW} runs the full suite once, through run.ts, on every viewport`, () => {
      expect(SUITE_STEPS.length).toBe(1);
      expect(SUITE_RUN).toMatch(/\bbun run test:e2e\b(?!:)/);
      expect(SUITE_RUN).not.toContain('playwright test');
      expect([...PROJECTS].sort()).toEqual(VIEWPORTS.map((v) => v.name).sort());
    });

    test(`those projects list at least ${MIN_CI_TESTS} tests, the same number on each`, () => {
      const total = listedTests(PROJECTS);
      const perViewport = listedTests([VIEWPORTS[0].name]);
      expect(perViewport).toBeGreaterThan(0);
      expect(total).toBe(perViewport * VIEWPORTS.length);
      expect(total).toBeGreaterThanOrEqual(MIN_CI_TESTS);
    });
  }

  /**
   * Buildkite is CI here, and Actions keeps only a subset job
   * (`test:e2e:a11y`). The assertion is that it stays a subset: a full-suite
   * step appearing in THIS `ci.yml` would be a second, unpinned copy of the
   * suite's CI, which is the duplication SC-745 removed from the mirror.
   */
  if (!ACTIONS_IS_CI) {
    test(`Buildkite is CI here: ${WORKFLOW} runs no full-suite Playwright step, only a subset`, () => {
      expect(SUITE_STEPS.map((s) => s.run)).toEqual([]);
      const subset = PLAYWRIGHT_JOBS[0]?.steps?.some((s) => /\btest:e2e:\w/.test(s.run ?? ''));
      expect(subset).toBe(true);
    });
  }
});
