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
 */
export function normaliseDescription(text: string): string {
  return decodeEntities(text)
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
        `The usual cause is release-please's chronological walk: it stops at ` +
        `${previousTag}'s sha, so a branch cut before the last release PR and merged ` +
        `after it sits behind the stop point and is never read (SC-572). Recover with a ` +
        `BEGIN_COMMIT_OVERRIDE on the merge commit, then re-run.`
    );
    process.exit(1);
  }

  console.log(
    `check-release-notes: PASS · exit 0 · ${releasable.length} releasable commits in ` +
      `${window}, ${bullets.length} bullets in the ${version} release notes, 0 missing`
  );
}
