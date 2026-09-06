import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * SC-949. COVERAGE'S VERDICT REACHED NOTHING.
 *
 * `.github/workflows/coverage.yml` triggers on `push: [main]` and
 * `workflow_dispatch` only, so its verdict lands on an already-merged commit
 * and gates nobody. It was red for 200 consecutive runs — back to
 * 2026-08-26T19:59:45Z, zero successes — and nobody noticed. Not a quiet
 * signal: a loud one that had been loud long enough to read as furniture.
 *
 * mgrin decided 2026-09-06 between the ticket's three options: **alert on
 * TRANSITION, not on state.** Option 1 (leave it advisory) is what produced the
 * outage; option 2 (a `pull_request` trigger + a required check) costs a second
 * full suite run per PR and needs a branch-protection setting this plan does
 * not offer. So the event is *red having been green*, and everything here
 * exists to keep the alarm from degrading into the state alarm SC-726 says gets
 * switched off inside a week.
 *
 * THE ARM THAT MATTERS IS `still-red`, not `transition`. Firing on a red run is
 * easy; the whole difficulty is NOT firing on the 199 that follow it. That arm
 * is built from real consecutive runs of this workflow on `MGrin/scani`, read
 * 2026-09-06 — every one `failure`, which is the population a state alarm would
 * have paged on 200 times.
 *
 * The `transition` arm is real too, from `MGrin/scani-oss`, where this workflow
 * genuinely executes (steps=13) and is green.
 *
 * THE DETECTOR IS THE REAL SCRIPT, executed. A test that restates its logic in
 * TypeScript passes over a script edited underneath it.
 */

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const DETECTOR = join(REPO_ROOT, 'scripts', 'coverage-transition.ts');

const WORKFLOW_PATH = new URL('../../.github/workflows/coverage.yml', import.meta.url);
const WORKFLOW_SRC = readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = Bun.YAML.parse(WORKFLOW_SRC) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
      if?: string;
      needs?: unknown;
      permissions?: Record<string, string>;
      steps?: {
        name?: string;
        id?: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
      }[];
    }
  >;
};

const ALARM_ID = 'coverage-went-red';
const ALARM = WORKFLOW.jobs?.[ALARM_ID];

const ISSUE_STEP_SHELL = (() => {
  const step = (ALARM?.steps ?? []).find((s) => s.name?.startsWith('Open an issue'));
  if (!step?.run) throw new Error('the alarm job has no issue-creating step to execute');
  return step.run;
})();

type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url?: string;
  head_sha?: string;
};

function run(id: number, conclusion: string | null, created_at: string, status = 'completed'): Run {
  return {
    id,
    status,
    conclusion,
    created_at,
    html_url: `https://github.com/MGrin/scani/actions/runs/${id}`,
    head_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  };
}

/** Executes the real detector against a payload shaped exactly like the runs API's. */
function detect(runs: Run[], currentRunId: number) {
  const dir = mkdtempSync(join(tmpdir(), 'sc949-'));
  const runsPath = join(dir, 'runs.json');
  const outPath = join(dir, 'github_output');
  writeFileSync(runsPath, JSON.stringify({ workflow_runs: runs }));
  writeFileSync(outPath, '');
  const proc = Bun.spawnSync(
    ['bun', DETECTOR, '--runs', runsPath, '--run-id', String(currentRunId)],
    { env: { ...process.env, GITHUB_OUTPUT: outPath }, cwd: REPO_ROOT }
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    output: readFileSync(outPath, 'utf8'),
  };
}

