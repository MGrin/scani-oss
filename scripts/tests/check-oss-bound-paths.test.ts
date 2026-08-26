import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * SC-659. The predicate above this block used to be a PRESENCE test, and the
 * evidence against it was already written in `classifyByTree`'s own docblock:
 * `private` branches carry 0.52-1.00 of the private-only set, `oss` ones carry
 * 0.00-0.02, and nothing sits between. Presence keeps only the sign of that
 * separation, so one mirror-only path outranked 541 private-only ones.
 *
 * Every case below is expressed as two SHARES rather than two counts, because
 * that is the thing the fix reads. The must-be-FOUND case is the first one —
 * it is the only one that was broken, and a suite that omits it would have
 * gone green on every day this bug existed.
 */
describe('the tree discriminator weighs shares, not presence (SC-659)', () => {
  /**
   * MUST-BE-FOUND. The upstream-first window, measured on `main` 2026-08-26:
   * a shared file is landed on `upstream/main` first, so until the private
   * half is committed it is mirror-only BY CONSTRUCTION. The private branch
   * carrying it scored `oss` under presence and the guard refused
   * `scripts/oss-eligibility.ts` — a private-only source file — on a tree that
   * was 541/546 private.
   */
  test('a private branch inside an upstream-first window is private, not oss', () => {
    const b = classifyByTree({
      privateOnlyTotal: 546,
      privateOnlyInHead: 541,
      mirrorOnlyTotal: 10,
      mirrorOnlyInHead: 1,
    });
    expect(b?.kind).toBe('private');
    // The `why` has to survive being read. It said "and none of the 10
    // mirror-only path(s)" while the tree carried one, which is a false
    // statement in the one message a refused author would have gone on.
    expect(b?.why).toContain('1/10');
    expect(b?.why).toContain('541/546');
    expect(b?.why).not.toContain('none of');
  });

  /**
   * MUST-BE-ABSENT, and the axis that stops the fix from being "reverse the
   * order". Three real OSS branches in this repo carry exactly one private-only
   * path; refusing that path is the whole job. A share comparison keeps them
   * `oss` because 9/9 is not 1/543 — the two mixed cases are two orders of
   * magnitude apart, not adjacent.
   */
  test('an oss branch carrying one private-only path is still oss', () => {
    const b = classifyByTree({
      privateOnlyTotal: 543,
      privateOnlyInHead: 1,
      mirrorOnlyTotal: 9,
      mirrorOnlyInHead: 9,
    });
    expect(b?.kind).toBe('oss');
  });

  /** A genuine mirror checkout: the whole mirror set, none of the private one. */
  test('a mirror tree is oss', () => {
    expect(
      classifyByTree({
        privateOnlyTotal: 546,
        privateOnlyInHead: 0,
        mirrorOnlyTotal: 10,
        mirrorOnlyInHead: 10,
      })?.kind
    ).toBe('oss');
  });

  /**
   * THE ORDER IS THE SAFETY PROPERTY AND THE FIX KEEPS IT. `oss` makes the
   * guard RUN and `private` makes it SKIP, so an exact tie resolves toward the
   * verdict whose failure is a refusal somebody reads. A future reader
   * tightening `>=` to `>` would be trading a visible failure for a silent one.
   */
  test('an exact tie resolves to oss, because a refusal beats a silent skip', () => {
    expect(
      classifyByTree({
        privateOnlyTotal: 10,
        privateOnlyInHead: 5,
        mirrorOnlyTotal: 10,
        mirrorOnlyInHead: 5,
      })?.kind
    ).toBe('oss');
  });

  /**
   * The whole population, as one table, so the boundary is visible rather than
   * asserted case by case. The two rows that matter sit next to each other:
   * identical `mirrorOnlyInHead`, opposite verdicts — which is precisely what
   * a presence test cannot express.
   */
  test.each([
    ['a mirror checkout', 0, 546, 10, 10, 'oss'],
    ['an oss branch with one private-only path', 1, 543, 9, 9, 'oss'],
    ['an upstream-first private branch', 541, 546, 1, 10, 'private'],
    ['an ordinary private branch', 543, 543, 0, 9, 'private'],
  ] as const)('%s', (_name, pIn, pTotal, mIn, mTotal, expected) => {
    expect(
      classifyByTree({
        privateOnlyTotal: pTotal,
        privateOnlyInHead: pIn,
        mirrorOnlyTotal: mTotal,
        mirrorOnlyInHead: mIn,
      })?.kind
    ).toBe(expected);
  });

  /**
   * `unknown` MUST NEVER BECOME PERMISSION. A tree matching neither repo is
   * still not resolved toward the convenient answer, and the share comparison
   * does not create a new route to `private` for it: 0/546 against 0/10 is two
   * empty shares, not a private one.
   */
  test('a tree carrying neither kind of marker is still undecided', () => {
    expect(
      classifyByTree({
        privateOnlyTotal: 546,
        privateOnlyInHead: 0,
        mirrorOnlyTotal: 10,
        mirrorOnlyInHead: 0,
      })
    ).toBeNull();
  });

  /**
   * THE ZERO DENOMINATOR, which is DEFENSIVE rather than a state this repo
   * reaches: the mirror-only set has a floor of 9 here — the release
   * automation, CodeQL and the publish workflows exist only on the mirror by
   * design — so it cannot empty. A fork or a differently-arranged mirror has
   * no such floor, which is why the branch exists. Left to the arithmetic it
   * lands on the right verdict for the wrong stated reason —
   * a `why` reading `0/0 mirror-only` tells the reader the tree LACKS paths
   * that do not exist to lack.
   */
  test('no mirror-only paths in existence is said out loud, not implied', () => {
    const b = classifyByTree({
      privateOnlyTotal: 546,
      privateOnlyInHead: 546,
      mirrorOnlyTotal: 0,
      mirrorOnlyInHead: 0,
    });
    expect(b?.kind).toBe('private');
    expect(b?.why).toContain('no mirror-only paths in existence');
    expect(b?.why).not.toContain('0/0');
  });

  test('no mirror-only paths and no private-only ones is still undecided', () => {
    expect(
      classifyByTree({
        privateOnlyTotal: 546,
        privateOnlyInHead: 0,
        mirrorOnlyTotal: 0,
        mirrorOnlyInHead: 0,
      })
    ).toBeNull();
  });
});

