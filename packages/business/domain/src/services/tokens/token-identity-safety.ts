import { SCAM_PROBABILITY_THRESHOLD } from '../../lib/constants';
import { decodeForDetection } from '../../lib/decode-for-detection';

/**
 * Is this token's identity trying to be another token's identity?
 *
 * EVM token discovery is unlimited by construction: anyone can deploy a
 * contract, airdrop it to a wallet, and have it appear in that wallet's
 * `tokentx` history under any name and symbol they like. Two of those
 * choices are attacks rather than metadata.
 *
 * 1. A symbol built from LOOKALIKE CHARACTERS. `UЅDС` — Cyrillic Ѕ,
 *    Cyrillic С — is a different string from `USDC` and an identical
 *    picture. Ten of these were sitting in production on Polygon, 45% of
 *    that chain's entire token set, indistinguishable in every surface
 *    that prints a symbol (SC-197).
 *
 * 2. A NAME that is an instruction rather than a name.
 *    `✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP` is an attack we ingested
 *    and would render.
 *
 * These get different treatments, because they are different risks:
 *
 * - The lookalike symbol is QUARANTINED, not rejected. The danger is not
 *   that the row exists, it is that the row is indistinguishable from the
 *   real one — so the fix is to make it distinguishable. Storing
 *   `lookalikeOf` is the first half of that and only the first half: a
 *   column no surface reads leaves the row exactly as indistinguishable as
 *   it was. It shipped alone for a while, nine marked rows deep in
 *   production, and was worth nothing to a user until the holdings list
 *   started printing what the symbol imitates (SC-219). Any NEW surface
 *   that prints a symbol has to read this column too — it does not arrive
 *   there by itself.
 *   Rejecting would also mean the one case that actually matters — a user
 *   who was tricked into BUYING one and holds a real balance — shows them
 *   nothing at all, and nothing reads as safe.
 *
 * - The attack name is REJECTED at discovery, because there is no reading
 *   of it that is a token identity, and no balance worth preserving
 *   behind it.
 *
 * Deliberately NOT keyed on `is_scam_probability`: that column's 0.3
 * bucket contains USDT, so it cannot carry a decision. This module
 * answers a narrow, checkable question instead.
 */

// Characters that render as an ASCII letter but are not one. Cyrillic and
// Greek supply most of the useful collisions; Lisu turns up in the wild
// because its letters are near-perfect capital Latin shapes and it is far
// enough off the beaten path to miss naive filters. Fullwidth forms round
// it out.
//
// This does not have to be exhaustive to be correct: a character that is
// not in this map and not ASCII still fails the ASCII test below, which
// is what actually decides. The map only improves the ATTRIBUTION — which
// real symbol the impostor is reaching for.
const CONFUSABLE_TO_ASCII: Readonly<Record<string, string>> = {
  // Cyrillic
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  Ѕ: 'S',
  І: 'I',
  Ј: 'J',
  Ԁ: 'D',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  // Greek
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  ο: 'o',
  ρ: 'p',
  // Lisu
  ꓐ: 'B',
  ꓑ: 'P',
  ꓒ: 'Q',
  ꓓ: 'D',
  ꓔ: 'T',
  ꓖ: 'G',
  ꓗ: 'K',
  ꓘ: 'K',
  ꓙ: 'J',
  ꓚ: 'C',
  ꓛ: 'C',
  ꓜ: 'Z',
  ꓝ: 'F',
  ꓞ: 'F',
  ꓟ: 'M',
  ꓠ: 'N',
  ꓡ: 'L',
  ꓢ: 'S',
  ꓣ: 'R',
  ꓤ: 'R',
  ꓥ: 'V',
  ꓦ: 'V',
  ꓧ: 'H',
  ꓨ: 'G',
  ꓩ: 'J',
  ꓪ: 'W',
  ꓫ: 'X',
  ꓬ: 'Y',
  ꓮ: 'A',
  ꓰ: 'E',
  ꓱ: 'E',
  ꓲ: 'I',
  ꓳ: 'O',
  ꓴ: 'U',
  ꓵ: 'U',
  ꓶ: 'U',
  ꓷ: 'D',
  ꓸ: '.',
  ꓹ: ',',
  // Armenian / Georgian strays that read as Latin
  Ց: 'S',
  Օ: 'O',
  Ո: 'N',
};

// ASCII printable. A token symbol is a ticker; every legitimate one in
// crypto, equities and fiat is expressible here.
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

// Combining marks, stripped after NFKD so `Ú` skeletonises to `U`.
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * The ASCII shape a symbol PRESENTS AS, regardless of what it is made of.
 * `UЅDС` → `USDC`. `ÚSDС` → `USDC`. `ꓴꓢꓓC` → `USDC`.
 *
 * This is the whole point of the module: two different strings that draw
 * the same picture collapse to one key, so we can say which real symbol
 * an impostor is reaching for instead of only that it is odd.
 */
