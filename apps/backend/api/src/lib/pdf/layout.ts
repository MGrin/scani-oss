import { Decimal, type ExportSheetDtoType, type ExportValueDtoType } from '@scani/shared';

/**
 * The arithmetic behind the statement — type sizes, column widths, what a cell
 * says, what a column totals, and which block lands on which page — with no PDF
 * library anywhere near it.
 *
 * Separated from `statement.ts` for one reason: this is where the layout can be
 * *wrong*, and a wrong layout is invisible in a passing test that only checks a
 * PDF was produced. Columns that overflow, a figure truncated into a different
 * number, a group heading orphaned from its rows, a page count off by one — all
 * of those are decisions made here, on plain numbers, and all of them are
 * checkable without rendering anything.
 *
 * The one thing this module cannot do alone is *measure text*, which needs the
 * embedded font. So it takes a `Measure` function instead of importing one, and
 * the tests hand it a deterministic stub.
 */

/** A4 at 72dpi, which is pdfkit's unit. */
const A4_SHORT = 595.28;
const A4_LONG = 841.89;

export const MARGIN = { top: 56, right: 40, bottom: 56, left: 40 } as const;

export interface Geometry {
  width: number;
  height: number;
  contentWidth: number;
  landscape: boolean;
}

function geometry(landscape: boolean): Geometry {
  const width = landscape ? A4_LONG : A4_SHORT;
  return {
    width,
    height: landscape ? A4_SHORT : A4_LONG,
    contentWidth: width - MARGIN.left - MARGIN.right,
    landscape,
  };
}

export const PORTRAIT = geometry(false);

/** Row rhythm. Generous by table standards — this is a statement, and what
 *  makes one readable is space, not rules. */
export const ROW_HEIGHT = 22;
/** The column-header band, repeated at the top of every page. */
export const HEADER_HEIGHT = 26;
/** A group heading and the air above it. */
export const GROUP_HEADING_HEIGHT = 32;
/** The totals summary: a rule, the figures, and the space that sets it apart
 *  from the last row. */
const TOTALS_HEIGHT = 40;
/** The gap between one column's text and the next column's. */
export const GUTTER = 12;

export type Face = 'sans' | 'bold' | 'mono';

export interface TypeStyle {
  face: Face;
  size: number;
  /** Extra tracking, in points per character. Only the small-caps column
   *  headers use it, and it is enough to matter to a measured width. */
  spacing?: number;
}

/** How wide a string sets, in points. Supplied by the renderer, which owns the
 *  fonts; stubbed in tests, which do not. */
export type Measure = (text: string, style: TypeStyle) => number;

/**
 * The type scale. One object because a statement's proportions are a *system* —
 * the column header has to read as subordinate to the row, the row as
 * subordinate to the total — and three sizes scattered across draw calls is how
 * that stops being true.
 */
export const TYPE = {
  title: { face: 'bold', size: 17 } as const,
  scope: { face: 'sans', size: 9.5 } as const,
  metaLabel: { face: 'sans', size: 8.5 } as const,
  metaValue: { face: 'sans', size: 8.5 } as const,
  columnHeader: { face: 'bold', size: 8, spacing: 0.4 } as const,
  rowText: { face: 'sans', size: 9.5 } as const,
  rowFigure: { face: 'mono', size: 9 } as const,
  groupHeading: { face: 'bold', size: 9.5 } as const,
  groupCount: { face: 'sans', size: 8.5 } as const,
  totalLabel: { face: 'bold', size: 8, spacing: 0.4 } as const,
  totalFigure: { face: 'mono', size: 9.5 } as const,
  footer: { face: 'sans', size: 8 } as const,
} satisfies Record<string, TypeStyle>;

