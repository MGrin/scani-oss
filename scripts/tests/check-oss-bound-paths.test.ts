import { describe, expect, test } from 'bun:test';
import {
  applyNewFileAllowance,
  type BranchFacts,
  classifyBranch,
  classifyByTree,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNKNOWN,
  refusedPaths,
  type TreeMarkers,
  VERDICT,
  type Violation,
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
    // Null on purpose: every test below this line is about the DESCENT
    // fallback, and null is what selects it. The tree discriminator has its
    // own describe block, with `markers()`.
    treeMarkers: null,
    ...over,
  };
}

/** A private tree: carries private-only paths, none of the mirror's. */
function markers(over: Partial<TreeMarkers> = {}): TreeMarkers {
  return {
    privateOnlyTotal: 543,
    privateOnlyInHead: 543,
    mirrorOnlyTotal: 9,
    mirrorOnlyInHead: 0,
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
   * Descent stopped meaning anything the moment the back-sync merged
   * `upstream/main` into private `main`: every branch then descends from both
   * (SC-629, SC-568). With no tree markers to fall back ON, that is still a
   * blindness rather than a pass — this is the state the outage was, and what
   * it looks like once the tree can no longer help either.
   */
  test('a branch descended from BOTH, with no tree markers, is unknown', () => {
    const b = classifyBranch(facts({ upstreamIsAncestor: true, originIsAncestor: true }));
    expect(b.kind).toBe('unknown');
    expect(b.why).toContain('BOTH');
  });
});

