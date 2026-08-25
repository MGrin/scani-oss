import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BranchFacts } from '../check-oss-bound-paths';
import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNKNOWN,
  findInternalRefs,
  scanScope,
} from '../check-oss-internal-refs';

/**
 * SC-598. `scripts/oss-classify.ts` answers ROUTING — which repo may have this
 * file — and it is itself private-only, so `--scan` from a mirror-bound branch
 * dies with `Module not found`: unrunnable at the one moment it exists to run.
 * The hazard it therefore never covered is an oss-eligible file, legitimately
 * pushed, whose COMMENTS carry internal references. A real draft carried a bb
 * board key and two bb thread ids into a mirror-bound branch and was caught by
 * one person checking precedent by hand.
 *
 * EVERY FIXTURE BELOW IS INTERPOLATED RATHER THAN WRITTEN OUT, and that is
 * load-bearing rather than style. This file is shared with the public mirror,
 * so a fixture written as a literal would be a genuine internal reference in a
 * genuinely public file — the test would be an instance of what it forbids.
 * Splitting each one across a `${}` boundary breaks the match without breaking
 * the string. `the check's own sources carry no internal reference` at the
 * bottom is what proves that claim instead of asserting it.
 */

const OSS_BOUND: BranchFacts = {
  hasUpstreamRemote: true,
  upstreamMainResolved: true,
  upstreamIsAncestor: true,
  originIsAncestor: false,
};

const PRIVATE_BRANCH: BranchFacts = {
  hasUpstreamRemote: true,
  upstreamMainResolved: true,
  upstreamIsAncestor: false,
  originIsAncestor: true,
};

const NO_UPSTREAM_REMOTE: BranchFacts = {
  hasUpstreamRemote: false,
  upstreamMainResolved: false,
  upstreamIsAncestor: false,
  originIsAncestor: true,
};

const UNFETCHED: BranchFacts = {
  hasUpstreamRemote: true,
  upstreamMainResolved: false,
  upstreamIsAncestor: false,
  originIsAncestor: true,
};

describe('scanScope — which checkouts must have their staged content read', () => {
  test('a branch descended from upstream/main is scanned', () => {
    expect(scanScope(OSS_BOUND, { privateMarkerPresent: true }).kind).toBe('scan');
  });

  /**
   * THE CASE THE SIBLING PATH GUARD GETS RIGHT BY ANSWERING THE OPPOSITE WAY,
   * and the reason this could not simply reuse its verdict. With no `upstream`
   * remote there is no mirror to be bound FOR, so `check-oss-bound-paths`
   * correctly does nothing: a public checkout holds no private paths. For
   * CONTENT the same fact inverts — a checkout with no mirror to push to is
   * either the mirror itself or a clone of it, so every commit made in it is
   * public and every staged file must be read. Resolving this toward `skip`
   * would leave the check dead in the one repository the ticket is about.
   */
  test('a checkout with no upstream remote and no private marker IS the mirror, and is scanned', () => {
    const scope = scanScope(NO_UPSTREAM_REMOTE, { privateMarkerPresent: false });
    expect(scope.kind).toBe('scan');
    expect(scope.why).toContain('.private-repo');
  });

  test('a private clone with no upstream remote is skipped, not scanned', () => {
    expect(scanScope(NO_UPSTREAM_REMOTE, { privateMarkerPresent: true }).kind).toBe('skip');
  });

  test('a private branch in the private repo is skipped', () => {
    expect(scanScope(PRIVATE_BRANCH, { privateMarkerPresent: true }).kind).toBe('skip');
  });

  /**
   * Blindness keeps its own name the whole way down. `unknown` is never
   * resolved toward `skip`: "could not tell" costs one `git fetch upstream`,
   * and reading it off a transcript as "checked and clean" is what makes a
   * guard decorative in the exact state where it cannot see.
   */
  test('an unfetched upstream is unknown, not skipped', () => {
    expect(scanScope(UNFETCHED, { privateMarkerPresent: true }).kind).toBe('unknown');
  });

  test('a branch descended from both mains is unknown, not skipped', () => {
    const both: BranchFacts = { ...OSS_BOUND, originIsAncestor: true };
    expect(scanScope(both, { privateMarkerPresent: true }).kind).toBe('unknown');
  });

  test('the three exit codes are distinct', () => {
    expect(new Set([EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN]).size).toBe(3);
  });
});

