#!/usr/bin/env bun
// Refuse a commit that would carry private-only paths onto a branch bound for
// MGrin/scani-oss.
//
// WHY THIS EXISTS (SC-569). Checking out a public-mirror branch inside a
// private worktree does NOT leave the private source behind — measured, both
// sandboxed and unsandboxed: git deletes every tracked file the target tree
// does not have. A leftover ignored artefact stops the DIRECTORY being pruned;
// it does not stop the FILES being removed.
//
// What it does leave is worse, because it is invisible. Several per-app
// `.gitignore` files are themselves TRACKED PRIVATE files. The checkout
// deletes them, so every local build artefact whose only ignore rule lived
// there stops being ignored — and a `git add -A` a second later takes files
// that were untrackable a moment before. Measured on a real mirror checkout
// with ordinary local build output present, that is nine files, several of
// them carrying deployment identity and one of them a complete compiled build
// of a private application with source maps beside it.
//
// The specific paths are deliberately not listed here. This file is shared
// with the public mirror, and an inventory of what a private tree contains is
// the same category of disclosure the guard exists to prevent. They are in the
// private commit that added this file.
//
// WHY IT IS NOT KEYED ON A CLASSIFIER, though the private repo has one and it
// would be a single call. Two measurements, either of which is fatal:
//
//   1. `.githooks/pre-commit` EXISTS IN BOTH REPOS, and the two copies differ.
//      Checking out a mirror branch REPLACES the hook with the mirror's — so a
//      guard that lives only in the private copy is deleted by the very
//      checkout it exists to guard, at the exact moment it should fire. This
//      file therefore has to be shared, and a shared file cannot import a
//      module that exists in only one of the two repositories.
//   2. The classifier verdict that sounds like it describes the hazard does
//      not. Every one of the nine residue paths lands in the same bucket as
//      `package.json`, `README.md` and the CI workflow — files that exist in
//      both repos and are edited on mirror branches as a matter of course. A
//      guard keyed on that verdict would refuse nothing in the reproduced
//      scenario: a check that cannot fail.
//
// THE PREDICATE. On a branch bound for the mirror, a staged path that does not
// exist in `upstream/main` is refused. That is deliberately broader than the
// hazard, and the breadth costs little: `git cherry-pick` does not run
// pre-commit hooks, so the documented port flow never reaches this check. What
// reaches it is a hand-made `git add` on a mirror branch, which is precisely
// the shape SC-569 is about. A genuinely new shared file is the one legitimate
// case, and it has a named one-step escape rather than a silent allowance.
//
// Usage:
//   bun scripts/check-oss-bound-paths.ts          # staged paths, current HEAD
//   OSS_ALLOW_NEW_FILES=1 git commit ...          # the escape

import { spawnSync } from 'node:child_process';

/** Whether the branch being committed to is bound for the public mirror. */
export type Boundness =
  /** Not bound for scani-oss. Nothing to check. */
  | { readonly kind: 'private'; readonly why: string }
  /** Bound for scani-oss. Check the staged paths. */
  | { readonly kind: 'oss'; readonly why: string }
  /**
   * Could not tell. Gets its own name and its own exit code, and is never
   * resolved toward `private` — "probably a private branch" is the plausibility
   * heuristic that makes a guard decorative, and it is most persuasive exactly
   * when it is wrong.
   */
  | { readonly kind: 'unknown'; readonly why: string };

export interface BranchFacts {
  /** An `upstream` remote is configured at all. */
  readonly hasUpstreamRemote: boolean;
  /** `refs/remotes/upstream/main` resolves. */
  readonly upstreamMainResolved: boolean;
  /** `upstream/main` is an ancestor of HEAD (or HEAD is upstream/main). */
  readonly upstreamIsAncestor: boolean;
  /** `origin/main` is an ancestor of HEAD. */
  readonly originIsAncestor: boolean;
  /**
   * What HEAD's own TREE says about which repo it belongs to, or `null` when
   * that could not be computed (either main unresolvable, HEAD unreadable, or
   * the two mains carrying identical file lists). Null falls back to descent.
   */
  readonly treeMarkers: TreeMarkers | null;
}

/**
 * How many paths that exist in only ONE of the two repos are present in HEAD's
 * tree — counted in both directions, each with its denominator.
 *
 * Which paths those are is discovered at run time by diffing the two mains,
 * never listed here: this file is shared with the public mirror, and an
 * inventory of what a private tree contains is the disclosure the guard exists
 * to prevent (SC-566). Only the counts are ever printed.
 */
export interface TreeMarkers {
  /** Paths in `origin/main` and not `upstream/main`. */
  readonly privateOnlyTotal: number;
  readonly privateOnlyInHead: number;
  /** Paths in `upstream/main` and not `origin/main`. */
  readonly mirrorOnlyTotal: number;
  readonly mirrorOnlyInHead: number;
}

