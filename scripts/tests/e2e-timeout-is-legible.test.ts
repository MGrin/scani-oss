import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * SC-925. The Playwright job's `timeout-minutes` expiring is the one outcome
 * this workflow produces that is neither a pass nor a failure: GitHub kills
 * the job as `cancelled`, and the terminal `CI Success` job correctly turns
 * that into a `failure` — so a pull request is blocked by a job that did not
 * fail, and the honest answer to "what broke" is "nothing".
 *
 * WHAT THIS FILE PINS, and why each half needs pinning:
 *
 *   THE BUDGETS. A step budget expiring is an ordinary `failure` that names
 *   its step; only the JOB budget produces the illegible `cancelled`. That
 *   ordering is a property of the numbers — it holds only while the step
 *   budgets sum below the job budget — and nothing else in the repository
 *   would notice a later edit inverting it.
 *
 *   THE BUDGET STATED TWICE. `jobs.<id>.timeout-minutes` cannot read the
 *   `env` context and no context carries it back, so the reporting step has
 *   to be told the budget separately. Two copies of one number is a drift
 *   waiting to happen, and a drifted one is worse than none: the report would
 *   confidently compare the elapsed time against a budget that is not the one
 *   that killed the job.
 *
 *   THE REPORT ITSELF, BY EXECUTION. The step is shell, so the only honest
 *   check is to run it. The three cases below are executed against the bytes
 *   extracted from the YAML — not a copy — the same way
 *   `deploy-replays-undeployed-backlog.test.ts` treats its scripts.
 *
 * IT RESOLVES THE JOB BY WHAT IT RUNS, NEVER BY ITS ID OR ITS NAME. The two
 * repositories' `ci.yml` are `merge=ours` and have diverged: the mirror's job
 * is `e2e` / `E2E (Playwright)`, the private one is `e2e-a11y` /
 * `Accessibility gate & mobile smoke`, and they run different commands under
 * different budgets. Keying on either identifier would make this file assert
 * nothing at all in one of the two checkouts — which is the vacuous pass this
 * whole ticket is about, reproduced inside its own guard.
 */

const WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  'timeout-minutes'?: number;
};
type Job = {
  name?: string;
  env?: Record<string, string>;
  steps?: Step[];
  'timeout-minutes'?: number;
};

const WORKFLOW = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs?: Record<string, Job>;
};
const JOBS = WORKFLOW.jobs ?? {};

/**
 * The job that installs Playwright browsers. One in each repository, and the
 * identifier differs between them — see the header. A `run:` this specific
 * cannot match a second job by accident.
 */
const ENTRIES = Object.entries(JOBS).filter(([, job]) =>
  (job.steps ?? []).some((s) => (s.run ?? '').includes('playwright install'))
);
const [JOB_ID, JOB] = ENTRIES[0] ?? ['', undefined as unknown as Job];
const STEPS: Step[] = JOB?.steps ?? [];

function stepIndex(predicate: (s: Step) => boolean): number {
  return STEPS.findIndex(predicate);
}

const REPORTER = STEPS.find((s) => (s.run ?? '').includes('E2E_BUDGET_MINUTES'));

