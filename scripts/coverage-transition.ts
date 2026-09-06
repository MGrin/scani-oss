#!/usr/bin/env bun
// SC-949. Decides whether Coverage has just gone RED HAVING BEEN GREEN.
//
// The workflow fetches this workflow's own run list and hands it here; the
// decision lives in a script so it is executable without a runner, and so
// `scripts/tests/coverage-alerts-on-transition.test.ts` can take both arms from
// real recorded runs rather than from invented payloads.
//
// FOUR OUTCOMES, and the fourth is not a quieter verdict:
//
//   transition        the newest prior verdict was `success`  -> alert
//   still-red         the newest prior verdict was not        -> silent
//   no-prior-verdict  nothing before this run ever concluded  -> silent
//   (exit 9) BLIND    the reading is not a reading            -> no alert, red
//
// `no-prior-verdict` is SILENT on purpose: a transition detector with no prior
// state that alerts anyway has invented the green half of the transition. It is
// distinguishable from BLIND only because of the self-check below.
//
// THE SELF-CHECK IS WHAT MAKES THE SILENCE TRUSTWORTHY. This runs inside a run,
// so that run must appear in the list it was handed. An empty or wrong list
// would otherwise resolve to `no-prior-verdict` and be silent forever — a
// broken alarm that looks exactly like a healthy quiet one, which is the
// not-a-result-wearing-a-result's-costume shape this repository keeps meeting.

import { appendFileSync, readFileSync } from 'node:fs';

// A run that produced a verdict about the code. `cancelled` (this workflow sets
// `cancel-in-progress: true`, so it is routine), `skipped`, `neutral`, `stale`,
// `action_required` and `startup_failure` did not, and reading one as the prior
// state would suppress a real transition.
const DEFINITIVE = new Set(['success', 'failure', 'timed_out']);

type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url?: string;
};

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    console.error(`coverage-transition: --${name} is required`);
    process.exit(2);
  }
  return process.argv[i + 1] as string;
}

function emit(fields: Record<string, string>): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  for (const [k, v] of Object.entries(fields)) appendFileSync(out, `${k}=${v}\n`);
}

const runsPath = arg('runs');
const currentRunId = Number(arg('run-id'));

let runs: Run[];
try {
  const parsed = JSON.parse(readFileSync(runsPath, 'utf8')) as { workflow_runs?: Run[] };
  if (!Array.isArray(parsed.workflow_runs)) throw new Error('no workflow_runs array');
  runs = parsed.workflow_runs;
} catch (err) {
  console.error(`coverage-transition: BLIND — could not read the run list: ${err}`);
  emit({ verdict: 'blind' });
  process.exit(9);
}

if (!runs.some((r) => r.id === currentRunId)) {
  console.error(
    `coverage-transition: BLIND — run ${currentRunId} is not in the ${runs.length} run(s) it was ` +
      `handed. This job runs inside that run, so its absence means the query is wrong, not that ` +
      `there is no history. NO ALERT SENT and no state inferred.`
  );
  emit({ verdict: 'blind' });
  process.exit(9);
}

const prior = runs
  .filter((r) => r.id !== currentRunId && DEFINITIVE.has(r.conclusion ?? ''))
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];

const skipped = runs.filter(
  (r) => r.id !== currentRunId && !DEFINITIVE.has(r.conclusion ?? '')
).length;

if (!prior) {
  console.log(
    `coverage-transition: no-prior-verdict — ${runs.length} run(s) visible and none before this ` +
      `one ever concluded. "No history" is NOT "was green", so nothing is alerted.`
  );
  emit({ verdict: 'no-prior-verdict', skipped: String(skipped) });
  process.exit(0);
}

if (prior.conclusion !== 'success') {
  console.log(
    `coverage-transition: still-red — the newest prior verdict (run ${prior.id}, ` +
      `${prior.created_at}) was \`${prior.conclusion}\`. Red that was already red carries nothing ` +
      `new; alerting on it is the state alarm that gets switched off inside a week.`
  );
  emit({ verdict: 'still-red', prior_run_id: String(prior.id), skipped: String(skipped) });
  process.exit(0);
}

console.log(
  `coverage-transition: TRANSITION — the newest prior verdict (run ${prior.id}, ` +
    `${prior.created_at}) was \`success\` and this run is red.` +
    (skipped > 0 ? ` ${skipped} non-verdict run(s) walked past.` : '')
);
emit({
  verdict: 'transition',
  prior_run_id: String(prior.id),
  prior_run_url: prior.html_url ?? '',
  prior_run_at: prior.created_at,
  skipped: String(skipped),
});
