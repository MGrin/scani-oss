import { rmSync } from 'node:fs';
import path from 'node:path';
import { type GitRun, runGit } from './check-verdict';

/**
 * SC-596. Two tests under `scripts/tests/` write a fixture INSIDE this
 * repository and record it with `git add -N`, because `check-docs.ts` only
 * reads files git tracks (SC-430) and an untracked fixture would leave the
 * check passing vacuously. Both clean up in `afterEach` — which does not run
 * when the process dies. A killed gate, an interrupted run, an OOM or the
 * docker daemon vanishing under a running suite all leave the fixture in the INDEX,
 * where a later `git add -A` sweeps it into a commit; the docs one also sits
 * in the content root, so the site builds it as a page.
 *
 * Every fixture name carries `process.pid`, so a later run writes a DIFFERENT
 * filename and its own `afterEach` removes only its own. Nothing self-heals.
 * The repair therefore has to sweep the PATTERN, at test start, before
 * anything is written — a run then repairs its predecessors even when it is
 * itself killed, which is what a `process.on('exit')` handler cannot do:
 * `SIGKILL` skips it, and `SIGKILL` is the case that produced this.
 */
export const FIXTURE_CORPSE_GLOBS = [
  // docs-site-repo-links.test.ts — inside the deployed docs content root.
  'apps/frontend/docs/src/content/docs/sc589-fixture-*.md',
  // queue-store-claims.test.ts — a directory holding a single README.md.
  'scripts/.sc546-fixture-*',
] as const;

/**
 * SC-609. The one name every fixture written INSIDE this repository starts
 * with, and the only thing `.gitignore`'s matching rule has to know about.
 *
 * Not dot-prefixed, deliberately. Two of these fixtures are `.mdx` pages the
 * docs check compiles and one is a directory that must read as an ordinary
 * candidate provider; a leading dot is exactly what several tools skip, so a
 * dotted family would make some fixtures invisible to the checks they exist to
 * exercise.
 */
export const REPO_FIXTURE_PREFIX = 'scani-test-fixture-';

/** The single `.gitignore` line that has to reach {@link REPO_FIXTURE_PREFIX}. */
export const REPO_FIXTURE_IGNORE_RULE = `**/${REPO_FIXTURE_PREFIX}*`;

function matchers(): Bun.Glob[] {
  // The `/**` twin catches paths BELOW a directory entry; `*` in a glob does
  // not cross a `/`, so without it the queue fixture's `README.md` matches
  // nothing and only the empty directory would be swept.
  return FIXTURE_CORPSE_GLOBS.flatMap((g) => [new Bun.Glob(g), new Bun.Glob(`${g}/**`)]);
}

function isCorpse(relPath: string): boolean {
  return matchers().some((m) => m.match(relPath));
}

function git(repoRoot: string, ...args: string[]): GitRun {
  return runGit(args, repoRoot);
}

/**
 * What one scan of the index found, or the fact that it could not look
 * (SC-780).
 *
 * This returned a bare `string[]`, built entirely from a git call whose status
 * was never read. A failed `git ls-files` produced `''`, which split to no
 * paths, which read as **no fixture corpses are staged** — the same value a
 * clean tree produces, from the guard that stands between a killed test run's
 * debris and a commit.
 *
 * A union rather than a status check, for the SC-775 reason: a helper handing
 * back a bare `string[]` gives its caller nothing to check, so the defect
 * regenerates at the next call site. `read` is the denominator — the number of
 * tracked paths actually examined — because a count of PATTERNS is constant and
 * says nothing about whether anything was read.
 */
export type CorpseScan =
  | { readonly kind: 'scanned'; readonly corpses: string[]; readonly read: number }
  | { readonly kind: 'blind'; readonly why: string };

/**
 * Paths a fixture left recorded in the index. Read from `git ls-files` rather
 * than by pathspec: git's own wildcard matching has enough corners that a
 * pattern silently matching nothing is the likeliest way this guard would go
 * quiet, and one full listing costs a single spawn.
 */
export function stagedFixtureCorpses(repoRoot: string): CorpseScan {
  const listed = git(repoRoot, 'ls-files', '-z');
  if (listed.kind === 'failed') return { kind: 'blind', why: listed.why };

  const tracked = listed.stdout.split('\0').filter((p) => p.length > 0);
  return { kind: 'scanned', corpses: tracked.filter(isCorpse).sort(), read: tracked.length };
}