/**
 * The scripts a tracked style is actually tracked in — SC-985.
 *
 * **What tracking does to a cursive script.** `characterSpacing` inserts a gap
 * after every glyph's advance, and Arabic joining works precisely because one
 * glyph's connecting stroke ends at that advance and the next one's begins at
 * zero. Any positive tracking therefore opens a gap at *every* junction in the
 * word, by construction — the only question is whether the gap is visible, and
 * at the size these styles are set it plainly is. Measured 2026-09-03 with SF
 * Arabic as an instrument, rendered at {@link TYPE}`.columnHeader`'s own 8pt and
 * rasterised: at `spacing: 0.4` every joint of `الحساب` is severed and the word
 * reads as six disconnected letterforms, against a bare control at `0` whose
 * baseline stroke runs unbroken. It sets 27.109pt tracked against 25.109pt bare
 * — 2.000pt, which is 0.4 at each of the five junctions.
 *
 * **An allowlist rather than a list of scripts to skip, and that is the whole
 * point.** This defect cannot be seen today: no Arabic face is bundled, so the
 * text is already `fonts.ts`'s unsupported marker by the time it is drawn. It
 * appears the moment a face is added, which is the moment nobody is looking for
 * it. A denylist would default a newly bundled script to *tracked* and break it
 * silently; an allowlist defaults it to *untracked*, which at worst sets a
 * heading a fraction narrower than it might have been. So **adding a face to
 * `fonts.ts`'s `STACKS` does not add its script here** — that is a second,
 * deliberate decision, and forgetting to make it is safe.
 *
 * **What is in it is exactly what is renderable today**, so this changes no
 * document that can currently be produced: of the 10,596 codepoints the bundled
 * faces cover, 10,595 track exactly as before and the one exception is U+FFFF, a
 * Unicode noncharacter. Bopomofo is here because the Noto CJK subsets cover it —
 * 44 codepoints, found by measuring rather than by reasoning about what a
 * "Japanese" subset contains — and, like every other script listed, it does not
 * join.
 */
const TRACKABLE_SCRIPTS =
  /^[\p{Script_Extensions=Latin}\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Bopomofo}\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]*$/u;

/**
 * The tracking `text` is actually set with — `style.spacing`, or none where
 * letterspacing would damage the script rather than loosen it.
 *
 * Asked per *run* rather than per string, because a run is already uniform in
 * face and in direction and is the unit both the measure pass and the draw pass
 * iterate. Two consequences worth stating: a mixed heading keeps its tracking on
 * the Latin half, and a run that mixes an allowed script with a disallowed one —
 * which needs a single face covering both — loses tracking for the whole run,
 * which is the safe direction.
 */
export function tracking(style: TypeStyle, text: string): number {
  const spacing = style.spacing ?? 0;
  return spacing > 0 && !TRACKABLE_SCRIPTS.test(text) ? 0 : spacing;
}

export interface Column {
  header: string;
  /** Right-aligned, and set in the mono face so decimals line up. */
  numeric: boolean;
  width: number;
  x: number;
}

/** The style a cell in this column is set in — the one place that decision is
 *  made, so measuring and drawing cannot disagree about it. */
export function cellStyle(column: Column): TypeStyle {
  return column.numeric ? TYPE.rowFigure : TYPE.rowText;
}

const MIN_TEXT_WIDTH = 54;

/**
 * A column that must never be cut: every figure column, and every column of
 * dates.
 *
 * The dates are the part that is easy to get wrong. They are left-aligned text
 * and they came out of a `text`-shaped code path, but `2026-0…` is not a
 * shortened date, it is *no* date — the same defect as a truncated figure, in a
 * column that does not look like it needs protecting.
 */
function isRigid(sheet: ExportSheetDtoType, index: number): boolean {
  if (sheet.numericColumns[index] === true) return true;
  let seen = 0;
  for (const row of sheet.rows) {
    const cell = row[index];
    if (!cell || cell.kind === 'blank') continue;
    if (cell.kind !== 'date') return false;
    seen += 1;
  }
  return seen > 0;
}

/**
 * The column heading as it is set: small caps.
 *
 * A function rather than a `.toUpperCase()` at the draw call, because the width
 * pass has to measure the *same* string. It did not, briefly — it measured
 * `Gain / loss` and the page drew `GAIN / LOSS`, which is wider, so every
 * heading with a lowercase-heavy name came out as `GAIN / L…`.
 */
export function headerText(header: string): string {
  return header.toUpperCase();
}

/** How wide each column would like to be: its header, its widest cell, and its
 *  total, each measured in the style it is actually drawn in. */
function columnDemands(sheet: ExportSheetDtoType, measure: Measure): number[] {
  const totals = totalsRow(sheet);
  return sheet.headers.map((header, index) => {
    const style = sheet.numericColumns[index] === true ? TYPE.rowFigure : TYPE.rowText;
    let widest = measure(headerText(header), TYPE.columnHeader);
    for (const row of sheet.rows) {
      const cell = row[index];
      if (!cell) continue;
      const text = cellText(cell);
      if (text) widest = Math.max(widest, measure(text, style));
    }
    const total = totals[index];
    if (total) widest = Math.max(widest, measure(total, TYPE.totalFigure));
    return widest + GUTTER;
  });
}