describe('the tree discriminator outranks descent (SC-629)', () => {
  /**
   * THE OUTAGE. Every private branch descends from both mains since the
   * back-sync, so descent alone said `unknown` and the hook refused every
   * commit in the repository — which taught people `--no-verify`, which
   * disables every pre-commit check rather than just the two that were blind.
   */
  test('a private branch descended from BOTH is private on tree evidence', () => {
    const b = classifyBranch(
      facts({ upstreamIsAncestor: true, originIsAncestor: true, treeMarkers: markers() })
    );
    expect(b.kind).toBe('private');
  });

  test('an oss branch descended from BOTH is oss on tree evidence', () => {
    const b = classifyBranch(
      facts({
        upstreamIsAncestor: true,
        originIsAncestor: true,
        treeMarkers: markers({ privateOnlyInHead: 0, mirrorOnlyInHead: 9 }),
      })
    );
    expect(b.kind).toBe('oss');
  });

  /**
   * THE SILENT FAILURE DESCENT ALSO HAD, and the reason the tree outranks it
   * rather than merely covering for it. `upstream/main` advances the moment
   * any OSS PR merges, so a still-OSS-bound branch stops descending from it —
   * and descent's answer for that is `private`, which SKIPS the guard
   * entirely. Measured on a real branch after its own PR merged.
   *
   * An exit-9 outage is loud and got a ticket within the day. This one would
   * have gone on being green.
   */
  test('an oss branch whose upstream/main has moved past it is NOT called private', () => {
    const stale = facts({
      upstreamIsAncestor: false,
      originIsAncestor: false,
      treeMarkers: markers({ privateOnlyInHead: 0, mirrorOnlyInHead: 9 }),
    });
    expect(classifyBranch({ ...stale, treeMarkers: null }).kind).toBe('private'); // descent alone
    expect(classifyBranch(stale).kind).toBe('oss'); // with the tree
  });

  /**
   * THE ORDERING, and it is a safety property rather than a preference.
   * `oss` makes the guard RUN and `private` makes it SKIP, so a tree carrying
   * BOTH kinds of marker resolves toward the verdict whose failure is visible.
   * Three real OSS branches in this repo carry exactly one private-only path,
   * and refusing that path is the whole job.
   */
  test('a tree carrying both kinds of marker is oss, never private', () => {
    const b = classifyByTree({
      privateOnlyTotal: 543,
      privateOnlyInHead: 1,
      mirrorOnlyTotal: 9,
      mirrorOnlyInHead: 9,
    });
    expect(b?.kind).toBe('oss');
  });

  /**
   * The case a future reader will want to soften, for the same reason as the
   * unfetched one above: "it has no mirror markers, so it is probably private"
   * is the plausibility heuristic, and `private` is the verdict that skips.
   */
  test('a tree carrying NEITHER kind of marker is unknown, never private', () => {
    expect(classifyByTree(markers({ privateOnlyInHead: 0, mirrorOnlyInHead: 0 }))).toBeNull();
    const b = classifyBranch(
      facts({ treeMarkers: markers({ privateOnlyInHead: 0, mirrorOnlyInHead: 0 }) })
    );
    expect(b.kind).toBe('unknown');
    expect(b.why).toContain('neither');
  });

  test('null markers fall back to descent rather than deciding', () => {
    expect(classifyBranch(facts({ treeMarkers: null })).kind).toBe('private');
    expect(
      classifyBranch(
        facts({ treeMarkers: null, upstreamIsAncestor: true, originIsAncestor: false })
      ).kind
    ).toBe('oss');
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

/**
 * SC-639. `OSS_ALLOW_NEW_FILES=1` was read in the `import.meta.main` block
 * before `main()` ran, so neither `classifyBranch` nor `refusedPaths` executed
 * and the flag silenced BOTH violation kinds — including private-only source,
 * the hazard the whole file exists for. It printed `SKIPPED · exit 0`.
 *
 * These tests are the reason the kind is a typed field rather than a substring
 * of `why`. A suppression decision keyed on prose changes what the guard
 * admits the next time somebody rewords a message, with nothing failing.
 */
describe('the new-files allowance is scoped to new files (SC-639)', () => {
  const privateOnly: Violation = {
    path: 'private-app/src/middleware.ts',
    kind: 'private-only',
    why: 'tracked in origin/main and absent from upstream/main — private-only source',
  };
  const newFile: Violation = {
    path: 'packages/shared/src/brand-new.ts',
    kind: 'new-file',
    why: 'absent from both repos — build residue, or a new file you meant to add',
  };

  test('THE REGRESSION: private-only source is refused even with the flag set', () => {
    // The one assertion this ticket exists for. Before SC-639 this returned a
    // clean skip and the commit went through.
    const { refused, admitted } = applyNewFileAllowance([privateOnly], true);
    expect(refused).toEqual([privateOnly]);
    expect(admitted).toEqual([]);
  });

  test('a genuinely new shared file is admitted with the flag set', () => {
    // The escape people legitimately need. Removing it would push them back to
    // `--no-verify`, which disables every hook rather than one check.
    const { refused, admitted } = applyNewFileAllowance([newFile], true);
    expect(refused).toEqual([]);
    expect(admitted).toEqual([newFile]);
  });

  test('the same new file is refused with the flag unset', () => {
    const { refused, admitted } = applyNewFileAllowance([newFile], false);
    expect(refused).toEqual([newFile]);
    expect(admitted).toEqual([]);
  });

  test('the flag admits nothing at all when it is unset', () => {
    const { refused, admitted } = applyNewFileAllowance([privateOnly, newFile], false);
    expect(refused).toHaveLength(2);
    expect(admitted).toEqual([]);
  });

  test('a MIXED commit admits the new files and still refuses the private ones', () => {
    // The failure shape from the report: eleven paths staged, three of them
    // genuinely new. The old flag admitted all eleven because it never looked.
    const { refused, admitted } = applyNewFileAllowance([newFile, privateOnly, newFile], true);
    expect(refused).toEqual([privateOnly]);
    expect(admitted).toHaveLength(2);
  });

  test('the decision reads `kind`, not the wording of `why`', () => {
    // Reword both messages to something the substring tests would not match —
    // the suppression must be unchanged, because a security decision may not
    // depend on prose somebody is free to edit.
    const reworded: Violation[] = [
      { ...privateOnly, why: 'nope' },
      { ...newFile, why: 'nope' },
    ];
    const { refused, admitted } = applyNewFileAllowance(reworded, true);
    expect(refused.map((v) => v.kind)).toEqual(['private-only']);
    expect(admitted.map((v) => v.kind)).toEqual(['new-file']);
  });

  test('refusedPaths labels the kind as a field, and it agrees with the prose', () => {
    const [source] = refusedPaths(['private-app/src/middleware.ts'], {
      existsUpstream: () => false,
      trackedPrivately: () => true,
    });
    const [fresh] = refusedPaths(['packages/shared/src/brand-new.ts'], {
      existsUpstream: () => false,
      trackedPrivately: () => false,
    });
    expect(source?.kind).toBe('private-only');
    expect(fresh?.kind).toBe('new-file');
    // Both carriers must still agree, so the human text cannot drift away from
    // the value the guard acts on without this failing.
    expect(source?.why).toContain('private-only source');
    expect(fresh?.why).toContain('residue');
  });

  test('nothing staged admits nothing and refuses nothing', () => {
    expect(applyNewFileAllowance([], true)).toEqual({ refused: [], admitted: [] });
  });
});

describe("a bypass cannot wear a legitimate skip's costume (SC-639)", () => {
  test('all five verdict words are distinct', () => {
    const words = Object.values(VERDICT);
    expect(new Set(words).size).toBe(words.length);
  });

  test('the bypass and the not-applicable verdicts differ by WORD, not by exit code', () => {
    // PASS, ALLOWED and SKIPPED all exit 0, so the exit code cannot separate
    // them and the word is doing the whole job. `SKIPPED · exit 0` was printed
    // for both a deliberate bypass and a branch the guard does not apply to,
    // distinguished only by trailing prose that nothing reads.
    expect(VERDICT.allowed).not.toBe(VERDICT.skipped);
    expect(VERDICT.allowed).not.toBe(VERDICT.pass);
  });
});
