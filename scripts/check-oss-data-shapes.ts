#!/usr/bin/env bun
// Refuse a change that carries an OPAQUE IDENTIFIER into MGrin/scani-oss.
//
// WHY THIS EXISTS (SC-838, after the 2026-09-01/02 exposure). Every guard that
// stood between the private tree and this repository detects a CLAIM — a
// sentence pairing a scope word with a measurement. What actually leaked was
// DATA: a bank account number, a named individual beside a payment amount, four
// wallet addresses, a transaction hash, 283 row identifiers, an invoice number.
// None of those carries a scope word or a measurement, so `check-oss-prose`,
// `check-oss-internal-refs` and `check-oss-bound-paths` all pass them. Three
// separate waves were found by a person reading files.
//
// THE ASYMMETRY THAT MAKES THIS TRACTABLE, and it is the opposite of the prose
// problem: DATA HAS STRONG SHAPES AND PROSE DOES NOT. `check-oss-prose` had to
// stay advisory because a sentence that looks like a deployment claim usually
// is not one. A 40-hex-digit string after `0x` is an EVM address and nothing
// else; there is no interpretation to get wrong.
//
// SO WHAT IS THE FALSE POSITIVE? Not the shape — the PROVENANCE. WETH's
// contract address is exactly as address-shaped as a user's wallet and is
// public knowledge. That is the whole difficulty, and it is bounded in a way
// the prose problem is not: the set of public constants a codebase legitimately
// hardcodes is small, enumerable, and changes rarely.
//
// TWO THINGS SEPARATE THEM, and neither is a judgement call:
//
//   1. STRUCTURE. A synthetic identifier is written by a person and looks it:
//      `0xc0ffee11223344556677889900aabbccddeeff01`,
//      `5c331000-0000-4000-8000-000000000001`,
//      `0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789`.
//      Production identifiers are uniformly random and have none of it.
//      {@link looksSynthetic} is that test, and it is measured rather than
//      asserted — see its docblock for both directions.
//   2. AN ALLOWLIST, for the real-but-public remainder. It is short because it
//      only has to cover what a change ADDS: everything already in the tree is
//      never re-added and so is never judged.
//
// THE ALLOWLIST IS THE ONLY ESCAPE, AND THAT IS DELIBERATE. There is no
// `OSS_ALLOW_...` environment variable here, unlike every other guard in this
// directory. An environment variable is set by whoever is blocked, at the
// moment they are blocked, and leaves nothing behind; an allowlist entry is a
// line in a diff, with a name on it, that somebody reviews. The exposure this
// guard exists for was not caused by a missing check — it was caused by nobody
// looking.
//
// Usage:
//   bun scripts/check-oss-data-shapes.ts --stdin-commits   # additions in commits on stdin
//   bun scripts/check-oss-data-shapes.ts                   # staged additions
//   bun scripts/check-oss-data-shapes.ts --scan            # audit the whole tree

import { existsSync } from 'node:fs';
import {
  type AddedLine,
  addedLines,
  collectBranchFacts,
  isScannable,
  refArg,
} from './check-oss-figures';
import { type RepoFacts, scanScope } from './check-oss-internal-refs';
import { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN, type GitRun, runGit } from './lib/check-verdict';

/**
 * The guard could not verify itself. Its own code rather than a refusal,
 * because it says nothing about the content that was scanned — and never
 * {@link EXIT_OK}, because an instrument that cannot demonstrate it still works
 * has not checked anything.
 */
export const EXIT_SELF_TEST_FAILED = 10;
export { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN };

/**
 * How many symbols this token could have drawn from — 16 if any of `a`-`f`
 * appears, 10 otherwise.
 *
 * A hex string that happens to use no letters is read as decimal, which makes
 * the threshold STRICTER rather than looser: it exempts less. That is the safe
 * direction for a guard whose exemptions are admissions.
 */
function alphabetOf(s: string): number {
  return /[a-f]/.test(s) ? 16 : 10;
}

