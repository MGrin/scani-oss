#!/usr/bin/env bun
// Refuse a commit that would carry an INTERNAL REFERENCE into MGrin/scani-oss.
//
// WHY THIS EXISTS (SC-598). The repository already has a guard for which files
// may travel — `scripts/check-oss-bound-paths.ts` — and a classifier that
// answers the same question in more detail. Neither reads what is INSIDE a
// file that is allowed to travel, and that is the hazard actually observed: a
// mirror-bound draft carrying an internal board key and two agent session ids
// code comments. Routing was correct; content was not. It was caught by one
// person checking precedent by hand, and nothing structural was behind them.
//
// WHY IT CANNOT BE KEYED ON THE CLASSIFIER, which is the obvious shape and is
// self-defeating in two independent ways:
//
//   1. The classifier is private-only. Run `--scan` from a branch checked out
//      against the mirror and it dies with `Module not found` — unrunnable at
//      exactly the moment it exists to run, immediately before an upstream
//      push. A guard that must work in both repositories cannot import a
//      module that exists in only one of them.
//   2. `.githooks/pre-commit` exists in BOTH repositories. Checking out a
//      mirror branch replaces the hook with the mirror's copy, so a guard
//      living only in the private copy is deleted by the very checkout it
//      exists to guard. This file is therefore shared, and imports nothing
//      that is not.
//
// THE ALLOWLIST IS THE LOAD-BEARING HALF. `SC-` references are WANTED in the
// mirror — 1110 of its 2090 tracked files carry one (measured 2026-08-25), so
// a blanket "no ticket references" rule would be wrong about the majority of
// the repository, would fire on ordinary work, and would be turned off. Every
// rule below is scoped to something with no legitimate published use, and
// each one was measured against the mirror at zero occurrences before it was
// added. `scripts/tests/check-oss-internal-refs.test.ts` carries the
// must-be-ABSENT control for each: the product hostnames, an `SC-` reference,
// a monitoring vendor's name, and a CSP wildcard all have to stay clean.
//
// ON MONITORING, which is a standing constraint rather than a leak this
// caught. Nothing about our infrastructure or monitoring belongs in the public
// repository or the published images — but the vendor's NAME is not that
// thing. Sentry appears in 101 mirror files as an integrated dependency: the
// SDK, the env schema, the CSP. A rule on the word would refuse a hundred
// files of already-published, legitimate integration, and would be ignored
// within a day. What must not travel is the coordinate that names our own
// project — a DSN with a credential in front of the `@`, an analytics project
// key, the tracking host. Those are the rules below.
//
// The analytics vendor goes deliberately unnamed in this file. The
// private-side marker list in `scripts/oss-eligibility.ts` already treats that
// name as private content, so spelling it out here — in a published file —
// would make this guard an instance of what it forbids. That list is worth
// knowing about for a second reason: content checking is not new on the
// private side. What is new is a content check that ALSO runs in the mirror,
// which that one structurally cannot, being part of the private classifier.
//
// Usage:
//   bun scripts/check-oss-internal-refs.ts          # staged content
//   bun scripts/check-oss-internal-refs.ts --scan   # every tracked file
//   OSS_ALLOW_INTERNAL_REFS=1 git commit ...        # the escape

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { type BranchFacts, classifyBranch, collectTreeMarkers } from './check-oss-bound-paths';

/**
 * A pattern is written with escaped separators and non-capturing alternations
 * so that its own source text does not match it. That is not decoration: this
 * file is published, so a rule spelled out as a plain literal would itself be
 * the internal reference it forbids, and the check would refuse the commit
 * that adds it. The reasoning is one character from being wrong, so the test
 * named `the check's own sources carry no internal reference` measures it.
 */
interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly why: string;
  /**
   * A string this rule MUST match, and one it must NOT. Both are checked
   * before every scan — see `selfTest`.
   *
   * They are assembled from fragments rather than written out for the same
   * reason the patterns are: a probe spelled as a literal would be a live
   * internal reference in a published file, and the guard would refuse the
   * commit that adds it.
   */
  readonly probe: string;
  readonly antiProbe: string;
}

