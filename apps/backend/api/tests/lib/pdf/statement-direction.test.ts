import { afterEach, describe, expect, it } from 'bun:test';
import { type ExportValueDtoType, RenderPdfInput } from '@scani/shared';
import PDFDocument from 'pdfkit';
import { MARGIN } from '../../../src/lib/pdf/layout';
import { renderStatement, type StatementInput } from '../../../src/lib/pdf/statement';

/**
 * SC-1198. A right-to-left statement starts from the right edge: the first
 * column, the mark, the metadata labels and the footer's subject sit on the
 * right, and the page numbers on the left. `bidi.ts` orders runs INSIDE a line
 * and could never move a line; this is the half that does.
 *
 * Read off the real renderer: `PDFDocument.prototype.text` and `roundedRect`
 * are wrapped for the duration of a render, so every assertion is about a call
 * that drew something on the page, at the coordinate it was drawn at. Every
 * right-to-left reading has its left-to-right control beside it — the same
 * input with the other direction — so a helper that recorded nothing, or
 * recorded the same thing twice, cannot pass.
 */

interface Drawn {
  text: string;
  left: number;
  right: number;
  y: number;
}

type TextFn = (
  this: PDFKit.PDFDocument,
  text: string,
  x?: number,
  y?: number,
  options?: PDFKit.Mixins.TextOptions
) => PDFKit.PDFDocument;
type RectFn = (
  this: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  r?: number
) => PDFKit.PDFDocument;

const proto = PDFDocument.prototype as unknown as { text: TextFn; roundedRect: RectFn };
const originalText = proto.text;
const originalRect = proto.roundedRect;

afterEach(() => {
  proto.text = originalText;
  proto.roundedRect = originalRect;
});

async function draw(input: StatementInput): Promise<{ texts: Drawn[]; marks: number[] }> {
  const texts: Drawn[] = [];
  const marks: number[] = [];
  proto.text = function (text, x = 0, y = 0, options) {
    const width = this.widthOfString(String(text), {
      characterSpacing: options?.characterSpacing ?? 0,
    });
    texts.push({ text: String(text), left: x, right: x + width, y });
    return originalText.call(this, text, x, y, options);
  };
  proto.roundedRect = function (x, y, w, h, r) {
    marks.push(x);
    return originalRect.call(this, x, y, w, h, r);
  };
  try {
    await renderStatement(input);
  } finally {
    proto.text = originalText;
    proto.roundedRect = originalRect;
  }
  return { texts, marks };
}

function money(value: string): ExportValueDtoType {
  return { kind: 'number', value, decimals: 2, style: 'money', currency: 'EUR' };
}

function input(direction?: 'ltr' | 'rtl'): StatementInput {
  return {
    account: 'Ada Lovelace (ada@example.com)',
    sheet: {
      name: 'Holdings',
      headers: ['Holding', 'Account', 'Value'],
      numericColumns: [false, false, true],
      totalColumns: [false, false, true],
      rows: [
        [{ kind: 'text', value: 'Alpha' }, { kind: 'text', value: 'Kraken' }, money('1000.00')],
        [{ kind: 'text', value: 'Beta' }, { kind: 'text', value: 'Kraken' }, money('25.50')],
      ],
    },
    provenance: {
      subject: 'Holdings',
      scope: 'All holdings',
      generatedAt: '2026-09-18T03:00:00.000Z',
      details: [],
      rowCount: 2,
      amountsWithheld: false,
    },
    ...(direction ? { direction } : {}),
  };
}

/** A4 portrait: every input here is three narrow columns. */
const PAGE_WIDTH = 595.28;
const CONTENT_LEFT = MARGIN.left;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN.right;
const CENTRE = PAGE_WIDTH / 2;

function one(texts: Drawn[], text: string): Drawn {
  const found = texts.filter((t) => t.text === text);
  expect(found.map((t) => t.text)).toEqual([text]);
  return found[0] as Drawn;
}

