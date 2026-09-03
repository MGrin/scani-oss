import {
  type ExportSheetDtoType,
  type RenderPdfInputType,
  SCANI_MARK,
  SCANI_VIOLET,
} from '@scani/shared';
import PDFDocument from 'pdfkit';
/**
 * **Static weights, not the variable face.** The app loads
 * `@fontsource-variable/ibm-plex-sans` and the obvious move was to embed the
 * same file — it produced a statement with the rules, the hairlines and the
 * mark all correct and **no text at all**. fontkit, which pdfkit embeds
 * through, does not instance a variable font: it finds no usable glyphs at a
 * weight axis and draws nothing. There is no error.
 *
 * Two static cuts instead — 400 for rows, 600 for the masthead and column
 * headings — which is the same typeface the browser renders, so the brand is
 * unchanged and the document gains a real bold rather than a synthesised one.
 *
 * Each of those weights is a *stack* of unicode subsets rather than one file,
 * and every string is split into runs by which subset covers each character.
 * `fonts.ts` explains why, and what a character no subset covers prints as.
 */
import { visualRuns } from './bidi';
import { loadTypesetter, type Run, type Typesetter, UNSUPPORTED_MARK } from './fonts';
import {
  type Block,
  buildBlocks,
  type Column,
  cellStyle,
  cellText,
  chooseGeometry,
  flowPages,
  type Geometry,
  GUTTER,
  HEADER_HEIGHT,
  headerText,
  layoutColumns,
  MARGIN,
  type Measure,
  ROW_HEIGHT,
  statementTimestamp,
  TYPE,
  type TypeStyle,
  totalsRow,
  tracking,
  truncate,
  withoutGroupColumn,
} from './layout';

/**
 * The branded statement — SC-94.
 *
 * A PDF of a list is **not** a table dump, and the difference is the whole
 * ticket. What makes a bank statement readable is not that it has borders; it
 * is that the eye can find a row, follow it across, and land on a figure whose
 * decimal point is in the same place as every other figure's. So:
 *
 * - **Hairlines, not boxes.** One rule under the column headers, one hairline
 *   between rows, nothing vertical. A grid draws attention to the grid; a
 *   statement should draw attention to the rows.
 * - **Figures in IBM Plex Mono, text in IBM Plex Sans** — the app's own faces,
 *   embedded from the very same `@fontsource` files the browser loads, so the
 *   document is recognisably Scani rather than Helvetica with a logo on top.
 *   Mono is what makes a money column line up on the decimal without any
 *   measuring.
 * - **Nothing wraps and nothing overflows.** Every string is measured in the
 *   font it will be drawn in and cut to its column with an ellipsis, and a
 *   *figure* is never cut at all (`layout.layoutColumns`).
 * - **The header block repeats and the footer counts pages.** A statement that
 *   loses its column headings on page two is a page of unlabelled numbers, and
 *   one without `Page 2 of 5` cannot be checked for completeness after printing.
 * - **Rows never straddle a page, and a group heading never leaves its group.**
 *   Pagination is computed up front (`layout.flowPages`) rather than discovered
 *   while drawing, which is also why the page count is known before the first
 *   page is written.
 *
 * **Why the server draws this.** Measured, not asserted: the only client
 * library that can lay out a statement (`@react-pdf/renderer`) costs +464 kB
 * gzip on a 629 kB bundle — a 74% increase in every page load, for a feature
 * used occasionally — and `CLAUDE.md` forbids `await import(...)`, so it cannot
 * be split out. `jspdf` is +135 kB and cannot do repeating headers or real page
 * breaks. Server-side costs one authenticated round trip and no bundle at all.
 * The numbers and the method are in `docs/features/2026-08-14_exports.md` §7.
 *
 * **The server does not decide what a list contains.** It is handed headers,
 * rows, groups and provenance — the same `ExportSheet` that becomes the CSV —
 * and only chooses how they look. That is what keeps the PDF and the CSV from
 * disagreeing, and it is why the wire contract lives in `@scani/shared`. The
 * one thing it adds is the account the document belongs to, which it takes from
 * the session rather than the payload: identity is the server's to state.
 */

const INK = '#111111';
const MUTED = '#6b6b6b';
const RULE = '#dedede';
const HAIRLINE = '#ececec';

const FOOTER_HEIGHT = 28;
const META_LINE_HEIGHT = 13;

/**
 * A document and the faces it can set — carried together because every string
 * now needs both: which faces cover its characters, and a document to measure
 * them on. Splitting them is how measuring and drawing come to disagree.
 */