const RULES: readonly Rule[] = [
  {
    name: 'agent session id',
    pattern: /thr_[a-z0-9]{10,}/,
    why: 'an agent session identifier — internal to the machine the work ran on',
    probe: `see ${'thr_'}k3n8x2qw9d`,
    antiProbe: 'three_letters and a thr with no id',
  },
  {
    name: 'internal board key',
    pattern: /\b(?:MX|AB|BC|MO|HA)-\d+\b/,
    why: 'a key from our internal work tracker. Only the `SC` project is public; the rest name work nobody outside can read',
    probe: `see ${'MX'}-269`,
    antiProbe: 'SC-500 and 0xABC-0x3 and MAX-12',
  },
  {
    name: 'internal hostname',
    pattern: /\b(?:admin|bb|hass|track)\.scani\.xyz\b/,
    why: 'an internal host. The published surfaces are app, api, cloud, demo, docs and status',
    probe: `https://bb.${'scani.xyz'}/x`,
    antiProbe: 'https://app.scani.xyz and https://status.scani.xyz',
  },
  {
    name: 'agent worktree path',
    pattern: /(?:~|\$HOME)\/\.bb\/|\.bb\/worktrees\//,
    why: 'a path inside the agent tooling directory, which exists only on the machine that wrote it',
    probe: `cd ~/.${'bb'}/worktrees/x`,
    antiProbe: 'cd ~/.config/scani and ./bb/notes',
  },
  {
    name: 'machine-local home path',
    pattern: /\/Users\/[A-Za-z0-9._-]+\//,
    why: 'an absolute path into somebody\u2019s home directory. Write it relative, or as a bare `~`',
    probe: `read /Users/${'someone'}/x`,
    antiProbe: 'read ~/x and ./Users/x',
  },
  {
    name: 'Sentry DSN',
    pattern: /https:\/\/[0-9a-zA-Z:]{16,}@[\w.-]*sentry\.io/,
    why: 'a DSN naming our own Sentry project. Naming the SDK is fine; the credential in front of the `@` is not',
    probe: `https://${'0123456789abcdef0123456789abcdef'}@o12345.ingest.us.sentry.io/678`,
    // Both halves are real mirror content: a CSP wildcard and a placeholder.
    antiProbe: 'connect-src https://*.ingest.sentry.io https://o12345.ingest.sentry.io/678',
  },
  {
    name: 'analytics project key',
    // The vendor goes deliberately unnamed here and in the test beside it: the
    // private-side marker list in `scripts/oss-eligibility.ts` already treats
    // that name as private content, so spelling it out in a published file
    // would make this rule an instance of what it forbids. The key prefix is
    // enough to key on, and the analytics workspace it belongs to is
    // private-only, so the path guard covers the rest.
    pattern: /\bphc_[A-Za-z0-9]{20,}/,
    why: 'an analytics project key — our own analytics coordinates, which the published images must not carry',
    probe: `KEY=${'phc_'}${'a'.repeat(24)}`,
    antiProbe: 'KEY=phc_short and a phc reference',
  },
];

/**
 * A FIFTH CLASS, AND IT FAILS DIFFERENTLY FROM THE FOUR ABOVE — so it gets its
 * own tier and exit 0, deliberately.
 *
 * These are names for the agent tooling this repository is worked on with.
 * They carry no secret and name no host; a reader of the mirror is simply
 * confused by them. A leaked thread id is a boundary violation and this is a
 * readability defect, and giving them one exit code is how the weak rule
 * eventually gets the strong ones waived along with it.
 *
 * KEYED ON NAMES THAT ARE OURS, NEVER ON WORDS THAT DESCRIBE A CONCEPT, and
 * that distinction is measured rather than aesthetic. Against the mirror:
 * `harness` reads 30 files and `orchestrator` 36 — ordinary vocabulary spread
 * across e2e, the domain tests, the rate limiter and the UI package, not one
 * cluster anybody could carve out. A rule on either is 30-odd false positives
 * on its first day, which trains people to ignore the whole instrument.
 * `subagent` reads 0 and was still declined: it is an English compound with an
 * honest meaning, so it is one product decision away from being legitimate —
 * the same shape as `harness`, just earlier. A tool name cannot become
 * ordinary vocabulary by accident; a noun can.
 */
