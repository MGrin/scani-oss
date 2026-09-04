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
//
// `--scan` READS THE INDEX, NOT THE WORKING TREE — `git show :0:<path>`, the
// same population `--cached` gives the diff mode. An edit you have not staged
// is not in what it scanned, and it reports the same count either way.

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
 * THE FALSE-ADMISSION RATE THE DISTINCT-SYMBOL ARM IS ALLOWED TO SPEND.
 *
 * 1e-5, and it is not a number invented here. SC-954 put this exact question
 * about the neighbouring `longestRun >= 6` arm — which admits a real v4 UUID at
 * a measured 0.0029% — and that rate was accepted on 2026-09-02 as the hole
 * this guard is willing to carry. This budget is strictly tighter than the arm
 * already in the tree, so it introduces no tolerance the file did not already
 * carry.
 */
export const SYNTHETIC_ADMISSION_BUDGET = { numerator: 1n, denominator: 100_000n };

function binomial(n: number, k: number): bigint {
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
  return r;
}

/** Strings of length `n` over `k` symbols using AT MOST `d` distinct ones. */
function stringsWithAtMostDistinct(n: number, k: number, d: number): bigint {
  let total = 0n;
  for (let j = 1; j <= d; j++) {
    let surjections = 0n;
    for (let i = 0; i <= j; i++) {
      const term = binomial(j, i) * BigInt(j - i) ** BigInt(n);
      surjections += i % 2 === 0 ? term : -term;
    }
    total += binomial(k, j) * surjections;
  }
  return total;
}

const ceilingCache = new Map<string, number>();

/**
 * THE LARGEST DISTINCT-SYMBOL COUNT THE ARM MAY ADMIT AT `n` SYMBOLS DRAWN FROM
 * AN ALPHABET OF `k` — a false-admission RATE expressed as a count, rather than
 * a count somebody picked.
 *
 * WHY THIS IS NOT A THIRD THRESHOLD (SC-971). What this replaces was
 * `distinct <= k / 2`, a constant. Every other arm of {@link looksSynthetic}
 * sits near 1e-5 at every length it meets; this one swung five orders of
 * magnitude, because a constant symbol count is a STATISTICAL test wearing a
 * STRUCTURAL threshold. Exactly, over uniform strings, `P(distinct <= k/2)`:
 *
 *      8 decimal digits   41.032%        32 hex digits   0.00027%
 *      9 decimal digits   25.156%        40 hex digits   0.0000011%
 *     10 decimal digits   14.646%        64 hex digits   ~0
 *
 * `\d{8,}` is the `account-number` rule's own minimum, so the arm was widest
 * exactly where account numbers live: two of every five 8-digit account numbers
 * were admitted without review. That is the second hole found in this one
 * function — SC-954 was the first — and two holes from one constant is why the
 * repair is the criterion rather than the number.
 *
 * BOTH OBVIOUS REPAIRS STILL DO NOT WORK, and they are recorded because a
 * reader will reach for them again. A FLAT `<= 8 distinct` is a fair test of a
 * 32-hex identifier and no test at all of a ten-digit one. SCALING TO LENGTH
 * fixes that and breaks the other end: `length / 4` is 16 for a 64-hex
 * transaction hash, which no hex string can ever exceed, so every one of them
 * read as synthetic. Both were caught by the must-fire fixtures rather than by
 * review, and both are still covered by them.
 *
 * CLAMPED TO `k / 2`, WHICH MAKES THIS A PURE TIGHTENING. At 40 and 64 hex
 * digits the budget alone would allow 9 and 11 distinct where the constant
 * allowed 8, and a guard change that ADMITS what it used to refuse is a
 * relaxation however well argued. Nothing moves from refused to admitted; only
 * short decimals move the other way.
 *
 * IT RETURNS 1 FOR AN 8- OR 9-DIGIT DECIMAL, WHICH MAKES THE ARM INERT THERE,
 * AND THAT IS THE HONEST ANSWER RATHER THAN A DEGENERATE ONE. A count of 1 is
 * an all-one-digit value, which `longestRun >= 6` already admits — so at those
 * lengths this arm says it has nothing to add, because no distinct-symbol count
 * separates a hand-written value from an account number over eight digits. The
 * other four arms — run, periodic, sequential, doubled — carry the shape on
 * their own, and a synthetic short decimal that none of them recognises needs
 * {@link ASSERTED_NOT_PRODUCTION}, which is a line in a diff somebody reviews.
 *
 * The derived ceiling, at the lengths this guard actually meets — pinned in
 * `check-oss-data-shapes.test.ts` so a reader can check the threshold by
 * looking at it, which is the property every other arm here has:
 *
 *      8 decimal   1      16 decimal  3      32 hex  8   (unchanged)
 *      9 decimal   1      24 decimal  4      40 hex  8   (clamped from 9)
 *     10 decimal   2      32 decimal  5      64 hex  8   (clamped from 11)
 *
 * EXACT, NEVER SAMPLED. `#strings of length n over k symbols using at most d
 * distinct` is `sum_j C(k,j) * Surj(n,j)`, compared with `budget * k^n` as
 * whole numbers, so the verdict carries no floating-point rounding and is the
 * same on every machine that runs it.
 */
