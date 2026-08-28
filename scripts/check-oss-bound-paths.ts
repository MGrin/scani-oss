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
  /**
   * What the facts are ABOUT, for the sentence only — never for a decision.
   * Defaults to `HEAD`, which is what a hook asks about. A caller that asks
   * about some other ref must pass it, or the verdict names the wrong thing
   * while being right about it (SC-712).
   */
  readonly subject?: string;
  /**
   * An `upstream` remote is configured at all, or `null` when that could not
   * be READ — `git remote` failed rather than returning an empty list. Those
   * are different facts and `boolean` cannot hold both: an empty stdout from a
   * dead subprocess is byte-identical to a repository with no remotes (SC-743).
   */
  readonly hasUpstreamRemote: boolean | null;
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
 * How many paths that exist in only ONE of the two repos are present in the
 * SUBJECT's tree — counted in both directions, each with its denominator.
 *
 * The `InHead` field names predate `collectTreeMarkers` taking a ref (SC-712)
 * and are kept rather than renamed across 37 sites in a guard this load-bearing.
 * Read them as "in the subject", which is `HEAD` unless a caller named another.
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
 * IT IS A SHARE, NOT A PRESENCE (SC-659). Each side scores as the fraction of
 * its own marker set that HEAD carries, and the larger share wins.
 *
 * THE NUMBERS FOR THAT WERE ALREADY IN THIS COMMENT. The paragraph below has
 * read `693 classified private, each carrying between 283 and 543 of the 543
 * private-only paths; 63 classified oss, each carrying 0 or 1` since SC-629 —
 * a clean bimodal separation, 0.52-1.00 against 0.00-0.02, empty in the
 * middle — and the predicate underneath it tested `> 0`, which discards the
 * separation and keeps only the sign. Somebody looked, wrote the measurement
 * down, and then wrote a check that could not use it; every reader since has
 * read the evidence and the bug together without the first reading as a fix
 * for the second. Recorded in these words on purpose: the next person to
 * arrive must not assume the gap was unknown and go measure it again.
 *
 * WHAT PRESENCE COSTS. An UPSTREAM-FIRST change is one file landed on
 * `upstream/main` first and the private half committed after. Between those
 * two moments the shared file is mirror-only BY CONSTRUCTION — in
 * `upstream/main`, not yet in `origin/main` — so the private branch carrying
 * it has exactly one mirror-only path. Presence read that as `oss`, ran the
 * guard, and refused every private-only source file on a branch that was
 * 541/546 private. Measured on `main` 2026-08-26: 1 of 10 mirror-only against
 * 541 of 546 private-only. Not a close call at any denominator.
 *
 * THE ORDER IS STILL THE SAFETY PROPERTY, and it is kept exactly. `oss` makes
 * the guard RUN; `private` makes it SKIP. Mirror evidence is still tested
 * first and still wins a TIE — hence `>=` — because the worst case of a wrong
 * `oss` is a refusal somebody reads, while the worst case of a wrong `private`
 * is a check that silently did not happen. Only the QUESTION changed: "does
 * HEAD carry any?" became "does HEAD carry more of one set than the other?".
 * Reversing the order was considered for SC-659 and rejected on this ground.
 *
 * The mixed case is real, not hypothetical, and MUST still refuse: three OSS
 * branches in this repo carry exactly one private-only path, and refusing that
 * path is precisely what this guard is for. They score 9/9 mirror against
 * 1/543 private, so they are nowhere near the boundary either.
 *
 * TWO EDGES, both stated rather than left to the arithmetic.
 *
 * `mirrorOnlyTotal === 0` is DEFENSIVE rather than reachable here, and the
 * claim is about WHAT `collectTreeMarkers` COUNTS, not about what the tree
 * contains. The distinction is not pedantry — it is the correction SC-662 was
 * filed for. Nine paths exist only on the mirror by design: the release
 * automation (`release-please.yml`, `release-please-config.json`,
 * `.release-please-manifest.json`, `CHANGELOG.md`), CodeQL, `docker-publish`,
 * `deploy-docs` and `sync-dockerhub-readmes`. Since SC-662 the counting sees
 * all nine, so they are a floor and an upstream-first file is 1 of 10, not
 * 1 of 1.
 *
 * Before SC-662 that same sentence was true of the CONTENTS and false of the
 * COUNT: `collectTreeMarkers` used `git diff`, and rename detection could pair
 * any one of those nine with a private-only path and drop both, so the floor
 * was not a floor. Right conclusion, wrong warrant — which survives until the
 * warrant is load-bearing for a different question, and then fails without
 * warning. Stated at length because a corrected number over an uncorrected
 * warrant is how the next reader inherits the same mistake.
 *
 * A fork or a differently-arranged mirror has no such floor, so the branch is
 * kept — but it guards an arrangement this repo does not have rather than a
 * state measured here. There is then NO mirror evidence to weigh, which is a
 * different thing from mirror evidence that came back empty, and a `why`
 * reading `0/0 mirror-only` would invite the reader to conclude the tree lacks
 * paths that do not exist to lack. It gets its own branch and says so. The
 * verdict is unchanged — a tree carrying private-only paths is `private`, one
 * carrying neither is still `unknown` — because a mirror checkout in that
 * state carries 0 of the private-only set and so cannot reach the `private`
 * branch at all.
 *
 * A very small non-zero `mirrorOnlyTotal` — one or two — would make a single
 * upstream-first file most of the mirror's set, and its share could then
 * outrank a 541/546 private one. The counted floor of 9 puts this repo far
 * from that, and where it does arise the verdict is `oss`: a refusal somebody
 * reads, which is the direction this function errs in on purpose. Loud, not
 * silent.
 *
 * Measured 2026-08-26 over all 756 local branches: 693 classified `private`,
 * each carrying between 283 and 543 of the 543 private-only paths; 63
 * classified `oss`, each carrying 0 or 1; none `unknown`. Nothing sits in the
 * middle, so the verdict is not a knife-edge.
 */