const ADVISORY_RULES: readonly Rule[] = [
  {
    name: 'agent-harness tool name',
    pattern: /\bTask(?:Stop|Output)\b/,
    why: 'names a tool of the agent harness this repo is worked on with; it means nothing to a reader here',
    probe: `call Task${'Stop'} on it`,
    antiProbe: 'the task stops and the harness reports it',
  },
  {
    name: 'agent-harness tool name',
    pattern: /\bbb (?:thread|tasks|memory|bus|browser|workflows|automation)\b/,
    why: 'a command of the agent tooling, which no reader of this repository has',
    probe: `run bb ${'thread'} list`,
    antiProbe: 'run bb and see the threads',
  },
  {
    name: 'agent-harness tool name',
    pattern: /\bbus-(?:send)\b/,
    why: 'a command of the agent tooling, which no reader of this repository has',
    probe: `pipe it to bus-${'send'}`,
    antiProbe: 'the bus sends it onward',
  },
];

/**
 * EVERY TERM ON BOTH LISTS READS ZERO IN THE MIRROR TODAY, which means a green
 * run and a probe that has silently stopped matching produce identical output.
 * That is the must-be-ABSENT axis on its own — the exact failure this whole
 * guard exists to prevent, sitting inside the guard.
 *
 * So each rule carries a string it must match and one it must not, and both
 * are checked before anything is scanned. A green then means *the guard
 * looked and found nothing* rather than *something returned zero*, and the
 * count of rules exercised is printed beside the count of violations for the
 * same reason the file denominator is.
 */
export function verifyRules(rules: readonly Rule[]): string[] {
  const broken: string[] = [];
  for (const rule of rules) {
    if (!rule.pattern.test(rule.probe)) broken.push(`${rule.name}: stopped matching its own probe`);
    if (rule.pattern.test(rule.antiProbe)) broken.push(`${rule.name}: now matches its anti-probe`);
  }
  return broken;
}

export function selfTest(): string[] {
  return verifyRules([...RULES, ...ADVISORY_RULES]);
}

/** Exported so a test can hand `verifyRules` a rule that is deliberately broken. */
export type { Rule };

export const RULE_COUNT = RULES.length + ADVISORY_RULES.length;

export interface InternalRef {
  readonly rule: string;
  /** 1-indexed, so it can be pasted after a colon and opened. */
  readonly line: number;
  readonly why: string;
}

function scan(content: string, rules: readonly Rule[]): InternalRef[] {
  const out: InternalRef[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      if (rule.pattern.test(lines[i] as string)) {
        out.push({ rule: rule.name, line: i + 1, why: rule.why });
      }
    }
  }
  return out;
}

/** Every refusal rule violated, in the order the lines appear. */
export function findInternalRefs(content: string): InternalRef[] {
  return scan(content, RULES);
}

/** Every advisory rule violated. Reported, never refused — see `ADVISORY_RULES`. */
export function findAdvisoryRefs(content: string): InternalRef[] {
  return scan(content, ADVISORY_RULES);
}

/** Whether this checkout's staged content is bound for the public mirror. */
export type Scope =
  | { readonly kind: 'scan'; readonly why: string }
  | { readonly kind: 'skip'; readonly why: string }
  /** Never resolved toward `skip`. See the comment on the `unknown` arm below. */
  | { readonly kind: 'unknown'; readonly why: string };

export interface RepoFacts {
  /** `.private-repo` is present — the marker the private repository carries and the mirror never will. */
  readonly privateMarkerPresent: boolean;
}