export function distinctCeiling(n: number, k: number): number {
  const clamp = Math.floor(k / 2);
  // At 64 symbols the clamp is already far inside any budget this guard would
  // set: `P(distinct <= d) <= C(k,d) * (d/k)^n`, which at `d = k/2` is at most
  // `C(16,8) * 2^-64`, about 7e-16. Short-circuiting keeps the exact arithmetic
  // off a token long enough to make `k^n` expensive to compute.
  if (n >= 64) return clamp;
  const key = `${n}:${k}`;
  const memo = ceilingCache.get(key);
  if (memo !== undefined) return memo;
  const total = BigInt(k) ** BigInt(n);
  let best = 0;
  for (let d = 1; d <= clamp; d++) {
    const admitted = stringsWithAtMostDistinct(n, k, d) * SYNTHETIC_ADMISSION_BUDGET.denominator;
    if (admitted > SYNTHETIC_ADMISSION_BUDGET.numerator * total) break;
    best = d;
  }
  ceilingCache.set(key, best);
  return best;
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
 *   too few distinct symbols        judged against chance at this length and
 *                                   alphabet — {@link distinctCeiling}, never a constant
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
  // FEWER DISTINCT SYMBOLS THAN CHANCE PRODUCES AT THIS LENGTH AND ALPHABET.
  // The threshold is derived rather than chosen — see {@link distinctCeiling}.
  if (new Set(s).size <= distinctCeiling(s.length, alphabetOf(s))) return true;
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
    //
    // SC-918 triaged the whole tree rather than one landing, so the entries
    // below arrive in one block. Each is a deployed contract, a published
    // specimen, or a fixture whose structure is what it tests — never a value
    // read off an account.
    //
    // DEPLOYED CONTRACTS. A contract address is published by its own
    // deployment: it is on every block explorer before this repository names
    // it, and naming it discloses nothing about who used it. Aave V2's
    // WETHGateway and the LendingPool behind it — both already named in
    // `RepairProtocolDepositOutflowsUseCase`'s protocol table, which is the
    // point of that table.
    '0xcc9a0b7c43dc2a5f023bb9b738e45b0ef6b06e04',
    '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
    // 0x Protocol's ExchangeProxy. The vanity prefix is the tell.
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
    // SocketGateway, identified from its verified source before a bridge leg
    // was ever accepted through it.
    '0x3a23f943181408eac424116af7b7790c94cb97a5',
    // POL on Ethereum, already carried by `well-known-ids.ts` — which is
    // exempt by path, so the value reaches this list only through a test.
    '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6',
    // The ERC-20 that shares BONK's symbol on Ethereum and is the reason
    // token identity needs an authority at all. A contract, not a holder.
    '0xf2b2c2a4e4eae02ba07decece8d831b11bd7a350',
    //
    // PUBLISHED SPECIMENS, the address-shaped equivalent of the RFC-4122 UUID
    // above. The first is the example address wallet documentation has used
    // for years; the second is this repository's one-character variant of it.
    // Both sit beside the Bitcoin genesis address and wrapped SOL's mint in
    // the fixtures that use them, and for the same reason.
    '0x742d35cc6634c0532925a3b844bc454e4438f44e',
    '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
    //
    // FIXTURES WHOSE STRUCTURE IS THE TEST. The address-poisoning pair differs
    // in its final character and nothing else; that difference IS the fixture,
    // so replacing either value would leave every test built on it asserting
    // nothing. {@link looksSynthetic} cannot admit them — a pair that differs
    // in one character has to look like two real addresses to be worth testing.
    '0x7a3f91b2c4d5e6f708192a3b4c5d6e7f8091a2b3',
    '0x7a3f91b2c4d5e6f708192a3b4c5d6e7f8091a2b4',
    // `1234567890abcdef` walked twice and truncated. Hand-written, and it
    // misses `isPeriodic` only because 40 is not a multiple of 16.
    '0x1234567890abcdef1234567890abcdef12345678',
    // The v3 peek sheet's "long, unbroken identifier" — a layout fixture that
    // exists to make a value column wrap rather than truncate, and shipped
    // with the design system rather than with any ledger work.
    '0x7f2c9a4b1d8e6f30a2c5b7e9d1f4a68c0b3e5d72',
    // drizzle-kit's own snapshot id, written by the generator into the
    // migration journal. It identifies a schema snapshot, not a row.
    'f37aaae9-601c-46ab-968d-b01da1842f50',
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
 *
 * AND THE COST WAS REAL, WITHIN A DAY (SC-918). `check-oss-data-shapes.test.ts`
 * carried a row identifier that the pre-rewrite mirror proves was PUBLISHED —
 * it is one of the values `0044` leaked, and the backup at that path is the
 * must-be-PRESENT control that makes the reading decisive rather than an
 * absence. Four sites, in a file this list makes unscannable, on an
 * `oss-eligible` path. It is gone; the lesson is that these five files are
 * audited BY HAND or not at all, and "a reviewer can hold all of it" is the
 * whole safety argument rather than a remark.
 *
 * HOW TO AUDIT ONE. Ask whether the value predates the guard: a fixture minted
 * for it appears in the commit that wrote it and nowhere else in the history,
 * while a leaked value appears in the migration or repair script it came from.
 * `git log --all -S<value> --name-only` separates the two in one step.
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
    // THE FIXTURE SITS INSIDE THE HOLE, WHICH IS THE POINT (SC-971). The value
    // here was `5426392559` — six distinct symbols, so it fired under the
    // `distinct <= alphabet / 2` constant as well as under what replaced it,
    // and a fixture that fires under both CANNOT report the hole between them.
    // The guard shipped with the arm admitting two of every five eight-digit
    // account numbers and this self-test was green throughout.
    //
    // `52255232` is eight digits over three distinct symbols, longest run 2,
    // neither periodic nor sequential — invented here, and squarely in the
    // 41.032% the constant admitted. Any future loosening of that arm now
    // fails the self-test at EVERY invocation of this guard rather than only
    // in the test file, and a failed self-test scans nothing.
    mustFire: "expect(memo).toBe('Deposit to account 52255232');",
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

/**
 * The identifiers on paths this tree does not publish — NAMED, never counted
 * toward the refusal, and never with their values.
 *
 * Silence here would be the defect this whole family is about. A scan scoped
 * to the published paths and reporting nothing else is indistinguishable from
 * a scan that read the whole tree and found it clean, and the difference is
 * roughly a hundred real identifiers. Naming the files says which question was
 * answered. Printing the VALUES would republish them into every CI log that
 * runs the check, which is the thing the guard exists to stop.
 */
function reportUnpublished(unpublished: readonly Finding[]): void {
  if (unpublished.length === 0) return;
  const files = [...new Set(unpublished.map((f) => f.path))].sort();
  console.error(
    `\n  ${unpublished.length} more opaque identifier(s) in ${files.length} file(s) this tree does NOT publish — reported, not refused. Values withheld deliberately:`
  );
  for (const path of files) console.error(`    ${path}`);
}

function report(
  findings: readonly Finding[],
  tail: string,
  unpublished: readonly Finding[] = []
): number {
  if (findings.length === 0) {
    console.log(`oss-data-shapes: PASS · exit ${EXIT_OK} · ${tail}, 0 opaque identifier(s)`);
    reportUnpublished(unpublished);
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
  reportUnpublished(unpublished);
  return EXIT_REFUSED;
}

export interface ScanOptions {
  /**
   * WHETHER A PATH IS ONE THIS TREE DOES NOT PUBLISH.
   *
   * ABSENT MEANS EVERY TRACKED PATH IS PUBLISHED, which is the truth in
   * `MGrin/scani-oss` and is why this is an injected option rather than an
   * import. The module that knows which paths stay private is itself private,
   * so a guard that named it would not resolve in the mirror — and this guard
   * travels. `scripts/check-oss-mirror-shapes.ts` is the private caller that
   * supplies it.
   *
   * THE DEFAULT IS THE CLOSED ONE. With no predicate every finding counts
   * toward the refusal, so a caller that forgets to pass one gets the stricter
   * answer rather than a quiet pass.
   */
  readonly unpublished?: (path: string) => boolean;
}

export function main(
  argv: readonly string[],
  cwd: string,
  stdin: string,
  opts: ScanOptions = {}
): number {
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
    const unpublished: Finding[] = [];
    let scanned = 0;
    for (const path of paths.filter(scannable)) {
      const read = runGit(['show', `:0:${path}`], cwd);
      // FAIL CLOSED, and this used to be `unreadable++; continue`. A file the
      // scan could not open was counted in the tail and changed no exit code,
      // so an unreadable tree — a corrupt object, a `git` that stopped
      // answering partway — read as a clean one with a smaller denominator
      // than anybody was checking. That is fine for an audit somebody reads
      // and fatal for a check that blocks: NOTHING IS KNOWN about a file that
      // was not read, and this mode is now the blocking one.
      if (read.kind !== 'ran') {
        console.error(
          `oss-data-shapes: UNKNOWN · exit ${EXIT_UNKNOWN} · could not read \`${path}\` from the index — ${read.why} — THE SCAN IS INCOMPLETE, which is not a pass`
        );
        return EXIT_UNKNOWN;
      }
      const content = read.stdout;
      if (content.includes('\0')) continue;
      scanned++;
      const published = opts.unpublished === undefined || !opts.unpublished(path);
      const into = published ? findings : unpublished;
      content.split('\n').forEach((text, i) => {
        for (const f of findInLine(text)) into.push({ path, line: i + 1, ...f });
      });
    }
    return report(
      findings,
      `${RULE_COUNT} rule(s) self-tested, ${scanned} of ${paths.length} tracked file(s) scanned${opts.unpublished === undefined ? '' : ', published paths only'}`,
      unpublished
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
