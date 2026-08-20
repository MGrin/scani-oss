/**
 * HTML entities in provider-supplied display text, decoded once at the
 * boundary where that text is normalised (SC-276).
 *
 * mgrin saw this on his phone's Top holdings:
 *
 *     VOO   VANGUARD S&amp;P 500 ETF
 *     XUU   ISHARES CORE S&amp;P US TOTAL MA
 *
 * Both are Interactive Brokers rows. IBKR serves an HTML-derived instrument
 * description, so `S&P` arrives as `S&amp;P` and ingestion stored it verbatim.
 *
 * **Not an IBKR special case, and not a rendering fix.** Any provider with an
 * HTML-derived feed can do this, and `&amp;` is only the most visible entity —
 * `&#39;` inside an apostrophe is subtler and equally wrong. Decoding at render
 * would leave the database holding text that is false, and every other consumer
 * still sees it: exports, the PDF statement, and search. Search is the sharp
 * one — somebody typing `S&P` cannot match these rows at all today.
 *
 * **Exactly one pass, deliberately.** `&amp;amp;` decodes to `&amp;` and stops
 * there, because that is what the provider's own escaping meant. Looping until
 * no entity remains would turn a legitimate product literally named `&amp;` in
 * the source data into `&`, and there is no way back from that.
 *
 * A bare `&` is left alone: `AT&T` is a real name, not a broken entity.
 */

/**
 * The named entities an HTML-derived feed actually produces. Deliberately not
 * the full HTML5 table (2,231 names): every additional name is another chance
 * to rewrite text that was never an entity, and a ticker or instrument name
 * containing `&sect` is likelier to be data than markup.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** `&amp;` `&#39;` `&#x27;` — named, decimal, hexadecimal. */
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/**
 * Code points we refuse to produce, whatever the entity asked for.
 *
 * A provider cannot make us write a NUL or a C0 control into a display column;
 * those break Postgres text handling and CSV alike, and no instrument name
 * needs one. The entity is left as written so the oddity stays visible rather
 * than becoming an invisible byte.
 */
function isRenderable(codePoint: number): boolean {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return false;
  // C0 controls except tab/newline/carriage return, and the C1 block.
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
    return false;
  }
  if (codePoint >= 0x7f && codePoint <= 0x9f) return false;
  // Lone surrogates are not characters and `String.fromCodePoint` will throw.
  return !(codePoint >= 0xd800 && codePoint <= 0xdfff);
}

/**
 * Decode HTML entities in one pass. Returns the input unchanged when there is
 * nothing to decode, so this is safe to call on every field.
 */
export function decodeProviderText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(ENTITY, (match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return isRenderable(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    // An unknown name is left exactly as it was found: it is far likelier to be
    // data that happens to look like an entity than markup we failed to list.
    return NAMED[body.toLowerCase()] ?? match;
  });
}

/**
 * `undefined`/`null` pass through, so call sites stay expression-shaped.
 *
 * The return is `string` for a string input, NOT `T`. Declaring `T` said the
 * output was the same literal as the input — so `decodeProviderTextOptional(
 * 'S&amp;P')` was typed `'S&amp;P'`, the one value it can never be. Decoding
 * is the whole point of the call, and a signature that denies it made
 * comparing the result to the decoded string a type error.
 */
export function decodeProviderTextOptional<T extends string | null | undefined>(
  raw: T
): T extends string ? string : T {
  return (typeof raw === 'string' ? decodeProviderText(raw) : raw) as T extends string ? string : T;
}

/** True when decoding would change the value — for reporting and dry runs. */
export function hasEncodedEntity(raw: string): boolean {
  return decodeProviderText(raw) !== raw;
}
