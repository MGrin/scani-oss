import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VIEWPORTS } from '../../apps/e2e/fixtures/devices';

/**
 * SC-745. CI's Playwright step runs the suite through `apps/e2e/scripts/run.ts`
 * (its `test:e2e` script, the name SC-925's budget test recognises)
 * and names EVERY viewport, because a bare run of the runner takes only the
 * desktop pair (`DEFAULT_SPEC_PROJECTS`) and the mobile projects are the ones
 * that caught an iPhone-only regression on 2026-09-19. Keeping mobile in CI
 * was a maintainer decision that day, so dropping it must be a visible edit
 * to this file rather than a quiet edit to a YAML list.
 *
 * It resolves the job by what it runs, never by its id or its name, for the
 * reason `e2e-timeout-is-legible.test.ts` gives.
 */

const WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);
const E2E_ROOT = new URL('../../apps/e2e/', import.meta.url).pathname;
const E2E_SCRIPTS =
  (
    JSON.parse(readFileSync(`${E2E_ROOT}package.json`, 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts ?? {};

/**
 * What CI ran on 2026-09-19 (`Running 160 tests`, run 35405872527): 40 tests
 * on each of four viewports. A spec deleted on purpose lowers it, and that
 * edit belongs here beside the reason.
 */
const MIN_CI_TESTS = 160;

type Step = { name?: string; run?: string };
type Job = { steps?: Step[] };

const WORKFLOW = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs?: Record<string, Job>;
};
const JOBS = Object.values(WORKFLOW.jobs ?? {}).filter((job) =>
  (job.steps ?? []).some((s) => (s.run ?? '').includes('playwright install'))
);
const SUITE_STEPS = (JOBS[0]?.steps ?? []).filter((s) =>
  /test:e2e|playwright test/.test(s.run ?? '')
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

describe('SC-745 · CI runs the Playwright suite through run.ts on every viewport', () => {
  /** THE CONTROL: every assertion below reads out of this one step. */
  test('exactly one job installs Playwright, and it has exactly one suite step', () => {
    expect(JOBS.length).toBe(1);
    expect(SUITE_STEPS.length).toBe(1);
  });

  test('the suite step goes through run.ts, not a bare playwright invocation', () => {
    expect(SUITE_RUN).toMatch(/\bbun run test:e2e\b(?!:)/);
    expect(SUITE_RUN).not.toContain('playwright test');
    expect(E2E_SCRIPTS['test:e2e']).toBe('bun scripts/run.ts');
  });

  test('it names every viewport devices.ts defines, and nothing else', () => {
    expect([...PROJECTS].sort()).toEqual(VIEWPORTS.map((v) => v.name).sort());
  });

  test(`those projects list at least ${MIN_CI_TESTS} tests, the same number on each`, () => {
    const total = listedTests(PROJECTS);
    const perViewport = listedTests([VIEWPORTS[0].name]);
    expect(perViewport).toBeGreaterThan(0);
    expect(total).toBe(perViewport * VIEWPORTS.length);
    expect(total).toBeGreaterThanOrEqual(MIN_CI_TESTS);
  });
});