/** The characters a token is judged on: hex digits, dashes and `0x` removed. */
function symbols(token: string): string {
  return token.replace(/^0x/i, '').replace(/-/g, '').toLowerCase();
}

function longestRun(s: string): number {
  let best = 1;
  let current = 1;
  for (let i = 1; i < s.length; i++) {
    current = s[i] === s[i - 1] ? current + 1 : 1;
    if (current > best) best = current;
  }
  return s.length === 0 ? 0 : best;
}

/** Whether `s` is some prefix of itself repeated — `abcabcabc`, `0101010101`. */
function isPeriodic(s: string): boolean {
  for (let period = 1; period <= Math.floor(s.length / 2); period++) {
    if (s.length % period !== 0) continue;
    const unit = s.slice(0, period);
    if (unit.repeat(s.length / period) === s) return true;
  }
  return false;
}

/**
 * Whether `s` walks the alphabet — `0123456789abcdef`, `1234567890`, either way.
 *
 * Both wraps are accepted because the token may be hex or decimal and the
 * function is not told which: `9 -> 0` ends a decimal run and `f -> 0` a hex
 * one. Rejecting the decimal wrap is what made `1234567890` read as opaque,
 * which the must-not-fire fixture caught.
 */
function isSequential(s: string): boolean {
  if (s.length < 8) return false;
  const step = (a: string, b: string) => Number.parseInt(b, 16) - Number.parseInt(a, 16);
  const first = step(s[0] as string, s[1] as string);
  if (first !== 1 && first !== -1) return false;
  for (let i = 2; i < s.length; i++) {
    const d = step(s[i - 1] as string, s[i] as string);
    if (d !== first && d !== -9 * first && d !== -15 * first) return false;
  }
  return true;
}

/**
 * Whether `s` is written in doubled characters — `c0ffee11223344556677889900`.
 *
 * This is how a person writes a long identifier by hand, and it is the arm the
 * other four miss: `0xc0ffee11223344556677889900aabbccddeeff01` uses 16 distinct
 * symbols, has no run of 6, and is neither periodic nor sequential, so without
 * this it reads as production data. The must-not-fire fixture caught it.
 *
 * Half the pairs is far above anything chance produces: a uniformly random hex
 * string doubles about one pair in sixteen, and the 200-UUID control below is
 * what confirms the margin rather than the arithmetic.
 */
function isDoubled(s: string): boolean {
  if (s.length < 16) return false;
  let doubled = 0;
  const pairs = Math.floor(s.length / 2);
  for (let i = 0; i + 1 < s.length; i += 2) if (s[i] === s[i + 1]) doubled++;
  return doubled / pairs >= 0.5;
}

/**
 * WHETHER A PERSON WROTE THIS IDENTIFIER RATHER THAN A DATABASE.
 *
 * This is the load-bearing predicate: everything it calls synthetic is admitted
 * without review, so an arm that is too generous is a hole and an arm that is
 * too strict is noise that gets the guard switched off. Both directions are
 * measured against the mirrored tree, 2026-09-02.
 *
 * WHAT IT ADMITS, and the numbers are the reason each arm exists:
 *
 *   run of >= 6 identical symbols   `5c331000-0000-4000-8000-000000000001`
 *   <= half its own alphabet     a value drawing on few of the symbols it could
 *   periodic                        `0xabcdef0123…` repeated to length
 *   sequential                      `0x1234…` or `1234567890`, either wrap
 *   doubled                         `0xc0ffee11223344556677889900aabbccddeeff01`
 *
 * Of the 334 RFC-4122 UUIDs in the tree, 308 are admitted by the first two arms
 * alone — 285 of them the `5c331000-…` series SC-916 wrote to replace the row
 * identifiers that leaked. Of the 26 remaining, 3 are the RFC-4122 example
 * UUID and 1 is a Drizzle snapshot id, both allowlisted below; the other 22 are
 * a genuine residual, reported rather than admitted.
 *
 * THE NEGATIVE CONTROL, and it is the arm that matters: 200 freshly generated
 * v4 UUIDs were classified, and 200 of 200 came back NOT synthetic. An
 * exemption that also admitted real identifiers would be worse than no guard,
 * because it would be a guard somebody trusts.
 *
 * IT IS NOT AN ENTROPY ESTIMATE, deliberately. Shannon entropy over 32 hex
 * digits is too noisy a statistic at that length to threshold safely, and a
 * threshold nobody can predict is one that fires on real work. Every arm here
 * is a property a reader can check by looking at the value.
 */
