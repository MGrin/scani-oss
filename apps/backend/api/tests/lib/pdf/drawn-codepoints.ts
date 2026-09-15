import { inflateSync } from 'node:zlib';

// Shared by `statement.test.ts` and `statement-locales.test.ts` (SC-1199), which both
// assert on what reached the PAGE rather than on what the renderer intended.

/**
 * Unicode maps out of every subset font pdfkit embedded. pdfkit compresses
 * them, so they have to be inflated; a stream that is not a CMap inflates to
 * something without `beginbfchar` and is skipped.
 *
 * This reads the DOCUMENT rather than the renderer's intent. `supports()`
 * returning false is what the renderer decided; this is what reached the
 * page.
 */
/**
 * A CMap destination is UTF-16BE, so an astral character arrives as a
 * SURROGATE PAIR — eight hex digits, not four. Taking the first four would
 * decode `U+20000` to `0xD840`, which means an assertion that a rare Han
 * codepoint is absent could never fail whatever the document contained.
 * That is the vacuous-control shape this ticket family is about, so the
 * pair is decoded rather than truncated.
 *
 * A LIGATURE's destination is every letter it stands for — `fi` is one glyph
 * mapped to two code points, written `<0066 0069>` WITH a space — so the
 * digits may be spaced and every letter is returned. The unspaced pattern
 * skipped that entry whole and reported the `f` of Spanish `filas` missing.
 */
function decodeDestination(spaced: string): number[] {
  const hex = spaced.replace(/\s/g, '');
  const units: number[] = [];
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    units.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return [...String.fromCharCode(...units)].map((character) => character.codePointAt(0) as number);
}

export function drawnCodepoints(pdf: Buffer): Set<number> {
  const found = new Set<number>();
  const latin1 = pdf.toString('latin1');
  const streams = /stream\r?\n/g;
  let match: RegExpExecArray | null = streams.exec(latin1);
  while (match !== null) {
    const start = match.index + match[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end > 0) {
      let text = '';
      try {
        text = inflateSync(pdf.subarray(start, end)).toString('latin1');
      } catch {
        text = '';
      }
      // Two syntaxes, and reading only one of them silently under-reports.
      // pdfkit writes the ARRAY form of `bfrange` — `<lo> <hi> [<d> <d> …]`,
      // where every element is a destination — so a naive pair match reads
      // the range bounds as if they were codepoints and misses most of the
      // real ones.
      for (const range of text.matchAll(/<[0-9a-fA-F]{4}>\s*<[0-9a-fA-F]{4}>\s*\[([^\]]*)\]/g)) {
        for (const item of (range[1] as string).matchAll(/<([0-9a-fA-F][0-9a-fA-F\s]{3,})>/g)) {
          for (const point of decodeDestination(item[1] as string)) found.add(point);
        }
      }
      for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of (block[1] as string).matchAll(
          /<[0-9a-fA-F]{4}>\s*<([0-9a-fA-F][0-9a-fA-F\s]{3,})>/g
        )) {
          for (const point of decodeDestination(pair[1] as string)) found.add(point);
        }
      }
    }
    match = streams.exec(latin1);
  }
  return found;
}