/**
 * Portrait, unless the table genuinely does not fit on it.
 *
 * A statement is a portrait document and that is the default. But a v3 list can
 * be seven columns wide — symbol, name, account, balance, value, gain, updated
 * — and squeezed onto 515pt every name becomes `Vanguard FTSE All-…`. A
 * document of ellipses is the "ugly table" this ticket exists to avoid, and
 * turning the paper is a cheaper answer than dropping columns the reader chose
 * to have on screen.
 *
 * The threshold is *natural* demand, so a list that fits stays portrait and
 * only the genuinely wide ones turn.
 */
export function chooseGeometry(sheet: ExportSheetDtoType, measure: Measure): Geometry {
  const natural = columnDemands(sheet, measure).reduce((sum, value) => sum + value, 0);
  return geometry(natural > PORTRAIT.contentWidth);
}

/**
 * Column widths, from the width the text actually sets.
 *
 * The first version of this measured **character counts**, on the grounds that
 * real measurement needs the font. It produced a statement whose date column
 * was too narrow for `2026-08-14` and whose balance column was too narrow for
 * `15,400.00000000`, and pdfkit answered by *wrapping* both — every row on the
 * page collided with the one below it. Guessing at a width is not a small
 * error with a tidy failure mode; it is the failure mode.
 *
 * So the renderer passes its own `widthOfString` in and this measures the real
 * glyphs, header and every cell, in the exact style each will be drawn in.
 *
 * Two rules resolve the fight for a page that is still too narrow:
 *
 * 1. **A rigid column always gets its full width** — every figure, every date.
 *    A truncated figure is not a shortened figure, it is a *different number*,
 *    and this is a document someone reconciles against a bank statement. Prose
 *    can lose its tail to an ellipsis and still be read; `41,230.55` cannot.
 * 2. **Text columns absorb what is left**, in proportion to what they asked
 *    for. They have a floor, but the floor gives way before a figure does: a
 *    second, proportional pass puts them back inside the budget rather than
 *    letting the whole row scale down. Only a page whose *rigid* columns alone
 *    overflow scales everything, and there is nothing better to do there.
 *
 * Slack goes to the text columns too. A statement fills its measure; a figure
 * column padded out to twice its content just moves the numbers away from the
 * heading they belong to.
 */
export function layoutColumns(
  sheet: ExportSheetDtoType,
  measure: Measure,
  available = PORTRAIT.contentWidth
): Column[] {
  const demand = columnDemands(sheet, measure);
  const rigid = sheet.headers.map((_, index) => isRigid(sheet, index));

  const rigidDemand = demand.reduce((sum, value, index) => sum + (rigid[index] ? value : 0), 0);
  const freeDemand = demand.reduce((sum, value, index) => sum + (rigid[index] ? 0 : value), 0);
  const freeBudget = Math.max(available - rigidDemand, 0);

  const widths = demand.map((value, index) =>
    rigid[index] ? value : Math.max(MIN_TEXT_WIDTH, (value * freeBudget) / (freeDemand || 1))
  );
  const freeTotal = widths.reduce((sum, value, index) => sum + (rigid[index] ? 0 : value), 0);
  if (freeTotal > freeBudget) {
    const squeeze = freeBudget / freeTotal;
    for (let index = 0; index < widths.length; index += 1) {
      if (!rigid[index]) widths[index] = (widths[index] as number) * squeeze;
    }
  }

  // A hair's overflow is float noise from the pass above, not a table that does
  // not fit, and scaling for it is not free: it shortens the widest rigid column
  // by a fraction of a point, which is enough to cut `18,200.00000000` to
  // `18,200.000000…`. Only a real overflow scales.
  const over = widths.reduce((sum, value) => sum + value, 0);
  const scale = over > available + 0.5 ? available / over : 1;

  let x = MARGIN.left;
  return sheet.headers.map((header, index) => {
    const width = (widths[index] as number) * scale;
    const column: Column = { header, numeric: sheet.numericColumns[index] === true, width, x };
    x += width;
    return column;
  });
}

/**
 * As much of `text` as fits, with an ellipsis where it was cut.
 *
 * Done here rather than by pdfkit's own `ellipsis` option because that option
 * only applies to text it is also allowed to wrap, and wrapping is precisely
 * what must not happen inside a statement row. Measured back to front so the
 * ellipsis is included in what fits.
 */
export function truncate(
  text: string,
  maxWidth: number,
  style: TypeStyle,
  measure: Measure
): string {
  // The tolerance matters: a column is sized to its widest string, so that
  // string measures *exactly* its own width and an exact comparison loses to
  // the last bit of a float. Cutting the widest cell in every column — which is
  // to say the one the column was built for — is the failure that produced.
  if (!text || measure(text, style) <= maxWidth + 0.05) return text;
  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, mid) + ellipsis, style) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? text.slice(0, low).trimEnd() + ellipsis : '';
}