/**
 * The branch facts are read the same way `check-oss-bound-paths` reads them,
 * and one of its answers is deliberately inverted here.
 *
 * With no `upstream` remote configured, that guard concludes there is no
 * mirror to be bound FOR and does nothing — correct for PATHS, because a
 * public checkout holds no private ones. For CONTENT the same fact means the
 * opposite: a checkout with no mirror to push to either IS the mirror or is a
 * clone of it, so everything committed in it is public. Deferring to the
 * sibling's verdict would leave this check dead in the one repository SC-598
 * is about. `.private-repo` is what separates that case from a private clone
 * whose remote was never added; it is a purpose-built marker the mirror will
 * never carry, already relied on by `scripts/publish-images-local.sh`.
 */
export function scanScope(facts: BranchFacts, repo: RepoFacts): Scope {
  const boundness = classifyBranch(facts);
  if (boundness.kind === 'unknown') return { kind: 'unknown', why: boundness.why };
  if (boundness.kind === 'oss') return { kind: 'scan', why: boundness.why };
  if (!facts.hasUpstreamRemote) {
    return repo.privateMarkerPresent
      ? {
          kind: 'skip',
          why: 'no `upstream` remote, and `.private-repo` marks this as the private repo',
        }
      : {
          kind: 'scan',
          why: 'no `upstream` remote and no `.private-repo` marker — this checkout is the public mirror, so every commit in it is public',
        };
  }
  return { kind: 'skip', why: boundness.why };
}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
/**
 * Blindness gets its own code so "could not tell" can never be read off a
 * transcript as "checked and clean".
 */
export const EXIT_UNKNOWN = 9;
/**
 * The guard could not verify itself. Its own code rather than a refusal,
 * because it says nothing about the content that was staged — and never
 * EXIT_OK, because an instrument that cannot demonstrate it still works has
 * not checked anything.
 */
export const EXIT_SELF_TEST_FAILED = 10;

/**
 * A git invocation that either RAN or did not — never a string a caller can use
 * without deciding which (SC-775).
 *
 * This returned `{ ok, stdout }`, and `.ok` was read at three call sites and
 * NOT at the two that build the file population. A failed `git` therefore
 * handed back `''`, which split to no paths, which read downstream as *the tree
 * has no files* — and this guard printed
 *
 *     oss-internal-refs: PASS · exit 0 · 10 rule(s) self-tested, 0 tracked
 *     file(s) scanned, 0 internal reference(s)
 *
 * over a directory that is not a git repository at all. Exit 0, from the check
 * standing between internal references and a public repo, run from a
 * pre-commit hook that reads the exit status rather than the line.
 *
 * The three call sites that DID check are the ones whose failure is harmless;
 * the two that did not are the two whose failure empties the scan. That is not
 * carelessness, it is the shape: a type that lets you reach the output without
 * consulting the status regenerates this defect indefinitely, and no amount of
 * review catches the next one. SC-743 was the identical defect in
 * `check-oss-bound-paths.ts`; SC-780 is a third instance elsewhere.
 *
 * So the failure is not merely reported, it is made UNREACHABLE: a caller
 * cannot get at `stdout` without narrowing `kind`, and the compiler enumerates
 * every consumer rather than a reviewer having to.
 */
type GitRun =
  | { readonly kind: 'ran'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly why: string };

function git(args: string[]): GitRun {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) return { kind: 'failed', why: `git ${args[0]}: ${r.error.message}` };
  if (r.status !== 0) {
    const said = (r.stderr ?? '').trim().split('\n')[0] ?? '';
    return {
      kind: 'failed',
      why: `git ${args[0]} exited ${r.status ?? 'on a signal'}${said === '' ? '' : `: ${said}`}`,
    };
  }
  return { kind: 'ran', stdout: r.stdout ?? '' };
}