interface Pen {
  doc: PDFKit.PDFDocument;
  type: Typesetter;
}

/** How wide `runs` set, in the style they will be drawn in.
 *
 *  Tracking is asked for per run rather than taken from the style, because a
 *  run in a script that joins is set without it (`layout.tracking`, SC-985).
 *  pdfkit charges tracking *between* characters and not after the last one, so
 *  a string cut into k runs is short by exactly the k-1 boundaries; each
 *  boundary is charged at the tracking of the run that precedes it, which is
 *  what `put` advances the cursor by. Without this a tracked heading measures
 *  narrower than it draws, which is the same defect as measuring `Gain / loss`
 *  and drawing `GAIN / LOSS`. */
function runsWidth(pen: Pen, runs: readonly Run[], style: TypeStyle): number {
  let width = 0;
  runs.forEach((run, index) => {
    const spacing = tracking(style, run.text);
    pen.doc.font(run.font).fontSize(style.size);
    width += pen.doc.widthOfString(run.text, { characterSpacing: spacing });
    if (index < runs.length - 1) width += spacing;
  });
  return width;
}

/**
 * The runs of `text`, cut by face and then ordered as they are drawn.
 *
 * The single place both halves go through, and that is the point rather than
 * tidiness: `runsWidth` charges tracking per run BOUNDARY, and ordering cuts a
 * mixed-direction line into more runs than the face split alone does. A
 * measure pass that skipped this would count a different number of boundaries
 * from the draw pass, which is the "measuring and drawing come to disagree"
 * failure this file already carries a comment about.
 */
function laidOut(pen: Pen, text: string, style: TypeStyle): Run[] {
  return visualRuns(pen.type.shape(text, style.face));
}

function measurer(pen: Pen): Measure {
  return (text, style) => runsWidth(pen, laidOut(pen, text, style), style);
}

/** One line of text at an exact point, never wrapped, never re-flowed. pdfkit's
 *  own width/ellipsis handling only applies to text it may also wrap, and a
 *  wrapped statement row collides with the row beneath it.
 *
 *  Drawn run by run at explicit coordinates rather than with `continued: true`:
 *  a continued run inherits pdfkit's flow, which is the thing this document
 *  cannot have, and advancing x by the width already measured keeps the drawn
 *  line exactly as wide as the layout was told it would be.
 *
 *  The cursor still advances left to right and always will — that is what a
 *  page coordinate means. What changed in SC-968 is that `laidOut` hands the
 *  runs over in the order they are DRAWN rather than the order they are
 *  stored, so a right-to-left run arrives at the point on the line where it
 *  belongs instead of the point its characters happen to be typed at. */
function put(
  pen: Pen,
  text: string,
  x: number,
  y: number,
  style: TypeStyle,
  colour: string,
  // `align` stays PHYSICAL, and SC-968 deliberately left it that way. Making it
  // logical means resolving `start`/`end` against a base direction, and the
  // render input has none to resolve against: `RenderPdfInput` carries a sheet
  // and a provenance block and no locale, language or direction anywhere in
  // either. Renaming the two values without an input that can select between
  // them would be an abstraction with nothing driving it, and it would read as
  // though the document had been made direction-aware when it had not.
  //
  // Nothing is misplaced by that. Alignment decides where a box of text sits in
  // its column; `laidOut` decides the order inside the box, and that is the
  // half a right-to-left name needs. Mirroring the TABLE — column order, the
  // mark, the footer — is SC-201's own step and is the thing that would supply
  // the missing direction (`@scani/shared`'s `LANGUAGE_FORMATS` already carries
  // `ar: { dir: 'rtl' }` for it).
  options: { width?: number; align?: 'left' | 'right' } = {}
): void {
  const width = options.width;
  const shown = width === undefined ? text : truncate(text, width, style, measurer(pen));
  const runs = laidOut(pen, shown, style);
  let cursor =
    options.align === 'right' && width !== undefined ? x + width - runsWidth(pen, runs, style) : x;
  for (const run of runs) {
    const spacing = tracking(style, run.text);
    pen.doc.font(run.font).fontSize(style.size).fillColor(colour);
    pen.doc.text(run.text, cursor, y, { lineBreak: false, characterSpacing: spacing });
    cursor += pen.doc.widthOfString(run.text, { characterSpacing: spacing }) + spacing;
  }
}