/** What a cell prints. The figures arrive pre-formatted by the same code that
 *  writes the CSV, so this only chooses notation, never rounding. */
export function cellText(value: ExportValueDtoType): string {
  switch (value.kind) {
    case 'blank':
      return '';
    case 'text':
      return value.value;
    case 'number':
      return formatFigure(value);
    case 'date':
      return value.withTime ? value.value.replace('T', ' ').slice(0, 16) : value.value.slice(0, 10);
  }
}

/**
 * Grouped digits, because this is the one output meant to be *read* rather than
 * parsed.
 *
 * The exact opposite of the CSV rule, and deliberately so: a CSV is consumed by
 * a machine, so it gets `1234.56` and no ornament, while a statement is consumed
 * by a person and `1,234.56` is what a person reads. Nothing is rounded that was
 * not already rounded — `decimals` comes from the cell, the digits come from the
 * decimal string, and the grouping is inserted into the integer part only.
 */
export function formatFigure(value: ExportValueDtoType & { kind: 'number' }): string {
  const fraction = value.value.split('.')[1] ?? '';
  const decimals = value.decimals ?? (value.style === 'money' ? 2 : fraction.length);

  // `Decimal.toFixed`, not string slicing. Slicing was the first version and it
  // *truncated*: a price of `0.867` printed as `0.86` in a document meant for an
  // accountant — neither the true figure nor a correct rounding of it. This is
  // the same `Decimal` the rest of the export uses, so the PDF rounds exactly
  // where the app rounds and never through a float.
  let fixed: string;
  try {
    fixed = new Decimal(value.value).toFixed(Math.max(decimals, 0));
  } catch {
    return value.value;
  }

  return group(fixed) + (value.style === 'percent' ? '%' : '');
}