export function looksSynthetic(token: string): boolean {
  const s = symbols(token);
  if (s.length === 0) return true;
  if (longestRun(s) >= 6) return true;
  // KEYED TO THE TOKEN'S OWN ALPHABET, and neither obvious alternative works.
  //
  // A FLAT `<= 8 distinct` is a fair test of a 32-hex identifier and no test at
  // all of a ten-digit one: decimal draws from ten symbols and a random
  // ten-digit number averages six or seven distinct, so `5426392559` — an
  // account number, the shape this guard exists for — read as synthetic.
  //
  // SCALING TO LENGTH fixes that and breaks the other end, because hex has only
  // sixteen symbols to draw from however long the string is: `length / 4` is 16
  // for a 64-hex transaction hash, which no hex string can ever exceed, so
  // every one of them read as synthetic. Both were caught by the must-fire
  // fixtures rather than by review.
  //
  // Half the alphabet is far below what chance produces — a random 32-hex
  // string averages 15 distinct of a possible 16, and a random ten-digit number
  // 6.5 of 10 — and the 200-UUID control is what confirms the margin.
  if (new Set(s).size <= alphabetOf(s) / 2) return true;
  if (isPeriodic(s)) return true;
  if (isSequential(s)) return true;
  if (isDoubled(s)) return true;
  return false;
}

/**
 * VALUES A PERSON HAS ASSERTED ARE NOT PRODUCTION DATA.
 *
 * Two kinds, and they need one mechanism rather than two because the question
 * they answer is the same one — *did this come off a real account?*
 *
 *   REAL AND PUBLIC. WETH's contract address is exactly as address-shaped as a
 *   user's wallet and is public knowledge.
 *
 *   SYNTHETIC BUT NOT STRUCTURED. This repository's fixture convention writes a
 *   pronounceable word in hex and then walks a stride — `0xa11ce…` for alice,
 *   `0xb0b1…` for bob. {@link looksSynthetic} does not admit those: they use 16
 *   distinct symbols, have no run, and are neither periodic, sequential nor
 *   doubled. Measured over the 20 landings before 2026-09-02, they are the ONLY
 *   thing this guard reported that was not a genuine residual — 15 of 15
 *   findings across the two refused landings, both of them privacy scrubs
 *   introducing these two values.
 *
 * SO THE LIST GROWS WHEN SOMEBODY INVENTS A NEW FIXTURE, AND THAT IS THE POINT.
 * A value a mechanical test cannot tell from production data needs a person to
 * say which it is, and a line in a diff is where that assertion is durable and
 * attributable. The alternative — loosening {@link looksSynthetic} until the
 * convention slips through — widens the hole for every value shaped like it,
 * including the real ones.
 *
 * SHORT BY CONSTRUCTION rather than by discipline: only what a change ADDS is
 * judged, so the 47 CoinGecko contracts and the rest of the tree's existing
 * identifiers never reach this list.
 */
export const ASSERTED_NOT_PRODUCTION: ReadonlySet<string> = new Set(
  [
    // The RFC-4122 specimen UUID and the two neighbours the batch DTO tests
    // count off from it.
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
    '550e8400-e29b-41d4-a716-446655440002',
    // WETH, and USDC on Ethereum, Base, Polygon and Arbitrum — hardcoded by a
    // migration and a returns test, and public knowledge.
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    // The fixture pair SC-915 and SC-916 wrote in place of the wallet addresses
    // that leaked. alice, and bob.
    '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
    '0xb0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9',
  ].map((v) => v.toLowerCase())
);