export function asciiSkeleton(symbol: string): string {
  return foldConfusables(symbol).toUpperCase();
}

/**
 * {@link asciiSkeleton} without the uppercasing.
 *
 * Split out for {@link normalizeForDetection}, which feeds patterns that are
 * not all case-insensitive and has no business changing the case of text it
 * did not come to change. `asciiSkeleton` keeps folding case because it builds
 * a comparison KEY — `UЅDС` and `uѕdс` must collapse onto the same `USDC`.
 */
function foldConfusables(value: string): string {
  const mapped = [...value].map((ch) => CONFUSABLE_TO_ASCII[ch] ?? ch).join('');
  return mapped.normalize('NFKD').replace(COMBINING_MARKS, '');
}

/**
 * The string the CONTENT rules should judge, rather than the one that arrived
 * (SC-281).
 *
 * Two channels let an attacker write a host that our regexes cannot see:
 *
 * 1. HTML entities — `yield-farming&period;io`. Closed by
 *    {@link decodeForDetection}, which enumerates every named entity that
 *    produces an ASCII character rather than chasing them one incident at a
 *    time. See that file for why its table can be complete where the storage
 *    decoder's deliberately is not.
 * 2. Confusable characters — a Lisu `ꓸ` or a fullwidth `．` in place of a dot.
 *    Closed by the same fold that already powers the lookalike-symbol rule.
 *
 * **This is for CONTENT rules only — never for character-class rules.** The
 * homoglyph and lookalike checks exist precisely to notice that a character is
 * not ASCII, and handing them a folded string would delete the evidence they
 * are looking for: `UЅDС` normalizes to `USDC`, and a symbol rule reading that
 * would report a clean ticker. `judgeSymbol` therefore keeps the raw symbol,
 * and `ScamTokenDetectionService` normalizes for its URL/TLD/word checks while
 * scoring emoji and homoglyphs on the original.
 *
 * Normalizing is free of the ordering hazard that SC-276 had to reason about:
 * this output is never stored, so it cannot disagree with the row it judged.
 */
export function normalizeForDetection(text: string): string {
  return foldConfusables(decodeForDetection(text));
}

/**
 * Unicode scripts present in a string, ignoring digits, punctuation and
 * spaces — those are script-neutral and appear in legitimate symbols
 * (`BRK.B`, `1INCH`).
 *
 * Two or more scripts in one symbol is the signature the lookalike cannot
 * avoid: to draw `USDC` it must borrow at least one letter from Latin.
 */
export function scriptsOf(value: string): string[] {
  const scripts = new Set<string>();
  for (const ch of value) {
    if (/[\d\s\p{P}\p{S}]/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) scripts.add('Latin');
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add('Cyrillic');
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add('Greek');
    else if (/\p{Script=Han}/u.test(ch)) scripts.add('Han');
    else if (/\p{Script=Arabic}/u.test(ch)) scripts.add('Arabic');
    else if (/\p{Script=Hebrew}/u.test(ch)) scripts.add('Hebrew');
    else if (/\p{Script=Lisu}/u.test(ch)) scripts.add('Lisu');
    else scripts.add('Other');
  }
  return [...scripts].sort();
}

export interface SymbolVerdict {
  /** True when the symbol cannot be trusted to read as what it draws. */
  lookalike: boolean;
  /**
   * The ASCII symbol this one presents as — what a reader will believe
   * they are looking at. Null when the symbol is already plain ASCII.
   */
  lookalikeOf: string | null;
  /** Why, in words a log line or an admin screen can print. */
  reasons: string[];
}

/**
 * Judge a symbol. Plain ASCII passes; anything else is a lookalike.
 *
 * The strictness is deliberate and it is the part worth arguing about, so:
 * a symbol is a TICKER, not prose. Crypto, equity and fiat tickers are
 * ASCII without exception in any venue we ingest from, and the cost of
 * being wrong is asymmetric — a legitimate non-ASCII symbol quarantined
 * is a flag to flip, while a lookalike admitted is an asset successfully
 * claiming to be USDC. Quarantine rather than rejection is what makes
 * that trade cheap enough to take.
 *
 * NAMES are judged separately and much more loosely — see
 * {@link nameIsAttack}. Real projects have non-ASCII names; none of them
 * need a non-ASCII ticker.
 */
