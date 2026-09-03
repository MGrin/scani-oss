/**
 * `bidi-js` ships no types and has no `@types/bidi-js` on the registry
 * (checked: *does not exist in this registry*), so the surface it is used
 * through is declared here.
 *
 * Deliberately only the four members this repo calls, rather than the whole
 * eleven-member API. A declaration file is an assertion about a package's
 * behaviour that nothing checks, so the smaller it is the less of it can be
 * wrong — and the members left out are mostly the bracket maps and the
 * segment-level reordering helpers nothing here needs.
 *
 * `getReorderedString` is the odd one: `bidi.ts` never calls it, deliberately,
 * because a CHARACTER-level reorder would be undone by fontkit reversing the
 * same run a second time. It is declared because `bidi.test.ts` uses it as the
 * independent instrument the run-level reordering is checked against.
 *
 * `levels` really is a `Uint8Array` indexed by UTF-16 code unit, not by code
 * point, which is what makes it line up with `String.prototype.slice` in
 * `atLevels`.
 */
declare module 'bidi-js' {
  interface BidiParagraph {
    start: number;
    end: number;
    level: number;
  }

  interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: BidiParagraph[];
  }

  interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    getBidiCharTypeName(character: string): string;
    getMirroredCharacter(character: string): string | null;
    getReorderedString(text: string, embeddingLevels: EmbeddingLevels): string;
  }

  export default function bidiFactory(): Bidi;
}
