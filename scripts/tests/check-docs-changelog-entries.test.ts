import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRepoFixtureIsIgnored } from '../lib/test-fixture-corpses';

/**
 * SC-556. `queue-store-claims` blocked the 0.15.0 release. It fired on two
 * lines of `CHANGELOG.md`:
 *
 *   * **queue:** move BullMQ from Redis to the Postgres backend (SC-518)
 *   * **queue:** upgrade BullMQ 5.77.3 -> 6.2.0, still on Redis (SC-518)
 *
 * Both are TRUE and both have to name Redis — one says the queue moved off it,
 * the other says an earlier version bump had not moved it yet. Neither makes a
 * claim about the current system. The rule's remedy is "fix the sentence", and
 * these are QUOTATIONS of commit subjects: fixing them means falsifying the
 * record. A changelog accumulates lines naming superseded technology forever,
 * which is its function.
 *
 * THE HALF THAT WILL LOOK WRONG LATER is the third test. The obvious form of
 * this exemption is a path exemption — skip `CHANGELOG.md` — and it is one
 * character shorter to write. It is also silently wrong: this file carries
 * plenty of prose somebody CHOSE, starting with a header block that explains
 * the heading shape at length and states that the 0.13.0, 0.14.0 and 0.14.1
 * sections are hand-written. A sentence claiming the queue runs on the other
 * store is exactly what the rule is for and is no less wrong for sitting here.
 *
 * So if you are here because the exemption looks fussier than it needs to be:
 * widening it to the path makes test three go red, and that is the test doing
 * its job rather than being in your way.
 *
 * These assert on the CHECK'S OWN MESSAGE rather than the exit code, on
 * purpose. `md-placement` disagrees about `CHANGELOG.md` between the two repos
 * by design — upstream's `ROOT_ALLOWED` includes it because release-please
 * writes it there, and this repo has no `CHANGELOG.md` at all (SC-520). Keying
 * on the exit code would make this file pass in one repo and fail in the other
 * for a reason that has nothing to do with what it is testing.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
// OUTSIDE the repository (SC-609). `GIT_INDEX_FILE` takes any path, so this
// never needed to be in the tree — and while it was, a killed run left an
// ordinary untracked file at the root for `git add -A` to commit.
const SCRATCH_INDEX = path.join(tmpdir(), `scani-sc556-index-${process.pid}`);

/**
 * NOT the root `CHANGELOG.md`. Upstream has a real one and this tree has none,
 * so a fixture at the root can only be built in the repo where the rule matters
 * least — and building it upstream would overwrite the very file under test and
 * then delete it in `afterEach`. The guard in `fixture()` is what surfaced
 * that, as a red CI run rather than as a clobbered changelog.
 *
 * The exemption is keyed on the basename, so a changelog in a scratch directory
 * exercises exactly the same branch.
 */
// The DIRECTORY carries the reserved prefix, not the file: the exemption under
// test is keyed on the basename `CHANGELOG.md`, so that name has to survive.
// One `.gitignore` rule on the directory covers everything inside it (SC-609).
const FIXTURE_DIR = `docs/scani-test-fixture-sc556-changelog-${process.pid}`;
const CHANGELOG_FIXTURE = `${FIXTURE_DIR}/CHANGELOG.md`;
const FIXTURES: string[] = [];

const ENTRY_LINK =
  '([1c117c4](https://github.com/MGrin/scani-oss/commit/1c117c4ac8e9aafc8828bcea))';

/**
 * Refuses to write over a path that already exists, and that guard is here
 * because it was needed: an earlier draft used `CONTRIBUTING.md` as the
 * "somewhere other than the changelog" fixture, overwrote the real file, and
 * `afterEach` then DELETED it. The test failed for that reason and not for the
 * one it was asserting, which is the tell. A fixture that clobbers a tracked
 * file is a test that damages the checkout it is run in.
 */
function fixture(rel: string, body: string): string {
  assertRepoFixtureIsIgnored(REPO_ROOT, rel);
  const abs = path.join(REPO_ROOT, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (existsSync(abs)) {
    throw new Error(
      `fixture path ${rel} already exists — pick one that cannot clobber a real file`
    );
  }
  writeFileSync(abs, `${body}\n`);
  FIXTURES.push(abs);
  return rel;
}

/** Does `queue-store-claims` fire with `staged` present in a throwaway index? */
function queueCheckFires(staged: string[]): boolean {
  const env = { ...process.env, GIT_INDEX_FILE: SCRATCH_INDEX };
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT, env });
  rmSync(SCRATCH_INDEX, { force: true });
  git(['read-tree', 'HEAD']);
  // `-f` because every fixture is deliberately gitignored (SC-609), and `git
  // add` refuses an ignored path without it. Checked rather than discarded: an
  // unstaged fixture leaves the check with nothing to look at, and every
  // assertion below that expects silence would pass for that reason instead.
  const add = git(['add', '-f', '--', ...staged]);
  if (add.exitCode !== 0) {
    throw new Error(
      `staging the fixture into the scratch index failed (exit ${add.exitCode}): ` +
        `${add.stderr.toString().trim()}`
    );
  }
  const run = Bun.spawnSync(['bun', 'scripts/check-docs.ts'], { cwd: REPO_ROOT, env });
  return `${run.stdout.toString()}${run.stderr.toString()}`.includes('queue-store-claims');
}

afterEach(() => {
  for (const f of FIXTURES.splice(0)) rmSync(f, { force: true });
  rmSync(path.join(REPO_ROOT, FIXTURE_DIR), { recursive: true, force: true });
  rmSync(SCRATCH_INDEX, { force: true });
});

describe('queue-store-claims and the changelog', () => {
  test('a generated entry quoting a commit does not block the release', () => {
    const f = fixture(
      CHANGELOG_FIXTURE,
      `* **queue:** move BullMQ from Redis to the Postgres backend (SC-518) ${ENTRY_LINK}\n` +
        `* **queue:** upgrade BullMQ 5.77.3 -&gt; 6.2.0, still on Redis (SC-518) ${ENTRY_LINK}`
    );
    expect(queueCheckFires([f])).toBe(false);
  });

  /**
   * Prove-red. Without this the first test passes just as well against a check
   * that has stopped looking at anything at all.
   */
  test('the rule still fires on the same line outside the changelog', () => {
    const f = fixture(
      // Carries the pid as well as the prefix. It did not, so two concurrent
      // runs raced for one path and `fixture()`'s clobber guard threw (SC-370).
      `docs/scani-test-fixture-sc556-queue-store-${process.pid}.md`,
      `* **queue:** move BullMQ from Redis to the Postgres backend ${ENTRY_LINK}`
    );
    expect(queueCheckFires([f])).toBe(true);
  });

  /**
   * DO NOT WIDEN THE EXEMPTION TO THE PATH. This is the assertion that stops it.
   * Hand-written prose in `CHANGELOG.md` is a sentence somebody chose and can
   * edit, and the header block of the real file is exactly that — several
   * paragraphs of it, including the note that three of its sections are
   * hand-written.
   */
  test('hand-written prose in the changelog is still checked', () => {
    const f = fixture(CHANGELOG_FIXTURE, 'The job queue runs on Redis in this deployment.');
    expect(queueCheckFires([f])).toBe(true);
  });

  /** A changelog naming neither store must be silent, or the two above prove nothing. */
  test('a changelog that names neither store is silent', () => {
    const f = fixture(CHANGELOG_FIXTURE, `* **ui:** widen the sidebar ${ENTRY_LINK}`);
    expect(queueCheckFires([f])).toBe(false);
  });
});
