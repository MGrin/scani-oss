/**
 * HTML entities decoded for a DETECTOR to judge — not for storage (SC-281).
 *
 * This is the deliberate opposite of {@link decodeProviderText}, and the two
 * must not be merged. They answer different questions:
 *
 *   decodeProviderText   "what did the provider MEAN?"   -> gets stored
 *   decodeForDetection   "what could this BECOME?"       -> never stored
 *
 * `decodeProviderText`'s named table is six entries on purpose: every extra
 * name is another chance to rewrite text that was never an entity, and it
 * writes its answer into a display column where there is no way back. That
 * minimality is correct, and coupling it to a threat model would destroy the
 * rationale for it.
 *
 * The consequence was an evasion. `nameIsAttack` keys on a literal `.`, so
 * `yield-farming&#46;io` was refused only because the storage decoder happens
 * to handle numeric entities, while `yield-farming&period;io` — the same
 * string, one entity name further out — was ADMITTED. Measured before the fix:
 *
 *     yield-farming.io           score 0.50  bareHost true   refused
 *     yield-farming&#46;io       score 0.50  bareHost true   refused
 *     yield-farming&period;io    score 0.00  bareHost false  ADMITTED
 *     #HEXPool&period;net        score 0.50  bareHost false  ADMITTED
 *     T&period;LY&sol;SHIBASWAP  score 0.40  attack   false  ADMITTED
 *
 * ## Why this table can be complete where the storage one cannot
 *
 * The objection to "just add `&period;`" is that the next evasion is `&sol;`,
 * then `&commat;`, forever. That is true of a list grown one incident at a
 * time. It is NOT true of the list below, because the thing being enumerated
 * is finite: **every HTML5 named entity whose expansion is an ASCII
 * character**. ASCII has 95 printable characters and the entity names for
 * them are a closed set. Once they are all here the named-entity channel is
 * shut, not narrowed, and `&sol;` and `&commat;` are already in it.
 *
 * Over-decoding is free here in a way it never is for storage: the output is
 * a throwaway string handed to a regex. The cost of being wrong is a false
 * positive on one judgement, not a corrupted display column.
 *
 * ## What this does NOT close
 *
 * Percent-encoding (`%2E`) and URL-shaped escapes are not decoded. No feed we
 * ingest produces them and no surface renders them as a dot, so decoding them
 * would invent attacks rather than reveal them. Legacy semicolon-less entities
 * (`&amp` with no `;`) are also skipped: HTML5 allows them only for a fixed
 * list, none of which produces a separator.
 */

/**
 * Group 1 — every HTML5 named entity that expands to an ASCII character.
 *
 * Complete by construction. The aliases (`QUOT`/`quot`, `lsqb`/`lbrack`) are
 * all real HTML5 names, not defensive guesses; leaving one out would leave a
 * hole exactly the size of the one this file exists to close.
 */
const ASCII_NAMED: Readonly<Record<string, string>> = {
  Tab: '\t',
  NewLine: '\n',
  excl: '!',
  quot: '"',
  QUOT: '"',
  num: '#',
  dollar: '$',
  percnt: '%',
  amp: '&',
  AMP: '&',
  apos: "'",
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  lt: '<',
  LT: '<',
  equals: '=',
  gt: '>',
  GT: '>',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  Hat: '^',
  lowbar: '_',
  UnderBar: '_',
  grave: '`',
  DiacriticalGrave: '`',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  VerticalLine: '|',
  rcub: '}',
  rbrace: '}',
};

/**
 * Group 2 — entities whose expansion is NOT ASCII but reads as ASCII
 * punctuation, and which NFKD does not fold on its own.
 *
 * The confusable fold that runs after this decode (`normalizeForDetection`)
 * handles anything NFKD can reach — `&#xFF0E;`, the fullwidth stop, arrives as
 * a real character and folds to `.` without help. These four do not: U+00A0,
 * U+2010 and U+2212 have no NFKD path to their ASCII twin, so if the decoder
 * skips them they survive as the literal text `&hyphen;` and the fold never
 * sees a character at all.
 */
const ASCII_LOOKALIKE_NAMED: Readonly<Record<string, string>> = {
  nbsp: ' ',
  NonBreakingSpace: ' ',
  hyphen: '-',
  dash: '-',
  minus: '-',
};

const NAMED: Readonly<Record<string, string>> = { ...ASCII_NAMED, ...ASCII_LOOKALIKE_NAMED };

/** `&amp;` `&#46;` `&#x2E;` — named, decimal, hexadecimal. */
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/**
 * Named lookup is CASE-SENSITIVE, unlike the storage decoder's.
 *
 * HTML5 distinguishes `&Hat;` from a hypothetical `&hat;`, and folding case
 * would make `&LT;` and `&lt;` collide harmlessly but `&Tab;`/`&tab;` collide
 * wrongly. Every alias that genuinely exists is listed above instead.
 */
function decodeNamed(name: string): string | null {
  return NAMED[name] ?? null;
}

/**
 * Numeric entities are decoded to whatever they name, with no renderability
 * filter.
 *
 * The storage decoder refuses to write a C0 control into a display column;
 * this one has no column to protect, and a control character smuggled into a
 * name is more interesting to a detector than a reason to give up on it.
 * Lone surrogates are still skipped because `String.fromCodePoint` throws.
 */
function decodeNumeric(body: string): string | null {
  const codePoint = body.startsWith('#x')
    ? Number.parseInt(body.slice(2), 16)
    : Number.parseInt(body.slice(1), 10);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  return String.fromCodePoint(codePoint);
}

/**
 * Decoding runs to a FIXED POINT, where storage decodes exactly once.
 *
 * `&amp;period;` decodes to `&period;` and then to `.`. Storage stops after
 * one pass because a second would destroy a product genuinely named `&amp;` in
 * the source data — an irreversible edit to a stored string. A detector has
 * nothing to destroy: it is asking how many wrappers deep the dot is, and the
 * answer for an attacker is "as many as it takes".
 *
 * Each pass strictly shortens the string, so the cap is a backstop against a
 * future table entry that expands rather than contracts, not a live limit.
 */
const MAX_PASSES = 4;

export function decodeForDetection(raw: string): string {
  let current = raw;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (!current.includes('&')) return current;
    const next = current.replace(ENTITY, (match, body: string) => {
      const decoded = body.startsWith('#') ? decodeNumeric(body) : decodeNamed(body);
      return decoded ?? match;
    });
    if (next === current) return current;
    current = next;
  }
  return current;
}
