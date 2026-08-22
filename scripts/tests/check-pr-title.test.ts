import { describe, expect, test } from 'bun:test';
import {
  isReleasePleasePullRequest,
  releasePleaseRunsHere,
  SPLIT_TYPES,
  titleBecomesAChangelogEntry,
} from '../check-pr-title';

/**
 * SC-556. Every entry in the 0.15.0 release PR was listed twice — once under a
 * branch commit and once under the merge commit that landed it, because
 * GitHub writes the PR title into the merge commit body and release-please
 * reads the full ancestry of `main`.
 *
 * The assertions below are in two halves and they pull in opposite directions.
 * The first half is the guard doing its job. The SECOND half is the one that
 * matters here: titles this deliberately LETS THROUGH. A guard that only ever
 * rejects looks correct from any angle, and the obvious tightening of this one
 * would forbid the very style the fix prescribes.
 */

describe('a PR title must not become a changelog entry', () => {
  test('rejects the shape that caused SC-556', () => {
    expect(
      titleBecomesAChangelogEntry('fix(redis): bound every Redis await on the api request path')
    ).toBe(true);
    expect(titleBecomesAChangelogEntry('feat: add the vaults dashboard')).toBe(true);
    expect(titleBecomesAChangelogEntry('chore(main): release 0.15.0')).toBe(true);
  });

  test('accepts a plain sentence, which is the house style', () => {
    expect(
      titleBecomesAChangelogEntry('Bound every Redis await on the api request path (SC-522)')
    ).toBe(false);
    expect(titleBecomesAChangelogEntry('Recurring daily transaction-sync job')).toBe(false);
  });

  /**
   * DO NOT "FIX" THIS BY TIGHTENING THE CHECK TO A CONVENTIONAL-COMMIT PARSER.
   *
   * Both titles below DO parse as conventional commits on their own, so a
   * parser-based guard rejects them — and both are measurably harmless in the
   * only position that matters. release-please splits a merge commit body on a
   * fixed list of types followed by `: `; `SC-522` is not in that list, and the
   * pattern carries no `!`. Measured against 17.11.1, inside a merge commit:
   *
   *     SC-522: bound every Redis await   -> 0 entries
   *     feat!: drop the v2 dashboard      -> 0 entries
   *
   * `SC-522: …` is a style this repo has already shipped in (scani-oss#149).
   * Forbidding it would block a correct title and teach people the check cries
   * wolf. If you are here because one of these looks like a hole, reproduce it
   * in the merge-commit position first; if it now produces an entry, the type
   * list is what changed and that is what to update.
   */
  test('deliberately allows titles that parse as conventional but cannot duplicate', () => {
    expect(titleBecomesAChangelogEntry('SC-522: bound every Redis await')).toBe(false);
    expect(titleBecomesAChangelogEntry('feat!: drop the v2 dashboard')).toBe(false);
    expect(titleBecomesAChangelogEntry('Prod fixes: Bybit chunking, DISTINCT ON')).toBe(false);
  });

  /**
   * The list is copied from release-please's `commit.js`. It is asserted here
   * so the copy is visible: if release-please ever changes it, this is the line
   * that has to be reconciled, rather than the check quietly narrowing.
   */
  test('the split list matches the one release-please splits on', () => {
    expect([...SPLIT_TYPES]).toEqual([
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]);
  });
});

describe("release-please's own release PR is exempt", () => {
  test('exempts the branch release-please generates, in this repository', () => {
    expect(
      isReleasePleasePullRequest('release-please--branches--main--components--scani', true)
    ).toBe(true);
  });

  /**
   * The exemption is keyed on the branch rather than the author on purpose, and
   * that only holds while the branch cannot be forged. A fork can name its head
   * branch anything, so the same-repository condition is load-bearing — delete
   * it and any outside contributor can opt out of the check by branch name.
   */
  test('a fork cannot claim the exemption by naming its branch', () => {
    expect(
      isReleasePleasePullRequest('release-please--branches--main--components--scani', false)
    ).toBe(false);
  });

  test('an ordinary branch is not exempt', () => {
    expect(isReleasePleasePullRequest('bb/sc-556-changelog-duplication', true)).toBe(false);
  });
});

describe('the rule applies only where release-please runs', () => {
  /**
   * This file reaches the private mirror through the downward sync. There is no
   * release-please there, so there is no changelog to duplicate into and the
   * check would forbid a title format for nothing — every private PR title is
   * conventional today.
   *
   * This is inapplicability, not blindness: the condition is a file that is
   * either there or not, and if it is ever removed from the mirror then
   * release-please stops running too. The check and the defect go quiet
   * together, which is the only reason an early exit is tolerable here.
   */
  test('applies where release-please is configured and nowhere else', () => {
    expect(releasePleaseRunsHere(true)).toBe(true);
    expect(releasePleaseRunsHere(false)).toBe(false);
  });
});