/**
 * WHICH REPO'S TREE IS THIS? — asked of the tree, not of the history (SC-629).
 *
 * The answer keys on the ONE asymmetry that cannot be argued with: a mirror
 * tree does not contain the private repo's files, and a private tree does not
 * contain the mirror's. Both sets are discovered by diffing the two mains at
 * run time, so nothing here goes stale as either repo moves.
 *
 * THE ORDER IS THE SAFETY PROPERTY, not a preference. `oss` makes the guard
 * RUN; `private` makes it SKIP. So mirror evidence is checked first and wins
 * outright: a tree carrying mirror-only paths is treated as mirror-bound even
 * if it also carries a private-only path, because the worst case is a refusal
 * somebody reads, while the worst case of the opposite order is a check that
 * silently did not happen. `private` is reached only on clean evidence — some
 * private-only paths and NO mirror-only ones. Anything else is `unknown`.
 *
 * That mixed case is real, not hypothetical: three OSS branches in this repo
 * carry exactly one private-only path, and refusing that path is precisely
 * what this guard is for.
 *
 * Measured 2026-08-26 over all 756 local branches: 693 classified `private`,
 * each carrying between 283 and 543 of the 543 private-only paths; 63
 * classified `oss`, each carrying 0 or 1; none `unknown`. Nothing sits in the
 * middle, so the verdict is not a knife-edge.
 */
export function classifyByTree(markers: TreeMarkers): Boundness | null {
  if (markers.mirrorOnlyInHead > 0) {
    return {
      kind: 'oss',
      why: `HEAD's tree carries ${markers.mirrorOnlyInHead}/${markers.mirrorOnlyTotal} mirror-only path(s)`,
    };
  }
  if (markers.privateOnlyInHead > 0) {
    return {
      kind: 'private',
      why: `HEAD's tree carries ${markers.privateOnlyInHead}/${markers.privateOnlyTotal} private-only path(s) and none of the ${markers.mirrorOnlyTotal} mirror-only path(s)`,
    };
  }
  return null;
}

/**
 * DESCENT IS THE FALLBACK, AND ONLY THE FALLBACK, since SC-629.
 *
 * It used to be the whole discriminator, resting on a premise this comment
 * stated and flagged: "the two mains diverge — neither is an ancestor of the
 * other". The back-sync that merges `upstream/main` into private `main` ends
 * that, every branch then descends from both, and descent says `unknown` for
 * everything. That sync is correct and recurs by design (SC-568), so the
 * premise is gone for good rather than temporarily.
 *
 * Descent had a SECOND failure that the outage hid, and it is the worse of the
 * two because it is silent. `upstream/main` advancing past a branch point —
 * which happens the moment any OSS PR merges — makes `upstreamIsAncestor`
 * false for a still-OSS-bound branch, and the verdict is then `private`, which
 * SKIPS the guard. Measured on `MGrin/sc-622-payment-horizon-roll` after its
 * own PR merged: descent said `private`, the tree said `oss` on 9/9 mirror
 * markers. An exit-9 outage is loud and got a ticket; that one would not have.
 */
export function classifyBranch(facts: BranchFacts): Boundness {
  if (!facts.hasUpstreamRemote) {
    // Determinate, not blind: with no upstream remote there is no scani-oss to
    // be bound for. This is the state of a self-hoster's clone, and of the
    // scani-oss checkout itself.
    return { kind: 'private', why: 'no `upstream` remote is configured' };
  }
  if (!facts.upstreamMainResolved) {
    return {
      kind: 'unknown',
      why: 'an `upstream` remote exists but `upstream/main` does not resolve — run `git fetch upstream`',
    };
  }
  if (facts.treeMarkers) {
    const byTree = classifyByTree(facts.treeMarkers);
    if (byTree) return byTree;
    // Markers existed to look for and HEAD has none of either kind. That is
    // not "probably private" — it is a tree that resembles neither repo, and
    // resolving it toward the convenient answer is the heuristic this guard
    // refuses on principle.
    return {
      kind: 'unknown',
      why: `HEAD's tree carries none of the ${facts.treeMarkers.privateOnlyTotal} private-only nor the ${facts.treeMarkers.mirrorOnlyTotal} mirror-only path(s), so it matches neither repo`,
    };
  }

  if (facts.upstreamIsAncestor && facts.originIsAncestor) {
    return {
      kind: 'unknown',
      why: 'HEAD descends from BOTH `origin/main` and `upstream/main`, and the two mains have no distinguishing paths to fall back on',
    };
  }
  if (facts.upstreamIsAncestor) {
    return { kind: 'oss', why: 'HEAD descends from `upstream/main` and not from `origin/main`' };
  }
  return { kind: 'private', why: 'HEAD does not descend from `upstream/main`' };
}

export interface Violation {
  readonly path: string;
  /** Why this path is refused, in the words a person needs to act on it. */
  readonly why: string;
}

export interface PathFacts {
  /** The path exists in `upstream/main`. */
  readonly existsUpstream: (path: string) => boolean;
  /** The path is tracked in `origin/main` — i.e. it is private source. */
  readonly trackedPrivately: (path: string) => boolean;
}

/**
 * A staged path is refused when it is absent from `upstream/main`.
 *
 * The two reasons are reported separately because they need different
 * responses, not because the rule differs. A path tracked privately is source
 * the checkout should have removed and the commit must not resurrect; a path
 * tracked nowhere is either build residue whose ignore rule the checkout
 * deleted, or a file you meant to add.
 */
