import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

/**
 * SC-838. THE PRIVATE/PUBLIC BOUNDARY HAD NO GATE — only `.githooks/pre-push`,
 * which `--no-verify` skips, which a fresh clone does not have until
 * `bun install` sets `core.hooksPath`, and which was measured configured in one
 * checkout and nowhere else. On 2026-09-01 a real leak reached
 * `MGrin/scani-oss` past it.
 *
 * The gate is the `oss-boundary` job in `.github/workflows/ci.yml`. What this
 * file guards is the handful of its properties that, if one quietly stopped
 * holding, would leave a job that still runs, still reports green, and no
 * longer checks anything — which is the failure the job exists to be the
 * opposite of, rebuilt inside it.
 *
 * IT IS A STRUCTURAL GUARD, NOT A SECOND IMPLEMENTATION. Whether the scanners
 * themselves still refuse is asserted by their own test files and, at run time,
 * by the job's `The guard can still go RED` step. This file asserts only that
 * the job is wired so that a refusal reaches somebody.
 */

const WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);

const WORKFLOW = Bun.YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs?: Record<
    string,
    {
      needs?: unknown;
      if?: unknown;
      steps?: { name?: string; uses?: string; run?: string; with?: unknown }[];
    }
  >;
};

const JOBS = WORKFLOW.jobs ?? {};
const GATE = JOBS['oss-boundary'];
const STEPS = GATE?.steps ?? [];
/** Every `run:` block in the job, as one string. What the runner will execute. */
const SHELL = STEPS.map((s) => s.run ?? '').join('\n');

/** One named step's `run:`, or `''` — never another step's, which is the trap. */
function stepRun(name: string): string {
  return STEPS.find((s) => s.name === name)?.run ?? '';
}

const PRE_PUSH = readFileSync(new URL('../../.githooks/pre-push', import.meta.url), 'utf8');

/**
 * Whether the pre-push hook actually RUNS a scanner, as opposed to mentioning
 * it (SC-1101).
 *
 * A comment line is excluded, because that is the exact difference the arms
 * below turn on: `check-oss-prose` is named in that hook's prose and invoked
 * nowhere, so a substring test reports it as wired. Keyed on `bun <script>`,
 * which is how every invocation in that file is spelled — a `printf … | bun
 * scripts/x.ts` still matches, and a bare mention of the filename does not.
 */
function invokedByPrePush(script: string): boolean {
  return PRE_PUSH.split('\n').some(
    (line) => !line.trimStart().startsWith('#') && line.includes(`bun scripts/${script}.ts`)
  );
}

/**
 * Whether this checkout is the private repository. The same discriminator the
 * scanners use (`scanScope`), read the same way, so this file and the guards it
 * describes cannot disagree about which repo they are in.
 */
const IS_PRIVATE = existsSync(new URL('../../.private-repo', import.meta.url));