/**
 * Files whose content is identifiers BY DESIGN.
 *
 * A PATH EXEMPTION IS BROADER THAN A VALUE EXEMPTION AND IS USED HERE ANYWAY,
 * for two reasons, one per group. `well-known-ids.ts` is a table of third-party
 * token contracts that grows whenever a chain is added, so listing its 47
 * values individually would put the allowlist's maintenance on the wrong side
 * of every routine change — and a list nobody can keep up with is a list
 * somebody deletes. This guard's own two files must contain a value of every
 * shape it refuses or its must-fire fixtures could not fire.
 *
 * THE COST IS STATED: a private identifier pasted into one of these five files
 * is not seen here. Nothing else in the tree gets this treatment, and the list
 * is short enough that a reviewer can hold all of it.
 */
export const IDENTIFIER_BY_DESIGN_PATHS: readonly string[] = [
  'packages/clients/providers/src/providers/coingecko/well-known-ids.ts',
  'packages/clients/providers/tests/providers/coingecko-wellknown-positive-match.test.ts',
  'packages/clients/providers/tests/providers/coingecko-contract-guard.test.ts',
  // THIS GUARD AND ITS TEST. Both must contain values of every shape it
  // refuses, or the must-fire fixtures could not fire, so without these two
  // entries the guard refuses every change to itself — including the change
  // that adds it. The exemption is narrow and its risk is the smallest of the
  // five: these are the two files a reviewer of this guard reads line by line.
  'scripts/check-oss-data-shapes.ts',
  'scripts/tests/check-oss-data-shapes.test.ts',
];

export interface Rule {
  readonly name: string;
  /** Global, and its first capture group is the value judged when present. */
  readonly re: RegExp;
  /** A line this rule MUST report. */
  readonly mustFire: string;
  /** A line this rule MUST NOT report — the same shape, synthetic or public. */
  readonly mustNotFire: string;
}

/**
 * WHAT A SHAPE IS. Each rule carries both of its own fixtures, so the assertion
 * that it can fire and the assertion that it can stay quiet travel with the
 * pattern rather than sitting in a test file that a pattern edit does not have
 * to touch.
 *
 * base58 chain addresses and "a capitalised name beside a payment word" are
 * NOT here, and that is a measurement rather than an omission. On the mirrored
 * tree a `[1-9A-HJ-NP-Za-km-z]{32,44}` pattern matches 99 distinct tokens
 * across 43 files — base64 blobs, integrity hashes and ordinary identifiers,
 * almost none of them Solana addresses — and there is no structural test that
 * separates them, because base58 has no fixed length or prefix to anchor on.
 * Shipping it would put this guard back in `check-oss-prose`'s position, where
 * the finding rate makes the guard advisory and an advisory guard is one nobody
 * reads. Both are worth revisiting with an anchor (a `solana`-adjacent word, a
 * declared field name); neither is worth shipping at this precision.
 */
export const RULES: readonly Rule[] = [
  {
    name: 'row-identifier',
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
    mustFire: "where id = 'f269e434-c1e4-477a-ae3d-9db32ee72aa5'",
    mustNotFire: "where id = '5c331000-0000-4000-8000-000000000001'",
  },
  {
    name: 'wallet-address',
    re: /\b0x[0-9a-fA-F]{40}\b/g,
    mustFire: "const owner = '0xfd91d367ab8a3722031528e5a5c6a08b743aef80';",
    mustNotFire: "const owner = '0xc0ffee11223344556677889900aabbccddeeff01';",
  },
  {
    name: 'transaction-hash',
    re: /\b0x[0-9a-fA-F]{64}\b/g,
    mustFire: "const tx = '0xd6233689dbc66c118b8639808426e2d192c15b49408833fe9e2cec914dc50a77';",
    mustNotFire: "const tx = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';",
  },
  {
    name: 'account-number',
    // The keyword carries the meaning; the digits alone are a version, a
    // timestamp or a row count. The capture is what gets judged.
    re: /\b(?:account|acct|deposit|iban|payout|invoice|reference)\b[^0-9\n]{0,24}(\d{8,})\b/gi,
    mustFire: "expect(memo).toBe('Deposit to account 5426392559');",
    mustNotFire: "expect(memo).toBe('Deposit to account 1234567890');",
  },
];