function group(fixed: string): string {
  const negative = fixed.startsWith('-');
  const bare = negative ? fixed.slice(1) : fixed;
  const [whole = '0', rest] = bare.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${rest ? `.${rest}` : ''}`;
}

/**
 * The column totals — one formatted figure per column, or `null` where a total
 * would be a lie.
 *
 * **Only where the surface said the column adds up**, and then only money, and
 * then only in one currency. A statement's summary is the line its reader
 * checks first, so the bar for printing one is that it is arithmetic they would
 * have done themselves:
 *
 * - A column nobody declared additive does not total. Being money is not being
 *   additive: a holding's *price* is money, and a column of daily net-worth
 *   snapshots is money, and summing either produces a figure that looks like
 *   wealth. `V3ColumnDef.exportTotal` is where a surface says otherwise.
 *
 * - A **percentage** column does not sum. Adding `+12.4%` to `-3.2%` is not a
 *   number anybody wants.
 * - A **quantity** column does not sum either — `0.42 BTC + 410 SOL` is 410.42
 *   of nothing. `style: 'plain'` covers both raw balances and counts, and a
 *   total row of holdings is not what this document is for.
 * - A **mixed-currency** money column does not sum, for the reason
 *   `workbook.ts` splits it into two columns in the first place: the sum of a
 *   column of different currencies is meaningless. `/vendors` is exactly this,
 *   and it also carries a converted base-currency column right beside it, which
 *   *does* total — so the summary lands on the only figure that means anything.
 * - A column of nothing but blanks has no total, as opposed to a total of zero.
 *
 * Summed through `Decimal`, in the currency's own precision, so the printed
 * total is the sum of the printed rows and not a float's opinion of it.
 */
export function totalsRow(sheet: ExportSheetDtoType): (string | null)[] {
  return sheet.headers.map((_, index) => {
    if (sheet.totalColumns?.[index] !== true) return null;
    let sum = new Decimal(0);
    let seen = 0;
    let currency: string | undefined;
    for (const row of sheet.rows) {
      const cell = row[index];
      if (!cell || cell.kind === 'blank') continue;
      if (cell.kind !== 'number' || cell.style !== 'money') return null;
      if (seen === 0) currency = cell.currency;
      else if (cell.currency !== currency) return null;
      try {
        sum = sum.plus(new Decimal(cell.value));
      } catch {
        return null;
      }
      seen += 1;
    }
    return seen > 0 ? group(sum.toFixed(2)) : null;
  });
}

function hasTotals(totals: readonly (string | null)[]): boolean {
  return totals.some((total) => total !== null);
}

/**
 * `Ada Lovelace (ada@example.com)`, or just the address.
 *
 * The metadata block names whose account the document describes, because it is
 * going to an accountant, a bank or a landlord and the first thing they need is
 * whose it is. **Trimmed before it is tested**: a name of `"  "` is not a name,
 * and rendering `  (ada@example.com)` would be a worse answer than the address
 * on its own.
 *
 * It survives the hide-amounts option deliberately (SC-93 withholds *money*,
 * not identity) — a statement of withheld figures that also cannot say who it
 * belongs to is not a document anybody can use.
 */
export function accountLabel(name: string | null | undefined, email: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? `${trimmed} (${email})` : email;
}

/**
 * The sheet as the statement wants it: without the group-label column.
 *
 * The spreadsheets carry the grouping as a column because that is the only
 * shape a pivot table can use. This format prints it as a heading, and keeping
 * the column as well would set the same value on every row underneath the
 * heading that already said it — the grouped list rendered twice, in the
 * narrowest medium of the three.
 */
export function withoutGroupColumn(sheet: ExportSheetDtoType): ExportSheetDtoType {
  const drop = sheet.groupColumn;
  if (drop === undefined || sheet.groups === undefined) return sheet;
  const keep = (_: unknown, index: number) => index !== drop;
  return {
    ...sheet,
    headers: sheet.headers.filter(keep),
    numericColumns: sheet.numericColumns.filter(keep),
    rows: sheet.rows.map((row) => row.filter(keep)),
    groupColumn: undefined,
  };
}

export type Block =
  | { kind: 'heading'; label: string; count: number; height: number }
  | { kind: 'row'; index: number; height: number }
  | { kind: 'totals'; height: number };

/** A group heading with only one row under it is a heading that has been
 *  separated from its group. Two is the smallest run that still reads as one. */
export const MIN_ROWS_UNDER_HEADING = 2;

/**
 * The statement as a sequence of blocks — headings, rows, and the summary.
 *
 * The grouping the reader applied on screen becomes **headings** here, where a
 * spreadsheet gets a column (`workbook.ts`). Both are right for their medium: a
 * column can be pivoted and a heading cannot, and a heading is legible and a
 * repeated column value is noise. This is the only format that is read rather
 * than queried, so it is the only one that gets headings.
 */
export function buildBlocks(
  sheet: ExportSheetDtoType,
  totals: readonly (string | null)[]
): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  for (const group of sheet.groups ?? []) {
    blocks.push({
      kind: 'heading',
      label: group.label,
      count: group.rowCount,
      height: GROUP_HEADING_HEIGHT,
    });
    for (let n = 0; n < group.rowCount && index < sheet.rows.length; n += 1, index += 1) {
      blocks.push({ kind: 'row', index, height: ROW_HEIGHT });
    }
  }
  for (; index < sheet.rows.length; index += 1) {
    blocks.push({ kind: 'row', index, height: ROW_HEIGHT });
  }
  if (hasTotals(totals)) blocks.push({ kind: 'totals', height: TOTALS_HEIGHT });
  return blocks;
}

/**
 * Which blocks go on which page.
 *
 * The first page carries the masthead and the metadata block, so it holds less
 * than the rest; both heights arrive already net of the column-header band,
 * which repeats at the top of every page.
 *
 * Two things are never split:
 *
 * - **A group heading from its group.** A heading needs itself and
 *   `MIN_ROWS_UNDER_HEADING` rows on the same page or it moves to the next one.
 *   A heading alone at the foot of a page reads as an empty group.
 * - **The totals summary.** It is the line the document exists for; it does not
 *   straddle a page break.
 */
export function flowPages(
  blocks: readonly Block[],
  firstPageHeight: number,
  laterPageHeight: number
): Block[][] {
  const pages: Block[][] = [[]];
  let remaining = firstPageHeight;

  const newPage = () => {
    pages.push([]);
    remaining = laterPageHeight;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as Block;
    let needed = block.height;
    if (block.kind === 'heading') {
      for (let n = 1; n <= MIN_ROWS_UNDER_HEADING; n += 1) {
        const next = blocks[index + n];
        if (next?.kind === 'row') needed += next.height;
      }
    }
    // A block too tall for any page still gets placed — on a page of its own,
    // since `remaining` goes negative and the next block breaks. Nothing this
    // renderer produces is that tall, but "one block per page" is a better
    // answer to it than either an overlap or a loop that never ends.
    if (needed > remaining && (pages[pages.length - 1] as Block[]).length > 0) newPage();
    (pages[pages.length - 1] as Block[]).push(block);
    remaining -= block.height;
  }

  return pages;
}

/** `14 August 2026 at 09:31 UTC` — a statement says when it was taken in words,
 *  and says the zone, because a document sent to an accountant is read in a
 *  different one. */
export function statementTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = at.toISOString().slice(11, 16);
  return `${date} at ${time} UTC`;
}
