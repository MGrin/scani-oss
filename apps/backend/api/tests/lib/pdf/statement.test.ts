import { describe, expect, it } from 'bun:test';
import type { ExportValueDtoType } from '@scani/shared';
import { documentText, renderStatement, type StatementInput } from '../../../src/lib/pdf/statement';

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

  it('renders a CJK name in the faces it already has, and does not fail', async () => {
    const pdf = await renderStatement(named('三菱UFJ銀行'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // No Plex face covers Han, so the marker is set in the face already there.
    // What must not happen is a new face appearing, or a throw.
    expect(embeddedFaces(pdf)).toEqual(embeddedFaces(await renderStatement(named('Mitsubishi'))));
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