export const RULE_COUNT = RULES.length;

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly value: string;
}

/** Every opaque identifier in one line, by rule. Public constants excluded. */
export function findInLine(text: string): { rule: string; value: string }[] {
  const out: { rule: string; value: string }[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      const value = m[1] ?? m[0];
      if (ASSERTED_NOT_PRODUCTION.has(value.toLowerCase())) continue;
      if (looksSynthetic(value)) continue;
      out.push({ rule: rule.name, value });
    }
  }
  return out;
}

/**
 * Every rule still behaves as written, checked before anything is scanned.
 *
 * A rule that stopped firing is a hole, and a rule that stopped staying quiet
 * is noise; a table with only one of the two fixtures can go silently wrong in
 * the direction it does not test. {@link EXIT_SELF_TEST_FAILED} rather than a
 * refusal, because neither says anything about the content.
 */
export function selfTest(): string[] {
  const broken: string[] = [];
  for (const rule of RULES) {
    const fired = findInLine(rule.mustFire).some((f) => f.rule === rule.name);
    if (!fired) broken.push(`${rule.name}: must-fire fixture no longer reports`);
    const quiet = findInLine(rule.mustNotFire).every((f) => f.rule !== rule.name);
    if (!quiet) broken.push(`${rule.name}: must-not-fire fixture now reports`);
  }
  return broken;
}

function scannable(path: string): boolean {
  return isScannable(path) && !IDENTIFIER_BY_DESIGN_PATHS.includes(path);
}

/** The population, as one diff or as a reason there is none (SC-775). */
function population(cwd: string, fromCommits: readonly string[] | null): GitRun {
  if (fromCommits === null) {
    return runGit(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], cwd);
  }
  const parts: string[] = [];
  for (const sha of fromCommits) {
    const r = runGit(
      ['diff-tree', '--no-commit-id', '-p', '--unified=0', '-r', '--diff-filter=ACMR', sha],
      cwd
    );
    if (r.kind === 'failed') return r;
    parts.push(r.stdout);
  }
  return { kind: 'ran', stdout: parts.join('\n') };
}

function report(findings: readonly Finding[], tail: string): number {
  if (findings.length === 0) {
    console.log(`oss-data-shapes: PASS · exit ${EXIT_OK} · ${tail}, 0 opaque identifier(s)`);
    return EXIT_OK;
  }
  for (const f of findings) console.error(`  ${f.path}:${f.line}  [${f.rule}]  ${f.value}`);
  console.error(
    `oss-data-shapes: REFUSED · exit ${EXIT_REFUSED} · ${tail}, ${findings.length} opaque identifier(s) in ${new Set(findings.map((f) => f.path)).size} file(s)`
  );
  console.error(
    '\n  These are bound for MGrin/scani-oss and none of them is structured the\n' +
      '  way a person writing a fixture structures one, so this check cannot tell\n' +
      '  a row identifier from a value somebody made up carefully.\n' +
      '\n' +
      '  Replace anything measured against production with a synthetic value —\n' +
      '  a repeated block, a sequence, or a ticket number in the leading digits,\n' +
      '  as `5c331000-0000-4000-8000-000000000001` does. If a value is real AND\n' +
      '  public, or is a fixture you invented, add it to\n' +
      '  ASSERTED_NOT_PRODUCTION in scripts/check-oss-data-shapes.ts —\n' +
      '  which is a line in a diff somebody reviews rather than an environment\n' +
      '  variable set by whoever is blocked. There is no environment variable\n' +
      '  here on purpose (SC-838).\n' +
      '\n' +
      '  WHAT THIS CANNOT SEE: a name, an email, a street address, a memo line.\n' +
      '  Those have no shape. Read your own diff.'
  );
  return EXIT_REFUSED;
}

