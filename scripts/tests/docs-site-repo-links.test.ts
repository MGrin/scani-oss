import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sweepFixtureCorpses } from '../lib/test-fixture-corpses';
import { replayStrandedMutations, withMutatedSources } from '../lib/test-source-mutations';

/**
 * SC-589. The published docs site linked a design note in the closed
 * repository this mirror is published from — a 404 for every reader, and the
 * closed repository's name printed on a public page beside a real hostname.
 * `checkDocsSiteRepoLinks` is the guard; what is tested here is the property
 * that makes it usable rather than the wording of any one finding.
 *
 * The slug the rule really guards against is a strict PREFIX of the allowed
 * one, so a substring test reports every correct link as a violation. Both
 * controls below exist for that: a link that must be reported, and a link that
 * must not be — run in the same file, so a broken harness cannot make the
 * second one look like a pass.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

// Inside the docs content root, because that is what the check reads, and as a
// `.md` so `mdx-syntax` does not also compile it and muddy what these
// assertions are reading.
const FIXTURE = path.join(
  REPO_ROOT,
  `apps/frontend/docs/src/content/docs/sc589-fixture-${process.pid}.md`
);
const FIXTURE_REL = path.relative(REPO_ROOT, FIXTURE);

// Assembled rather than written out, so this file does not itself carry the
// closed repository's URL — the same reason `check-docs.ts` states its rule
// positively.
const HOST = 'https://github.com/MGrin';
const PUBLIC_REPO = 'scani-oss';
const CLOSED_REPO = PUBLIC_REPO.replace('-oss', '');

function git(...args: string[]): void {
  Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT });
}

function runCheck(): { exitCode: number; output: string } {
  const run = Bun.spawnSync(['bun', 'scripts/check-docs.ts'], { cwd: REPO_ROOT });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

/**
 * The check only reads files git TRACKS (SC-430), so an untracked fixture is
 * invisible to it. `git add -N` records intent-to-add: the path appears in
 * `git ls-files` while its content stays entirely in the working tree, so no
 * committed blob is touched and `git rm --cached` undoes it completely.
 */
function writeTrackedFixture(body: string): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, body);
  git('add', '-N', FIXTURE_REL);

  // Without this the harness failing silently and the check finding nothing
  // print the same thing — which is the failure this whole file is about.
  const tracked = Bun.spawnSync(['git', 'ls-files', FIXTURE_REL], { cwd: REPO_ROOT })
    .stdout.toString()
    .trim();
  expect(tracked).toBe(FIXTURE_REL);
}

/**
 * SC-596. `afterEach` below does not run when the process is killed, and the
 * pid in the fixture name means no later run ever removes a predecessor's
 * corpse — it stays in the INDEX, inside a directory the docs site deploys,
 * waiting for a `git add -A`. So the repair is a sweep of the PATTERN at
 * module scope, before anything here is written: this run repairs its
 * predecessors even if it is itself killed, which a `process.on('exit')`
 * handler cannot do because `SIGKILL` skips it.
 */
const swept = sweepFixtureCorpses(REPO_ROOT);
if (swept.length > 0) console.log(`swept ${swept.length} stale fixture(s): ${swept.join(', ')}`);

/**
 * SC-601. The last test here rewrites `scripts/check-docs.ts` — TRACKED SOURCE
 * — and restores it in a `finally` that `SIGKILL` skips just as thoroughly. The
 * corpse is a legitimate filename with wrong contents, which no glob can find,
 * so the sweep above structurally cannot cover it and this one replays a
 * journal instead. Same reason it sits at module scope: a killed run repairs
 * its predecessor.
 */
const restored = replayStrandedMutations(REPO_ROOT);
if (restored.length > 0) console.log(`restored ${restored.length} file(s): ${restored.join(', ')}`);

afterEach(() => {
  git('rm', '--cached', '--quiet', '--force', FIXTURE_REL);
  rmSync(FIXTURE, { force: true });
});

describe('docs:check refuses a docs-site link to any repository but the public one', () => {
  test('the tree as committed is green — the baseline the other assertions need', () => {
    const { exitCode, output } = runCheck();
    expect(output).toMatch(/all \d+ checks passed/);
    expect(exitCode).toBe(0);
  });

  test('POSITIVE CONTROL — a link to the closed repository is reported', () => {
    writeTrackedFixture(
      `# fixture\n\nSee [the notes](${HOST}/${CLOSED_REPO}/blob/main/docs/x.md).\n`
    );

    const { exitCode, output } = runCheck();
    expect(output).toContain('docs-site-repo-links');
    expect(output).toContain(FIXTURE_REL);
    expect(exitCode).toBe(1);
  });

  /**
   * NEGATIVE CONTROL, AND THE ONE TO DELETE LAST.
   *
   * A rule that only ever fires is indistinguishable from a broken one, and
   * this rule has a specific way of being broken that still passes the test
   * above: the closed slug is a strict prefix of the public one, so a
   * substring test flags BOTH and the positive control stays green while
   * every correct link in the site turns red. The load-bearing evidence that
   * the rule works is therefore not the report above — it is this link going
   * unreported.
   */
  test('NEGATIVE CONTROL — a link to the public repository is not reported', () => {
    writeTrackedFixture(
      `# fixture\n\nSee [the license](${HOST}/${PUBLIC_REPO}/blob/main/LICENSE).\n`
    );

    const { exitCode, output } = runCheck();
    expect(output).not.toContain(FIXTURE_REL);
    expect(exitCode).toBe(0);
  });

  test('a link to some third repository of ours is reported too', () => {
    writeTrackedFixture(`# fixture\n\nSee [elsewhere](${HOST}/some-other-repo/blob/main/R.md).\n`);

    const { exitCode, output } = runCheck();
    expect(output).toContain('docs-site-repo-links');
    expect(output).toContain('MGrin/some-other-repo');
    expect(exitCode).toBe(1);
  });

  /**
   * THE ONE A FUTURE READER WILL WANT TO DELETE, so the reason sits here
   * rather than only in the assertion.
   *
   * When the check finds no tracked files under the docs app it has verified
   * NOTHING. The tempting softening is that an empty result set there is
   * almost always benign — and it is, right up to the day the site is
   * relocated, at which point this check goes quietly vacuous over its new
   * home and can never fire again. A blindness state gets its own failure and
   * never a plausibility downgrade.
   */
  test('an empty docs app FAILS — it is never read as "no bad links"', () => {
    const script = path.join(REPO_ROOT, 'scripts/check-docs.ts');
    const original = readFileSync(script, 'utf8');
    const moved = original.replace(
      "const DOCS_APP = 'apps/frontend/docs';",
      "const DOCS_APP = 'apps/frontend/docs-moved-away';"
    );

    // Control: the substitution matched. Without it, a renamed constant would
    // leave the file untouched and this test would assert against a green run.
    expect(moved).not.toBe(original);

    // SC-601. `withMutatedSources` journals the original bytes before writing,
    // so a `kill -9` between here and the restore is repaired by the replay at
    // the top of this file rather than committed by the next `git add -A`.
    const { exitCode, output } = withMutatedSources(REPO_ROOT, { [script]: moved }, runCheck);

    expect(output).toContain('docs-site-repo-links');
    expect(output).toContain('no link was checked');
    expect(exitCode).toBe(1);

    // Restoration is asserted, not assumed: a stranded mutation here turns
    // every later file in this single-process run red with no connection to
    // what it names.
    expect(readFileSync(script, 'utf8')).toBe(original);
  });
});