/**
 * SC-659. THE CONTROL, END TO END, AND IT IS NOT THE SAME TEST AS THE TABLE
 * ABOVE. Those hand the classifier a `TreeMarkers` literal, so they prove the
 * predicate and nothing about the thing that FILLS it. This builds two real
 * git repositories, opens a real upstream-first window between them, and runs
 * the real entrypoint as a subprocess — `collectTreeMarkers`, `classifyBranch`
 * and the refusal path together, on a tree git actually produced.
 *
 * A SUBPROCESS on purpose. `collectTreeMarkers` shells out to git in
 * `process.cwd()`, and `bun test` runs all 5xx files in ONE process, so a test
 * that chdir'd to a scratch directory would be changing global state every
 * later file reads — the same class of leak `restoreContainerAfterAll` exists
 * for. Spawning with `cwd` set touches nothing.
 *
 ***REMOVED***
 * match is the SHAPE — a private tree carrying the whole private-only set and
 ***REMOVED***
 * docblock and in the table above.
 */
describe('an upstream-first window on real repositories (SC-659)', () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-bound-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const guard = join(import.meta.dir, '..', 'check-oss-bound-paths.ts');

  function git(cwd: string, ...args: string[]): void {
    const run = Bun.spawnSync(['git', ...args], {
      cwd,
      // The scratch repos sit under $TMPDIR, which on a developer's machine can
      // be inside no repository at all or inside somebody else's. Ceiling them
      // so a mistake here can never reach the checkout running the test. HOME
      // is deliberately NOT overridden: git then cannot reach xcrun's cache on
      // macOS and every call prints an errno over the real result.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (run.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(run.stderr)}`);
    }
  }

  function identify(cwd: string): void {
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'test');
  }

  const PRIVATE_ONLY = 20;
  const MIRROR_ONLY = 5;

  // Built once: three branches off one pair of repositories, which is also the
  // cheapest way to be sure the three verdicts differ because the TREES differ
  // and not because anything else does.
  const work = (() => {
    const up = join(root, 'up.git');
    const priv = join(root, 'priv.git');
    const seed = join(root, 'seed');
    const clone = join(root, 'work');
    // `--initial-branch`, on the BARE repos too. Without it these inherit the
    // machine's `init.defaultBranch`, so their HEAD points at `master` on a
    // default git and at `main` on one configured like this repo. When it is
    // `master`, `git clone` warns `remote HEAD refers to nonexistent ref`,
    // checks out NOTHING, and leaves HEAD unborn — `ls-tree HEAD` then fails
    // and the scratch subdirectories do not exist. Green here and red on CI,
    // which is exactly the configuration dependence SC-662 removed from the
    // code under test (SC-662, found on scani-oss#242).
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', up);
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', priv);
    git(root, 'init', '--quiet', '--initial-branch=main', seed);
    identify(seed);
    for (let i = 0; i < 8; i += 1) writeFileSync(join(seed, `shared${i}.ts`), `shared ${i}\n`);
    for (let i = 0; i < MIRROR_ONLY; i += 1)
      writeFileSync(join(seed, `mirror${i}.yml`), `m ${i}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'the mirror');
    git(seed, 'push', '--quiet', up, 'main');
    git(seed, 'rm', '--quiet', ...Array.from({ length: MIRROR_ONLY }, (_, i) => `mirror${i}.yml`));
    for (let i = 0; i < PRIVATE_ONLY; i += 1)
      writeFileSync(join(seed, `private${i}.ts`), `p ${i}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'the private repo');
    git(seed, 'push', '--quiet', priv, 'main');
    // Cloned and fetched, never `update-ref`: a remote-tracking ref written by
    // hand is a confident wrong answer to every later question about it.
    git(root, 'clone', '--quiet', priv, clone);
    identify(clone);
    git(clone, 'remote', 'add', 'upstream', up);
    git(clone, 'fetch', '--quiet', 'upstream');
    return clone;
  })();

  function runGuard(branch: string, stage: string): { code: number; out: string } {
    git(work, 'checkout', '--quiet', branch);
    git(work, 'add', stage);
    const run = Bun.spawnSync(['bun', guard], {
      cwd: work,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // `--hard`, not a bare reset: the run leaves an edited tracked file, and
    // unstaging it is not enough for the next `checkout` to succeed.
    git(work, 'reset', '--quiet', '--hard');
    return {
      code: run.exitCode,
      out: new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr),
    };
  }

  /**
   * MUST-BE-FOUND. `mirror0.yml` was landed on `upstream/main` first; this is
   * the private half committed after, which is what every shared change in
   * this repository looks like for the hours between the two. Under the
   * presence test this branch classified `oss` and the guard refused a
   * private-only source file on a tree that was 20/20 private.
   */
  test('the private half of an upstream-first change does not trigger the guard', () => {
    git(work, 'checkout', '--quiet', '-b', 'private-half', '--no-track', 'origin/main');
    const from = Bun.spawnSync(['git', 'show', 'upstream/main:mirror0.yml'], { cwd: work });
    writeFileSync(join(work, 'mirror0.yml'), from.stdout);
    git(work, 'add', 'mirror0.yml');
    git(work, 'commit', '--quiet', '-m', 'the private half of an upstream-first change');

    writeFileSync(join(work, 'private7.ts'), 'edited\n');
    const { code, out } = runGuard('private-half', 'private7.ts');
    expect(out).toContain(VERDICT.skipped);
    expect(code).toBe(EXIT_OK);
    // The denominators, so a pass cannot be read as the window never opening.
    expect(out).toContain(`1/${MIRROR_ONLY} mirror-only`);
    expect(out).toContain(`${PRIVATE_ONLY}/${PRIVATE_ONLY} private-only`);
  });

  /**
   * MUST-BE-ABSENT, on the same pair of repositories. If the fix had been
   * "reverse the order" or "any private-only path means private", this is the
   * case that would have gone quiet — and it is the case the guard exists for.
   */
  test('an oss branch staging a private-only path is still refused', () => {
    git(work, 'checkout', '--quiet', '-b', 'oss-side', '--no-track', 'upstream/main');
    const from = Bun.spawnSync(['git', 'show', 'origin/main:private1.ts'], { cwd: work });
    writeFileSync(join(work, 'private1.ts'), from.stdout);

    const { code, out } = runGuard('oss-side', 'private1.ts');
    expect(out).toContain(VERDICT.refused);
    expect(code).toBe(EXIT_REFUSED);
    expect(out).toContain('private1.ts');
  });

  /** The third population, so neither verdict above is the only one reachable. */
  test('a private branch with no window open is still skipped', () => {
    git(work, 'checkout', '--quiet', '-b', 'no-window', '--no-track', 'origin/main');
    writeFileSync(join(work, 'private7.ts'), 'edited again\n');
    const { code, out } = runGuard('no-window', 'private7.ts');
    expect(out).toContain(VERDICT.skipped);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain(`0/${MIRROR_ONLY} mirror-only`);
  });
});

