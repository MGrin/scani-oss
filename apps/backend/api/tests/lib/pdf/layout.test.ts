import { describe, expect, it } from 'bun:test';
import type { ExportSheetDtoType, ExportValueDtoType } from '@scani/shared';
import {
  accountLabel,
  buildBlocks,
  cellText,
  chooseGeometry,
  flowPages,
  formatFigure,
  GROUP_HEADING_HEIGHT,
  headerText,
  layoutColumns,
  MARGIN,
  type Measure,
  MIN_ROWS_UNDER_HEADING,
  PORTRAIT,
  ROW_HEIGHT,
  statementTimestamp,
  TYPE,
  totalsRow,
  tracking,
  truncate,
  withoutGroupColumn,
} from '../../../src/lib/pdf/layout';

/**
 * The statement's arithmetic, checked without rendering anything.
 *
 * A PDF test that only asserts "some bytes came back" passes while the columns
 * run off the page, a figure is cut into a different number and a group heading
 * is orphaned on page two. Everything that can be *wrong* about the layout is a
 * number, and every one of those numbers is decided in `layout.ts`.
 *
 * Text is measured by a stub rather than by the real font: a monospaced
 * pretend-face, one unit per character, scaled by the type size. That makes
 * every width in here arithmetic anybody can check, and the property the code
 * has to hold — *what was measured is what is drawn* — is exactly the property
 * a stub can test, because the stub is used for both.
 */

const CHAR = 0.6;
const measure: Measure = (text, style) =>
  text.length * style.size * CHAR + text.length * (style.spacing ?? 0);

function money(value: string, currency = 'EUR'): ExportValueDtoType {
  return { kind: 'number', value, decimals: 2, style: 'money', currency };
}

function sheet(overrides: Partial<ExportSheetDtoType> = {}): ExportSheetDtoType {
  return {
    name: 'Holdings',
    headers: ['Holding', 'Account', 'Value (EUR)'],
    numericColumns: [false, false, true],
    totalColumns: [false, false, true],
    rows: [
      [{ kind: 'text', value: 'BTC' }, { kind: 'text', value: 'Kraken Spot' }, money('33938.80')],
    ],
    ...overrides,
  };
}

