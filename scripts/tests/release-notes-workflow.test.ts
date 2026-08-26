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

  /**
   * SC-653. THE `pull_request` TRIGGER IS BACK, AND IT IS NOT THE ONE SC-640
   * REMOVED. That one was how the check tried to reach the RELEASE PR, and it
   * never did — those runs are `action_required` and never start. This one is
   * how the check reports on an ORDINARY PR, which is not approval-gated.
   *
   * It has to report there at all because a required status check no ordinary
   * PR can receive is not strict, it is impassable: adding this context to
   * `main-protection` deadlocked the repository and blocked all four open PRs
   * (SC-647).
   *
   * The dangerous shape is a `pull_request` run posting a blanket success
   * about a RELEASE PR — a pass on the one population the check exists for,
   * from a run that examined nothing. That path refuses instead, and this is
   * the must-be-ABSENT axis for it.
   */
  test('the pull_request_target path refuses a release branch instead of passing it', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toContain('pull_request_target:');
    expect(chained).toContain('workflow_run:');
    expect(chained).toMatch(/ref\.startsWith\('release-please--'\)/);
    // The refusal sets `silent`, never `reported`. If these two ever swap, an
    // unexamined release PR gets a green required check.
    const refusal =
      /startsWith\('release-please--'\)\)\s*\{[\s\S]{0,400}?setOutput\('mode',\s*'([a-z]+)'\)/.exec(
        chained
      );
    expect(refusal?.[1]).toBe('silent');
  });

  test('an ordinary pull request gets a passing status, so the context always exists', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toMatch(/mode === 'reported'/);
    expect(chained).toContain("state: 'success'");
    expect(chained).toContain('Not a release pull request');
    // Same context string as the real verdict — a required check matches on
    // this exact text, so a second wording would satisfy nothing.
    expect(
      chained.match(/context: 'Release notes cover every releasable commit'/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * SC-653. `pull_request_target` PAIRS A WRITE TOKEN WITH A CONTRIBUTOR'S
   * BRANCH, and this file uses it because `pull_request` gives a FORK PR a
   * read-only token — `createCommitStatus` would 403, the context would never
   * appear, and requiring it would block every fork contribution on a repo
   * whose CONTRIBUTING.md tells people to fork.
   *
   * It is safe here only while nothing on that path checks out or executes
   * repository code. THAT is what this pins, and it is deliberately broader
   * than the guards that exist today: the failure mode is somebody adding a
   * step months from now for an unrelated reason, who will not be thinking
   * about token scope. This test is the only thing that will be.
   *
   * `actions/github-script` is exempt on purpose — its script is the inline
   * one from the workflow file on the BASE branch, never the contributor's.
   * A `run:` block, a `uses: actions/checkout`, or a local `uses: ./…`
   * composite are not exempt: all three can reach a checked-out tree.
   */
  test('no step that checks out or runs code is reachable from pull_request_target', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    const stepsBlock = chained.slice(chained.indexOf('    steps:'));
    const steps = stepsBlock.split(/\n(?= {6}- )/).filter((c) => c.trim().startsWith('- '));

    // Denominator, and the must-be-FOUND control: a split that silently
    // stopped matching would report a clean workflow forever.
    expect(steps.length).toBeGreaterThanOrEqual(4);

    const GUARD = "github.event_name != 'pull_request_target'";
    const unguarded = steps.filter((step) => {
      const executesRepoCode =
        /^\s*(- )?uses:\s*actions\/checkout/m.test(step) ||
        /^\s*(- )?uses:\s*\.\//m.test(step) ||
        /^\s*run:\s*\|/m.test(step);
      if (!executesRepoCode) return false;
      return !step.includes(GUARD);
    });

    expect(unguarded.map((s) => s.split('\n')[0]?.trim())).toEqual([]);
  });

  test('the fork rationale is written where someone adding a step will read it', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    // The test refuses; the comment explains. Whoever trips the first needs
    // the second, and a bare assertion failure teaches nothing about tokens.
    expect(chained).toContain('pull_request_target');
    expect(chained).not.toMatch(/^\s*pull_request:/m);
    expect(chained).toMatch(/READ-ONLY|read-only/);
    expect(chained).toMatch(/DO NOT ADD A CHECKOUT/);
  });

  // A single global group made every PR queue behind every other, and runs on
  // a release branch sit unapproved for a long time.
  test('the concurrency group is per pull request, not global', async () => {
    const chained = await read('.github/workflows/release-notes.yml');
    expect(chained).toMatch(/group: release-notes-\$\{\{ github\.event\.pull_request\.number/);
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