/** Run the reporter's own bytes the way the runner does: `bash -e <file>`. */
function runReporter(env: Record<string, string>): {
  code: number;
  stdout: string;
  summary: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'sc925-'));
  const script = join(dir, 'reporter.sh');
  const summary = join(dir, 'summary.md');
  writeFileSync(script, REPORTER?.run ?? '');
  writeFileSync(summary, '');
  const proc = Bun.spawnSync(['bash', '-e', script], {
    env: { PATH: process.env.PATH ?? '', GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
    summary: readFileSync(summary, 'utf8'),
  };
}

describe('SC-925 · the Playwright job cannot die on an unexplained clock', () => {
  /**
   * THE CONTROL. Every assertion below reads out of `JOB`. A parse that
   * yielded no jobs, or a job that stopped installing browsers, makes them
   * vacuous rather than red — `undefined` compares equal to `undefined` in
   * more places than is comfortable. If this one goes red, nothing else in
   * this file means anything.
   */
  test('the workflow parses and exactly one job installs Playwright', () => {
    expect(Object.keys(JOBS).length).toBeGreaterThan(0);
    expect(ENTRIES.length).toBe(1);
    expect(JOB_ID.length).toBeGreaterThan(0);
    expect(STEPS.length).toBeGreaterThan(4);
  });

  test('the job declares a budget at all', () => {
    expect(typeof JOB?.['timeout-minutes']).toBe('number');
    expect(JOB?.['timeout-minutes']).toBeGreaterThan(0);
  });

  /**
   * The two numbers that must agree. A reader who edits `timeout-minutes` and
   * not the env — the likely edit, since the env sits ten lines lower — gets
   * a red here rather than a report comparing against the wrong budget.
   */
  test('E2E_BUDGET_MINUTES states the same budget as timeout-minutes', () => {
    const budget = JOB?.['timeout-minutes'];
    // Asserted here as well as in its own test above: `expect` throws, so
    // this is what stops the comparison below from reading NaN === NaN as
    // agreement when BOTH numbers are absent.
    expect(typeof budget).toBe('number');
    expect(JOB?.env?.E2E_BUDGET_MINUTES).toBeDefined();
    expect(Number(JOB?.env?.E2E_BUDGET_MINUTES)).toBe(Number(budget));
  });

  /**
   * The whole design in one assertion. The job budget is a backstop; if the
   * step budgets ever sum past it, the job budget binds first and every
   * timeout goes back to being an unattributable `cancelled`.
   */
  test('the step budgets sum below the job budget, so a step always binds first', () => {
    const stepBudgets = STEPS.map((s) => s['timeout-minutes']).filter(
      (n): n is number => typeof n === 'number'
    );
    expect(stepBudgets.length).toBeGreaterThanOrEqual(2);
    const sum = stepBudgets.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(JOB?.['timeout-minutes'] ?? 0);
  });

  /**
   * The two steps that have actually consumed a whole job budget: the browser
   * install hung 14m40s against packages.microsoft.com on 2026-09-04, and the
   * suite was killed 11m12s in on 2026-09-03 while it was reporting real
   * failures. Both are bounded now; neither was.
   */
  test('the browser install and the suite each carry their own budget', () => {
    const install = STEPS.find((s) => (s.run ?? '').includes('playwright install'));
    const suite = STEPS.find(
      (s) => (s.run ?? '').includes('playwright test') || (s.run ?? '').includes('test:e2e')
    );
    expect(typeof install?.['timeout-minutes']).toBe('number');
    expect(typeof suite?.['timeout-minutes']).toBe('number');
  });

  /**
   * `always()` survives a job timeout here and `failure()` does not — measured
   * on both timed-out runs, where `Stop stack` is `success` and the
   * neighbouring `if: failure()` upload is `skipped`. A reporter guarded on
   * anything but `always()` would be silent in the one case it exists for.
   */
  test('the reporter exists, runs on always(), and precedes the teardown', () => {
    expect(REPORTER).toBeDefined();
    expect(REPORTER?.if).toBe('always()');
    const reporterAt = stepIndex((s) => s === REPORTER);
    const teardownAt = stepIndex((s) => (s.run ?? '').includes('down -v'));
    expect(teardownAt).toBeGreaterThan(-1);
    expect(reporterAt).toBeLessThan(teardownAt);
  });

  /**
   * Executed, not read. The three cases are the three things the step can be
   * asked, and the exit code is asserted in all of them: a reporting step
   * that can redden a green run is a step somebody deletes.
   */
  describe('the reporter, run as the runner runs it', () => {
    const budget = String(JOB?.['timeout-minutes'] ?? 0);
    const now = () => Math.floor(Date.now() / 1000);

    test('a normal run says it did NOT hit the clock, and says so out loud', () => {
      const r = runReporter({
        E2E_STARTED_AT: String(now() - 8 * 60),
        E2E_BUDGET_MINUTES: budget,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('did NOT hit the clock');
      expect(r.stdout).not.toContain('::error::');
      expect(r.summary).toContain('supersede');
    });

    test('a run at its budget says the clock killed it, and annotates', () => {
      const r = runReporter({
        E2E_STARTED_AT: String(now() - Number(budget) * 60),
        E2E_BUDGET_MINUTES: budget,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('::error::');
      expect(r.stdout).toContain('HIT ITS CLOCK');
      expect(r.stdout).toContain('killed by timeout-minutes');
      expect(r.summary).toContain('HIT THE BUDGET');
    });

    /**
     * The absence of a reading, reported as one. A reporter that defaulted a
     * missing marker to zero would print a confident `0m00s` over a run it
     * could not measure — the shape this ticket exists to remove.
     */
    test('a missing start marker is UNVERIFIED, not a duration of zero', () => {
      const r = runReporter({ E2E_BUDGET_MINUTES: budget });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('UNVERIFIED');
      expect(r.stdout).not.toContain('0m00s');
    });
  });
});