describe('layoutColumns', () => {
  it('starts at the left margin and ends at the right one', () => {
    const columns = layoutColumns(sheet(), measure);
    expect(columns[0]?.x).toBe(MARGIN.left);
    const last = columns[columns.length - 1];
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(MARGIN.left + PORTRAIT.contentWidth, 5);
  });

  it('never runs off the page, however many columns there are', () => {
    const headers = Array.from({ length: 14 }, (_, index) => `Column ${index}`);
    const columns = layoutColumns(
      sheet({
        headers,
        numericColumns: headers.map(() => false),
        rows: [headers.map((header) => ({ kind: 'text', value: `${header} value` }) as const)],
      }),
      measure
    );
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    expect(total).toBeLessThanOrEqual(PORTRAIT.contentWidth + 0.001);
  });

  it('gives every figure room to be printed in full', () => {
    // The rule the whole module turns on: a cut figure is not a short figure,
    // it is a different number. Text may lose its tail; a column of money may
    // not, even when the text beside it is long enough to want the room.
    const columns = layoutColumns(
      sheet({
        rows: [
          [
            { kind: 'text', value: 'A very long holding name that would like the whole page' },
            { kind: 'text', value: 'An institution with an unreasonably long name as well' },
            money('12345678.90'),
          ],
        ],
      }),
      measure
    );
    const figure = columns[2];
    const printed = formatFigure({ kind: 'number', value: '12345678.90', decimals: 2 });
    expect(measure(printed, TYPE.rowFigure)).toBeLessThanOrEqual((figure?.width ?? 0) - 1);
  });

  it('gives a column of dates room too, though they are not numeric', () => {
    // `2026-0…` is not a shortened date, it is no date — and a date column is
    // left-aligned text, so it is the one that looks safe to squeeze.
    const columns = layoutColumns(
      sheet({
        headers: ['Holding', 'Note', 'Updated'],
        numericColumns: [false, false, false],
        rows: [
          [
            { kind: 'text', value: 'A long holding name here' },
            { kind: 'text', value: 'A long note that wants every point of width it can get' },
            { kind: 'date', value: '2026-08-14', withTime: false },
          ],
        ],
      }),
      measure
    );
    const dates = columns[2];
    expect(measure('2026-08-14', TYPE.rowText)).toBeLessThanOrEqual((dates?.width ?? 0) - 1);
  });

  it('measures the heading in the case it is set in', () => {
    // Measured `Gain / loss` and drew `GAIN / LOSS`, which is wider, so the
    // heading came back as `GAIN / L…` on a column that had room for it.
    const columns = layoutColumns(
      sheet({
        headers: ['Symbol', 'Note', 'Gain / loss'],
        numericColumns: [false, false, true],
        rows: [[{ kind: 'text', value: 'BTC' }, { kind: 'text', value: 'n' }, money('12.40')]],
      }),
      measure
    );
    const gain = columns[2];
    expect(measure(headerText('Gain / loss'), TYPE.columnHeader)).toBeLessThanOrEqual(
      (gain?.width ?? 0) - 1
    );
  });

  it('marks the numeric columns, which is what right-aligns them', () => {
    expect(layoutColumns(sheet(), measure).map((column) => column.numeric)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('chooseGeometry', () => {
  it('keeps a narrow list on portrait paper', () => {
    expect(chooseGeometry(sheet(), measure).landscape).toBe(false);
  });

  it('turns the page when the columns genuinely do not fit', () => {
    const headers = Array.from({ length: 9 }, (_, index) => `A column named ${index}`);
    const wide = sheet({
      headers,
      numericColumns: headers.map(() => false),
      rows: [headers.map(() => ({ kind: 'text', value: 'a fairly long cell value' }) as const)],
    });
    expect(chooseGeometry(wide, measure).landscape).toBe(true);
  });
});

describe('truncate', () => {
  it('leaves a string that fits exactly alone', () => {
    // A column is sized to its widest string, so that string measures its own
    // width to the last bit of a float. An exact comparison cut the one cell
    // every column was built around.
    const text = '18,200.00000000';
    const width = measure(text, TYPE.rowFigure);
    expect(truncate(text, width, TYPE.rowFigure, measure)).toBe(text);
  });

  it('cuts with an ellipsis and stays inside the width', () => {
    const text = 'Vanguard FTSE All-World UCITS ETF';
    const cut = truncate(text, 60, TYPE.rowText, measure);
    expect(cut.endsWith('…')).toBe(true);
    expect(measure(cut, TYPE.rowText)).toBeLessThanOrEqual(60.05);
  });

  /**
   * SC-984. The cut used to be made on `text.length` and `slice`, which are
   * UTF-16 code UNITS, so it could land between the halves of a surrogate pair
   * or between a combining mark and its base. A lone surrogate has no face, so
   * the cell ended `[?]…` and the metadata note fired — the document claiming a
   * character was unrenderable when the input was fine and the renderer broke
   * it.
   *
   * Asserted as the general property rather than against a fixed string,
   * because "does not split a character" is what the code has to hold and a
   * pinned expectation would only cover the one width it was written at. The
   * ASCII and precomposed-CJK cases are the control: they offer no interior
   * boundary to get wrong, so a check that flagged them would be flagging
   * everything.
   */
  describe('cuts only where a character is not taken apart', () => {
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    function boundaries(text: string): Set<number> {
      const offsets = [0];
      for (const { segment } of graphemes.segment(text)) {
        offsets.push((offsets[offsets.length - 1] as number) + segment.length);
      }
      return new Set(offsets);
    }

    const cases: [string, string][] = [
      // CJK Extension B — the range `fonts.test.ts`'s own sweep draws from, and
      // the one a merchant name reaches this through.
      ['astral', '\u{20000}\u{20001}\u{20002}\u{20003}'],
      ['an Arabic name with its marks', 'بَنْكَبَنْكَ'],
      ['Devanagari with matras', 'नितिननितिन'],
      ['a decomposed Latin name', 'école-longer'],
      ['a ZWJ emoji sequence', '\u{1F469}‍\u{1F4BB}\u{1F469}‍\u{1F4BB}'],
      ['ASCII, the control', 'abcdefghij'],
      ['precomposed CJK, the control', '三菱UFJ銀行です'],
    ];

    // Taken from `measure` rather than written out, so the widths below stay
    // one-character steps whatever the stub's scale is. A fixed number here was
    // under one character wide and every case returned '' — a loop that passes
    // by never testing anything, which is what the assertion after it exists to
    // catch.
    const unit = measure('a', TYPE.rowText);

    for (const [label, text] of cases) {
      it(label, () => {
        const cut = boundaries(text);
        let everCut = false;
        // Every width from "nothing fits" to "it all fits", so the search is
        // exercised at every position it can settle on rather than one.
        for (let step = 1; step <= text.length + 2; step += 1) {
          const shown = truncate(text, unit * step, TYPE.rowText, measure);
          if (shown === '' || shown === text) continue;
          everCut = true;
          const body = shown.slice(0, -1);
          expect({ step, body, onBoundary: cut.has(body.length) }).toEqual({
            step,
            body,
            onBoundary: true,
          });
        }
        // Without this the loop is satisfied by a `truncate` that only ever
        // returns the whole string or nothing, and asserts about no cut at all.
        expect({ text, everCut }).toEqual({ text, everCut: true });
      });
    }

    it('cuts where the old code-unit search cut, when that was already safe', () => {
      // The fix is not "cut earlier": on text with no interior boundary to get
      // wrong it must land in exactly the same place as before.
      expect(truncate('abcdefghij', unit * 5, TYPE.rowText, measure)).toBe('abcd…');
      expect(
        truncate('\u{20000}\u{20001}\u{20002}\u{20003}', unit * 5, TYPE.rowText, measure)
      ).toBe('\u{20000}\u{20001}…');
    });
  });
});

/**
 * SC-985. `characterSpacing` inserts a gap after every glyph's advance, and
 * Arabic joining works because one glyph's connecting stroke ends at that
 * advance and the next one's begins at zero — so any positive tracking opens a
 * gap at every junction in the word. Measured with SF Arabic at
 * `TYPE.columnHeader`'s own 8pt: at `spacing: 0.4` every joint of `الحساب` is
 * severed; at `0` the baseline stroke runs unbroken.
 *
 * The list is an ALLOWLIST, and these tests are what makes that load-bearing: a
 * script nobody has thought about gets no tracking, which is at worst a heading
 * set a fraction narrow. Adding a face to `fonts.ts` must not quietly add its
 * script here, and the Arabic case below goes red if it does.
 */
describe('tracking', () => {
  it('drops the tracking of a script whose letters join', () => {
    expect(tracking(TYPE.columnHeader, 'الحساب')).toBe(0);
    expect(tracking(TYPE.totalLabel, 'المجموع')).toBe(0);
  });

  it('keeps it for every script the bundled faces can set', () => {
    // The positive arm. Without it the assertions above are satisfied by a
    // `tracking` that returns 0 for everything.
    for (const text of [
      'GAIN / LOSS',
      'BALANCE (USD) 1,000.00',
      'СБЕРБАНК',
      'ΤΡΑΠΕΖΑ',
      '三菱UFJ銀行',
      'ㄅㄆㄇ',
    ]) {
      expect({ text, spacing: tracking(TYPE.columnHeader, text) }).toEqual({
        text,
        spacing: TYPE.columnHeader.spacing,
      });
    }
  });

  it('leaves an untracked style untracked whatever the script', () => {
    expect(tracking(TYPE.rowText, 'الحساب')).toBe(0);
    expect(tracking(TYPE.rowText, 'GAIN / LOSS')).toBe(0);
  });

  it('tracks the unsupported marker, which is what an unbundled script sets as', () => {
    // Why this change moves no document that can be produced today: an Arabic
    // header has already become `[?]` by the time runs exist, and that is
    // ASCII. The tracking turns off when a face is bundled, not before.
    expect(tracking(TYPE.columnHeader, '[?]')).toBe(TYPE.columnHeader.spacing);
  });
});

describe('totalsRow', () => {
  it('totals a single-currency money column', () => {
    const totals = totalsRow(
      sheet({
        rows: [
          [{ kind: 'text', value: 'BTC' }, { kind: 'text', value: 'K' }, money('1000.50')],
          [{ kind: 'text', value: 'ETH' }, { kind: 'text', value: 'K' }, money('2000.25')],
        ],
      })
    );
    expect(totals[2]).toBe('3,000.75');
    expect(totals[0]).toBeNull();
  });

  it('refuses a money column the surface did not declare additive', () => {
    // A price is money and a daily net-worth snapshot is money; neither adds
    // up, and both would print as `TOTAL` under a rule that only looked at the
    // cells. Being additive is a fact about the column, and only the surface
    // knows it.
    const totals = totalsRow(
      sheet({
        headers: ['Price (EUR)'],
        numericColumns: [true],
        totalColumns: [false],
        rows: [[money('10.00')], [money('20.00')]],
      })
    );
    expect(totals[0]).toBeNull();
  });

  it('refuses a column on a sheet that declared nothing at all', () => {
    const totals = totalsRow(
      sheet({
        headers: ['Value (EUR)'],
        numericColumns: [true],
        totalColumns: undefined,
        rows: [[money('10.00')]],
      })
    );
    expect(totals[0]).toBeNull();
  });

  it('refuses a mixed-currency column, whose sum means nothing', () => {
    const totals = totalsRow(
      sheet({
        rows: [
          [{ kind: 'text', value: 'A' }, { kind: 'text', value: 'K' }, money('10.00', 'EUR')],
          [{ kind: 'text', value: 'B' }, { kind: 'text', value: 'K' }, money('10.00', 'GBP')],
        ],
      })
    );
    expect(totals[2]).toBeNull();
  });

  it('refuses quantities and percentages', () => {
    const totals = totalsRow(
      sheet({
        headers: ['Balance', 'Gain'],
        numericColumns: [true, true],
        totalColumns: [true, true],
        rows: [
          [
            { kind: 'number', value: '0.42', decimals: 8, style: 'plain' },
            { kind: 'number', value: '12.40', decimals: 2, style: 'percent' },
          ],
        ],
      })
    );
    expect(totals).toEqual([null, null]);
  });

  it('has no total for a column of blanks, which is not a total of zero', () => {
    const totals = totalsRow(
      sheet({
        headers: ['Value (EUR)'],
        numericColumns: [true],
        totalColumns: [true],
        rows: [[{ kind: 'blank' }], [{ kind: 'blank' }]],
      })
    );
    expect(totals[0]).toBeNull();
  });

  it('sums through Decimal rather than through a double', () => {
    const totals = totalsRow(
      sheet({
        headers: ['Value (EUR)'],
        numericColumns: [true],
        totalColumns: [true],
        rows: [[money('0.10')], [money('0.20')]],
      })
    );
    expect(totals[0]).toBe('0.30');
  });
});

describe('flowPages', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'row' as const,
      index,
      height: ROW_HEIGHT,
    }));

  it('emits every row exactly once, in order', () => {
    const pages = flowPages(rows(50), 10 * ROW_HEIGHT, 20 * ROW_HEIGHT);
    const seen = pages.flat().flatMap((block) => (block.kind === 'row' ? [block.index] : []));
    expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => index));
  });

  it('fits fewer rows on the first page, which carries the masthead', () => {
    const pages = flowPages(rows(30), 10 * ROW_HEIGHT, 20 * ROW_HEIGHT);
    expect(pages[0]?.length).toBe(10);
    expect(pages[1]?.length).toBe(20);
  });

  it('keeps a group heading with the start of its group', () => {
    // Room for the heading and one row, which is a heading that has been
    // separated from its group by a page break.
    const blocks = [
      ...rows(3),
      { kind: 'heading' as const, label: 'Kraken', count: 4, height: GROUP_HEADING_HEIGHT },
      ...rows(4),
    ];
    const capacity = 3 * ROW_HEIGHT + GROUP_HEADING_HEIGHT + ROW_HEIGHT;
    const pages = flowPages(blocks, capacity, 40 * ROW_HEIGHT);
    expect(pages[0]?.some((block) => block.kind === 'heading')).toBe(false);
    expect(pages[1]?.[0]?.kind).toBe('heading');
    const under = pages[1]?.filter((block) => block.kind === 'row').length ?? 0;
    expect(under).toBeGreaterThanOrEqual(MIN_ROWS_UNDER_HEADING);
  });

  it('keeps the summary whole', () => {
    const blocks = [...rows(4), { kind: 'totals' as const, height: 40 }];
    const pages = flowPages(blocks, 4 * ROW_HEIGHT + 10, 40 * ROW_HEIGHT);
    expect(pages[0]?.some((block) => block.kind === 'totals')).toBe(false);
    expect(pages[1]?.[0]?.kind).toBe('totals');
  });

  it('gives an empty selection one page rather than none', () => {
    expect(flowPages([], 400, 600)).toEqual([[]]);
  });

  it('always makes progress, even where a page can hold nothing', () => {
    const pages = flowPages(rows(3), 1, 1);
    expect(pages.flat().length).toBe(3);
    expect(pages.length).toBe(3);
  });
});

