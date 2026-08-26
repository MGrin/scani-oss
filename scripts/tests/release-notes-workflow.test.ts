import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * SC-640. `release-notes.yml` ran on `pull_request` and had never executed
 * once: release-please pushes the release branch with the default
 * GITHUB_TOKEN, and every run on such a branch landed in
 * `conclusion: action_required` — created, never approved, never started.
 * `action_required` reports as `status: completed`, so a run list showed three
 * finished runs and hid it entirely.
 *
 * It now chains off Release Please's own completed run. These pin the parts of
 * that wiring that fail SILENTLY — a chain that stops firing looks exactly
 * like a chain that fires and finds nothing, which is the bug one level up.
 */

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const read = (p: string) => Bun.file(join(REPO_ROOT, p)).text();

describe('the chain fires at all', () => {
  /**
   * The highest-value assertion here: `workflow_run` names the upstream
   * workflow by its `name:`, in a different file. Rename that and the chain
   * stops firing — no error, no failing job, nothing to notice.
   */
  test('the workflow it chains off is named exactly that in release-please.yml', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    const named = /workflows:\s*\["([^"]+)"\]/.exec(chained);
    expect(named).not.toBeNull();

    // `release-please.yml` is upstream-only, so in this tree the coupling
    // cannot be checked. Assert the REASON rather than returning quietly: a
    // skip that states no ground reads exactly like a pass. Upstream CI, where
    // both files exist, is where this assertion actually bites.
    const upstreamWorkflow = Bun.file(join(REPO_ROOT, '.github/workflows/release-please.yml'));
    if (!(await upstreamWorkflow.exists())) {
      expect(await Bun.file(join(REPO_ROOT, 'release-please-config.json')).exists()).toBe(false);
      return;
    }

    const upstreamName = /^name:\s*(.+)$/m.exec(await upstreamWorkflow.text());
    expect(upstreamName).not.toBeNull();
    expect(named?.[1]).toBe(upstreamName?.[1]?.trim());
  });

  // Must-be-ABSENT: the trigger this replaced. Left in place it would keep
  // producing `action_required` runs on the release PR, which read as
  // completed and make the check look present when it is not.
  test('it no longer triggers on pull_request', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).not.toContain('pull_request:');
    expect(chained).toContain('workflow_run:');
  });

  /**
   * SC-638's whole shape is a release-please run that SUCCEEDS and regenerates
   * nothing. Gating this on that run's conclusion would skip the exact case it
   * exists for — and would look perfectly reasonable in review.
   */
  test('it does not gate on Release Please having succeeded', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('types: [completed]');
    expect(chained).not.toMatch(/workflow_run\.conclusion\s*==\s*'success'/);
  });
});

describe('the verdict reaches the release pull request', () => {
  /**
   * A `workflow_run` job is not a check on the pull request, so without an
   * explicit commit status the result lives where nobody looks. That is the
   * defect this file closes, reproduced by the fix.
   */
  test('it posts a commit status, and does so even when the check fails', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('createCommitStatus');
    expect(chained).toContain('statuses: write');
    const statusStep = chained.slice(chained.indexOf('Report the verdict'));
    expect(chained.slice(0, chained.indexOf('Report the verdict'))).toContain('always()');
    expect(statusStep).toContain('createCommitStatus');
  });

  // `| tee` returns tee's status, so reading `$?` after the pipe reports 0 over
  // a failed check — the SC-487 mistake, which would post `success` onto a
  // release that is short of entries.
  test('the exit code is read from PIPESTATUS, not from the pipe', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('${PIPESTATUS[0]}');
    expect(chained).not.toMatch(/rc=\$\?\s*$/m);
  });

  // Exit 3 is BLIND — no comparison made. Reporting it as a plain failure
  // would send someone to look for a missing entry that was never established.
  test('blindness is reported as blindness, not as a shortfall', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain("rc === '3'");
    expect(chained).toContain('BLIND');
  });
});

describe('an unmeasured run does not wear a measured verdict', () => {
  /**
   * The check step is skipped when a step above it fails, and its `rc` output
   * is then the empty string. Reporting that as `A releasable commit has no
   * entry in the release notes` is this workflow's own defect reproduced
   * inside it — a verdict about a comparison that never happened, sending the
   * reader to hunt a missing changelog entry that does not exist. Measured on
   * the first control run: checkout died and the status said exactly that.
   *
   * It stays RED either way. What is pinned here is that it says which.
   */
  test('an empty rc is reported as BLIND, not as a shortfall', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toMatch(/rc === ''\s*\n?\s*\?\s*'BLIND[^']*'/);
  });

  test('exit 3 is reported as BLIND, not as a pass', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toMatch(/rc === '3'/);
    expect(chained).toContain('BLIND');
    // Must-be-ABSENT: blind mapping to a green state is the failure this whole
    // file is about, one level up.
    expect(chained).not.toMatch(/rc === '3'[\s\S]{0,80}?'success'/);
  });
});

describe('the control that keeps it demonstrable', () => {
  /**
   * A guard nobody has seen refuse is one nobody has seen work. The dispatch
   * input points it at a known-short release commit — `6e86a6b81`, the one
   * from SC-638 — so the red is reproducible on demand rather than only at the
   * next incident.
   */
  test('a head can be dispatched so the check can be made to fail on purpose', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('workflow_dispatch:');
    expect(chained).toContain('inputs:');
    expect(chained).toMatch(/head:\s*\n\s*description:/);
  });

  /**
   * BOTH OF THESE WERE FOUND BY RUNNING THE CONTROL, not by review, and the
   * first control run failed on them.
   *
   * `actions/checkout` and the statuses API both refuse an abbreviated sha:
   * checkout dies, and `createCommitStatus` answers 422 `Sha must be a valid
   * hex object ID`. `6e86a6b81` — the obvious thing to paste, and what the
   * comment in the workflow suggests — is nine characters.
   */
  test('a dispatched head is resolved to a full sha rather than used as typed', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('github.rest.repos.getCommit(');
    // Must-be-ABSENT: the raw input reaching setOutput('sha') is the bug.
    expect(chained).not.toMatch(/setOutput\('sha',\s*dispatched\)/);
  });

  // The denominator: "no open release pull request" must not read like a pass
  // that examined something.
  test('it logs how many pull requests it looked at', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('open pull requests:');
    expect(chained).toContain('release pull requests:');
  });
});