describe('renderStatement — direction (SC-1198)', () => {
  it('right-to-left puts the first column at the right edge; left-to-right at the left', async () => {
    const rtl = (await draw(input('rtl'))).texts;
    const ltr = (await draw(input('ltr'))).texts;
    expect(one(rtl, 'HOLDING').right).toBeCloseTo(CONTENT_RIGHT - 0, 0);
    expect(one(ltr, 'HOLDING').left).toBeCloseTo(CONTENT_LEFT, 0);
    // Column ORDER, not only the first column's edge.
    expect(one(rtl, 'HOLDING').left).toBeGreaterThan(one(rtl, 'ACCOUNT').right);
    expect(one(rtl, 'ACCOUNT').left).toBeGreaterThan(one(rtl, 'VALUE').right);
    expect(one(ltr, 'HOLDING').right).toBeLessThan(one(ltr, 'ACCOUNT').left);
  });

  it('a text cell starts at its column’s start edge', async () => {
    const rtl = (await draw(input('rtl'))).texts;
    const alpha = one(rtl, 'Alpha');
    const beta = one(rtl, 'Beta');
    // Different widths, one right edge: flush to the start of a right-to-left column.
    expect(alpha.right).toBeCloseTo(beta.right, 1);
    expect(alpha.left).not.toBeCloseTo(beta.left, 1);
  });

  it('figures stay flush RIGHT in both directions, so their decimals line up', async () => {
    for (const direction of ['rtl', 'ltr'] as const) {
      const { texts } = await draw(input(direction));
      const figures = texts.filter((t) => /\d\.\d\d/.test(t.text) && t.y > 150);
      expect(figures.length).toBeGreaterThanOrEqual(3);
      const rights = figures.map((t) => t.right.toFixed(1));
      expect(new Set(rights).size).toBe(1);
      // …and the figure column itself moved: last column, so left on an rtl page.
      const side = (figures[0] as Drawn).right < CENTRE ? 'left' : 'right';
      expect(side).toBe(direction === 'rtl' ? 'left' : 'right');
    }
  });

  it('the mark, the title and the metadata labels start from the right', async () => {
    const rtl = await draw(input('rtl'));
    const ltr = await draw(input('ltr'));
    expect(rtl.marks.length).toBe(1);
    expect(rtl.marks[0]).toBeGreaterThan(CENTRE);
    expect(ltr.marks[0]).toBeLessThan(CENTRE);
    expect(one(rtl.texts, 'Holdings').right).toBeLessThan(rtl.marks[0] as number);
    const label = one(rtl.texts, 'Account');
    const value = one(rtl.texts, 'Ada Lovelace (ada@example.com)');
    expect(label.left).toBeGreaterThan(value.right);
    expect(one(ltr.texts, 'Account').right).toBeLessThan(
      one(ltr.texts, 'Ada Lovelace (ada@example.com)').left
    );
  });

  it('the footer’s page count moves to the left', async () => {
    const rtl = (await draw(input('rtl'))).texts;
    const ltr = (await draw(input('ltr'))).texts;
    expect(one(rtl, 'Page 1 of 1').left).toBeCloseTo(CONTENT_LEFT, 0);
    expect(one(ltr, 'Page 1 of 1').right).toBeCloseTo(CONTENT_RIGHT, 0);
  });

  it('the wire takes either direction or none, and nothing else', () => {
    const { account: _, ...wire } = input();
    for (const direction of ['rtl', 'ltr', undefined]) {
      expect(RenderPdfInput.safeParse({ ...wire, direction }).success).toBe(true);
    }
    // The control: a value the renderer has no reading for is refused.
    expect(RenderPdfInput.safeParse({ ...wire, direction: 'ttb' }).success).toBe(false);
  });

  // The stale client sends no direction, and gets exactly the page it got.
  it('no direction draws exactly what left-to-right draws', async () => {
    const omitted = (await draw(input())).texts;
    const ltr = (await draw(input('ltr'))).texts;
    expect(omitted.length).toBeGreaterThan(10);
    expect(omitted).toEqual(ltr);
  });
});