describe('buildBlocks', () => {
  it('opens each run with its heading and covers every row', () => {
    const withGroups = sheet({
      rows: [
        [{ kind: 'text', value: 'a' }, { kind: 'text', value: 'K' }, money('1.00')],
        [{ kind: 'text', value: 'b' }, { kind: 'text', value: 'K' }, money('2.00')],
        [{ kind: 'text', value: 'c' }, { kind: 'text', value: 'L' }, money('3.00')],
      ],
      groups: [
        { label: 'Kraken', rowCount: 2 },
        { label: 'Ledger', rowCount: 1 },
      ],
    });
    const blocks = buildBlocks(withGroups, totalsRow(withGroups));
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'row',
      'row',
      'heading',
      'row',
      'totals',
    ]);
  });

  it('adds no summary when nothing can be totalled', () => {
    const plain = sheet({
      headers: ['Holding'],
      numericColumns: [false],
      rows: [[{ kind: 'text', value: 'BTC' }]],
    });
    expect(buildBlocks(plain, totalsRow(plain)).some((block) => block.kind === 'totals')).toBe(
      false
    );
  });
});

describe('withoutGroupColumn', () => {
  it('drops the column whose value the heading already says', () => {
    const projected = withoutGroupColumn(
      sheet({
        headers: ['Account', 'Holding', 'Value (EUR)'],
        numericColumns: [false, false, true],
        rows: [[{ kind: 'text', value: 'Kraken' }, { kind: 'text', value: 'BTC' }, money('1.00')]],
        groups: [{ label: 'Kraken', rowCount: 1 }],
        groupColumn: 0,
      })
    );
    expect(projected.headers).toEqual(['Holding', 'Value (EUR)']);
    expect(projected.numericColumns).toEqual([false, true]);
    expect(projected.rows[0]).toHaveLength(2);
  });

  it('leaves an ungrouped sheet exactly as it was', () => {
    const original = sheet();
    expect(withoutGroupColumn(original)).toBe(original);
  });
});