function rule(pen: Pen, geo: Geometry, y: number, colour: string, weight: number): void {
  pen.doc
    .moveTo(MARGIN.left, y)
    .lineTo(MARGIN.left + geo.contentWidth, y)
    .lineWidth(weight)
    .strokeColor(colour)
    .stroke();
}

/**
 * The Scani mark, drawn as vector from the shared geometry (`SCANI_MARK`).
 *
 * It used to be the letter `S` in a rounded square — a wordmark, not the brand.
 * The real mark is a rounded frame over three stacked bars, and it is drawn
 * here from the same numbers `ScaniLogo` renders in the app, because the api
 * cannot import a React package and a second copy of the coordinates is how a
 * logo drifts. Vector, not a raster: this is a print document, and a resampled
 * PNG beside vector type is exactly the softness the ticket asked to avoid.
 */
function drawMark(pen: Pen, x: number, y: number, size: number): void {
  const doc = pen.doc;
  const unit = size / SCANI_MARK.size;
  const { inset, radius } = SCANI_MARK.frame;
  const stroke = SCANI_MARK.strokeWidth * unit;

  doc.save();
  doc.lineWidth(stroke).strokeColor(SCANI_VIOLET).lineCap('round');
  doc
    .roundedRect(
      x + inset * unit,
      y + inset * unit,
      (SCANI_MARK.size - inset * 2) * unit,
      (SCANI_MARK.size - inset * 2) * unit,
      radius * unit
    )
    .stroke();
  for (const bar of SCANI_MARK.bars) {
    doc
      .moveTo(x + bar.x1 * unit, y + bar.y * unit)
      .lineTo(x + bar.x2 * unit, y + bar.y * unit)
      .stroke();
  }
  doc.restore();
}

function drawColumnHeaders(pen: Pen, geo: Geometry, columns: Column[], y: number): void {
  for (const column of columns) {
    put(pen, headerText(column.header), column.x, y, TYPE.columnHeader, MUTED, {
      width: column.width - GUTTER,
      align: column.numeric ? 'right' : 'left',
    });
  }
  rule(pen, geo, y + HEADER_HEIGHT - 8, RULE, 0.8);
}

function drawRow(
  pen: Pen,
  columns: Column[],
  row: RenderPdfInputType['sheet']['rows'][number],
  y: number
): void {
  columns.forEach((column, index) => {
    const cell = row[index];
    if (!cell) return;
    const text = cellText(cell);
    if (!text) return;
    put(pen, text, column.x, y, cellStyle(column), INK, {
      width: column.width - GUTTER,
      align: column.numeric ? 'right' : 'left',
    });
  });
}

/** A group heading: the label, the size of the group, and a rule that ties the
 *  two together and separates them from the run above. */
function drawGroupHeading(pen: Pen, geo: Geometry, label: string, count: number, y: number): void {
  const top = y + 10;
  put(pen, label, MARGIN.left, top, TYPE.groupHeading, INK, { width: geo.contentWidth * 0.7 });
  put(
    pen,
    `${count} ${count === 1 ? 'row' : 'rows'}`,
    MARGIN.left + geo.contentWidth * 0.7,
    top + 1,
    TYPE.groupCount,
    MUTED,
    { width: geo.contentWidth * 0.3, align: 'right' }
  );
  rule(pen, geo, top + 15, RULE, 0.5);
}

/**
 * The summary — the figure the reader checks first, and the reason a statement
 * is not a table.
 *
 * Set apart rather than appended: a heavier rule above it, the label in the
 * same small caps as the column headers, and the figures a size larger than the
 * rows in the same mono face, so they stay on the decimal they have been on all
 * the way down the page. Only the columns that have a meaningful total carry
 * one (`layout.totalsRow`); the rest are left blank rather than given a zero.
 */
function drawTotals(
  pen: Pen,
  geo: Geometry,
  columns: Column[],
  totals: readonly (string | null)[],
  y: number
): void {
  rule(pen, geo, y + 6, RULE, 1);
  const top = y + 16;
  const first = columns.findIndex((_, index) => totals[index] !== null);
  columns.forEach((column, index) => {
    const total = totals[index];
    if (total === null || total === undefined) return;
    put(pen, total, column.x, top, TYPE.totalFigure, INK, {
      width: column.width - GUTTER,
      align: 'right',
    });
  });
  // The word sits in whatever room is left to the left of the leftmost total,
  // so it never collides with a figure on a narrow page.
  const label = columns[first];
  if (label) {
    put(pen, 'TOTAL', MARGIN.left, top + 1, TYPE.totalLabel, MUTED, {
      width: Math.max(label.x - MARGIN.left - GUTTER, 0),
    });
  }
}

