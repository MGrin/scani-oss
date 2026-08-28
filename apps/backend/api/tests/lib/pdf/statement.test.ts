import { describe, expect, it } from 'bun:test';
import { inflateSync } from 'node:zlib';
import type { ExportValueDtoType } from '@scani/shared';
import { loadTypesetter, UNSUPPORTED_MARK } from '../../../src/lib/pdf/fonts';
import {
  documentText,
  renderStatement,
  type StatementInput,
  UNSUPPORTED_NOTE,
} from '../../../src/lib/pdf/statement';

/**
 * The renderer end to end, at the only level worth asserting on bytes: that a
 * document came out, that it is a PDF, and that it has the number of pages the
 * layout said it would.
 *
 * Everything *about* the layout is tested in `layout.test.ts`, on numbers. What
 * this file catches is the wiring underneath — the embedded faces loading, the
 * page count matching the flow, and the footer's out-of-flow trick not adding a
 * blank page after every one, which it did once and turned three pages into nine.
 */

function money(value: string): ExportValueDtoType {
  return { kind: 'number', value, decimals: 2, style: 'money', currency: 'EUR' };
}

function input(rowCount: number, extra: Partial<StatementInput['sheet']> = {}): StatementInput {
  return {
    account: 'Ada Lovelace (ada@example.com)',
    sheet: {
      name: 'Holdings',
      headers: ['Holding', 'Account', 'Value (EUR)'],
      numericColumns: [false, false, true],
      totalColumns: [false, false, true],
      rows: Array.from({ length: rowCount }, (_, index) => [
        { kind: 'text', value: `Holding ${index}` } as ExportValueDtoType,
        { kind: 'text', value: 'Kraken · Main' } as ExportValueDtoType,
        money((1000 + index).toFixed(2)),
      ]),
      ...extra,
    },
    provenance: {
      subject: 'Holdings',
      scope: `All ${rowCount} holdings`,
      generatedAt: '2026-08-14T09:31:00.000Z',
      details: [{ label: 'Sorted by', value: 'Value, high to low' }],
      rowCount,
      amountsWithheld: false,
    },
  };
}

/** `/Type /Page` appears once per page and `/Pages` is the tree node, so the
 *  count is the difference. Crude, and exactly as crude as it needs to be. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe('renderStatement', () => {
  it('produces a PDF', async () => {
    const pdf = await renderStatement(input(3));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(4_000);
  });

  it('renders one page for a short list', async () => {
    expect(pageCount(await renderStatement(input(5)))).toBe(1);
  });

  it('breaks a long list across pages, and adds no blank ones', async () => {
    // The footer is drawn below the bottom margin, and pdfkit answers text past
    // the margin by starting a page — which turned a 3-page statement into 9.
    const pdf = await renderStatement(input(90));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(6);
  });

  it('renders a grouped list without falling over its own headings', async () => {
    const pdf = await renderStatement(
      input(30, {
        groups: [
          { label: 'Kraken · Main', rowCount: 12 },
          { label: 'Ledger Nano · Cold', rowCount: 18 },
        ],
        groupColumn: 1,
      })
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('renders an empty selection as one page rather than none', async () => {
    expect(pageCount(await renderStatement(input(0)))).toBe(1);
  });
});

/**
 * SC-127. A name outside the Latin subset used to draw as empty boxes, and
 * nothing about the document said so — same page count, same size, same
 * everything a test could see.
 *
 * `/BaseFont /XXXXXX+IBMPlexSans` appears once per *embedded subset*, and pdfkit
 * only embeds a face it actually drew with. So the count is the observable
 * proof: a statement whose vendor is `Сбербанк` carries a face the Latin-only
 * one does not, which it could only have done by drawing those letters with it.
 */
function embeddedFaces(pdf: Buffer): string[] {
  const matches = pdf.toString('latin1').match(/\/BaseFont \/[A-Z]+\+[A-Za-z]+/g) ?? [];
  return [...new Set(matches)];
}

function named(...names: string[]): StatementInput {
  const base = input(names.length);
  return {
    ...base,
    sheet: {
      ...base.sheet,
      rows: names.map((name, index) => [
        { kind: 'text', value: name } as ExportValueDtoType,
        { kind: 'text', value: 'Kraken · Main' } as ExportValueDtoType,
        { kind: 'number', value: `${1000 + index}`, decimals: 2, style: 'money', currency: 'EUR' },
      ]),
    },
  };
}