describe('findInternalRefs — what must not travel', () => {
  test('a bb thread id is refused and named', () => {
    const refs = findInternalRefs(`// ${'thr_'}k3n8x2qw9d saw this fail under load`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rule).toBe('bb thread id');
    expect(refs[0]?.line).toBe(1);
  });

  test('a bb board key is refused', () => {
    const refs = findInternalRefs(`// see ${'MX'}-269 for why the load gate reads two averages`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rule).toBe('bb board key');
  });

  test('every bb board project prefix is covered', () => {
    for (const prefix of ['MX', 'AB', 'BC', 'MO', 'HA']) {
      expect(findInternalRefs(`ref ${prefix}-12 here`)).toHaveLength(1);
    }
  });

  /**
   * THE LOAD-BEARING HALF. `SC-` references are WANTED upstream — 1110 of the
   * mirror's 2090 tracked files carry one, measured 2026-08-25. A blanket
   * "no ticket references" rule would be wrong about the majority of the
   * repository, would fire on ordinary work, and would therefore be turned
   * off — which is worse than no rule at all.
   */
  test('an SC- reference is clean, because it is wanted upstream', () => {
    expect(findInternalRefs('// SC-123: the rollup reads the pool')).toHaveLength(0);
    expect(findInternalRefs('fix(gate): name the database (SC-500)')).toHaveLength(0);
  });

  test('a bb board prefix that is part of a longer word is not a board key', () => {
    expect(findInternalRefs('the token 0xABC-0x3 in a fixture')).toHaveLength(0);
    expect(findInternalRefs('MAX-12 and TMO-3 are not board keys')).toHaveLength(0);
  });

  test('an internal hostname is refused', () => {
    for (const host of ['admin', 'bb', 'hass', 'track']) {
      const refs = findInternalRefs(`https://${host}.${'scani.xyz'}/x`);
      expect(refs).toHaveLength(1);
      expect(refs[0]?.rule).toBe('internal hostname');
    }
  });

  /**
   * The must-be-ABSENT control on the hostname rule. The first five are the
   * only `scani.xyz` subdomains the mirror carries, at 188 occurrences between
   * them — a rule that fired on any would fire on the product itself. `status`
   * is the sixth deliberately: it looked internal, and the evidence says
   * otherwise. `docs/SELF_HOST.md` sends a self-hoster to it by name, so it is
   * a published surface rather than infrastructure, and it was dropped from
   * the forbidden set on that.
   */
  test('the product hostnames are clean', () => {
    for (const host of ['app', 'api', 'cloud', 'demo', 'docs', 'status']) {
      expect(findInternalRefs(`https://${host}.scani.xyz/x`)).toHaveLength(0);
    }
  });

  test('a bb worktree path is refused', () => {
    expect(findInternalRefs(`cd ~/.${'bb'}/worktrees/env_x/scani`)).toHaveLength(1);
    expect(findInternalRefs(`$HOME/.${'bb'}/plugins/browser`)).toHaveLength(1);
  });

  test('a machine-local home path is refused', () => {
    const refs = findInternalRefs(`read /Users/${'someone'}/Projects/scani/.secrets`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rule).toBe('machine-local home path');
  });

  test('a real Sentry DSN is refused', () => {
    const dsn = `https://${'0123456789abcdef0123456789abcdef'}@o12345.ingest.us.sentry.io/678`;
    const refs = findInternalRefs(dsn);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rule).toBe('Sentry DSN');
  });

  /**
   * THE MUST-BE-ABSENT CONTROL ON THE MONITORING RULE, and the reason it is
   * keyed on coordinates rather than on the vendor's name. `Sentry` appears in
   * 101 of the mirror's files — the SDK, the env schema, the CSP — so banning
   * the word would refuse a hundred files of legitimate, already-published
   * integration. Both strings below are real mirror content: a CSP wildcard
   * and a documentation placeholder. What must not travel is the DSN that
   * names our own project, and only that has a credential in front of the `@`.
   */
  test('a CSP wildcard and a placeholder DSN are clean', () => {
    expect(findInternalRefs('connect-src https://*.ingest.sentry.io')).toHaveLength(0);
    expect(
      findInternalRefs("optionalUrl.parse('https://o12345.ingest.sentry.io/678')")
    ).toHaveLength(0);
  });

  test('a PostHog project key is refused', () => {
    const refs = findInternalRefs(`POSTHOG_KEY=${'phc_'}${'a'.repeat(24)}`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rule).toBe('PostHog project key');
  });

  /**
   * The decision, recorded where it can go red rather than in a PR comment.
   * Naming a monitoring vendor is not the leak; our coordinates within it are.
   * PostHog additionally needs no word-level rule here — it lives in
   * `packages/infra/analytics`, which is private-only, and a path guard
   * already refuses that.
   */
  test('naming a monitoring vendor is not itself a leak', () => {
    expect(findInternalRefs('import * as Sentry from "@sentry/node";')).toHaveLength(0);
    expect(findInternalRefs('// PostHog capture happens server-side')).toHaveLength(0);
  });

  test('several references in one file are all reported, with their lines', () => {
    const refs = findInternalRefs(
      ['clean line', `// ${'thr_'}k3n8x2qw9d`, 'also clean', `// ${'AB'}-42`].join('\n')
    );
    expect(refs.map((r) => r.line)).toEqual([2, 4]);
  });

  test('an empty file is clean', () => {
    expect(findInternalRefs('')).toHaveLength(0);
  });
});

/**
 * The guard applied to itself. Both of these files are oss-eligible and will
 * be published, so if either carried a live pattern the check would refuse the
 * commit that adds it — and the regexes are written the way they are (escaped
 * separators, non-capturing alternations) specifically so their own source
 * text does not match them. That reasoning is easy to get wrong by one
 * character, so it is measured here rather than trusted.
 */
test("the check's own sources carry no internal reference", () => {
  // Resolved from this file rather than from the working directory: the mirror
  // is where this test matters most and is the one place nobody will be
  // standing in the repo root when it runs.
  for (const rel of [
    'scripts/check-oss-internal-refs.ts',
    'scripts/tests/check-oss-internal-refs.test.ts',
  ]) {
    const source = readFileSync(path.resolve(import.meta.dir, '../..', rel), 'utf8');
    expect(findInternalRefs(source).map((r) => `${rel}:${r.line} ${r.rule}`)).toEqual([]);
  }
});