/**
 * For a git command whose NON-ZERO exit is a legitimate answer rather than a
 * failure — `merge-base --is-ancestor` says "no" that way, and `rev-parse
 * --verify --quiet` says "no such ref".
 *
 * Spelled as its own verb so that asking *did this succeed* and asking *what
 * did this print* cannot be the same call. Collapsing them is what let a
 * population read borrow a predicate's tolerance for failure.
 */
function gitSucceeds(args: string[]): boolean {
  return spawnSync('git', args, { encoding: 'utf8' }).status === 0;
}

/**
 * `hasUpstreamRemote` is `null` when `git remote` FAILED, and that is the whole
 * point of the field (SC-775).
 *
 * `classifyBranch` in `check-oss-bound-paths.ts` has handled the blind reading
 * since SC-743 — it returns `unknown`, which becomes `EXIT_UNKNOWN` here. This
 * file imports that classifier and then could never hand it the value that
 * reaches the branch: it took `git remote`'s stdout without its status, so a
 * dead subprocess produced `''`, which contains no `upstream`, which is
 * `false` — *there is no upstream remote* — and not `null`.
 *
 * The consequence is a SKIP rather than a wrong scan, and a skip is exit 0. In
 * this repo `.private-repo` is present, so `scanScope` reads
 * `!hasUpstreamRemote` plus that marker and returns
 * `skip: no upstream remote, and .private-repo marks this as the private repo`.
 * A guard that could not ask git anything says the thing that means *checked,
 * nothing to do here*.
 *
 * So the remedy for this already existed, fully written and separately tested,
 * one import away — and was unreachable because the collector could not produce
 * its input. Worth more than the two-line fix: a repair applied to a shared
 * classifier does not travel to a caller that feeds it a narrower type.
 */