describe('non-Latin names', () => {
  it('embeds the face that covers a Cyrillic name', async () => {
    const latin = embeddedFaces(await renderStatement(named('Vanguard', 'Kraken')));
    const cyrillic = embeddedFaces(await renderStatement(named('Сбербанк', 'Kraken')));
    expect(cyrillic.length).toBeGreaterThan(latin.length);
  });

  it('embeds a face for Latin Extended, which the latin subset does not carry', async () => {
    const latin = embeddedFaces(await renderStatement(named('Zabka Polska')));
    const extended = embeddedFaces(await renderStatement(named('Żabka Polska')));
    expect(extended.length).toBeGreaterThan(latin.length);
  });

  /**
   * THIS ASSERTION WAS DELIBERATELY INVERTED BY SC-782, and the old claim is
   * kept here because a reader needs to know it was a decision.
   *
   * It read `renders a CJK name in the faces it already has, and does not
   * fail`, and asserted that a CJK name embeds EXACTLY the faces a Latin name
   * does — i.e. that no new face appears. That was the correct pin while no
   * bundled face covered Han: the only safe thing to do with `三菱UFJ銀行` was
   * mark it in a face already on the page.
   *
   * A Han face now ships, so a new face appearing is precisely what must
   * happen, and the old assertion would have gone green only if the font had
   * failed to load. Inverting it quietly is how a pin becomes a rubber stamp,
   * so the new claim is written out rather than edited into place.
   */
  it('embeds a Han face for a CJK name, which a Latin name does not carry', async () => {
    const pdf = await renderStatement(named('三菱UFJ銀行'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const latin = embeddedFaces(await renderStatement(named('Mitsubishi')));
    const cjk = embeddedFaces(pdf);
    // The claim is the DIFFERENCE, not a vendor's name. `/BaseFont` carries the
    // face's PostScript name rather than the label this module registers runs
    // under, so matching on `Han` would assert against a string the font file
    // chooses and Fontsource has already made misleading once
    // (`NotoSansJPThin-Regular` is a 400 cut).
    expect(cjk.filter((face) => !latin.includes(face))).not.toHaveLength(0);
    expect(cjk.length).toBeGreaterThan(latin.length);
  });

  /**
   * THE CONTROL THAT MAKES PARTIAL COVERAGE SAFE (SC-782).
   *
   * Bundling a Han frequency subset covers 10036 codepoints and leaves the rest
   * of Han uncovered on purpose, on the argument that a gap degrades LOUDLY:
   * the mark is per codepoint, and the metadata line tells the reader where the
   * full name is. That argument is worth exactly nothing unmeasured — a subset
   * that happened to cover every sample anyone thought of would satisfy every
   * other assertion in this file.
   *
   * So: a Han codepoint chosen to be OUTSIDE the shipped subset, and both arms.
   * One is not enough — the mark can fire while the note regresses, and the note
   * is the half that says where to get the name.
   *
   * The sample is DERIVED, not named. A literal rare codepoint would be a
   * hardcoded stand-in for `uncovered`, which is the exact defect this ticket
   * moved three assertions in `fonts.test.ts` to fix.
   */
  describe('a Han codepoint outside the shipped subset', () => {
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
     */
    function decodeDestination(hex: string): number {
      const units: number[] = [];
      for (let index = 0; index + 4 <= hex.length; index += 4) {
        units.push(Number.parseInt(hex.slice(index, index + 4), 16));
      }
      return String.fromCharCode(...units).codePointAt(0) as number;
    }

    function drawnCodepoints(pdf: Buffer): Set<number> {
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
          for (const range of text.matchAll(
            /<[0-9a-fA-F]{4}>\s*<[0-9a-fA-F]{4}>\s*\[([^\]]*)\]/g
          )) {
            for (const item of (range[1] as string).matchAll(/<([0-9a-fA-F]{4,})>/g)) {
              found.add(decodeDestination(item[1] as string));
            }
          }
          for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
            for (const pair of (block[1] as string).matchAll(
              /<[0-9a-fA-F]{4}>\s*<([0-9a-fA-F]{4,})>/g
            )) {
              found.add(decodeDestination(pair[1] as string));
            }
          }
        }
        match = streams.exec(latin1);
      }
      return found;
    }

    /** The first Han codepoint the bundled faces do not cover. */
    async function rareHan(): Promise<string> {
      const type = await loadTypesetter();
      for (let point = 0x20000; point <= 0x2a6df; point += 1) {
        const character = String.fromCodePoint(point);
        if (!type.supports(character)) return character;
      }
      return '';
    }

    it('control — such a codepoint exists to test with', async () => {
      // Without this, every assertion below is satisfied by an empty string.
      // If it ever reds, the subset grew to cover all of Han and THAT is the
      // finding — not a reason to delete the control.
      const sample = await rareHan();
      expect(sample).not.toBe('');
      expect(sample.codePointAt(0)).toBeGreaterThan(0x4e00);
    });

    it('control — a COVERED Han codepoint is visible to this probe', async () => {
      // The must-be-FOUND control for the probe itself. `is marked` asserts a
      // rare codepoint is ABSENT from the drawn set, and absence is what a
      // broken reader reports about everything — so that assertion is worth
      // nothing until this one shows the reader can see a Han codepoint at all.
      const drawn = drawnCodepoints(await renderStatement(named('三菱銀行')));
      expect(drawn.has('三'.codePointAt(0) as number)).toBe(true);
      expect(drawn.has('銀'.codePointAt(0) as number)).toBe(true);
    });

    it('is marked, and the mark reaches the page', async () => {
      const sample = await rareHan();
      const pdf = await renderStatement(named(`Bank ${sample}`));
      const drawn = drawnCodepoints(pdf);

      for (const character of UNSUPPORTED_MARK) {
        expect(drawn.has(character.codePointAt(0) as number)).toBe(true);
      }
      // The arm that would catch a face quietly covering it after all.
      expect(drawn.has(sample.codePointAt(0) as number)).toBe(false);
    });

    it('triggers the metadata note, which is the other half of the mark', async () => {
      // The note's signature is DERIVED: the characters it uses that nothing
      // else in this document does. Hardcoding a word out of the sentence would
      // go quiet the day the sentence is reworded.
      const plain = await renderStatement(named('Vanguard'));
      const elsewhere = drawnCodepoints(plain);
      const signature = [...new Set(UNSUPPORTED_NOTE)]
        .map((character) => character.codePointAt(0) as number)
        .filter((point) => !elsewhere.has(point));

      expect(signature.length).toBeGreaterThan(0);

      const sample = await rareHan();
      const marked = drawnCodepoints(await renderStatement(named(`Bank ${sample}`)));
      for (const point of signature) expect(marked.has(point)).toBe(true);
    });

    it('control — a fully covered name draws neither the mark nor the note', async () => {
      // The must-be-ABSENT arm. Without it both assertions above are satisfied
      // by a document that always prints the note, which is a different bug.
      const drawn = drawnCodepoints(await renderStatement(named('Vanguard')));
      expect(drawn.has('['.codePointAt(0) as number)).toBe(false);
    });
  });

  it('gathers every string the document sets, so the note cannot miss one', () => {
    const statement = named('Сбербанк');
    const sheet = {
      ...statement.sheet,
      groups: [{ label: 'Банки', rowCount: 1 }],
    };
    const text = documentText(statement, sheet);

    expect(text).toContain('Сбербанк');
    expect(text).toContain('Банки');
    expect(text).toContain(statement.account);
    expect(text).toContain('Holding');
    expect(text).toContain('Value, high to low');
  });
});

