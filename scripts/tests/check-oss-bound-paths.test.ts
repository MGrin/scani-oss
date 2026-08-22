import { describe, expect, test } from 'bun:test';
import {
  type BranchFacts,
  classifyBranch,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNKNOWN,
  refusedPaths,
} from '../check-oss-bound-paths';

/**
 * SC-569. Checking out a public-mirror branch inside a private worktree
 * deletes the per-app `.gitignore` files, because they are themselves tracked
 * private files — so every local build artefact whose only ignore rule lived
 * there stops being ignored, and a `git add -A` a second later takes files
 * that were untrackable a moment before.
 *
 * The fixtures below have the SHAPE of that residue — a Terraform state file,
 * a deployment-identity file, a framework build artefact, each under a
 * directory the mirror does not have — but they are synthetic, and that is
 * deliberate for the same reason SC-566 was: this file is shared with the
 * public mirror, and an inventory of what a private tree actually contains is
 * the disclosure the guard exists to prevent. The real nine, measured on a
 * real mirror checkout, are recorded in the private commit that added this
 * file and on SC-569.
 *
 * Nothing is lost by the substitution, because the predicate is
 * path-agnostic: it refuses on ABSENCE FROM `upstream/main`, never on a path
 * pattern. What these prove is that absence is what it keys on, and — the
 * half that matters more — that presence is not.
 */
const RESIDUE_SHAPES = [
  'private-app/.framework-cache/trace',
  'private-app/.deploy/project.json',
  'private-app/.deploy/output/config.json',
  'private-app/public/version.json',
  'private-tree/state.tfstate',
  'private-tree/state.tfstate.backup',
  'private-tree/plan.out',
] as const;

/** Files that exist in BOTH repos and are legitimately edited on an OSS branch. */
const SHARED = [
  'package.json',
  'README.md',
  'docker-compose.yml',
  '.github/workflows/ci.yml',
  'scripts/lib/worktree.ts',
] as const;

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    hasUpstreamRemote: true,
    upstreamMainResolved: true,
    upstreamIsAncestor: false,
    originIsAncestor: true,
    ...over,
  };
}

describe('classifyBranch decides whether a commit is bound for the mirror', () => {
  test('a branch cut from upstream/main is oss-bound', () => {
    expect(classifyBranch(facts({ upstreamIsAncestor: true, originIsAncestor: false })).kind).toBe(
      'oss'
    );
  });

  /**
   * THE TEST THAT PROVES THE GUARD DOES NOT ALWAYS FIRE, and the one worth
   * keeping longest. A state that only ever fires is indistinguishable from a
   * broken one, and almost every commit in this repository takes this path
   * while carrying private-only paths perfectly legitimately.
   */
  test('an ordinary private branch is NOT oss-bound', () => {
    expect(classifyBranch(facts()).kind).toBe('private');
  });

  test('a checkout with no upstream remote is private, determinately', () => {
    // The scani-oss checkout itself, and any self-hoster's clone. There is no
    // mirror to be bound for, so this is an answer rather than a blindness.
    const b = classifyBranch(facts({ hasUpstreamRemote: false }));
    expect(b.kind).toBe('private');
    expect(b.why).toContain('upstream');
  });

  /**
   * THE CASE A FUTURE READER WILL WANT TO SOFTEN, and the reason is here so
   * they have to argue with the reason rather than with the assertion.
   *
   * "`upstream/main` is not fetched, so this is almost certainly an ordinary
   * private branch" is true nearly every time, and it is the plausibility
   * heuristic this guard exists to refuse. Resolving a blindness toward the
   * convenient answer turns the check into decoration exactly in the state
   * where it cannot see — and the refusal costs one command, which the message
   * names.
   */
  test('an unfetched upstream/main is UNKNOWN, never private', () => {
    const b = classifyBranch(facts({ upstreamMainResolved: false }));
    expect(b.kind).toBe('unknown');
    expect(b.why).toContain('git fetch upstream');
  });

  /**
   * The discriminator is descent, and it works only because the two mains have
   * diverged — neither is an ancestor of the other. If the mirror were ever
   * fast-forwarded onto private main, every branch would descend from both and
   * descent would stop meaning anything. That is a blindness, not a pass.
   */
  test('a branch descended from BOTH is unknown, not private', () => {
    const b = classifyBranch(facts({ upstreamIsAncestor: true, originIsAncestor: true }));
    expect(b.kind).toBe('unknown');
    expect(b.why).toContain('BOTH');
  });
});

describe('refusedPaths names every path that cannot travel', () => {
  const nowhere = { existsUpstream: () => false, trackedPrivately: () => false };
  const everywhere = { existsUpstream: () => true, trackedPrivately: () => true };

  test('every residue-shaped path is refused', () => {
    const refused = refusedPaths(RESIDUE_SHAPES, nowhere);
    expect(refused.map((v) => v.path).sort()).toEqual([...RESIDUE_SHAPES].sort());
  });

  test('a shared file is never refused, whatever else is staged', () => {
    // The false-positive that would get this guard bypassed. `package.json`
    // and `ci.yml` differ deliberately between the repos and are edited on OSS
    // branches as a matter of course.
    expect(refusedPaths(SHARED, everywhere)).toEqual([]);
  });

  test('private source and untracked residue are refused for DIFFERENT stated reasons', () => {
    // Same rule, different remedy: one is `git restore --staged`, the other is
    // "did you mean to add this?". A single message would send half the
    // readers the wrong way.
    const [source] = refusedPaths(['private-app/src/middleware.ts'], {
      existsUpstream: () => false,
      trackedPrivately: () => true,
    });
    const [residue] = refusedPaths(['private-tree/state.tfstate'], nowhere);
    expect(source?.why).toContain('private-only source');
    expect(residue?.why).toContain('residue');
    expect(source?.why).not.toBe(residue?.why);
  });

  test('nothing staged refuses nothing', () => {
    expect(refusedPaths([], nowhere)).toEqual([]);
  });

  test('a mixed commit refuses only the paths that cannot travel', () => {
    const mixed = [...SHARED, ...RESIDUE_SHAPES];
    const upstreamHas = new Set<string>(SHARED);
    const refused = refusedPaths(mixed, {
      existsUpstream: (p) => upstreamHas.has(p),
      trackedPrivately: () => false,
    });
    expect(refused).toHaveLength(RESIDUE_SHAPES.length);
    for (const v of refused) expect(SHARED).not.toContain(v.path as (typeof SHARED)[number]);
  });
});

describe('the three outcomes have three distinct exit codes', () => {
  test('a blindness can never be read as a pass', () => {
    // The whole point of EXIT_UNKNOWN having its own number: `exit 0` on a
    // transcript must mean "checked and clean", never "could not tell".
    expect(new Set([EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN]).size).toBe(3);
    expect(EXIT_UNKNOWN).not.toBe(EXIT_OK);
  });
});
