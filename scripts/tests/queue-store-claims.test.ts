import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sweepFixtureCorpses } from '../lib/test-fixture-corpses';
import { replayStrandedMutations, withMutatedSources } from '../lib/test-source-mutations';

/**
 * SC-546. `docs:check`'s other ten checks all ask about COVERAGE — does each
 * router, job, provider and env var appear somewhere. None of them can see a
 * sentence that names the right thing and says something false about it. When
 * SC-518 moved BullMQ onto its Postgres backend, twenty sentences went false at
 * once and `docs:check` passed 10/10 over every one of them.
 *
 * `checkQueueBackendClaims` is the narrow pair-keyed check that closes it. What
 * is tested here is not the phrasing of any one finding — it is the three
 * properties that make it worth having in a gate.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

// A README, because `checkMarkdownPlacement` allows one in any directory — so a
// fixture cannot make the run red for a second, unrelated reason and muddy what
// these assertions are reading.
const FIXTURE_DIR = path.join(REPO_ROOT, `scripts/.sc546-fixture-${process.pid}`);
const FIXTURE = path.join(FIXTURE_DIR, 'README.md');
const FIXTURE_REL = path.relative(REPO_ROOT, FIXTURE);

const CLIENTS = [
  path.join(REPO_ROOT, 'packages/infra/queue/src/producer/queue-client.ts'),
  path.join(REPO_ROOT, 'packages/infra/queue/src/consumer/worker-client.ts'),
];

function git(...args: string[]): void {
  Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT });
}

function runCheck(): { exitCode: number; output: string } {
  const run = Bun.spawnSync(['bun', 'scripts/check-docs.ts'], { cwd: REPO_ROOT });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

/**
 * The check only reads files git TRACKS (SC-430), so a plain untracked fixture
 * is invisible to it. `git add -N` records intent-to-add: the path appears in
 * `git ls-files` while its content stays entirely in the working tree, so this
 * touches no committed blob and `git rm --cached` undoes it completely.
 */
function writeTrackedFixture(body: string): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE, body);
  git('add', '-N', FIXTURE_REL);
}

function removeFixture(): void {
  git('rm', '--cached', '--quiet', '--force', FIXTURE_REL);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

/**
 * SC-596. `afterEach` below does not run when the process is killed, and the
 * pid in the fixture name means no later run ever removes a predecessor's
 * corpse — it stays in the INDEX, waiting for a `git add -A` to sweep it
 * into a commit. So the repair is a sweep of the PATTERN at
 * module scope, before anything here is written: this run repairs its
 * predecessors even if it is itself killed, which a `process.on('exit')`
 * handler cannot do because `SIGKILL` skips it.
 */
const swept = sweepFixtureCorpses(REPO_ROOT);
if (swept.length > 0) console.log(`swept ${swept.length} stale fixture(s): ${swept.join(', ')}`);

/**
 * SC-601. The last test here rewrites the two queue clients — TRACKED SOURCE —
 * and restores them in a `finally` that `SIGKILL` skips just as thoroughly. The
 * corpse is a legitimate filename with wrong contents, which no glob can find,
 * so the sweep above structurally cannot cover it and this one replays a
 * journal instead. Same reason it sits at module scope: a killed run repairs
 * its predecessor.
 */
const restored = replayStrandedMutations(REPO_ROOT);
if (restored.length > 0) console.log(`restored ${restored.length} file(s): ${restored.join(', ')}`);

afterEach(removeFixture);

describe('docs:check catches prose that puts the job queue on the wrong store', () => {
  test('a clean tree is green — the baseline every other assertion needs', () => {
    const { exitCode, output } = runCheck();
    expect(output).toMatch(/all \d+ checks passed/);
    expect(exitCode).toBe(0);
  });

  test('a line naming the queue and Redis together is reported', () => {
    writeTrackedFixture('# fixture\n\nAsync work goes through BullMQ on Redis.\n');

    // Negative control. Without it this test would also pass if `git add -N`
    // had silently failed, because the check would never have seen the file —
    // and a check that never looked and a check that found nothing print the
    // same thing.
    const tracked = Bun.spawnSync(['git', 'ls-files', FIXTURE_REL], { cwd: REPO_ROOT })
      .stdout.toString()
      .trim();
    expect(tracked).toBe(FIXTURE_REL);

    const { exitCode, output } = runCheck();
    expect(output).toContain('queue-store-claims');
    expect(output).toContain(FIXTURE_REL);
    expect(exitCode).toBe(1);
  });

  test('the same line is accepted once it carries the opt-out marker', () => {
    writeTrackedFixture(
      '# fixture\n\nBullMQ runs on Postgres; Redis carries the rate limiters. <!-- queue-store-ok -->\n'
    );

    const { exitCode, output } = runCheck();
    expect(output).not.toContain(FIXTURE_REL);
    expect(exitCode).toBe(0);
  });

  /**
   * THE ONE A FUTURE READER WILL WANT TO DELETE, so the reason is here rather
   * than only in the assertion.
   *
   * When the check cannot find `create<X>Backend` in the queue clients' bullmq
   * imports it has verified NOTHING — it does not know which store the prose
   * ought to name. The tempting softening is "no factory imported means
   * BullMQ's default, which is Redis, so assume Redis and carry on." That
   * reading is usually right, and it is most persuasive exactly when it is
   * wrong: a restructured, renamed or relocated queue client produces the
   * identical signature, and the check would then compare every doc against a
   * guess while printing a pass.
   *
   * A blindness state gets its own exit code and never a plausibility
   * downgrade. Argue with this comment before changing the assertion; the fix
   * when it fires is two lines in check-docs.ts, pointing the pattern at
   * wherever the factory moved to.
   */
  test('an undetectable backend FAILS — it is never read as "the docs are fine"', () => {
    const originals = CLIENTS.map((f) => readFileSync(f, 'utf8'));
    const renamed = Object.fromEntries(
      CLIENTS.map((f, i) => [f, originals[i]!.replaceAll('createPostgresBackend', 'makeBackend')])
    );

    // Control: the rename matched in both files. Without it, a moved factory
    // would leave them untouched and this test would assert against a green
    // run it never caused.
    for (const [i, f] of CLIENTS.entries()) expect(renamed[f]).not.toBe(originals[i]!);

    // SC-601. `withMutatedSources` journals the original bytes before writing,
    // so a `kill -9` between here and the restore is repaired by the replay at
    // the top of this file rather than committed by the next `git add -A`.
    const { exitCode, output } = withMutatedSources(REPO_ROOT, renamed, runCheck);

    expect(output).toContain('queue-store-claims');
    expect(output).toContain('verified NOTHING');
    expect(exitCode).toBe(1);

    // Restoration is asserted, not assumed: a test that leaves a tracked source
    // file mutated turns every later file in this single-process run into a
    // failure with no connection to what it names.
    for (const [i, f] of CLIENTS.entries()) expect(readFileSync(f, 'utf8')).toBe(originals[i]!);
    expect(existsSync(CLIENTS[0]!)).toBe(true);
  });
});
