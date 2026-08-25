import { rmSync } from 'node:fs';
import path from 'node:path';

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

function matchers(): Bun.Glob[] {
  // The `/**` twin catches paths BELOW a directory entry; `*` in a glob does
  // not cross a `/`, so without it the queue fixture's `README.md` matches
  // nothing and only the empty directory would be swept.
  return FIXTURE_CORPSE_GLOBS.flatMap((g) => [new Bun.Glob(g), new Bun.Glob(`${g}/**`)]);
}

function isCorpse(relPath: string): boolean {
  return matchers().some((m) => m.match(relPath));
}

function git(repoRoot: string, ...args: string[]): string {
  return Bun.spawnSync(['git', ...args], { cwd: repoRoot }).stdout.toString();
}

/**
 * Paths a fixture left recorded in the index. Read from `git ls-files` rather
 * than by pathspec: git's own wildcard matching has enough corners that a
 * pattern silently matching nothing is the likeliest way this guard would go
 * quiet, and one full listing costs a single spawn.
 */
export function stagedFixtureCorpses(repoRoot: string): string[] {
  return git(repoRoot, 'ls-files', '-z')
    .split('\0')
    .filter((p) => p.length > 0 && isCorpse(p))
    .sort();
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

  for (const staged of stagedFixtureCorpses(repoRoot)) {
    git(repoRoot, 'rm', '--cached', '--quiet', '--force', '--', staged);
    removed.add(staged);
  }

  for (const rel of onDiskFixtureCorpses(repoRoot)) {
    rmSync(path.join(repoRoot, rel), { recursive: true, force: true });
    removed.add(rel);
  }

  return Array.from(removed).sort();
}