function collectBranchFacts(): BranchFacts {
  const remotes = git(['remote']);
  const upstreamMainResolved = gitSucceeds([
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/remotes/upstream/main',
  ]);
  return {
    hasUpstreamRemote:
      remotes.kind === 'failed' ? null : remotes.stdout.trim().split('\n').includes('upstream'),
    upstreamMainResolved,
    upstreamIsAncestor:
      upstreamMainResolved && gitSucceeds(['merge-base', '--is-ancestor', 'upstream/main', 'HEAD']),
    originIsAncestor: gitSucceeds(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']),
    treeMarkers: collectTreeMarkers(),
  };
}

/** A file with a NUL byte is not text; matching regexes against it reports noise. */
function isBinary(content: string): boolean {
  return content.includes('\0');
}

function main(argv: readonly string[]): number {
  const wholeTree = argv.includes('--scan');

  const broken = selfTest();
  if (broken.length > 0) {
    for (const b of broken) console.error(`  ${b}`);
    console.error(
      `oss-internal-refs: SELF-TEST FAILED · exit ${EXIT_SELF_TEST_FAILED} · ${broken.length} of ${RULE_COUNT} rule(s) no longer behave as written — NOTHING WAS SCANNED`
    );
    return EXIT_SELF_TEST_FAILED;
  }

  if (!wholeTree) {
    const scope = scanScope(collectBranchFacts(), {
      privateMarkerPresent: existsSync('.private-repo'),
    });
    if (scope.kind === 'unknown') {
      console.error(`oss-internal-refs: UNKNOWN · exit ${EXIT_UNKNOWN} · ${scope.why}`);
      return EXIT_UNKNOWN;
    }
    if (scope.kind === 'skip') {
      console.log(`oss-internal-refs: SKIPPED · exit ${EXIT_OK} · ${scope.why}`);
      return EXIT_OK;
    }
  }

  /**
   * The population. A git that FAILED is `EXIT_UNKNOWN`, never an empty list
   * (SC-775).
   *
   * `git diff --cached` legitimately returning zero paths and `git ls-files`
   * dying are not the same fact, and the old code could not tell them apart —
   * both arrived as `''`. Only the first is a scan with nothing in it; the
   * second is no scan at all, and this file already owns a code that says so.
   */
  const listed = wholeTree
    ? git(['ls-files'])
    : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (listed.kind === 'failed') {
    console.error(
      `oss-internal-refs: UNKNOWN · exit ${EXIT_UNKNOWN} · could not list the ${wholeTree ? 'tracked' : 'staged'} files to scan — ${listed.why} — NOTHING WAS SCANNED`
    );
    return EXIT_UNKNOWN;
  }
  const listing = listed.stdout;
  const paths = listing.trim() ? listing.trim().split('\n') : [];

  let scanned = 0;
  let skippedBinary = 0;
  let unreadable = 0;
  const found: { path: string; ref: InternalRef }[] = [];
  const advisories: { path: string; ref: InternalRef }[] = [];
  for (const path of paths) {
    // The STAGED content, not the working tree: a partially staged file is a
    // different file, and the commit carries the half that is in the index.
    const read: GitRun = wholeTree
      ? (() => {
          try {
            return { kind: 'ran', stdout: readFileSync(path, 'utf8') } as const;
          } catch (e) {
            return { kind: 'failed', why: (e as Error).message } as const;
          }
        })()
      : git(['show', `:${path}`]);
    // A file that could not be read is COUNTED, not silently dropped. It was a
    // bare `continue`, so a path skipped this way left the denominator looking
    // like a complete scan — the same defect as the population read, one file
    // at a time (SC-775).
    if (read.kind === 'failed') {
      unreadable++;
      continue;
    }
    if (isBinary(read.stdout)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    for (const ref of findInternalRefs(read.stdout)) found.push({ path, ref });
    for (const ref of findAdvisoryRefs(read.stdout)) advisories.push({ path, ref });
  }

  // The denominator is printed on every outcome. `0 found` beside no count at
  // all is indistinguishable from a scan that never read anything.
  const where = wholeTree ? 'tracked' : 'staged';
  const tail = `${RULE_COUNT} rule(s) self-tested, ${scanned} of ${paths.length} ${where} file(s) scanned${skippedBinary > 0 ? `, ${skippedBinary} binary skipped` : ''}${unreadable > 0 ? `, ${unreadable} UNREADABLE` : ''}`;

  // Printed before the verdict and never folded into it. Advisories are a
  // readability defect, not a boundary violation; one exit code for both is
  // how the weak rule gets the strong ones waived along with it.
  if (advisories.length > 0) {
    for (const { path, ref } of advisories)
      console.error(`  ${path}:${ref.line}\n      advisory · ${ref.rule} — ${ref.why}`);
    console.error(
      `oss-internal-refs: ADVISORY · ${advisories.length} agent-tooling reference(s) in ${new Set(advisories.map((a) => a.path)).size} file(s). Not a refusal — rewrite them in ordinary words.`
    );
  }

  if (found.length === 0) {
    console.log(`oss-internal-refs: PASS · exit ${EXIT_OK} · ${tail}, 0 internal reference(s)`);
    return EXIT_OK;
  }

  for (const { path, ref } of found)
    console.error(`  ${path}:${ref.line}\n      ${ref.rule} — ${ref.why}`);
  console.error(
    `oss-internal-refs: REFUSED · exit ${EXIT_REFUSED} · ${tail}, ${found.length} internal reference(s) in ${new Set(found.map((f) => f.path)).size} file(s)`
  );
  console.error(
    '  This content is bound for MGrin/scani-oss. Rewrite the reference — an `SC-`\n' +
      '  number is public and says the same thing. If a line genuinely has to keep it,\n' +
      '  re-run with OSS_ALLOW_INTERNAL_REFS=1 — see SC-598.'
  );
  return EXIT_REFUSED;
}

if (import.meta.main) {
  if (process.env.OSS_ALLOW_INTERNAL_REFS === '1') {
    console.log(`oss-internal-refs: SKIPPED · exit ${EXIT_OK} · OSS_ALLOW_INTERNAL_REFS=1 was set`);
    process.exit(EXIT_OK);
  }
  process.exit(main(process.argv.slice(2)));
}
