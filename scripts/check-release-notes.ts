/**
 * SC-573. A releasable commit must not reach a release with no changelog entry.
 *
 * THE FAILURE THIS EXISTS FOR, measured on scani-oss 0.16.0 (SC-572).
 *
 * release-please reads `main` through GitHub's GraphQL `history` connection
 * with no `orderBy`, so commits arrive in COMMITTER-DATE order, and
 * `manifest.js` breaks the walk the instant it sees the previous release's
 * sha. The walk is chronological, not topological. A branch cut BEFORE a
 * release PR merged and merged AFTER it therefore carries commits whose
 * committer dates predate the release commit: they sit behind the stop sha and
 * are never reached, even though they are on `main` and unreachable from the
 * tag.
 *
 * The 0.16.0 release PR was generated at `77021b26` (parent `aa5c9c63a`). The
 * v0.15.0 sha `fc5847ba` was at walk position 9, committed 08:26:51Z; SC-567's
 * two `fix(holdings):` commits `56b86286` and `d4996660` were at positions 15
 * and 16, committed 08:12:49Z and merged at 08:39:00Z. Four releasable commits
 * were on `main`; the release notes listed two. A data-loss fix and a security
 * fix were absent, CI was green, and nothing anywhere reported it. It was
 * found by a `grep` run out of curiosity.
 *
 * The trigger is routine: it fires whenever a release PR merges while another
 * pull request is open.
 *
 * WHAT THIS CHECKS. It derives the two sides independently and differences
 * them — the commit side from `git log <previous tag>..<the commit the release
 * PR was generated from>`, the notes side from `CHANGELOG.md` as the release
 * PR proposes to write it. Neither is computed from the other, which is what
 * makes a shortfall visible at all. A guard whose two sides share a derivation
 * reports clean forever.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, AND WHY. SC-572 named a second,
 * independent way a fix goes missing: a commit subject that is a plain
 * sentence rather than a conventional commit. release-please logs `commit
 * could not be parsed` at debug level and carries on. Those subjects are
 * PRINTED here as a notice and never fail the run, because from the log alone
 * they are indistinguishable from work that is legitimately covered by a
 * sibling commit — measured on this same window, `483e269c` ("The self-hosted
 * SPA sends no security headers at all (SC-561)") is unparseable and the same
 * work is listed under `050fbc63` `fix(self-host):`. Failing on it would make
 * the check permanently red on a release nobody can rewrite the history of,
 * which is the shape of a rule people learn to route around. Catching that
 * cause belongs at the moment it is still fixable — on the ordinary pull
 * request — and is a contributor-facing policy decision, not this file's.
 *
 * A SHORTFALL DOES NOT NAME ITS OWN CAUSE (SC-621). This file used to tell
 * whoever hit it that the chronological walk above was "the usual cause". That
 * was measured FALSE on the next real instance: `19e7300fb`'s committer date
 * is 2026-08-25 08:36Z, well after `v0.17.1`'s 2026-08-22 15:07Z, so it was
 * never behind the stop sha. Feeding the whole `git log` corpus to
 * release-please's own parser dropped it anyway — the message did not parse.
 *
 * So there are two independent causes and the shortfall looks identical under
 * both; the failure message now names both and gives the one-step
 * discriminator (the committer date against the tag's) rather than asserting
 * one. A confident wrong cause is worse than none: it sends the reader to
 * `BEGIN_COMMIT_OVERRIDE` when the fix was a bracket, and the override has a
 * placement trap of its own — see the message.
 *
 * BLINDNESS IS NOT A PASS. Every way this check can fail to look — no release
 * commit at the head, no previous tag, a changelog whose top section is not
 * the version being released, or a window in which it finds NO releasable
 * commits at all — exits 3 and says so. The last one is the important one: a
 * release PR exists precisely because release-please found something
 * releasable, so a commit side that comes back empty means this check's own
 * derivation is broken, not that the release is clean. A young release PR with
 * no bullets yet is a shortfall of N, not a pass.
 */

const RELEASE_COMMIT_SUBJECT = /^chore(?:\([^)]*\))?: release /;