function drawFooter(pen: Pen, geo: Geometry, page: number, total: number, subject: string): void {
  const doc = pen.doc;
  const y = geo.height - MARGIN.bottom + 16;
  // The footer sits *below* the bottom margin, and pdfkit adds a page whenever
  // text is written past it — which turned a 3-page statement into 9, one blank
  // page per footer. Dropping the margin for the duration of the draw is the
  // documented way to write out of flow; it is restored immediately so nothing
  // else inherits it.
  const restore = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  rule(pen, geo, y - 10, RULE, 0.5);
  put(pen, `Scani · ${subject}`, MARGIN.left, y, TYPE.footer, MUTED, {
    width: geo.contentWidth / 2,
  });
  put(pen, `Page ${page} of ${total}`, MARGIN.left + geo.contentWidth / 2, y, TYPE.footer, MUTED, {
    width: geo.contentWidth / 2,
    align: 'right',
  });
  doc.page.margins.bottom = restore;
}

/**
 * What the metadata block says when a name contained a character no embedded
 * face can draw.
 *
 * The marker alone is honest but not actionable — a reader who meets `[?]` in a
 * vendor's name 200 rows down has no way to tell whether the document lost the
 * name or never had it. This says which, and where the whole name is. Kept
 * short enough to set on one metadata line at portrait width; anything longer
 * is truncated by the same rule as every other value here.
 */
/**
 * Exported so the test that proves this note reaches the page can DERIVE its
 * signature — the characters that appear here and nowhere else the document
 * sets — rather than hardcoding a word out of it. A test holding its own copy
 * of this sentence goes quiet the day the sentence is reworded (SC-782).
 */
export const UNSUPPORTED_NOTE = `${UNSUPPORTED_MARK} marks a character these fonts cannot set — the CSV and XLSX exports carry the full name.`;

/** The first page's masthead and metadata block. Returns the y the table starts
 *  at, so pagination and drawing cannot disagree about it. */
function drawMasthead(
  pen: Pen,
  geo: Geometry,
  input: StatementInput,
  substituted: boolean
): number {
  const { provenance } = input;
  drawMark(pen, MARGIN.left, MARGIN.top - 2, 26);

  put(pen, provenance.subject, MARGIN.left + 38, MARGIN.top, TYPE.title, INK, {
    width: geo.contentWidth - 38,
  });
  put(pen, provenance.scope, MARGIN.left + 38, MARGIN.top + 22, TYPE.scope, MUTED, {
    width: geo.contentWidth - 38,
  });

  let y = MARGIN.top + 52;
  rule(pen, geo, y, RULE, 0.8);
  y += 12;

  // The metadata block — the same provenance the CSV carries as `#` lines and
  // the workbook carries as an About sheet, so a reader comparing three files
  // of the same export sees the same facts in all three. Plus the account,
  // which only this format states: a statement is a document about *someone*.
  const meta: [string, string][] = [
    ['Account', input.account],
    ['Generated', statementTimestamp(provenance.generatedAt)],
    ...(provenance.rowCount === undefined
      ? []
      : ([['Rows', String(provenance.rowCount)]] as [string, string][])),
    ...provenance.details.map((detail): [string, string] => [detail.label, detail.value]),
    ...(provenance.amountsWithheld
      ? ([['Amounts', 'Withheld on purpose — this statement carries no figures']] as [
          string,
          string,
        ][])
      : []),
    ...(substituted ? ([['Characters', UNSUPPORTED_NOTE]] as [string, string][]) : []),
  ];

  const labelWidth = 96;
  for (const [label, value] of meta) {
    put(pen, label, MARGIN.left, y, TYPE.metaLabel, MUTED, { width: labelWidth - 6 });
    put(pen, value, MARGIN.left + labelWidth, y, TYPE.metaValue, INK, {
      width: geo.contentWidth - labelWidth,
    });
    y += META_LINE_HEIGHT;
  }

  return y + 14;
}

export interface StatementInput extends RenderPdfInputType {
  /**
   * Whose account this describes — `Name (email)`, or the address alone.
   *
   * Not on the wire and not the client's to send: it comes from the session on
   * the server (`accountLabel` builds it), because a document that names an
   * account is making a claim, and a claim the caller supplied is not one.
   */
  account: string;
}

