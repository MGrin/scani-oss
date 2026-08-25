#!/usr/bin/env bun
// Refuse a commit that would carry an INTERNAL REFERENCE into MGrin/scani-oss.
//
// WHY THIS EXISTS (SC-598). The repository already has a guard for which files
// may travel — `scripts/check-oss-bound-paths.ts` — and a classifier that
// answers the same question in more detail. Neither reads what is INSIDE a
// file that is allowed to travel, and that is the hazard actually observed: a
// mirror-bound draft carrying a bb board key and two bb thread ids in ordinary
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
// project — a DSN with a credential in front of the `@`, a PostHog project
// key, the tracking host. Those are the rules below. PostHog needs no further
// rule: it lives in a private-only package, and the path guard already
// refuses that.
//
// Usage:
//   bun scripts/check-oss-internal-refs.ts          # staged content
//   bun scripts/check-oss-internal-refs.ts --scan   # every tracked file
//   OSS_ALLOW_INTERNAL_REFS=1 git commit ...        # the escape

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { type BranchFacts, classifyBranch } from './check-oss-bound-paths';

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
}

const RULES: readonly Rule[] = [
  {
    name: 'bb thread id',
    pattern: /thr_[a-z0-9]{10,}/,
    why: 'a bb thread identifier — internal to the machine that ran the work',
  },
  {
    name: 'bb board key',
    pattern: /\b(?:MX|AB|BC|MO|HA)-\d+\b/,
    why: 'a bb board key. Only the `SC` project is public; the rest name work nobody outside can read',
  },
  {
    name: 'internal hostname',
    pattern: /\b(?:admin|bb|hass|track)\.scani\.xyz\b/,
    why: 'an internal host. The published surfaces are app, api, cloud, demo, docs and status',
  },
  {
    name: 'bb worktree path',
    pattern: /(?:~|\$HOME)\/\.bb\/|\.bb\/worktrees\//,
    why: 'a path inside the agent tooling directory, which exists only on the machine that wrote it',
  },
  {
    name: 'machine-local home path',
    pattern: /\/Users\/[A-Za-z0-9._-]+\//,
    why: 'an absolute path into somebody’s home directory. Write it relative, or as a bare `~`',
  },
  {
    name: 'Sentry DSN',
    pattern: /https:\/\/[0-9a-zA-Z:]{16,}@[\w.-]*sentry\.io/,
    why: 'a DSN naming our own Sentry project. Naming the SDK is fine; the credential in front of the `@` is not',
  },
  {
    name: 'PostHog project key',
    pattern: /\bphc_[A-Za-z0-9]{20,}/,
    why: 'a PostHog project key — our analytics coordinates, which the published images must not carry',
  },
];

export interface InternalRef {
  readonly rule: string;
  /** 1-indexed, so it can be pasted after a colon and opened. */
  readonly line: number;
  readonly why: string;
}

/** Every rule violated, in the order the lines appear. */
export function findInternalRefs(content: string): InternalRef[] {
  const out: InternalRef[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.pattern.test(lines[i] as string)) {
        out.push({ rule: rule.name, line: i + 1, why: rule.why });
      }
    }
  }
  return out;
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

function git(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

function collectBranchFacts(): BranchFacts {
  const hasUpstreamRemote = git(['remote']).stdout.trim().split('\n').includes('upstream');
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
  };
}

/** A file with a NUL byte is not text; matching regexes against it reports noise. */
function isBinary(content: string): boolean {
  return content.includes('\0');
}

function main(argv: readonly string[]): number {
  const wholeTree = argv.includes('--scan');

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

  const listing = wholeTree
    ? git(['ls-files']).stdout
    : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).stdout;
  const paths = listing.trim() ? listing.trim().split('\n') : [];

  let scanned = 0;
  let skippedBinary = 0;
  const found: { path: string; ref: InternalRef }[] = [];
  for (const path of paths) {
    // The STAGED content, not the working tree: a partially staged file is a
    // different file, and the commit carries the half that is in the index.
    const read = wholeTree
      ? (() => {
          try {
            return { ok: true, stdout: readFileSync(path, 'utf8') };
          } catch {
            return { ok: false, stdout: '' };
          }
        })()
      : git(['show', `:${path}`]);
    if (!read.ok) continue;
    if (isBinary(read.stdout)) {
      skippedBinary++;
      continue;
    }
    scanned++;
    for (const ref of findInternalRefs(read.stdout)) found.push({ path, ref });
  }

  // The denominator is printed on every outcome. `0 found` beside no count at
  // all is indistinguishable from a scan that never read anything.
  const where = wholeTree ? 'tracked' : 'staged';
  const tail = `${scanned} ${where} file(s) scanned${skippedBinary > 0 ? `, ${skippedBinary} binary skipped` : ''}`;

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
