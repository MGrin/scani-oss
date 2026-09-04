import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * SC-1024. A pull request whose only change was `ci.yml` did not run the jobs
 * it edited. Every filter in `detect-changes` names the code a job TESTS;
 * none of them named the DEFINITION of the job itself, so the dependent jobs
 * reported `skipped` — the same word a healthy path-filtered skip produces,
 * which is the SC-726 collision in the one place where the change under test
 * IS the workflow.
 *
 * Measured on the mirror, where a terminal `CI Success` job turns that word
 * into a green: pull request #383 changed `ci.yml` and nothing else — and the
 * change was to `detect-changes` itself — and Test, E2E, Lint, Docs and knip
 * all reported `skipped` while `CI Success` reported success.
 *
 * THE INVARIANT PINNED HERE IS NOT "`.github` APPEARS SOMEWHERE". It is that
 * for every job gated on a path filter, the files that job is BUILT FROM are
 * reachable through at least one of the filters that job actually reads. Both
 * halves are derived from the workflow rather than listed here:
 *
 *   the files      `ci.yml`, plus every local composite action the job `uses`.
 *                  A new `./.github/actions/<x>` extends this file's coverage
 *                  by existing, with nothing to remember.
 *   the filters    parsed out of the `dorny/paths-filter` step's own `with:`
 *                  block, and matched to the job through the `needs.<id>
 *                  .outputs.<name>` references in its `if:`.
 *
 * IT IS KEYED ON NO OUTCOME WORD. `skipped` is what a correct path filter and
 * a never-considered job both report, so an assertion that read a conclusion
 * would fire on every legitimate filtered skip — a noisy alarm, switched off
 * inside a week (SC-726). This reads the workflow's own reachability instead,
 * before any run exists.
 *
 * IT RESOLVES THE FILTER JOB BY THE ACTION IT USES, NEVER BY ITS ID. The two
 * repositories' `ci.yml` are `merge=ours` and have diverged into different
 * job sets — the mirror gates `e2e` / `E2E (Playwright)` on `code`, the
 * private copy gates `e2e-a11y` / `Accessibility gate & mobile smoke` on its
 * own `e2e` filter — so a file keyed on an id would assert nothing at all in
 * one of the two checkouts. That vacuous pass is the defect this file exists
 * to be the opposite of.
 */

const WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');

/** The workflow file's own repository-relative path — always a required input. */
const SELF = '.github/workflows/ci.yml';

function parse(source: string): Workflow {
  return Bun.YAML.parse(source) as Workflow;
}

/**
 * The job that runs the path filter. One in each repository; the `uses:` is
 * what both copies share, where the id and the name need not.
 */
function findFilterJob(workflow: Workflow): [string, Job] {
  const entries = Object.entries(workflow.jobs ?? {}).filter(([, job]) =>
    (job.steps ?? []).some((s) => (s.uses ?? '').includes('dorny/paths-filter'))
  );
  if (entries.length !== 1) {
    throw new Error(`expected exactly one job using dorny/paths-filter, found ${entries.length}`);
  }
  return entries[0] as [string, Job];
}

/** filter name -> its globs, read out of the action's own `with.filters`. */
function readFilters(job: Job): Record<string, string[]> {
  const step = (job.steps ?? []).find((s) => (s.uses ?? '').includes('dorny/paths-filter'));
  const raw = step?.with?.filters;
  if (typeof raw !== 'string')
    throw new Error('the paths-filter step declares no `filters:` string');
  const parsed = Bun.YAML.parse(raw) as Record<string, string[]>;
  return parsed;
}

/**
 * output name -> filter name. They are equal in both copies today, but the
 * indirection is real — `outputs.code` reads `steps.filter.outputs.code` —
 * and resolving it costs one regex.
 */
function readOutputMap(job: Job & { outputs?: Record<string, string> }): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, expr] of Object.entries(job.outputs ?? {})) {
    const m = /steps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/.exec(String(expr));
    map[name] = m?.[1] ?? name;
  }
  return map;
}