function share(inHead: number, total: number): number {
  return total === 0 ? 0 : inHead / total;
}

export function classifyByTree(markers: TreeMarkers, subject = 'HEAD'): Boundness | null {
  const counts =
    `${markers.mirrorOnlyInHead}/${markers.mirrorOnlyTotal} mirror-only ` +
    `and ${markers.privateOnlyInHead}/${markers.privateOnlyTotal} private-only path(s)`;

  if (markers.mirrorOnlyTotal === 0) {
    if (markers.privateOnlyInHead === 0) return null;
    return {
      kind: 'private',
      why:
        `${subject}'s tree carries ${markers.privateOnlyInHead}/${markers.privateOnlyTotal} ` +
        `private-only path(s), and there are no mirror-only paths in existence to weigh ` +
        `against them`,
    };
  }

  if (
    markers.mirrorOnlyInHead > 0 &&
    share(markers.mirrorOnlyInHead, markers.mirrorOnlyTotal) >=
      share(markers.privateOnlyInHead, markers.privateOnlyTotal)
  ) {
    return {
      kind: 'oss',
      why: `${subject}'s tree carries ${counts} — the mirror's share is not the smaller of the two`,
    };
  }
  if (markers.privateOnlyInHead > 0) {
    return {
      kind: 'private',
      why: `${subject}'s tree carries ${counts} — the private repo's share is the larger`,
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
  const subject = facts.subject ?? 'HEAD';
  if (facts.hasUpstreamRemote === null) {
    // SC-743. This branch exists because the one below it claims to be
    // DETERMINATE, and it also absorbed every blind read: the probe took
    // `git remote`'s stdout without checking its exit status, so a subprocess
    // that died produced `''` and the guard SKIPPED a branch bound for the
    // mirror. Measured on a checkout that HAS the remote, by failing only
    // `git remote`: byte-identical to the real incident.
    return {
      kind: 'unknown',
      why: "could not read this repository's remotes — `git remote` failed, so whether an `upstream` exists is unknown rather than absent",
    };
  }
  if (!facts.hasUpstreamRemote) {
    // Determinate, not blind: with no upstream remote there is no scani-oss to
    // be bound for. This is the state of a self-hoster's clone, and of the
    // scani-oss checkout itself. The claim holds only because the blind case
    // is taken above it.
    return { kind: 'private', why: 'no `upstream` remote is configured' };
  }
  if (!facts.upstreamMainResolved) {
    return {
      kind: 'unknown',
      why: 'an `upstream` remote exists but `upstream/main` does not resolve — run `git fetch upstream`',
    };
  }
  if (facts.treeMarkers) {
    const byTree = classifyByTree(facts.treeMarkers, subject);
    if (byTree) return byTree;
    // Markers existed to look for and HEAD has none of either kind. That is
    // not "probably private" — it is a tree that resembles neither repo, and
    // resolving it toward the convenient answer is the heuristic this guard
    // refuses on principle.
    return {
      kind: 'unknown',
      why: `${subject}'s tree carries none of the ${facts.treeMarkers.privateOnlyTotal} private-only nor the ${facts.treeMarkers.mirrorOnlyTotal} mirror-only path(s), so it matches neither repo`,
    };
  }

  if (facts.upstreamIsAncestor && facts.originIsAncestor) {
    return {
      kind: 'unknown',
      why: `${subject} descends from BOTH \`origin/main\` and \`upstream/main\`, and the two mains have no distinguishing paths to fall back on`,
    };
  }
  if (facts.upstreamIsAncestor) {
    return {
      kind: 'oss',
      why: `${subject} descends from \`upstream/main\` and not from \`origin/main\``,
    };
  }
  return { kind: 'private', why: `${subject} does not descend from \`upstream/main\`` };
}

/**
 * Which of the two hazards a refused path is.
 *
 * This is a FIELD rather than a substring of `why`, and that is the whole
 * repair (SC-639). `OSS_ALLOW_NEW_FILES` now makes a security decision on this
 * value, and a decision keyed on prose changes what the guard admits the next
 * time somebody rewords a sentence — silently, with no test failing, because
 * the sentence would still read correctly to a human.
 */
export type ViolationKind =
  /**
   * Tracked in `origin/main` and absent upstream: private source the checkout
   * should have removed. This is the SC-569 hazard the guard exists for, and
   * no flag admits it.
   */
  | 'private-only'
  /**
   * Absent from both repos: build residue whose ignore rule the checkout
   * deleted, or a genuinely new shared file. The one legitimate case, and the
   * only thing `OSS_ALLOW_NEW_FILES=1` admits.
   */
  | 'new-file';

export interface Violation {
  readonly path: string;
  readonly kind: ViolationKind;
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
    const privateOnly = facts.trackedPrivately(path);
    out.push({
      path,
      kind: privateOnly ? 'private-only' : 'new-file',
      why: privateOnly
        ? 'tracked in origin/main and absent from upstream/main — private-only source'
        : 'absent from both repos — build residue, or a new file you meant to add',
    });
  }
  return out;
}

/** What the new-files allowance did to a set of violations. */
export interface Allowance {
  /** Violations that still refuse the commit. */
  readonly refused: readonly Violation[];
  /**
   * Violations the flag admitted. Non-empty ONLY when the flag actually let
   * something through, which is what lets the caller tell a deliberate bypass
   * apart from a flag that was set and changed nothing.
   */
  readonly admitted: readonly Violation[];
}

/**
 * Apply `OSS_ALLOW_NEW_FILES` to a set of violations.
 *
 * SC-639. The flag used to be read before `main()` ran at all, so neither
 * `classifyBranch` nor `refusedPaths` executed and it silenced BOTH violation
 * kinds — including private-only source, the hazard the guard exists for. It
 * was named for the benign kind and disabled the dangerous one in the same
 * keystroke, printing `SKIPPED · exit 0`.
 *
 * That mattered more than a misnaming, because the refusal message is the only
 * place the flag is advertised anywhere: the guard named a total bypass, called
 * it a narrow escape, and did so at the moment somebody was blocked by a
 * correct refusal. Two careful people set it in one session on the honest
 * belief it was scoped.
 *
 * It is scoped now, so the sentence the refusal prints is true as written.
 * `private-only` is never admissible — there is no flag for it and adding one
 * would rebuild the defect under a longer name.
 */
export function applyNewFileAllowance(
  violations: readonly Violation[],
  allowNewFiles: boolean
): Allowance {
  if (!allowNewFiles) return { refused: violations, admitted: [] };
  return {
    refused: violations.filter((v) => v.kind === 'private-only'),
    admitted: violations.filter((v) => v.kind === 'new-file'),
  };
}

/**
 * The verdict word each outcome prints.
 *
 * Exported and pinned because three of the five share `exit 0`, so the WORD is
 * the only thing distinguishing them (SC-639). `SKIPPED` used to be printed
 * both for a deliberate bypass and for a branch the guard does not apply to,
 * with only trailing prose telling them apart — and nothing reads trailing
 * prose. A bypass must not be able to wear a legitimate skip's costume.
 */
export const VERDICT = {
  /** Checked, and everything staged can travel. */
  pass: 'PASS',
  /** Checked, and the new-files allowance admitted something. A bypass, on the record. */
  allowed: 'ALLOWED',
  /** Not applicable: this branch is not bound for the mirror. */
  skipped: 'SKIPPED',
  /** Checked, and something staged cannot travel. */
  refused: 'REFUSED',
  /** Could not tell which repo the branch is for. */
  unknown: 'UNKNOWN',
} as const;

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
 * SET DIFFERENCE OVER TWO TREES, NOT A DIFF (SC-662). "Which paths exist on
 * one side only" is a question about membership, and `git diff` answers a
 * richer question that does not reduce to it: with rename detection on — which
 * is the DEFAULT — git pairs a path that exists only upstream with one that
 * exists only privately and emits a single `R` entry, and `--diff-filter=A`
 * and `--diff-filter=D` both skip it. BOTH markers then disappear at once, in
 * silence.
 *
 * Measured 2026-08-26 on a live pair at 65% similarity —
 * `packages/infra/db/tests/fixtures/scripts/read-only-probe.ts` upstream
 * against `.../fixtures/repair-read-only-probe.ts` privately:
 *
 *     mirror-only    9 by diff    10 by set difference
 *     private-only 543 by diff   544 by set difference
 *
 * The bug surfaced as two tools disagreeing about one file: `oss-drift --scan`
 * called it `absent-privately` while this function did not count it at all.
 * `oss-drift` builds `git ls-tree` blob maps, so it was never exposed to
 * rename detection — and this now asks the question the same way it does,
 * which makes the two agree BY CONSTRUCTION rather than by both happening to
 * be configured alike. `--no-renames` would have fixed the count and left the
 * agreement resting on a flag; `diff.renames` is user-configurable and
 * `copies` would have made it worse.
 *
 * `--full-tree`, because `git ls-tree` is CWD-RELATIVE and `git diff` is not.
 * Run from `scripts/`, the old `ls-tree -r --name-only HEAD` returned 177
 * paths against 2680 — so every private-only path would have read as absent
 * from HEAD. Git runs hooks from the top level, which is why this never fired;
 * a hand-run from a subdirectory is all it needed.
 *
 * Three git calls, measured at ~150ms total against a 2680-path tree, against
 * a hook that already runs `bun run type-check`.
 */
function treePaths(ref: string): string[] | null {
  return gitPaths(['ls-tree', '-r', '--full-tree', '--name-only', ref]);
}

export function collectTreeMarkers(ref = 'HEAD'): TreeMarkers | null {
  const upstreamPaths = treePaths('upstream/main');
  const originPaths = treePaths('origin/main');
  if (upstreamPaths === null || originPaths === null) return null;

  const inUpstream = new Set(upstreamPaths);
  const inOrigin = new Set(originPaths);
  const privateOnly = originPaths.filter((p) => !inUpstream.has(p));
  const mirrorOnly = upstreamPaths.filter((p) => !inOrigin.has(p));
  if (privateOnly.length === 0 && mirrorOnly.length === 0) return null;

  const headPaths = treePaths(ref);
  if (headPaths === null) return null;
  const inHead = new Set(headPaths);

  return {
    privateOnlyTotal: privateOnly.length,
    privateOnlyInHead: privateOnly.filter((p) => inHead.has(p)).length,
    mirrorOnlyTotal: mirrorOnly.length,
    mirrorOnlyInHead: mirrorOnly.filter((p) => inHead.has(p)).length,
  };
}

/**
 * The facts about a ref, defaulting to the one a hook cares about.
 *
 * EXPORTED FOR A CALLER THAT ASKS ABOUT SOMETHING OTHER THAN `HEAD` (SC-712).
 * `check-oss-derivation.ts` is handed a CANDIDATE — a fetched pull-request head
 * that is deliberately never checked out — and must know which repo THAT
 * belongs to. Asking about `HEAD` there answers about the private working
 * branch the tool happens to be standing in, which is not the question and is
 * `private` every time.
 */
export function collectBranchFacts(ref = 'HEAD'): BranchFacts {
  const remotes = git(['remote']);
  const hasUpstreamRemote = remotes.ok ? remotes.stdout.split('\n').includes('upstream') : null;
  const upstreamMainResolved = git([
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/remotes/upstream/main',
  ]).ok;
  return {
    subject: ref,
    hasUpstreamRemote,
    upstreamMainResolved,
    upstreamIsAncestor:
      upstreamMainResolved && git(['merge-base', '--is-ancestor', 'upstream/main', ref]).ok,
    originIsAncestor: git(['merge-base', '--is-ancestor', 'origin/main', ref]).ok,
    treeMarkers: collectTreeMarkers(ref),
  };
}

/**
 * Where `main` gets the paths it judges, and which rev it classifies (SC-813).
 *
 * `staged` is the pre-commit caller and the default, and its behaviour is
 * unchanged to the byte. `given` is the pre-push caller: a cherry-pick and a
 * rebase both fire NO hook — measured, 0 firings over a landed cherry-pick and
 * over 2 replayed commits, against a control of 4 ordinary commits firing 4
 * times — so the one operation that actually carries code across the boundary
 * is the one pre-commit never sees. The paths there are the ones in the
 * commits about to leave the machine, which is a different set from anything
 * in the index.
 *
 * `ref` exists because the pushed branch need not be the checked-out one.
 * `git push upstream branchB` while standing on private branchA would classify
 * branchA, read `private`, and SKIP — a silent pass on a mirror-bound push,
 * which is this check's own subject reproduced inside its caller.
 */
export interface PathSource {
  kind: 'staged' | 'given';
  /** Only for `given`. Already filtered to A/M/R/C by the caller. */
  paths?: readonly string[];
  /** Rev to classify. Defaults to HEAD, which is what pre-commit wants. */
  ref?: string;
}

function main(allowNewFiles: boolean, source: PathSource = { kind: 'staged' }): number {
  const boundness = classifyBranch(collectBranchFacts(source.ref ?? 'HEAD'));

  if (boundness.kind === 'unknown') {
    console.error(`oss-bound-paths: ${VERDICT.unknown} · exit ${EXIT_UNKNOWN} · ${boundness.why}`);
    return EXIT_UNKNOWN;
  }
  if (boundness.kind === 'private') {
    console.log(`oss-bound-paths: ${VERDICT.skipped} · exit ${EXIT_OK} · ${boundness.why}`);
    return EXIT_OK;
  }

  // SC-743, and the worse of the two: this call had the same defect as the
  // remotes probe and fails in the opposite direction. A dead `git diff
  // --cached` yields `''`, which reads as NOTHING IS STAGED — a clean exit 0
  // over a branch whose staged paths were never examined. The remotes one at
  // least printed a wrong verdict you could see.
  // The noun travels with the source so every verdict line below says which
  // set it judged. "3 staged path(s)" printed over a pushed range would be the
  // same defect this check exists to prevent, one level up.
  const noun = source.kind === 'given' ? 'pushed' : 'staged';

  let paths: string[];
  if (source.kind === 'given') {
    paths = [...(source.paths ?? [])];
  } else {
    const stagedResult = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    if (!stagedResult.ok) {
      console.error(
        `oss-bound-paths: ${VERDICT.unknown} · exit ${EXIT_UNKNOWN} · could not list the staged paths — \`git diff --cached\` failed, so NOTHING WAS CHECKED. This is not a pass.`
      );
      return EXIT_UNKNOWN;
    }
    paths = stagedResult.stdout ? stagedResult.stdout.split('\n') : [];
  }
  const violations = refusedPaths(paths, {
    existsUpstream: (p) => git(['cat-file', '-e', `upstream/main:${p}`]).ok,
    trackedPrivately: (p) => git(['cat-file', '-e', `origin/main:${p}`]).ok,
  });

  const { refused, admitted } = applyNewFileAllowance(violations, allowNewFiles);

  if (refused.length > 0) {
    for (const v of refused) console.error(`  ${v.path}\n      ${v.why}`);
    console.error(
      `oss-bound-paths: ${VERDICT.refused} · exit ${EXIT_REFUSED} · ${refused.length} of ${paths.length} ${noun} path(s) are not in upstream/main`
    );
    // The remedy depends on WHICH kind refused, and naming the flag in front
    // of private-only source is what recruited two people into bypassing this
    // guard (SC-639). When the flag cannot help, the message must say so
    // rather than leave the reader to discover it by trying.
    if (refused.some((v) => v.kind === 'private-only')) {
      console.error(
        '  The paths above are private source, and OSS_ALLOW_NEW_FILES=1 does NOT\n' +
          '  admit them — it is scoped to files absent from both repos. `git restore\n' +
          '  --staged` them; if one genuinely belongs upstream, land it there first.\n' +
          '  See SC-569.'
      );
    } else {
      console.error(
        '  This branch is bound for MGrin/scani-oss. If these are genuinely new\n' +
          '  shared files, re-run with OSS_ALLOW_NEW_FILES=1 — it admits only files\n' +
          '  absent from both repos, never private source. If they are build residue\n' +
          '  left by the checkout, `git restore --staged` them — see SC-569.'
      );
    }
    return EXIT_REFUSED;
  }

  // A bypass gets its own verdict WORD, not a shared one with a trailing
  // explanation (SC-639). `SKIPPED · exit 0` was printed both for a deliberate
  // bypass and for a branch the guard does not apply to, and only the trailing
  // text told them apart — which nothing reads. Each admitted path is listed,
  // so what the flag let through is on the record rather than merely counted.
  if (admitted.length > 0) {
    for (const v of admitted) console.log(`  admitted: ${v.path}`);
    console.log(
      `oss-bound-paths: ${VERDICT.allowed} · exit ${EXIT_OK} · OSS_ALLOW_NEW_FILES=1 admitted ${admitted.length} new shared file(s) of ${paths.length} ${noun}; 0 private-only`
    );
    return EXIT_OK;
  }

  // Reached with the flag set but nothing to admit, too. That case says so
  // rather than reporting a skip: setting the flag on a branch with no new
  // files used to turn a real PASS into `SKIPPED · exit 0`, which bought
  // nothing and looked like the check had not run.
  console.log(
    `oss-bound-paths: ${VERDICT.pass} · exit ${EXIT_OK} · ${paths.length} ${noun} path(s), 0 absent from upstream/main` +
      (allowNewFiles ? ' · OSS_ALLOW_NEW_FILES=1 was set and admitted nothing' : '')
  );
  return EXIT_OK;
}

if (import.meta.main) {
  // Two OPTIONAL flags, added for the pre-push caller (SC-813). With neither,
  // every line above runs exactly as it did for pre-commit — the default is
  // not a special case here, it is the absence of both.
  //
  //   --stdin-paths   judge newline-separated paths on stdin, not the index
  //   --ref <rev>     classify <rev> rather than HEAD
  const argv = process.argv.slice(2);
  const refAt = argv.indexOf('--ref');
  const ref = refAt === -1 ? undefined : argv[refAt + 1];
  if (refAt !== -1 && !ref) {
    console.error(
      `oss-bound-paths: ${VERDICT.unknown} · exit ${EXIT_UNKNOWN} · --ref was given with no rev, so NOTHING WAS CHECKED. This is not a pass.`
    );
    process.exit(EXIT_UNKNOWN);
  }

  let source: PathSource = { kind: 'staged', ref };
  if (argv.includes('--stdin-paths')) {
    // Read to EOF. An empty stdin is a real answer — "this push introduces no
    // A/M/R/C paths" — and is NOT conflated with a failed read: the caller
    // could not have got here without a successful `git rev-list`.
    const raw = await Bun.stdin.text();
    source = {
      kind: 'given',
      ref,
      paths: raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  }

  // Read here and passed in, never consulted deeper: the flag has to reach
  // `main()` for `classifyBranch` and `refusedPaths` to run at all. Reading it
  // in this block and returning early is the SC-639 defect itself.
  process.exit(main(process.env.OSS_ALLOW_NEW_FILES === '1', source));
}