export function judgeSymbol(symbol: string): SymbolVerdict {
  const reasons: string[] = [];
  if (ASCII_PRINTABLE.test(symbol)) {
    return { lookalike: false, lookalikeOf: null, reasons };
  }

  reasons.push('symbol contains characters outside ASCII printable');
  const scripts = scriptsOf(symbol);
  if (scripts.length > 1) {
    reasons.push(`symbol mixes scripts: ${scripts.join(' + ')}`);
  }

  const skeleton = asciiSkeleton(symbol);
  // Only claim impersonation when the skeleton is itself a plausible
  // ticker. A symbol of genuinely non-Latin text (a CJK-named asset, say)
  // skeletonises to something that is still not ASCII, and calling that
  // "impersonating" would be a false accusation dressed as a fact.
  const impersonates = ASCII_PRINTABLE.test(skeleton) ? skeleton : null;
  if (impersonates) reasons.push(`renders as "${impersonates}"`);

  return { lookalike: true, lookalikeOf: impersonates, reasons };
}

/**
 * Is this NAME an attack rather than a name?
 *
 * Kept separate from the symbol rule because the two fields have
 * different legitimate ranges. A name can be any language; what it cannot
 * be is a call to action with a destination. So this matches on CONTENT —
 * URLs, hosts, link shorteners, imperatives — not on character class.
 *
 * The pattern set is the one that already lived in the Etherscan
 * provider's spam filter, extended with the link shorteners it missed.
 *
 * DO NOT remove the imperative pattern on the belief that the domain
 * pattern covers it. Before `.ly` was added below, the production row
 * `✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP` was matched ONLY by
 * `(?:swap|claim).{0,256}on` — the domain list had no `.ly` and `T.LY`
 * sailed through it. The two rules caught this string by luck rather
 * than by design, and each still covers cases the other does not: a bare
 * `bit.ly/x` has no imperative, and `CLAIM YOUR REWARD NOW` has no host.
 *
 * Bounded quantifiers throughout: `.{0,256}` keeps these linear-time
 * (CodeQL js/polynomial-redos) without changing behaviour on real input.
 */
/**
 * A BARE HOST IS NOT AN ATTACK, and reading it as one refused six real
 * equities at ingest (SC-220). `judgeTokenIdentity` throws on `nameAttack`,
 * so a user importing Amazon from a broker had the token creation refused
 * outright — this was never a script-only false positive:
 *
 *   AMAZON.COM INC · SALESFORCE.COM INC · BOOKING.COM
 *   MATCH.COM · PRICELINE.COM · OVERSTOCK.COM
 *
 * IBKR supplies full legal names, so that is the normal import path, not
 * an edge case. What separates those from the real attacks is the PATH:
 * every phishing name carries a destination after the host —
 * `T.LY/SHIBASWAP`, `WR.DO/S/ETHER`, `bit.ly/free-tokens` — because the
 * point of the string is to send someone somewhere. `AMAZON.COM INC` has
 * nowhere to send anyone.
 *
 * So a host counts when it carries a path, and a KNOWN SHORTENER counts
 * either way — nobody's legal name is `bit.ly`, and a bare shortener is
 * already the whole payload.
 *
 * Scoping this to non-stock token types was considered and rejected: it
 * would miss a crypto project legitimately named after a domain, and it
 * would stop protecting stock imports, which is precisely where attack
 * names arriving as airdrops land.
 */

/** Hosts whose only purpose is to redirect. A bare one needs no path. */
const SHORTENER_HOSTS =
  /\b(?:bit\.ly|t\.ly|wr\.do|tinyurl\.com|cutt\.ly|is\.gd|goo\.gl|t\.co|rb\.gy|rebrand\.ly|ow\.ly|buff\.ly|shorturl\.at|s\.id|t\.me|discord\.gg)\b/i;

/**
 * A host followed by a path — `example.com/anything`. The trailing `\/\S`
 * is the whole discriminator: it demands somewhere to go, which is what a
 * legal name never has and an attack string always does.
 */
const HOST_WITH_PATH =
  /\b[a-z0-9][a-z0-9-]*\.(?:com|xyz|cc|io|app|eu|org|net|ly|gg|to|me|link|club|vip|top|live|site|online|do|info|ru|tk)\/\S/i;

const ATTACK_NAME_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /www\./i,
  HOST_WITH_PATH,
  SHORTENER_HOSTS,
  /claim|visit|reward|bonus|airdrop|voucher|giveaway|winner|prize/i,
  /^\$/,
  /telegram/i,
  /(?:swap|claim|connect|verify|unlock).{0,256}(?:on|at|via|now)\b/i,
  /<|>|\{|\}|\[|\]/,
];