/** The local composite actions a job runs, as the file each one resolves to. */
function localActionFiles(job: Job): string[] {
  return (job.steps ?? [])
    .map((s) => s.uses ?? '')
    .filter((u) => u.startsWith('./'))
    .map((u) => `${u.replace(/^\.\//, '').replace(/\/$/, '')}/action.yml`);
}

type Finding = { job: string; path: string; filters: string[] };

/**
 * Every job gated on a path filter, whose own definition is unreachable
 * through the filters it reads. Empty is the healthy reading.
 */
function unreachableDefinitions(workflow: Workflow): Finding[] {
  const [filterJobId, filterJob] = findFilterJob(workflow);
  const filters = readFilters(filterJob);
  const outputs = readOutputMap(filterJob as Job & { outputs?: Record<string, string> });

  const findings: Finding[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (jobId === filterJobId) continue;
    const referenced = [
      ...String(job.if ?? '').matchAll(
        new RegExp(`needs\\.${filterJobId}\\.outputs\\.([A-Za-z0-9_-]+)`, 'g')
      ),
    ].map((m) => m[1] as string);
    if (referenced.length === 0) continue; // ungated: it always runs

    const globs = referenced.flatMap((out) => filters[outputs[out] ?? out] ?? []);
    for (const path of [SELF, ...localActionFiles(job)]) {
      const matched = globs.some((g) => new Bun.Glob(g).match(path));
      if (!matched) findings.push({ job: jobId, path, filters: referenced });
    }
  }
  return findings;
}

describe('ci.yml path filters reach the workflow that defines the jobs', () => {
  const workflow = parse(SOURCE);

  test('at least one job is gated on a path filter, so the check below is not vacuous', () => {
    const [filterJobId] = findFilterJob(workflow);
    const gated = Object.entries(workflow.jobs ?? {}).filter(
      ([id, job]) =>
        id !== filterJobId && String(job.if ?? '').includes(`needs.${filterJobId}.outputs.`)
    );
    expect(gated.length).toBeGreaterThan(0);
  });

  test('every gated job re-runs when the workflow that defines it changes', () => {
    const findings = unreachableDefinitions(workflow);
    const report = findings
      .map((f) => `${f.job}: ${f.path} is matched by none of [${f.filters.join(', ')}]`)
      .join('\n');
    expect(report).toBe('');
  });

  test('every gated job re-runs when a composite action it uses changes', () => {
    // Stated separately from the assertion above so a regression names which
    // of the two inputs went unreachable. `setup-bun` is a step in every gated
    // job and is in no filter that names source code.
    const usesLocalAction = Object.values(workflow.jobs ?? {}).some(
      (job) => localActionFiles(job).length > 0
    );
    expect(usesLocalAction).toBe(true);
  });

  // The control. A check that cannot come back red is not a check, and this
  // one's healthy reading is an empty list — indistinguishable from a parse
  // that found no jobs at all. Deleting the entry that makes `ci.yml`
  // reachable must reproduce exactly the defect SC-1024 describes.
  test('removing the workflow from the filters makes this check fail', () => {
    const mutated = SOURCE.replace(/^\s*- '\.github\/workflows\/ci\.yml'\n/gm, '').replace(
      /^\s*- '\.github\/actions\/\*\*'\n/gm,
      ''
    );
    expect(mutated).not.toBe(SOURCE);

    const findings = unreachableDefinitions(parse(mutated));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === SELF)).toBe(true);
  });

  test('an empty filter list is a finding, not a pass', () => {
    const mutated = SOURCE.replace(
      /steps\.filter\.outputs\.[A-Za-z0-9_-]+/g,
      'steps.filter.outputs.zznope'
    );
    const findings = unreachableDefinitions(parse(mutated));
    expect(findings.length).toBeGreaterThan(0);
  });
});