/**
 * SC-129. pdfkit resolves its default face, Helvetica, by reading
 * `node_modules/pdfkit/js/data/Helvetica.afm` at construction time. That path
 * exists in every dev tree and in none of the runtime images, which hold only
 * the compiled binary — so a `new PDFDocument()` without an explicit `font`
 * renders perfectly in every test and throws ENOENT on the first export in
 * production. It did.
 *
 * This is asserted on the source rather than on behaviour on purpose: the
 * failure is unreachable from a test that runs where `node_modules` exists, so
 * there is nothing to observe. What can be pinned is the invariant that made it
 * possible — every document this module opens names its own face.
 */
describe('pdfkit default-font trap', () => {
  it('never constructs a PDFDocument without an explicit font', async () => {
    const source = await Bun.file(
      new URL('../../../src/lib/pdf/statement.ts', import.meta.url)
    ).text();

    const constructions = source.match(/new PDFDocument\((?:[^)]|\([^)]*\))*\)/g) ?? [];
    expect(constructions.length).toBeGreaterThan(0);

    // Each call must carry the shared face — either inline as `font:` or via the
    // spread that holds it. A bare `new PDFDocument()` is the exact defect.
    for (const call of constructions) {
      expect(call).toMatch(/font:|startWithOwnFace/);
    }
  });
});
