/**
 * SC-556. A pull-request title must not become a changelog entry.
 *
 * release-please walks `history(first: …)` on `main`'s tip, which is GitHub's
 * FULL ancestry rather than `--first-parent` — 70 commits against 27 over the
 * 0.15.0 window. So a merge commit and every branch commit it landed are all
 * read. GitHub then writes the PR title into the merge commit's message under
 * every one of the three title/message combinations it permits
 * (`PR_TITLE`+`PR_BODY`, `PR_TITLE`+`BLANK`, `MERGE_MESSAGE`+`PR_TITLE`), so
 * when the title is itself a conventional commit the same change is listed
 * twice: once under the branch commit, once under the merge commit. Every
 * entry in the 0.15.0 release PR was duplicated that way.
 *
 * There is no release-please config key for this — all 46 keys `manifest.js`
 * reads were enumerated and none governs merge-commit reading — and there is
 * no repository setting either, which is why the rule lives here.
 *
 * WHAT THIS CHECKS, AND WHY IT IS NARROWER THAN IT LOOKS.
 *
 * The defect needs the title to be split OUT of the merge commit message, and
 * that split is done by `splitMessages` in release-please's `commit.js`, which
 * matches a fixed list of types followed by `: `. It is deliberately NOT the
 * full conventional-commit parser. Measured against release-please 17.11.1
 * with the title in the position that actually matters — inside a merge
 * commit — the two disagree, in BOTH directions:
 *
 *     title                                    parsed alone   inside a merge commit
 *     fix(redis): bound every Redis await             1              1   duplicate
 *     feat: add the vaults dashboard                  1              1   duplicate
 *     feat!: drop the v2 dashboard                    1              0   clean
 *     SC-522: bound every Redis await                 1              0   clean
 *     Bound every Redis await (SC-522)                0              0   clean
 *
 * So the obvious guard — "the title must not parse as a conventional commit" —
 * is wrong twice over. It would forbid `SC-522: …`, which is the ticket-prefix
 * style this repo already shipped in (#149) and which cannot produce a
 * duplicate, and it would forbid `feat!: …`, which also cannot. A guard that
 * blocks provably harmless titles is one people learn to route around.
 *
 * This checks the mechanism instead. If it ever needs to be widened, widen it
 * because a measurement in the merge-commit position changed — not because a
 * title looked conventional to a reader.
 *
 * THE COUPLING, STATED SO IT CANNOT ROT SILENTLY. The type list below is a
 * copy of release-please's own split list. If release-please changes it, this
 * check goes quiet rather than red, and so does the defect it names — the two
 * fail together, in the same direction, which is the only reason a copy is
 * tolerable here. `scripts/tests/check-pr-title.test.ts` asserts the list.
 *
 * WHEN THIS GUARD BECOMES DECORATION: if the repo ever moves to squash-merge,
 * branch commits stop being ancestors of `main` at all, duplication becomes
 * structurally impossible, and this check can never fire again. It would then
 * be a rule with no failure mode, which reads exactly like a rule that works.
 * Delete it in that change rather than leaving it to reassure people.
 */

/** release-please `commit.js` `splitMessages`: the types it will split a message on. */
export const SPLIT_TYPES = [
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
] as const;

const SPLITS_OUT_OF_A_MERGE_COMMIT = new RegExp(`^(?:${SPLIT_TYPES.join('|')})(?:\\(.*?\\))?: `);

export function titleBecomesAChangelogEntry(title: string): boolean {
  return SPLITS_OUT_OF_A_MERGE_COMMIT.test(title.trim());
}

/**
 * release-please's own release PR is titled `chore(main): release X.Y.Z`, so it
 * trips the rule it is exempt from — its merge commit is meant to carry that.
 * Keyed on the head branch, which release-please generates, rather than on the
 * author: a bot identity can change, and an author allowlist is a hole anyone
 * can walk through. The same-repository condition is what stops a fork naming
 * a branch `release-please--anything` and claiming the exemption.
 */
export function isReleasePleasePullRequest(headRef: string, sameRepository: boolean): boolean {
  return sameRepository && headRef.startsWith('release-please--');
}

/**
 * The rule exists because release-please reads merge commits. Where
 * release-please does not run there is no changelog to duplicate into, and the
 * check would only forbid a title format for no gain — this file reaches the
 * private mirror through the downward sync, where every PR title is
 * conventional today and none of them feeds a changelog.
 *
 * Keyed on release-please's config rather than on the repository name: if that
 * file is ever removed or renamed, release-please stops running and this check
 * stops applying, together and for the same reason. A name-keyed condition
 * would go quiet on a rename while the defect came back.
 */
export function releasePleaseRunsHere(hasReleasePleaseConfig: boolean): boolean {
  return hasReleasePleaseConfig;
}

if (import.meta.main) {
  const repoRoot = new URL('..', import.meta.url).pathname;
  if (!releasePleaseRunsHere(await Bun.file(`${repoRoot}release-please-config.json`).exists())) {
    console.log(
      'check-pr-title: no release-please-config.json here, so no changelog to duplicate into — rule does not apply.'
    );
    process.exit(0);
  }

  const title = process.env.PR_TITLE ?? '';
  const headRef = process.env.PR_HEAD_REF ?? '';
  const sameRepository = process.env.PR_SAME_REPO === 'true';

  if (!title) {
    console.error('check-pr-title: PR_TITLE is empty — refusing rather than passing vacuously.');
    process.exit(2);
  }

  if (isReleasePleasePullRequest(headRef, sameRepository)) {
    console.log(`check-pr-title: exempt — ${headRef} is release-please's own release PR.`);
    process.exit(0);
  }

  if (!titleBecomesAChangelogEntry(title)) {
    console.log(`check-pr-title: ok — this title adds no changelog entry.\n  ${title}`);
    process.exit(0);
  }

  console.error(
    `check-pr-title: this title would be listed in CHANGELOG.md twice.\n` +
      `\n  ${title}\n\n` +
      `GitHub puts the PR title in the merge commit body, and release-please reads\n` +
      `both that and the branch commit — so the same change appears under two shas.\n\n` +
      `Write the title as a plain sentence and keep the conventional prefix on the\n` +
      `COMMITS, which is where release-please is meant to read it:\n\n` +
      `  not   fix(redis): bound every Redis await on the api request path (SC-522)\n` +
      `  but   Bound every Redis await on the api request path (SC-522)\n`
  );
  process.exit(1);
}
