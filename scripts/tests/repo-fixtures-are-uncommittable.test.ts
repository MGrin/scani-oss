import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertRepoFixtureIsIgnored,
  REPO_FIXTURE_IGNORE_RULE,
  REPO_FIXTURE_PREFIX,
} from '../lib/test-fixture-corpses';

/**
 * SC-609. Three tests under this directory write fixtures INSIDE the repository
 * — they have to, because `check-docs.ts` derives its lists from the tree, so a
 * fixture in TMPDIR exercises nothing — and remove them in `afterEach`, which
 * `SIGKILL` skips. Eleven such paths were committable when this was written.
 *
 * SC-596's answer to the same hazard was a list of name globs. The ticket that
 * filed this one enumerated six of the eleven, which is the argument against
 * repeating that: a name list is exactly as wide as its entries, and this one
 * was already incomplete on the day it was written.
 *
 * So the mechanism is git's own ignore machinery instead — `git add -A` cannot
 * stage an ignored path, whatever it is called — and what is asserted here is
 * that the guard enforcing it can actually FAIL, in both of the two ways it is
 * supposed to, against a tree built for the purpose.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository, so nothing here edits the real `.gitignore`. */
function repoWithIgnoreRules(rules: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc609-'));
  scratch.push(dir);
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir });
  git(['init', '-q', '.']);
  writeFileSync(path.join(dir, '.gitignore'), `${rules.join('\n')}\n`);
  return dir;
}

function refusal(repoRoot: string, rel: string): string {
  try {
    assertRepoFixtureIsIgnored(repoRoot, rel);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('an in-repo test fixture cannot be committed', () => {
  test('MUST-BE-FOUND — a path no ignore rule reaches is refused, and named', () => {
    const repo = repoWithIgnoreRules([REPO_FIXTURE_IGNORE_RULE]);
    const message = refusal(repo, 'docs/sc999-hand-rolled-fixture.md');

    expect(message).toContain('docs/sc999-hand-rolled-fixture.md');
    expect(message).toContain('git add -A');
    // The remedy for THIS cause is to rename it into the family.
    expect(message).toContain('Name it under the reserved family');
  });

  test('MUST-BE-ABSENT — a path the rule reaches passes, so the guard is not refusing everything', () => {
    const repo = repoWithIgnoreRules([REPO_FIXTURE_IGNORE_RULE]);

    expect(refusal(repo, `docs/${REPO_FIXTURE_PREFIX}sc999-${process.pid}.md`)).toBe('');
    expect(refusal(repo, `a/deep/${REPO_FIXTURE_PREFIX}dir-${process.pid}/CHANGELOG.md`)).toBe('');
  });

  /**
   * THE DISCRIMINATING CASE, and the reason this file exists rather than a
   * prefix comparison. A guard that checked the NAME would pass this: the path
   * carries the reserved prefix. The property that matters is not whether the
   * convention was followed, it is whether `git add -A` can take the file — so
   * the guard asks git, and deleting the rule turns the three fixture-writing
   * tests red instead of turning the guard into a no-op.
   */
  test('a correctly-named fixture is still refused when the ignore rule is gone', () => {
    const repo = repoWithIgnoreRules(['# no fixture rule here']);
    const rel = `docs/${REPO_FIXTURE_PREFIX}sc999-${process.pid}.md`;

    const message = refusal(repo, rel);
    expect(message).toContain(rel);
    // And it must NOT send the reader to rename the one thing that is correct.
    expect(message).not.toContain('Name it under the reserved family');
    expect(message).toContain(REPO_FIXTURE_IGNORE_RULE);
  });

  test('the rule the guard depends on is in the real .gitignore', () => {
    const ignores = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());

    expect(ignores).toContain(REPO_FIXTURE_IGNORE_RULE);
  });

  /**
   * The end-to-end property, asserted against git rather than inferred: a file
   * under the reserved family is invisible to `git add -A` and still reachable
   * with `-f`, which is what the two tests staging into a scratch index rely on.
   */
  test('git add -A cannot stage a reserved fixture, and git add -f still can', () => {
    const repo = repoWithIgnoreRules([REPO_FIXTURE_IGNORE_RULE]);
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo });
    const rel = `docs/${REPO_FIXTURE_PREFIX}sc999-${process.pid}/CHANGELOG.md`;

    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), '# fixture\n');
    const tracked = () => git(['ls-files', '--', rel]).stdout.toString().trim();

    git(['add', '-A']);
    expect(tracked()).toBe('');

    expect(git(['add', '-f', '--', rel]).exitCode).toBe(0);
    expect(tracked()).toBe(rel);
  });
});