function onDiskFixtureCorpses(repoRoot: string): string[] {
  const found = new Set<string>();
  for (const glob of FIXTURE_CORPSE_GLOBS) {
    for (const hit of new Bun.Glob(glob).scanSync({ cwd: repoRoot, onlyFiles: false, dot: true })) {
      found.add(hit);
    }
  }
  return Array.from(found).sort();
}

/**
 * Unstage and delete every fixture corpse in the tree, whatever pid it names.
 * Returns what it removed, so a caller can say so rather than sweeping
 * silently. Safe to call when there is nothing to sweep.
 */
export function sweepFixtureCorpses(repoRoot: string): string[] {
  const removed = new Set<string>();

  const staged = stagedFixtureCorpses(repoRoot);
  // A sweep that could not read the index still sweeps the DISK below, which is
  // the half that does not need git. Reporting only what it actually removed is
  // the point: claiming a clean index it never read is the defect itself.
  if (staged.kind === 'scanned') {
    for (const corpse of staged.corpses) {
      git(repoRoot, 'rm', '--cached', '--quiet', '--force', '--', corpse);
      removed.add(corpse);
    }
  }

  for (const rel of onDiskFixtureCorpses(repoRoot)) {
    rmSync(path.join(repoRoot, rel), { recursive: true, force: true });
    removed.add(rel);
  }

  return Array.from(removed).sort();
}

/**
 * SC-609. The globs above are a NAME LIST, so they are exactly as wide as
 * their entries and no wider. The ticket that filed this named six fixtures no
 * pattern covered; observing the tree throughout a run of `scripts/tests/`
 * found ELEVEN, and the five it missed included four sitting in the deployed
 * docs content root. A list that was already incomplete when written is the
 * argument against fixing this with a longer list.
 *
 * What closes the COMMIT path instead is git's own ignore machinery: `git add
 * -A` cannot stage an ignored path, at all, whatever it is called. So every
 * fixture a test writes inside this repository goes under one reserved family,
 * `.gitignore` carries one rule for it, and this function refuses a path that
 * rule does not reach — at the moment of writing, on the first run, rather
 * than at some later kill.
 *
 * It asks GIT whether the path is ignored rather than matching the prefix
 * itself. Those come apart: matching the prefix asserts the convention was
 * followed, and the property that actually matters is whether `git add -A`
 * can take the file. A prefix check would pass with the `.gitignore` rule
 * deleted.
 *
 * THE RESIDUAL, which this does not close and must not be read as closing: a
 * fixture written to a brand-new path by a test that does not call this
 * function is invisible here. `fixture-corpse-sweep.test.ts` scans for that
 * shape as a backstop, and a source scan is itself a pattern.
 */
export function assertRepoFixtureIsIgnored(repoRoot: string, rel: string): void {
  const probe = Bun.spawnSync(['git', 'check-ignore', '-q', '--', rel], { cwd: repoRoot });

  // 0 ignored, 1 not ignored, 128 a real git failure. Treating anything
  // non-zero as "not ignored" would report a broken git as a fixture bug.
  if (probe.exitCode === 0) return;
  if (probe.exitCode !== 1) {
    throw new Error(
      `git check-ignore failed (exit ${probe.exitCode}) for ${rel}: ` +
        `${probe.stderr.toString().trim()}`
    );
  }

  // Two different causes reach this line and they need opposite remedies, so
  // the message discriminates rather than guessing. A path already carrying the
  // prefix cannot be fixed by renaming it — telling its reader to rename would
  // send them to edit the one thing that is already right.
  const carriesPrefix = rel.split('/').some((segment) => segment.startsWith(REPO_FIXTURE_PREFIX));

  throw new Error(
    `${rel} is a test fixture inside the repository that git would let ` +
      `\`git add -A\` commit.\n\n` +
      (carriesPrefix
        ? `It is named correctly, so the rule that should cover it is missing: ` +
          `.gitignore has no line matching \`${REPO_FIXTURE_IGNORE_RULE}\`. Put it back.`
        : `Name it under the reserved family, so the one rule in .gitignore reaches ` +
          `it:\n\n  ${REPO_FIXTURE_PREFIX}<what-it-is>-\${process.pid}\n\n` +
          `The prefix is what makes it uncommittable; the pid is what stops two ` +
          `concurrent runs sharing one path (SC-370).`)
  );
}