export function main(argv: readonly string[], cwd: string, stdin: string): number {
  const broken = selfTest();
  if (broken.length > 0) {
    for (const b of broken) console.error(`  ${b}`);
    console.error(
      `oss-data-shapes: SELF-TEST FAILED · exit ${EXIT_SELF_TEST_FAILED} · ${broken.length} of ${RULE_COUNT * 2} fixture(s) no longer behave as written — NOTHING WAS SCANNED`
    );
    return EXIT_SELF_TEST_FAILED;
  }

  // The audit mode answers a different question from the gate — not *did this
  // change add one* but *how many are already here* — so it does not ask which
  // repository it is in. Every tree can be audited; only a mirror-bound change
  // can be refused.
  if (argv.includes('--scan')) {
    const listed = runGit(['ls-files'], cwd);
    if (listed.kind === 'failed') {
      console.error(
        `oss-data-shapes: UNKNOWN · exit ${EXIT_UNKNOWN} · could not list the tracked files to scan — ${listed.why} — NOTHING WAS SCANNED`
      );
      return EXIT_UNKNOWN;
    }
    const paths = listed.stdout.trim() === '' ? [] : listed.stdout.trim().split('\n');
    const findings: Finding[] = [];
    let scanned = 0;
    let unreadable = 0;
    for (const path of paths.filter(scannable)) {
      const read = runGit(['show', `:0:${path}`], cwd);
      let content: string;
      if (read.kind === 'ran') {
        content = read.stdout;
      } else {
        unreadable++;
        continue;
      }
      if (content.includes('\0')) continue;
      scanned++;
      content.split('\n').forEach((text, i) => {
        for (const f of findInLine(text)) findings.push({ path, line: i + 1, ...f });
      });
    }
    return report(
      findings,
      `${RULE_COUNT} rule(s) self-tested, ${scanned} of ${paths.length} tracked file(s) scanned${unreadable > 0 ? `, ${unreadable} UNREADABLE` : ''}`
    );
  }

  const scope = scanScope(collectBranchFacts(cwd, refArg(argv)), {
    privateMarkerPresent: existsSync('.private-repo'),
  } satisfies RepoFacts);
  if (scope.kind === 'unknown') {
    console.error(`oss-data-shapes: UNKNOWN · exit ${EXIT_UNKNOWN} · ${scope.why}`);
    return EXIT_UNKNOWN;
  }
  if (scope.kind === 'skip') {
    console.log(`oss-data-shapes: SKIPPED · exit ${EXIT_OK} · ${scope.why}`);
    return EXIT_OK;
  }

  const commits = argv.includes('--stdin-commits')
    ? stdin
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : null;

  const diff = population(cwd, commits);
  if (diff.kind === 'failed') {
    console.error(
      `oss-data-shapes: UNKNOWN · exit ${EXIT_UNKNOWN} · could not read the ${commits === null ? 'staged' : 'pushed'} changes — ${diff.why} — NOTHING WAS SCANNED`
    );
    return EXIT_UNKNOWN;
  }

  const added: AddedLine[] = addedLines(diff.stdout).filter((l) => scannable(l.path));
  const findings: Finding[] = [];
  for (const l of added) {
    for (const f of findInLine(l.text)) findings.push({ path: l.path, line: l.line, ...f });
  }
  return report(
    findings,
    `${RULE_COUNT} rule(s) self-tested, ${added.length} added line(s) read across ${new Set(added.map((l) => l.path)).size} path(s)${commits === null ? '' : ` in ${commits.length} pushed commit(s)`}`
  );
}

if (import.meta.main) {
  const stdin = process.argv.includes('--stdin-commits') ? await Bun.stdin.text() : '';
  process.exit(main(process.argv.slice(2), process.cwd(), stdin));
}