/**
 * SC-662. `collectTreeMarkers` asked a MEMBERSHIP question with `git diff`,
 * and `git diff` answers a richer one. With rename detection on — the DEFAULT
 * — git pairs a path that exists only upstream with one that exists only
 * privately, emits a single `R` entry, and `--diff-filter=A` and
 * `--diff-filter=D` both skip it. Both markers vanish at once, silently.
 *
 * Found because two tools disagreed about one file: `oss-drift --scan` called
 * `packages/infra/db/tests/fixtures/scripts/read-only-probe.ts`
 * `absent-privately` while `collectTreeMarkers` did not count it at all. The
 * live pair measured 9/543 by diff against 10/544 by set difference.
 *
 * The fix is a set difference over two `ls-tree` listings — the same way
 * `oss-drift` has always asked — so the two agree BY CONSTRUCTION rather than
 * by both being configured alike. `--no-renames` would have fixed the number
 * and left the agreement resting on a flag that `diff.renames` can change.
 */
describe('a cross-repo rename does not hide both markers (SC-662)', () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-rename-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function git(cwd: string, ...args: string[]): string {
    const run = Bun.spawnSync(['git', ...args], {
      cwd,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (run.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(run.stderr)}`);
    }
    return new TextDecoder().decode(run.stdout);
  }

  // Similar enough that git's default 50% threshold pairs them, which is the
  // whole precondition — the live pair that exposed this scored 65%.
  const COMMON = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join('\n');
  const UPSTREAM_PROBE = `${COMMON}\nexport const onlyUpstream = true;\n`;
  const PRIVATE_PROBE = `${COMMON}\nexport const onlyPrivate = true;\n`;

  const work = (() => {
    const up = join(root, 'up.git');
    const priv = join(root, 'priv.git');
    const seed = join(root, 'seed');
    const clone = join(root, 'work');
    // `--initial-branch`, on the BARE repos too. Without it these inherit the
    // machine's `init.defaultBranch`, so their HEAD points at `master` on a
    // default git and at `main` on one configured like this repo. When it is
    // `master`, `git clone` warns `remote HEAD refers to nonexistent ref`,
    // checks out NOTHING, and leaves HEAD unborn — `ls-tree HEAD` then fails
    // and the scratch subdirectories do not exist. Green here and red on CI,
    // which is exactly the configuration dependence SC-662 removed from the
    // code under test (SC-662, found on scani-oss#242).
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', up);
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', priv);
    git(root, 'init', '--quiet', '--initial-branch=main', seed);
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'test');
    writeFileSync(join(seed, 'shared.ts'), 'export const shared = 1;\n');
    // The must-be-ABSENT control, committed to BOTH sides at the same path: a
    // rename that happened identically in each repo is in both trees and
    // belongs in neither marker set.
    writeFileSync(join(seed, 'renamed-in-both.ts'), 'export const both = 1;\n');
    mkdirSync(join(seed, 'fixtures', 'scripts'), { recursive: true });
    writeFileSync(join(seed, 'fixtures', 'scripts', 'probe.ts'), UPSTREAM_PROBE);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'the mirror');
    git(seed, 'push', '--quiet', up, 'main');

    git(seed, 'rm', '--quiet', 'fixtures/scripts/probe.ts');
    // `git rm` prunes the emptied parent, so `fixtures/` is gone by now.
    mkdirSync(join(seed, 'fixtures'), { recursive: true });
    writeFileSync(join(seed, 'fixtures', 'repair-probe.ts'), PRIVATE_PROBE);
    writeFileSync(join(seed, 'private-only.ts'), 'export const p = 1;\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'the private repo');
    git(seed, 'push', '--quiet', priv, 'main');

    git(root, 'clone', '--quiet', priv, clone);
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'test');
    git(clone, 'remote', 'add', 'upstream', up);
    git(clone, 'fetch', '--quiet', 'upstream');
    return clone;
  })();

  function markersIn(cwd: string): TreeMarkers | null {
    const script = join(import.meta.dir, '..', 'check-oss-bound-paths.ts');
    const run = Bun.spawnSync(
      [
        // The running interpreter, not the name: `bun` is only on PATH if the
        // caller's environment puts it there, and a test should not depend on
        // that.
        process.execPath,
        '-e',
        `import { collectTreeMarkers } from ${JSON.stringify(script)};
` + `console.log(JSON.stringify(collectTreeMarkers()));`,
      ],
      {
        cwd,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    if (run.exitCode !== 0) {
      throw new Error(`markers: ${new TextDecoder().decode(run.stderr)}`);
    }
    return JSON.parse(new TextDecoder().decode(run.stdout));
  }

  /**
   * The precondition, asserted rather than assumed. If git ever stopped
   * pairing these two the test below would pass for the wrong reason, and a
   * must-be-FOUND control that can go vacuous is not a control.
   */
  test('git really does pair the two paths as a rename', () => {
    const status = git(work, 'diff', '--name-status', 'upstream/main', 'origin/main');
    expect(status).toContain('fixtures/scripts/probe.ts');
    expect(status).toContain('fixtures/repair-probe.ts');
    expect(status).toMatch(/^R\d+\t/m);
  });

  /** MUST-BE-FOUND: the paired paths are counted on both sides. */
  test('both halves of a cross-repo rename are counted', () => {
    const m = markersIn(work);
    expect(m).not.toBeNull();
    // upstream-only: probe.ts. private-only: repair-probe.ts and private-only.ts.
    expect(m?.mirrorOnlyTotal).toBe(1);
    expect(m?.privateOnlyTotal).toBe(2);

    // And the diff-based question, run side by side, gives the wrong answer —
    // so the difference is demonstrated here rather than remembered.
    const byDiff = git(
      work,
      'diff',
      '--name-only',
      '--diff-filter=D',
      'upstream/main',
      'origin/main'
    );
    expect(byDiff.trim()).toBe('');
  });

  /**
   * MUST-BE-ABSENT. A set difference is only correct if it stays quiet about
   * paths present on both sides — including one that got there by a rename
   * performed in each repo independently.
   */
  test('a path present in both trees is in neither marker set', () => {
    const upstream = git(work, 'ls-tree', '-r', '--full-tree', '--name-only', 'upstream/main');
    const origin = git(work, 'ls-tree', '-r', '--full-tree', '--name-only', 'origin/main');
    expect(upstream).toContain('renamed-in-both.ts');
    expect(origin).toContain('renamed-in-both.ts');
    const m = markersIn(work);
    // 1 mirror-only and 2 private-only above account for every one-sided path,
    // so `renamed-in-both.ts` and `shared.ts` are in neither set.
    expect((m?.mirrorOnlyTotal ?? 0) + (m?.privateOnlyTotal ?? 0)).toBe(3);
  });

  /**
   * `git ls-tree` is CWD-RELATIVE and `git diff` is not, so swapping one for
   * the other introduces a bug unless `--full-tree` comes with it. Measured in
   * the real checkout: `ls-tree -r --name-only HEAD` run from `scripts/`
   * returned 177 paths against 2680. Git runs hooks from the top level, which
   * is the only reason this was never seen.
   */
  test('the answer does not depend on which directory it runs from', () => {
    const fromRoot = markersIn(work);
    const fromSubdir = markersIn(join(work, 'fixtures'));
    expect(fromSubdir).toEqual(fromRoot);
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