export function refusedPaths(staged: readonly string[], facts: PathFacts): Violation[] {
  const out: Violation[] = [];
  for (const path of staged) {
    if (facts.existsUpstream(path)) continue;
    out.push({
      path,
      why: facts.trackedPrivately(path)
        ? 'tracked in origin/main and absent from upstream/main — private-only source'
        : 'absent from both repos — build residue, or a new file you meant to add',
    });
  }
  return out;
}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
/**
 * Blindness gets its own code so "could not tell" can never be read off a
 * transcript as "checked and clean".
 */
export const EXIT_UNKNOWN = 9;

function git(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

/**
 * NUL-separated, because `core.quotePath` renders a non-ASCII path as an
 * escaped, quoted string and the same path read two different ways would be
 * counted as absent from a tree that has it.
 */
function gitPaths(args: string[]): string[] | null {
  const r = git([...args, '-z']);
  if (!r.ok) return null;
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

/**
 * Discover the two one-sided path sets and how many of each HEAD's tree has.
 *
 * Returns null — meaning "fall back to descent" — when either main cannot be
 * read, when HEAD has no tree to read, or when the two mains have identical
 * file lists and so offer nothing to key on. Null is never a verdict; the
 * caller decides, and its options are descent or `unknown`.
 *
 * Three git calls, measured at ~150ms total against a 2674-path tree, against
 * a hook that already runs `bun run type-check`.
 */
export function collectTreeMarkers(): TreeMarkers | null {
  const privateOnly = gitPaths([
    'diff',
    '--name-only',
    '--diff-filter=A',
    'upstream/main',
    'origin/main',
  ]);
  const mirrorOnly = gitPaths([
    'diff',
    '--name-only',
    '--diff-filter=D',
    'upstream/main',
    'origin/main',
  ]);
  if (privateOnly === null || mirrorOnly === null) return null;
  if (privateOnly.length === 0 && mirrorOnly.length === 0) return null;

  const headPaths = gitPaths(['ls-tree', '-r', '--name-only', 'HEAD']);
  if (headPaths === null) return null;
  const inHead = new Set(headPaths);

  return {
    privateOnlyTotal: privateOnly.length,
    privateOnlyInHead: privateOnly.filter((p) => inHead.has(p)).length,
    mirrorOnlyTotal: mirrorOnly.length,
    mirrorOnlyInHead: mirrorOnly.filter((p) => inHead.has(p)).length,
  };
}

function collectBranchFacts(): BranchFacts {
  const hasUpstreamRemote = git(['remote']).stdout.split('\n').includes('upstream');
  const upstreamMainResolved = git([
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/remotes/upstream/main',
  ]).ok;
  return {
    hasUpstreamRemote,
    upstreamMainResolved,
    upstreamIsAncestor:
      upstreamMainResolved && git(['merge-base', '--is-ancestor', 'upstream/main', 'HEAD']).ok,
    originIsAncestor: git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).ok,
    treeMarkers: collectTreeMarkers(),
  };
}

function main(): number {
  const boundness = classifyBranch(collectBranchFacts());

  if (boundness.kind === 'unknown') {
    console.error(`oss-bound-paths: UNKNOWN · exit ${EXIT_UNKNOWN} · ${boundness.why}`);
    return EXIT_UNKNOWN;
  }
  if (boundness.kind === 'private') {
    console.log(`oss-bound-paths: SKIPPED · exit ${EXIT_OK} · ${boundness.why}`);
    return EXIT_OK;
  }

  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).stdout;
  const paths = staged ? staged.split('\n') : [];
  const violations = refusedPaths(paths, {
    existsUpstream: (p) => git(['cat-file', '-e', `upstream/main:${p}`]).ok,
    trackedPrivately: (p) => git(['cat-file', '-e', `origin/main:${p}`]).ok,
  });

  if (violations.length === 0) {
    console.log(
      `oss-bound-paths: PASS · exit ${EXIT_OK} · ${paths.length} staged path(s), 0 absent from upstream/main`
    );
    return EXIT_OK;
  }

  for (const v of violations) console.error(`  ${v.path}\n      ${v.why}`);
  console.error(
    `oss-bound-paths: REFUSED · exit ${EXIT_REFUSED} · ${violations.length} of ${paths.length} staged path(s) are not in upstream/main`
  );
  console.error(
    '  This branch is bound for MGrin/scani-oss. If these are genuinely new shared\n' +
      '  files, re-run with OSS_ALLOW_NEW_FILES=1. If they are build residue left by\n' +
      '  the checkout, `git restore --staged` them — see SC-569.'
  );
  return EXIT_REFUSED;
}

if (import.meta.main) {
  if (process.env.OSS_ALLOW_NEW_FILES === '1') {
    console.log(`oss-bound-paths: SKIPPED · exit ${EXIT_OK} · OSS_ALLOW_NEW_FILES=1 was set`);
    process.exit(EXIT_OK);
  }
  process.exit(main());
}