/**
 * The conventional-commit types release-please renders into a visible
 * changelog section. `release-please-config.json` sets no `changelog-sections`
 * key, so `manifest.js` passes `changelogSections: undefined` and the
 * `conventional-changelog-conventionalcommits` preset defaults apply: feat,
 * feature, fix, perf and revert are visible; docs, style, chore, refactor,
 * test, build and ci are `hidden: true`.
 *
 * `feat`, `fix` and `perf` are MEASURED on this repo's own published notes —
 * `perf(token-prices): DISTINCT ON latest-price lookup` (`f8c6734`) is
 * rendered under "Performance Improvements" in CHANGELOG.md. `feature` and
 * `revert` have never occurred here and are taken from the preset rather than
 * observed; if either ever produces a spurious shortfall, that is the entry to
 * doubt first.
 *
 * A wrong list fails in a knowable direction. Too narrow under-reports (a
 * missing entry goes unseen, which is today's failure); too wide reports a
 * shortfall for a commit release-please never intended to list, which blocks a
 * release. Widen it only against a rendered changelog, never against a reading
 * of the preset.
 */
export const RELEASE_NOTE_TYPES = ['feat', 'feature', 'fix', 'perf', 'revert'] as const;

export interface ParsedSubject {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const CONVENTIONAL_SUBJECT = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?: (.+)$/;

export function parseSubject(subject: string): ParsedSubject | null {
  const match = CONVENTIONAL_SUBJECT.exec(subject.trim());
  if (!match) return null;
  return {
    type: match[1]!.toLowerCase(),
    scope: match[2] ?? null,
    breaking: match[3] === '!',
    description: match[4]!,
  };
}

/** A breaking change is released whatever its type — it gets its own section. */
export function earnsAReleaseNote(parsed: ParsedSubject): boolean {
  return parsed.breaking || (RELEASE_NOTE_TYPES as readonly string[]).includes(parsed.type);
}

/**
 * conventional-changelog-writer HTML-escapes the description, so a commit
 * subject reading `say "< 0.00000001" not "0"` is written to CHANGELOG.md as
 * `say "&lt; 0.00000001" not "0"`. Comparing the two without decoding reports
 * a shortfall for an entry that is present.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Matching is on the DESCRIPTION alone, not on `scope: description`. The scope
 * is rendered as `**scope:** ` in the bullet and reformatting it upstream
 * would produce a shortfall for an entry that is present — a false red on a
 * release. Two commits in one window sharing a description but not a scope is
 * the cost, and the comparison is a multiset so genuine duplicates still need
 * one bullet each.
 *
 * The trailing ` (#123)` is release-please's pull-request reference, which it
 * strips from the description and re-renders as a link, so it is stripped from
 * both sides.
 *
 * ` (SC-612)` is stripped too, from both sides, and that one is a repair
 * (SC-621). Recovering a missing entry means writing the bullet by hand
 * through a `BEGIN_COMMIT_OVERRIDE`, and the natural thing to write is this
 * repo's usual ticket suffix — which the commit subject may not carry.
 * Measured on the 0.18.0 repair: 20 bullets in the release PR, the entry
 * plainly there, and this check still reporting `1 of 20 ... have no entry`.
 * A visible entry the guard cannot see is worse than an obvious absence,
 * because the changelog is what a reader believes.
 *
 * Stripping cannot hide a real shortfall: it only makes two descriptions match
 * that differ by a ticket reference, and a bullet that says the same thing
 * about the same ticket IS the entry. The cost is two commits in one window
 * whose descriptions differ only by their SC number — the same trade already
 * accepted for the scope, one paragraph up.
 */
const SUFFIXES_STRIPPED_FROM_BOTH_SIDES = /\s*\((?:#\d+|SC-\d+)\)\s*$/i;

export function normaliseDescription(text: string): string {
  let out = decodeEntities(text);
  // A loop, not one replace: both suffixes can be present, in either order.
  let previous: string;
  do {
    previous = out;
    out = out.replace(SUFFIXES_STRIPPED_FROM_BOTH_SIDES, '');
  } while (out !== previous);
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The section for `version`, or null when the top section is some other version. */
export function extractVersionSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const headingAt = lines.findIndex((line) => /^## /.test(line));
  if (headingAt === -1) return null;
  const heading = lines[headingAt]!;
  const headingVersion = /^## \[?([0-9]+\.[0-9]+\.[0-9]+[^\]\s)]*)/.exec(heading);
  if (!headingVersion || headingVersion[1] !== version) return null;
  const rest = lines.slice(headingAt + 1);
  const nextHeadingAt = rest.findIndex((line) => /^## /.test(line));
  return (nextHeadingAt === -1 ? rest : rest.slice(0, nextHeadingAt)).join('\n');
}

/**
 * `* **holdings:** show the pot name ([d21d588](https://…/commit/d21d588…))`
 * — strip the bullet marker, the bolded scope, and every trailing link.
 */
export function parseBulletDescriptions(section: string): string[] {
  return section
    .split('\n')
    .filter((line) => line.startsWith('* '))
    .map((line) =>
      line
        .slice(2)
        .replace(/^\*\*[^*]*:\*\*\s*/, '')
        .replace(/(?:\s*\(\[[^\]]*\]\([^)]*\)\))+\s*$/, '')
    )
    .map(normaliseDescription)
    .filter((description) => description.length > 0);
}

export interface ReleasableCommit {
  sha: string;
  subject: string;
  description: string;
}

/** Releasable commits with no bullet, as a multiset difference. */
export function findShortfall(commits: ReleasableCommit[], bullets: string[]): ReleasableCommit[] {
  const remaining = new Map<string, number>();
  for (const bullet of bullets) remaining.set(bullet, (remaining.get(bullet) ?? 0) + 1);

  const missing: ReleasableCommit[] = [];
  for (const commit of commits) {
    const key = normaliseDescription(commit.description);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else missing.push(commit);
  }
  return missing;
}

const BLIND = 3;

function git(args: string[]): { ok: boolean; stdout: string } {
  const run = Bun.spawnSync(['git', ...args]);
  return { ok: run.exitCode === 0, stdout: new TextDecoder().decode(run.stdout) };
}

function blind(reason: string): never {
  console.error(
    `check-release-notes: BLIND · exit ${BLIND} · NO COMPARISON MADE — ${reason}\n\n` +
      `This is not a pass. It means the check could not see the two sides it\n` +
      `differences, so it cannot say whether a releasable commit is missing\n` +
      `from the release notes. Someone has to look.`
  );
  process.exit(BLIND);
}

if (import.meta.main) {
  const headArg = process.argv.indexOf('--head');
  const head = headArg === -1 ? 'HEAD' : (process.argv[headArg + 1] ?? 'HEAD');

  const headSubject = git(['log', '-1', '--format=%s', head]);
  if (!headSubject.ok) blind(`\`${head}\` does not resolve to a commit`);
  if (!RELEASE_COMMIT_SUBJECT.test(headSubject.stdout.trim())) {
    blind(
      `\`${head}\` is not a release commit — its subject is ` +
        `"${headSubject.stdout.trim()}", not "chore(main): release X.Y.Z"`
    );
  }

  // The release branch is main's tip plus one release commit, so the parent IS
  // the commit release-please generated these notes from. Reading main's tip
  // instead would report a shortfall for anything merged in the meantime,
  // which release-please has not been asked to look at yet.
  const parents = git(['rev-list', '--parents', '-n', '1', head]);
  const parentShas = parents.stdout.trim().split(/\s+/).slice(1);
  if (parentShas.length !== 1) {
    blind(`the release commit has ${parentShas.length} parents, expected exactly 1`);
  }
  const base = parentShas[0]!;

  const manifestAt = (ref: string): string | null => {
    const shown = git(['show', `${ref}:.release-please-manifest.json`]);
    if (!shown.ok) return null;
    try {
      const value = (JSON.parse(shown.stdout) as Record<string, string>)['.'];
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  const version = manifestAt(head);
  const previousVersion = manifestAt(base);
  if (!version) blind(`no version at "." in .release-please-manifest.json at ${head}`);
  if (!previousVersion) blind(`no version at "." in .release-please-manifest.json at ${base}`);
  if (version === previousVersion) {
    blind(`the release commit does not bump the manifest — both sides read ${version}`);
  }

  const previousTag = [`v${previousVersion}`, previousVersion].find(
    (candidate) => git(['rev-parse', '-q', '--verify', `refs/tags/${candidate}^{commit}`]).ok
  );
  if (!previousTag) {
    blind(
      `no tag for the previous release ${previousVersion} — looked for ` +
        `v${previousVersion} and ${previousVersion}. A shallow checkout without ` +
        `tags reads exactly like a repository that has never released.`
    );
  }

  const changelogShown = git(['show', `${head}:CHANGELOG.md`]);
  if (!changelogShown.ok) blind(`no CHANGELOG.md at ${head}`);
  const section = extractVersionSection(changelogShown.stdout, version);
  if (section === null) {
    blind(`the top section of CHANGELOG.md at ${head} is not ${version}`);
  }

  const log = git(['log', `${previousTag}..${base}`, '--no-merges', '--format=%H%x1f%s%x1e']);
  if (!log.ok) blind(`could not walk ${previousTag}..${base}`);

  const releasable: ReleasableCommit[] = [];
  const unparseable: { sha: string; subject: string }[] = [];
  for (const record of log.stdout.split('\x1e')) {
    const [sha, subject] = record.replace(/^\n/, '').split('\x1f');
    if (!sha || subject === undefined) continue;
    const parsed = parseSubject(subject);
    if (!parsed) {
      unparseable.push({ sha: sha.slice(0, 9), subject });
      continue;
    }
    if (earnsAReleaseNote(parsed)) {
      releasable.push({ sha: sha.slice(0, 9), subject, description: parsed.description });
    }
  }

  if (releasable.length === 0) {
    blind(
      `no releasable commit found in ${previousTag}..${base}, yet release-please ` +
        `proposed ${version}. It found something this walk did not, so this ` +
        `check's own derivation is what is wrong.`
    );
  }

  const bullets = parseBulletDescriptions(section);
  const missing = findShortfall(releasable, bullets);

  const window = `${previousTag}..${base.slice(0, 9)}`;
  if (unparseable.length > 0) {
    console.log(
      `check-release-notes: notice · ${unparseable.length} commit(s) in ${window} have a ` +
        `subject release-please cannot parse, so it listed nothing for them. This does ` +
        `not fail the run — the same work is often listed under a sibling commit — but ` +
        `it is the second way a fix goes missing (SC-572), so read them:\n` +
        unparseable.map(({ sha, subject }) => `    ${sha}  ${subject}`).join('\n')
    );
  }

  if (missing.length > 0) {
    console.error(
      `check-release-notes: FAILED · exit 1 · ${missing.length} of ${releasable.length} ` +
        `releasable commits in ${window} have no entry in the ${version} release notes ` +
        `(${bullets.length} bullets)\n\n` +
        missing.map(({ sha, subject }) => `    ${sha}  ${subject}`).join('\n') +
        `\n\nThese are on main and not in ${previousTag}, so merging this release ships ` +
        `them with no line in CHANGELOG.md and no line in the GitHub release.\n\n` +
        `TWO CAUSES PRODUCE AN IDENTICAL SHORTFALL. This message used to assert the ` +
        `first\nas "the usual cause"; on the next real instance it was the second ` +
        `(SC-621).\n\n` +
        `  1. THE WALK NEVER REACHED IT. release-please stops at ${previousTag}'s sha and ` +
        `walks\n     in committer-date order, so a branch cut before the last release PR ` +
        `and merged\n     after it sits behind the stop point (SC-572).\n\n` +
        `  2. THE MESSAGE DOES NOT PARSE. The parser reads the WHOLE message, not the ` +
        `subject:\n     one unbalanced bracket anywhere in the body throws, and ` +
        `parseConventionalCommits\n     logs it at DEBUG level and returns ZERO commits ` +
        `for that sha. Measured on\n     19e7300fb (SC-612) — a "(" on line 9, under a ` +
        `perfectly formed subject.\n\n` +
        `  2b. THE MESSAGE PARSED WAS NOT THE COMMIT'S. An override marker anywhere in a ` +
        `pull\n      request BODY makes release-please use the text after it as the ` +
        `message for EVERY\n      commit of that PR. Mentioned in prose, unclosed, it ` +
        `swallows the rest of the body\n      and drops all of them. Measured on ` +
        `scani-oss#219: three commits, one an ordinary\n      fix(oss), all parsed to ` +
        `nothing, and release-please reported success having\n      regenerated nothing ` +
        `(SC-638). check-pr-body.ts refuses this now; if a shortfall\n      names every ` +
        `commit of one PR and no others, look at that PR's body first.\n\n` +
        `Tell them apart in one step. Cause 1 needs a committer date EARLIER than the ` +
        `tag's:\n\n` +
        `    git show -s --format='%cI %h %s' ${previousTag} ` +
        `${missing.map(({ sha }) => sha).join(' ')}\n\n` +
        `RECOVERY, and the placement matters. Put ` +
        `BEGIN_COMMIT_OVERRIDE / END_COMMIT_OVERRIDE\ncarrying the conventional message ` +
        `you wanted in the BODY of a pull request that is\nSQUASH-merged. The rule is ONE ` +
        `commit on main for that pull request:\npreprocessCommitMessage reads the override ` +
        `out of the pull request BODY, and the\nwalk attaches that body to EVERY commit of ` +
        `the same PR — so behind a merge commit\nthe merge and each branch commit produce ` +
        `the entry, which is the duplication\ncheck-pr-title.ts exists to prevent. Measured ` +
        `against 17.11.2:\n\n` +
        `    override on a merge-commit PR    21 bullets, the entry listed twice\n` +
        `    override on a squash-merged PR   20 bullets, the entry listed once\n\n` +
        `The override REPLACES the commit's own message, so the squash SUBJECT does not\n` +
        `matter here — measured: a multi-commit squash whose subject was the unparseable\n` +
        `PR title still yielded exactly one entry, the overridden one. That holds only\n` +
        `WITH an override. A pull request you are NOT overriding must not be squashed\n` +
        `unless its branch is a single conventional commit, because\n` +
        `squash_merge_commit_title is COMMIT_OR_PR_TITLE and check-pr-title.ts has forced\n` +
        `that title to be unparseable — cause 2 again, from the other direction.\n\n` +
        `Those markers are literal, and that is the trap in 2b: do NOT write either of ` +
        `them\nin the body of a pull request you are not actually overriding. A lone ` +
        `opening marker\nreplaces every commit message of that PR. check-pr-body.ts ` +
        `refuses a malformed one.\n\n` +
        `Write the override's subject to match the commit's byte for byte. Only a ` +
        `trailing\n(#123) or (SC-nnn) is stripped before comparison; anything else you ` +
        `append leaves a\nbullet that is VISIBLE in CHANGELOG.md and invisible to this ` +
        `check, and it goes on\nreporting a shortfall against an entry that is there.\n\n` +
        `ONE OVERRIDE BLOCK CAN CARRY SEVERAL MESSAGES, which is what you need whenever ` +
        `a\nsingle pull request is short more than one entry — the common case, since a ` +
        `walk\nthat stopped early missed every commit of that branch, not one of them. ` +
        `Separate\nthem with a BLANK LINE inside the one block; do not open a second ` +
        `block, and do not\nraise a pull request per missing commit.\n\n` +
        `Measured against release-please 17.11.2's own parseConventionalCommits, with a ` +
        `\none-message control so the result is a measurement rather than a hopeful ` +
        `reading:\n\n` +
        `    two conventional messages, blank-line separated   ->  2 parsed\n` +
        `    one message (control)                             ->  1 parsed\n\n` +
        `This paragraph exists because the advice above it reads as singular — "the ` +
        `message\nyou wanted" — and a reader holding two missing shas has no way to tell ` +
        `whether the\nmechanism is one-per-block without testing it (SC-676).`
    );
    process.exit(1);
  }

  console.log(
    `check-release-notes: PASS · exit 0 · ${releasable.length} releasable commits in ` +
      `${window}, ${bullets.length} bullets in the ${version} release notes, 0 missing`
  );
}