export function nameIsAttack(name: string): boolean {
  const normalized = normalizeForDetection(name);
  return ATTACK_NAME_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * A host with NOTHING after it — `Draf.io`, `BOOKING.COM`, `#HEXPool.net`.
 *
 * Not a verdict on its own, and this is the shape of the whole problem
 * (SC-224). Both populations are full of bare hosts and no rule over the
 * string separates them:
 *
 *   legitimate:  BOOKING.COM  MATCH.COM  PRICELINE.COM  OVERSTOCK.COM
 *   scam:        Draf.io  EthFork2.com  Aintiution.io  #HEXPool.net
 *
 * The TLD does not split them either — `EthFork2.com` is a `.com` scam.
 * Treating a bare host as an attack blocked six real equity imports
 * (SC-220); treating it as harmless admitted seven live scam rows
 * (SC-224). It is evidence, and only evidence.
 */
export function nameHasBareHost(name: string): boolean {
  return BARE_HOST.test(normalizeForDetection(name));
}

const BARE_HOST =
  /\b[a-z0-9][a-z0-9-]*\.(?:com|xyz|cc|io|app|eu|org|net|ly|gg|to|me|link|club|vip|top|live|site|online|do|info|ru|tk)\b/i;

export interface IdentityVerdict extends SymbolVerdict {
  /** True when the NAME is an instruction — reject rather than quarantine. */
  nameAttack: boolean;
  /** True when the row should exist but must never read as canonical. */
  quarantine: boolean;
}

/**
 * The whole judgement for one incoming token identity.
 *
 * `nameAttack` is for the caller to refuse on. `quarantine` is for the
 * caller to persist — the row is created, and it carries a permanent
 * statement that it is not what it appears to be.
 *
 * TWO KINDS OF NAME ATTACK, and the second one needs the score.
 *
 * A name that SENDS you somewhere — a path, a shortener, an imperative —
 * is refused on the string alone. A name that is merely a bare host is
 * refused only when `scamProbability` is also elevated, because no rule
 * over the string separates `BOOKING.COM` from `Draf.io`.
 *
 * Measured on the production population: every equity scores 0.00 (the
 * score is computed for crypto only, so a legal name never reaches it)
 * and every bare-host scam scores 0.70–0.80. The conjunction is what
 * works — NOT the score by itself, which does not separate these
 * populations at all:
 *
 *   Curve DAO Token  0.80     #HEXPool.net      0.80
 *   Lido DAO Token   0.80     yield-farming.io  0.80
 *   1inch Network    0.80     Draf.io           0.80
 *   Uniswap          0.70     dev dao giveaway  0.70
 *
 * Those legitimate tokens are admitted because they carry no host, not
 * because of their score. Requiring both signals is the entire mechanism.
 *
 * PASS THE CREATION-TIME SCORE, NEVER THE STORED COLUMN.
 * `tokens.is_scam_probability` is re-written downward once a price
 * arrives (SC-207), so a rule reading it would admit today what it
 * refused yesterday for reasons the token had no part in.
 * `TokenIdentityService` computes this fresh from symbol and name with
 * `hasPriceData: false` immediately before calling here, which is
 * deterministic and does not drift. A retroactive caller must recompute
 * the same way rather than read the row.
 *
 * Omitting `scamProbability` means "no evidence", and a bare host alone
 * then never refuses — the safe direction, because the failure it avoids
 * (blocking a real import) is worse than the one it allows.
 *
 * IF YOU ARE VERIFYING THIS FUNCTION, PASS THE SCORE. Calling it bare and
 * observing that `#HEXPool.net` is admitted does not show a hole; it shows
 * the permissive default doing its job. That check has already been run
 * twice and read as a failure both times — once against a live fix that
 * was in fact correct. What the ingest path does is
 * `judgeTokenIdentity({ symbol, name, scamProbability })`, and a
 * verification that does not include the third field is testing a
 * different question than the one it thinks it is asking.
 */
export function judgeTokenIdentity(identity: {
  symbol: string;
  name?: string | null;
  /** Creation-time score, recomputed — not `tokens.is_scam_probability`. */
  scamProbability?: number;
}): IdentityVerdict {
  const symbolVerdict = judgeSymbol(identity.symbol);
  const sendsYouSomewhere = identity.name ? nameIsAttack(identity.name) : false;
  const bareHost = identity.name ? nameHasBareHost(identity.name) : false;
  const scoreElevated = (identity.scamProbability ?? 0) >= SCAM_PROBABILITY_THRESHOLD;
  const hostWithElevatedScore = bareHost && scoreElevated;

  const nameAttack = sendsYouSomewhere || hostWithElevatedScore;
  const reasons = [...symbolVerdict.reasons];
  if (sendsYouSomewhere) reasons.push('name reads as an instruction, not a name');
  if (hostWithElevatedScore) {
    reasons.push(
      `name is a bare host and the token scores ${identity.scamProbability?.toFixed(2)} on other signals`
    );
  }
  return {
    ...symbolVerdict,
    reasons,
    nameAttack,
    quarantine: symbolVerdict.lookalike || nameAttack,
  };
}