describe('SC-838 · the OSS boundary gate is wired to be able to refuse', () => {
  /**
   * THE CONTROL, and it is load-bearing rather than ceremony. Every assertion
   * below reads something out of `GATE`. A parse that yielded no jobs, or a
   * renamed job id, makes most of them vacuous — `[].join('')` contains
   * nothing, and `expect('').not.toContain(x)` passes. If this one goes red,
   * nothing else in the file means anything.
   */
  test('the workflow parses and the gate job is present', () => {
    expect(Object.keys(JOBS).length).toBeGreaterThan(0);
    expect(Object.keys(JOBS)).toContain('oss-boundary');
    expect(STEPS.length).toBeGreaterThanOrEqual(4);
    expect(SHELL.length).toBeGreaterThan(0);
  });

  /**
   * The leak that caused this ticket travelled in a SQL migration and in prose.
   * A path filter deciding this job is irrelevant to a change is a path filter
   * deciding a leak is irrelevant, and it would report the one word this
   * repository's CI already uses for two opposite things (SC-726).
   */
  test('the gate is never path-filtered — no `needs`, no `if`', () => {
    expect(GATE?.needs).toBeUndefined();
    expect(GATE?.if).toBeUndefined();
  });

  /**
   * `git rev-parse` cannot reach a pull request's base at `actions/checkout`'s
   * default depth of 1. Lose this and the range arm refuses every run — loud,
   * so not a false green, but a gate nobody can get past is a gate somebody
   * removes.
   */
  test('the checkout is deep enough to resolve the base commit', () => {
    // Bound to the checkout step BY NAME. `find` on "the first step with a
    // `with:`" reads `setup-bun` the moment `fetch-depth` is the only key
    // removed, and `undefined` there is indistinguishable from a step that was
    // never the subject — the assertion passes for the wrong reason.
    const checkout = STEPS.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkout).toBeDefined();
    expect((checkout?.with as { 'fetch-depth'?: unknown })?.['fetch-depth']).toBe(0);
  });

  /**
   * The four content scanners are the gate. `check-oss-bound-paths.ts` is
   * deliberately NOT among them — it needs both repositories' trees and has
   * only one here, so it answers `SKIPPED · exit 0` in a mirror checkout. That
   * absence is asserted, not merely omitted: adding it back would be a green
   * over a tree nothing looked at.
   */
  test('the gate runs the four content scanners and not the two-tree one', () => {
    // EACH ASSERTION IS BOUND TO THE STEP THAT MUST CARRY IT. Against the
    // job's whole shell, `contains('check-oss-figures.ts')` is satisfied by
    // the RED-probe step alone: replacing the real scan with `true` left this
    // green, because the evidence came from a different step than the claim
    // (measured while writing this file).
    expect(stepRun('Scan what this change introduces')).toContain(
      'bun scripts/check-oss-data-shapes.ts --stdin-commits'
    );
    expect(stepRun('Scan what this change introduces')).toContain(
      'bun scripts/check-oss-figures.ts --stdin-commits'
    );
    expect(stepRun('Scan what this change introduces')).toContain(
      'bun scripts/check-oss-prose.ts --stdin-commits'
    );
    expect(stepRun('No internal reference anywhere in the tree')).toContain(
      'bun scripts/check-oss-internal-refs.ts --scan'
    );
    expect(SHELL).not.toMatch(/bun scripts\/check-oss-bound-paths\.ts/);
  });

  /**
   * A missing script makes `bun` exit non-zero, which is the right answer by
   * accident. This step makes it the right answer by construction, and says so
   * in the words the hook uses. `check-oss-bound-paths.ts` and
   * `lib/check-verdict.ts` are in the list because the three scanners import
   * them: their absence is the scan's absence.
   */
  test('a missing guard file is a refusal, not a pass', () => {
    const step = STEPS.find((s) => s.name === 'The guards are present in this tree');
    expect(step?.run).toBeDefined();
    expect(step?.run).toContain('NOTHING WAS SCANNED');
    expect(step?.run).toContain('This is not a pass');
    for (const f of [
      'check-oss-data-shapes',
      'check-oss-figures',
      'check-oss-prose',
      'check-oss-internal-refs',
      'check-oss-bound-paths',
      'lib/check-verdict',
    ]) {
      expect(step?.run).toContain(f);
    }
  });

  /**
   * ARM 3 OF THE MATRIX IN MGrin/scani#1374. Every other arm is a green
   * whenever the tree is clean, and a green from an instrument nobody has
   * watched refuse is a non-result wearing a result. This step is the only
   * thing in the repository that reads whether THE WORKFLOW STEP fails when the
   * scanner refuses — the scanners' own self-tests and their unit tests both
   * stop at the process boundary.
   */
  test('the gate proves a red is reachable before trusting its own greens', () => {
    const step = STEPS.find((s) => s.name === 'The guard can still go RED');
    expect(step?.run).toBeDefined();
    // The known-bad probe value, and the assertion that a zero exit is fatal.
    expect(step?.run).toContain('98765.43210987');
    expect(step?.run).toMatch(/if \[ "\$rc" -eq 0 \]/);
    expect(step?.run).toContain('NOTHING THIS JOB REPORTS IS EVIDENCE');
  });

  /**
   * An unresolvable base and an empty range arrive identically — as no commits
   * — and only one of them is a scan.
   */
  test('a base it cannot resolve is a refusal, not an empty scan', () => {
    const step = STEPS.find((s) => s.name === 'Scan what this change introduces');
    expect(step?.run).toContain('NOTHING WAS SCANNED');
    expect(step?.run).toContain('This is not a pass');
    // The denominator, so a run that read nothing cannot look like one that
    // read everything (SC-771).
    expect(step?.run).toContain('non-merge commit(s)');
    // THE MERGE BASE, not `base.sha`, which is the base branch's TIP and need
    // not be an ancestor of what was checked out. Pinned because the shorter
    // form reads correct.
    //
    // It is NOT what fixed the 283-commit range this job's own pull request
    // first reported — there the merge base and `base.sha` were the same
    // commit, and the cause was a branch cut from a lineage the force-push of
    // 2026-09-01 had rewritten away. Recorded here because a reader who finds
    // that number in the history will otherwise credit it to this line.
    expect(step?.run).toContain('git merge-base');
    expect(step?.run).not.toMatch(/rev-list --no-merges "\$\{PR_BASE\}\.\./);
  });

  /**
   * WHERE THE GATE ACTUALLY GATES. `MGrin/scani-oss` names one required status
   * check, `CI Success`, and that job's `needs` list is the whole of what
   * "required" means there — a job absent from it can go red without blocking a
   * merge. The private repository has no `ci-success` job and cannot have a
   * required check at all: `GET /rulesets` returns `403 Upgrade to GitHub Pro`.
   *
   * So the branch below is keyed on the workflow's own shape, and the arm that
   * skips the assertion asserts the reason it may — if `ci-success` ever
   * vanished from the mirror, this goes red there rather than quietly taking
   * the private repo's branch.
   */
  test('the gate is inside the required status check, where one exists', () => {
    const ciSuccess = JOBS['ci-success'];
    if (!ciSuccess) {
      expect(IS_PRIVATE).toBe(true);
      return;
    }
    const needs = Array.isArray(ciSuccess.needs) ? ciSuccess.needs : [ciSuccess.needs];
    expect(needs).toContain('oss-boundary');
  });

  /**
   * The hook is the seatbelt and this job is the gate; the end state is both.
   * SC-838's scope said so explicitly, and a later change that "replaced the
   * hook with CI" would remove the only check that runs before the content
   * leaves the machine.
   */
  test('the pre-push hook still runs the boundary checks', () => {
    expect(invokedByPrePush('check-oss-bound-paths')).toBe(true);
    expect(invokedByPrePush('check-oss-figures')).toBe(true);
    expect(invokedByPrePush('check-oss-data-shapes')).toBe(true);
  });

  /**
   * SC-1101. THE ONE OF THE FOUR SCANNERS WITH REFUSAL RULES WAS THE ONE THIS
   * HOOK DID NOT CALL, and the arm above could not have told anybody.
   *
   * `check-oss-internal-refs` ran in pre-commit and nowhere else. Pre-commit is
   * the one moment the destination is structurally unknowable, so on a private
   * branch `scanScope` reads `private` and skips — correctly. The skip is
   * harmless only if a later reader exists, and none did: cherry-pick and
   * rebase fire pre-commit zero times (SC-813), and this hook invoked the other
   * three. Content authored privately into a mirror-tracked file therefore
   * reached MGrin/scani-oss with the only check that refuses it never having
   * read it.
   *
   * `toContain` WAS THE WRONG INSTRUMENT AND WOULD HAVE PASSED, which is why
   * the arm above is rewritten rather than extended. `check-oss-prose` appears
   * in this hook — in a comment, explaining what it detects — and is invoked
   * exactly nowhere. A substring assertion cannot tell a mention from a call,
   * and this file's whole subject is a check that reports nothing reading
   * identically to one with nothing to report.
   */
  test('a mention is not an invocation — the assertion can tell them apart', () => {
    // The control, and it is what makes the arm above a reading. `prose` is
    // named in this hook and never run; if this flipped to `true` the matcher
    // has gone back to matching prose and the arm above means nothing.
    expect(PRE_PUSH).toContain('check-oss-prose');
    expect(invokedByPrePush('check-oss-prose')).toBe(false);
  });

  /**
   * `--ref "$local_sha"`, not HEAD. `git push upstream branchB` while standing
   * on private branchA would classify branchA, read `private`, and skip — a
   * silent pass on a mirror-bound push, which is this hook's own subject
   * reproduced inside it.
   */
  test('the internal-reference check runs at the push, on the ref being pushed', () => {
    expect(invokedByPrePush('check-oss-internal-refs')).toBe(true);
    const call = PRE_PUSH.split('\n').find(
      (l) => l.includes('bun scripts/check-oss-internal-refs.ts') && !l.trimStart().startsWith('#')
    );
    expect(call).toBeDefined();
    expect(call).toContain('--stdin-paths');
    expect(call).toContain('--ref "$local_sha"');
  });

  /**
   * A missing script must be a REFUSAL here, not a note. pre-commit notes,
   * which is right for a commit — local and amendable. This is the last point
   * before the content is public, so the answer flips, and the invariant is
   * stated once in the hook's own words: a check that could not run is not a
   * pass.
   */
  test('an absent internal-reference check fails the push rather than noting it', () => {
    const guard = PRE_PUSH.slice(
      PRE_PUSH.indexOf('check-oss-internal-refs.ts is not in this tree')
    );
    expect(guard).toContain('NO INTERNAL REFERENCE WAS CHECKED');
    expect(guard).toContain('This is not a pass.');
  });
});