describe('the detector reads a transition, never a state', () => {
  // MGrin/scani-oss, read 2026-09-06: this workflow executes there for real
  // (steps=13) and every recent run is `success`. A red run behind one of those
  // is the event that carries information.
  test('fires when the newest prior verdict was green', () => {
    const r = detect(
      [
        run(34023037430, null, '2026-09-06T09:30:00Z', 'in_progress'),
        run(34019036060, 'success', '2026-09-06T07:23:56Z'),
        run(34016412566, 'success', '2026-09-06T06:24:44Z'),
      ],
      34023037430
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('verdict=transition');
  });

  // MGrin/scani, read 2026-09-06 — six real consecutive runs, every one
  // `failure`. THIS is the arm the ticket is about: a state alarm fires on all
  // of them and is switched off inside a week.
  test('stays silent when the newest prior verdict was already red', () => {
    const r = detect(
      [
        run(34023039896, null, '2026-09-06T08:51:50Z', 'in_progress'),
        run(34019920557, 'failure', '2026-09-06T07:43:40Z'),
        run(34019918649, 'failure', '2026-09-06T07:43:37Z'),
        run(34019011367, 'failure', '2026-09-06T07:23:21Z'),
        run(34016415519, 'failure', '2026-09-06T06:24:48Z'),
        run(34015444346, 'failure', '2026-09-06T06:01:55Z'),
      ],
      34023039896
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('verdict=still-red');
    expect(r.output).not.toContain('verdict=transition');
  });

  // `cancel-in-progress: true` is set on this workflow, so a `cancelled` run
  // sits between a green and a red whenever two pushes land close together.
  // Reading it as the prior verdict would suppress a real transition — the
  // alarm would go quiet for exactly the busy periods it is most needed in.
  test('walks past a cancelled run rather than reading it as a verdict', () => {
    const r = detect(
      [
        run(500, null, '2026-09-06T09:00:00Z', 'in_progress'),
        run(400, 'cancelled', '2026-09-06T08:00:00Z'),
        run(300, 'success', '2026-09-06T07:00:00Z'),
      ],
      500
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('verdict=transition');
  });

  // NO HISTORY IS NOT "WAS GREEN". A transition detector with no prior state
  // that fires anyway has invented the green half of the transition.
  test('does not treat an absent history as a prior green', () => {
    const r = detect([run(500, null, '2026-09-06T09:00:00Z', 'in_progress')], 500);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('verdict=no-prior-verdict');
    expect(r.output).not.toContain('verdict=transition');
  });

  // THE SELF-CHECK, and it is what separates "no history" from "the query is
  // wrong". This job runs INSIDE a run, so that run must appear in the list it
  // just fetched. If it does not, the reading is not a reading — and a broken
  // query that resolved to `no-prior-verdict` would be silent forever while a
  // broken query that resolved to `transition` would page on every red push.
  test('refuses rather than answering when it cannot see its own run', () => {
    const r = detect(
      [run(400, 'success', '2026-09-06T08:00:00Z'), run(300, 'success', '2026-09-06T07:00:00Z')],
      999
    );
    expect(r.exitCode).toBe(9);
    expect(r.output).not.toContain('verdict=transition');
    expect(`${r.stdout}${r.stderr}`).toContain('BLIND');
  });
});

describe('the alarm job cannot degrade into a state alarm', () => {
  test('is gated on the coverage job failing, on main, and on nothing else', () => {
    expect(ALARM).toBeDefined();
    const condition = (ALARM?.if ?? '').trim();
    expect(condition).toContain('always()');
    expect(condition).toContain("needs.coverage.result == 'failure'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    // The SC-726 restraint, in the form it can be asserted: the gate may not
    // consult a step output, and `coverage` is the only job result it reads.
    expect(condition).not.toContain('steps.');
    const needsRefs = [...condition.matchAll(/needs\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]);
    expect([...new Set(needsRefs)]).toEqual(['coverage']);
  });

  test('reaches a human by opening an issue, not by being another red job', () => {
    const steps = ALARM?.steps ?? [];
    const shell = steps.map((s) => s.run ?? '').join('\n');
    expect(shell).toContain('gh issue create');
    // Assignment notifies the assignee whether or not they watch the repo; the
    // scheduled-workflow failure email does not (it goes to whoever last edited
    // the cron line, and moves silently when that line is edited).
    expect(shell).toContain('--assignee');
  });

  test('takes issue-write at the job, leaving the workflow default read-only', () => {
    expect(WORKFLOW.permissions?.contents).toBe('read');
    expect(WORKFLOW.permissions?.issues).toBeUndefined();
    expect(ALARM?.permissions?.issues).toBe('write');
    expect(ALARM?.permissions?.actions).toBe('read');
  });

  // The ticket's own falsifier, kept executable: a `pull_request:` trigger
  // appearing here means option 2 was taken instead and everything above is
  // stale. mgrin declined it — it costs a second full suite run per PR.
  test('did not grow the pull_request trigger option 2 would have needed', () => {
    expect(Object.keys(WORKFLOW.on ?? {}).sort()).toEqual(['push', 'workflow_dispatch']);
  });
});

/**
 * THE ISSUE STEP IS EXECUTED, NOT READ. Its shell is extracted verbatim from
 * the workflow and run against a stubbed `gh`, because a heredoc body is
 * exactly the shape that looks right in a diff and produces nothing at
 * runtime — and this step only ever runs in the situation where nobody is
 * watching it.
 */
function runIssueStep(ghStub: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sc949-issue-'));
  const step = ISSUE_STEP_SHELL;
  writeFileSync(join(dir, 'step.sh'), step);
  writeFileSync(join(dir, 'gh'), ghStub);
  Bun.spawnSync(['chmod', '+x', join(dir, 'gh')]);
  const proc = Bun.spawnSync(['bash', 'step.sh'], {
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    body: (() => {
      try {
        return readFileSync(join(dir, 'body.md'), 'utf8');
      } catch {
        return '';
      }
    })(),
  };
}

const ISSUE_ENV = {
  GH_TOKEN: 'stub',
  REPO: 'MGrin/scani',
  OWNER: 'MGrin',
  RUN_URL: 'https://github.com/MGrin/scani/actions/runs/34023039896',
  SHA: 'ec03e0601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  PRIOR_URL: 'https://github.com/MGrin/scani-oss/actions/runs/34023037430',
  PRIOR_AT: '2026-09-06T08:51:47Z',
};

const GH_NO_EXISTING = `#!/bin/sh
case "$*" in
  *"issue list"*) echo 0 ;;
  *"issue create"*) echo "CREATED $*" ;;
esac
`;

const GH_ALREADY_ALERTED = `#!/bin/sh
case "$*" in
  *"issue list"*) echo 1 ;;
  *"issue create"*) echo "CREATED $*" ;;
esac
`;

describe('the issue step actually produces an issue', () => {
  test('creates one, assigned, with a body that survived the heredoc', () => {
    const r = runIssueStep(GH_NO_EXISTING, ISSUE_ENV);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('CREATED');
    expect(r.stdout).toContain('--assignee MGrin');
    // Rendered, not templated: the heredoc must have expanded and must not
    // have shipped its own YAML indentation into the markdown.
    expect(r.body).toContain('@MGrin');
    expect(r.body).toContain(ISSUE_ENV.RUN_URL);
    expect(r.body).toContain(ISSUE_ENV.PRIOR_URL);
    expect(r.body).not.toContain('${');
    for (const line of r.body.split('\n')) expect(line.startsWith(' ')).toBe(false);
  });

  test('opens nothing when this exact transition was already alerted', () => {
    const r = runIssueStep(GH_ALREADY_ALERTED, ISSUE_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('CREATED');
    expect(r.stdout).toContain('Already alerted');
  });
});