/**
 * Every string this document will set.
 *
 * Gathered up front so the metadata block on page one can disclose a
 * substitution that first appears on page four — the reader is told before they
 * meet it, not after, and a marker in the last row of a long statement is still
 * explained. Cheap: these are the same strings the width pass measures anyway.
 */
export function documentText(input: StatementInput, sheet: ExportSheetDtoType): string[] {
  const { provenance } = input;
  return [
    provenance.subject,
    provenance.scope,
    input.account,
    ...provenance.details.flatMap((detail) => [detail.label, detail.value]),
    ...sheet.headers,
    ...(sheet.groups ?? []).map((group) => group.label),
    ...sheet.rows.flatMap((row) => row.map((cell) => cellText(cell))),
  ];
}

export async function renderStatement(input: StatementInput): Promise<Buffer> {
  const type = await loadTypesetter();
  const { provenance } = input;
  const sheet = withoutGroupColumn(input.sheet);
  const substituted = !documentText(input, sheet).every((text) => type.supports(text));

  // Orientation is a property of the table, decided before the first page
  // exists — but deciding it needs the fonts, which need a document. So a
  // throwaway one is opened purely to measure with, and the real one is created
  // knowing which way up the paper goes.
  // `font` is passed to BOTH constructors, and it is not a style choice.
  // pdfkit's default is Helvetica, whose metrics it reads at construction time
  // from `node_modules/pdfkit/js/data/Helvetica.afm` — a path that exists in
  // dev and does not exist in the runtime image, which holds only the compiled
  // binary. Omitting it throws ENOENT on the first export in production while
  // every local run passes, which is exactly what happened (SC-129).
  //
  // The cast is because @types/pdfkit types this option as `string` while the
  // implementation forwards it straight to `doc.font(src)`, which takes
  // `string | Buffer` — the same Buffer `registerFont` already accepts below.
  const startWithOwnFace = { font: type.primary as unknown as string };

  const geo = chooseGeometry(
    sheet,
    measurer({ doc: type.register(new PDFDocument(startWithOwnFace)), type })
  );

  const doc = new PDFDocument({
    ...startWithOwnFace,
    size: 'A4',
    layout: geo.landscape ? 'landscape' : 'portrait',
    margins: { ...MARGIN },
    autoFirstPage: false,
    info: {
      Title: `${provenance.subject} — ${provenance.scope}`,
      Author: 'Scani',
      Creator: 'Scani',
      Subject: provenance.scope,
    },
  });
  const pen: Pen = { doc: type.register(doc), type };

  const chunks: Uint8Array[] = [];
  doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const totals = totalsRow(sheet);
  const columns = layoutColumns(sheet, measurer(pen), geo.contentWidth);
  const blocks = buildBlocks(sheet, totals);

  // Measure the masthead by drawing it on the real first page, then flow the
  // blocks now that its height is known. Cheaper than maintaining a second copy
  // of the masthead's height, which would drift the first time a metadata line
  // is added — and two have been added since, this ticket's among them.
  doc.addPage();
  const tableTop = drawMasthead(pen, geo, input, substituted);
  const bottom = geo.height - MARGIN.bottom - FOOTER_HEIGHT;
  const pages = flowPages(
    blocks,
    bottom - tableTop - HEADER_HEIGHT,
    bottom - MARGIN.top - HEADER_HEIGHT
  );

  pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    const top = index === 0 ? tableTop : MARGIN.top;
    drawColumnHeaders(pen, geo, columns, top);

    let y = top + HEADER_HEIGHT;
    page.forEach((block: Block, position) => {
      if (block.kind === 'heading') {
        drawGroupHeading(pen, geo, block.label, block.count, y);
      } else if (block.kind === 'totals') {
        drawTotals(pen, geo, columns, totals, y);
      } else {
        const row = sheet.rows[block.index];
        if (row) drawRow(pen, columns, row, y);
        // A hairline *under* each row rather than a box around it, and never
        // under the last row of a run — a rule with nothing beneath it reads as
        // a total, which is a line this document uses for something else.
        const next = page[position + 1];
        if (next?.kind === 'row') rule(pen, geo, y + ROW_HEIGHT - 6, HAIRLINE, 0.5);
      }
      y += block.height;
    });

    if (page.length === 0) {
      put(pen, 'No rows in this selection.', MARGIN.left, y + 6, TYPE.rowText, MUTED);
    }

    drawFooter(pen, geo, index + 1, pages.length, provenance.subject);
  });

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}