describe('accountLabel', () => {
  it('names the person and the address', () => {
    expect(accountLabel('Ada Lovelace', 'ada@example.com')).toBe('Ada Lovelace (ada@example.com)');
  });

  it('falls back to the address when there is no name', () => {
    expect(accountLabel(null, 'ada@example.com')).toBe('ada@example.com');
    expect(accountLabel('', 'ada@example.com')).toBe('ada@example.com');
  });

  it('treats a whitespace-only name as no name', () => {
    // Otherwise the statement is addressed to `  (ada@example.com)`.
    expect(accountLabel('   ', 'ada@example.com')).toBe('ada@example.com');
  });

  it('trims a name that merely has room around it', () => {
    expect(accountLabel(' Ada ', 'ada@example.com')).toBe('Ada (ada@example.com)');
  });
});

describe('formatFigure', () => {
  it('groups thousands, because this is the output meant to be read', () => {
    expect(formatFigure({ kind: 'number', value: '1234567.89', decimals: 2, style: 'money' })).toBe(
      '1,234,567.89'
    );
  });

  it('rounds rather than truncating', () => {
    // `0.867` printed as `0.86` is neither the figure nor a correct rounding of
    // it, in a document going to an accountant.
    expect(formatFigure({ kind: 'number', value: '0.867', decimals: 2, style: 'money' })).toBe(
      '0.87'
    );
  });

  it('keeps a quantity at the precision it arrived with', () => {
    expect(formatFigure({ kind: 'number', value: '0.42130000', style: 'plain' })).toBe(
      '0.42130000'
    );
  });

  it('keeps the sign in front of the grouping', () => {
    expect(formatFigure({ kind: 'number', value: '-1234.50', decimals: 2, style: 'money' })).toBe(
      '-1,234.50'
    );
  });

  it('marks a percent as one', () => {
    expect(formatFigure({ kind: 'number', value: '12.4', decimals: 2, style: 'percent' })).toBe(
      '12.40%'
    );
  });

  it('prints a value it cannot parse rather than dropping it', () => {
    expect(formatFigure({ kind: 'number', value: 'n/a', style: 'plain' })).toBe('n/a');
  });

  /**
   * SC-179. The statement's LUNC row read `4,200,000 · 0.00 · 324.03`, and a
   * document whose own multiplication does not work is worse than no document
   * — the reader it is *for* is an accountant, a bank or a landlord, which is
   * to say the one reader guaranteed to check it.
   *
   * This file only had to stop hardcoding a fallback of two: the decimals come
   * from the sheet, and the sheet now asks the figure (`moneyDecimals`). What
   * this holds is that a price arriving with more of them is printed with them.
   */
  it('prints a sub-cent price at the decimals the sheet declared for it', () => {
    const price = formatFigure({
      kind: 'number',
      value: '0.00007715',
      decimals: 8,
      style: 'money',
    });
    expect(price).toBe('0.00007715');
    // The row now multiplies out to the total printed beside it.
    expect(Number(price) * 4_200_000).toBeCloseTo(324.03, 2);
  });
});

describe('cellText', () => {
  it('leaves a blank blank', () => {
    expect(cellText({ kind: 'blank' })).toBe('');
  });

  it('shows a date without its stored midnight', () => {
    expect(cellText({ kind: 'date', value: '2026-08-14T00:00:00.000Z', withTime: false })).toBe(
      '2026-08-14'
    );
    expect(cellText({ kind: 'date', value: '2026-08-14T09:31:00.000Z', withTime: true })).toBe(
      '2026-08-14 09:31'
    );
  });
});

describe('statementTimestamp', () => {
  it('says when, in words, and names the zone', () => {
    expect(statementTimestamp('2026-08-14T09:31:00.000Z')).toBe('14 August 2026 at 09:31 UTC');
  });

  it('passes through something it cannot parse', () => {
    expect(statementTimestamp('not a date')).toBe('not a date');
  });
});
