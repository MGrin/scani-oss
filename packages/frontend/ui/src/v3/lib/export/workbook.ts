import {
  type ExportSheetDtoType,
  type ExportValueDtoType,
  moneyDecimals,
  roundToDecimals,
} from '@scani/shared';
import { type ExportCell, exportText } from './cell';

/**
 * The step between "what a surface knows" and "what a file contains".
 *
 * A surface declares **fields** — a header and a function from a record to an
 * `ExportCell`. A file wants **columns** — a flat header row and a rectangle of
 * scalars. The gap between the two is entirely money, and it is why this module
 * exists rather than the writers reading fields directly:
 *
 * - A money field over rows in **one** currency is one column, with the code in
 *   the header: `Value (EUR)`. Repeating `EUR` down 200 rows is a column that
 *   carries no information and one more thing to strip before a pivot table.
 * - A money field over rows in **several** currencies is two columns — the
 *   amount and its code — because a single column of mixed-currency numbers is
 *   a column whose sum is meaningless. `/vendors` is exactly this list.
 * - A money field whose cells carry SC-60's base-currency companion gains a
 *   third: `Committed (EUR, converted)`. The screen shows `£42.50 / ≈ €49.73`
 *   and so does the file, and the word **converted** in the header is the
 *   export's version of the `≈` — a total in a column that does not say it was
 *   converted is a figure someone will reconcile against a bank statement.
 *
 * That decision needs every row of the column at once, which is why fields are
 * resolved in one pass here rather than row by row in the writers.
 */

export interface ExportField<T> {
  header: string;
  value: (item: T) => ExportCell;
  /** Whether the column adds up — see `V3ColumnDef.exportTotal`. Only the PDF
   *  reads it, and only to decide what to print in its summary. */
  total?: boolean;
}

/**
 * A resolved cell: one scalar, in one column, ready for any writer.
 *
 * Inferred from the zod schema in `@scani/shared` rather than declared here,
 * since SC-94: the PDF is rendered on the server, so this shape is a **wire
 * contract** as well as an internal one. Two declarations would be two things
 * to keep in step, and the one that drifted would produce a PDF that disagreed
 * with the CSV beside it.
 *
 * `style` drives the XLSX number format and the PDF's alignment; CSV writes the
 * bare digits either way.
 */
export type ExportValue = ExportValueDtoType;

/** One table. The XLSX tab name, the stem of a single-sheet CSV's file name,
 *  and the PDF's own title. `numericColumns` is right-aligned everywhere. */
export type ExportSheet = ExportSheetDtoType;

const BLANK: ExportValue = { kind: 'blank' };

/**
 * What a file *is* — subject, scope, when it was taken, what narrowed it.
 *
 * **This used to reach XLSX only, and that was wrong (SC-93 item 2).** The
 * original rule here was "a CSV is only ever a header row and data rows",
 * defended on the grounds that a preamble makes Numbers import junk rows and
 * `pandas.read_csv` misread the file. The first half is true and the conclusion
 * did not follow: every bank CSV in the world carries a preamble, readers cope
 * with it, and a parser opts out with one `comment='#'`. Weighed against that,
 * an exported file that cannot say what it is or when it was taken is worth
 * less to the person who has to hand it to someone else — which is what these
 * files are *for*.
 *
 * So provenance is now rendered twice from one description: as the workbook's
 * About sheet, and as `#`-marked lines above the CSV header. The two cannot
 * disagree, because neither owns the content.
 */
export interface ExportProvenance {
  /** "Holdings", "Vendors" — what was exported. */
  subject: string;
  /** "Filtered — 12 of 69 holdings" or "All 69 holdings". */
  scope: string;
  generatedAt: Date;
  /** Label/value pairs: the filters, the sort, the grouping, the rate date. */
  details: { label: string; value: string }[];
  /** How many data rows the file carries. Stated because a reader checking a
   *  file against a screen counts rows, and a spreadsheet's own row count is
   *  off by the header. */
  rowCount?: number;
  /**
   * SC-93 item 3 — set when the amounts were withheld.
   *
   * Not optional in spirit: a file with its money columns silently absent looks
   * like an export that failed halfway. Saying it was deliberate is what makes
   * the file trustworthy to whoever receives it, which is the entire point of
   * being able to send one.
   */
  amountsWithheld?: boolean;
}

export interface BuildSheetOptions {
  /**
   * The row runs the group-by produced, in row order — carried for the PDF,
   * which prints them as headings (SC-94). The spreadsheets ignore it and read
   * the group column instead.
   */
  groups?: { label: string; rowCount: number }[];
  /**
   * Set when `fields[0]` is the group-label column, so the sheet can say
   * *which* column that turned out to be. It cannot be assumed to be column
   * zero by the reader: a field can expand into several columns, and a field
   * can be dropped entirely while withholding amounts.
   */
  groupField?: boolean;
  /**
   * SC-93 item 3 — drop every column that discloses value.
   *
   * A **property of the column set, not of a field**, which is the reason it is
   * applied here and not by each surface. Removing the amount but leaving
   * `Gain / loss +12.4%`, or the base-currency equivalent, or the raw balance,
   * discloses the position anyway; someone sharing a file has removed the money
   * or they have not. So the rule is stated once, over the resolved cells:
   * `money`, `percent` and `number` go, `count`, `text` and `date` stay.
   *
   * Note which way round that is. Everything numeric is withheld *unless* it
   * was explicitly declared a `count` — see the `count` kind in `cell.ts`. A
   * column nobody classified is withheld, so forgetting a call site costs a
   * column rather than leaking one.
   */
  hideAmounts?: boolean;
}

/** Whether a cell carries value, and so must not survive `hideAmounts`. */
function disclosesValue(cell: ExportCell): boolean {
  return cell.kind === 'money' || cell.kind === 'percent' || cell.kind === 'number';
}

export function buildSheet<T>(
  name: string,
  fields: readonly ExportField<T>[],
  items: readonly T[],
  options: BuildSheetOptions = {}
): ExportSheet {
  const resolved = fields.map((field) => items.map((item) => field.value(item)));

  const headers: string[] = [];
  const numericColumns: boolean[] = [];
  const totalColumns: boolean[] = [];
  const columns: ExportValue[][] = [];

  let groupColumn: number | undefined;

  fields.forEach((field, index) => {
    const cells = resolved[index] as ExportCell[];
    // A column is judged on every row, not on the first: a money column whose
    // top row happens to be blank is still a money column, and one blank row
    // must not be enough to let it through.
    if (options.hideAmounts && cells.some(disclosesValue)) return;
    // And a column that came out entirely empty goes too — but only while
    // withholding. `/holdings` on an account with no cost basis produces a
    // `Gain / loss` column of nothing but blanks: `some(disclosesValue)` is
    // correctly false, so it survives, and the file then carries an empty
    // money-sounding column directly under a line saying the amounts were
    // removed. That reads as a bug in the redaction rather than as an account
    // with no cost basis. Outside `hideAmounts` the same column is left
    // standing, because there a stable column set is worth more than a tidy
    // one — the reader is diffing these files against each other.
    if (options.hideAmounts && cells.every((cell) => cell.kind === 'blank')) return;
    // Recorded here rather than before the two drops above, so a group column
    // that did not survive them leaves the index unset instead of pointing at
    // whichever column took its place.
    if (options.groupField && index === 0) groupColumn = headers.length;
    for (const column of expandField(field.header, cells)) {
      headers.push(column.header);
      numericColumns.push(column.numeric);
      // A field that adds up yields at most two columns that do: the amount and
      // its converted companion. The currency *code* beside a mixed-currency
      // amount is a label, not a figure.
      totalColumns.push(field.total === true && column.numeric);
      columns.push(column.values);
    }
  });

  const rows = items.map((_, rowIndex) => columns.map((column) => column[rowIndex] ?? BLANK));

  return {
    name,
    headers,
    rows,
    numericColumns,
    totalColumns,
    groups: options.groups,
    groupColumn,
  };
}

interface ResolvedColumn {
  header: string;
  numeric: boolean;
  values: ExportValue[];
}

function expandField(header: string, cells: readonly ExportCell[]): ResolvedColumn[] {
  const money = cells.filter((cell) => cell.kind === 'money');
  if (money.length === 0) {
    // A percent column names its unit in the header, exactly as a money column
    // names its currency there (SC-174). The XLSX and the PDF write a `%` into
    // the cell and a CSV writes none, by design — so `Gain / loss` over a
    // column of `35.14` was a figure whose unit a reader could only guess at,
    // and euros was as good a guess as percent. The condition is `every`, not
    // `some`: a column that is percent all the way down is a percent column,
    // and one that is not stays unlabelled rather than mislabelled.
    const percent =
      cells.some((cell) => cell.kind === 'percent') &&
      cells.every((cell) => cell.kind === 'percent' || cell.kind === 'blank');
    return [
      {
        header: percent ? `${header} (%)` : header,
        numeric: cells.some(
          (cell) => cell.kind === 'number' || cell.kind === 'percent' || cell.kind === 'count'
        ),
        values: cells.map(toScalar),
      },
    ];
  }

  const currencies = new Set(money.map((cell) => cell.currency));
  const single = currencies.size === 1 ? [...currencies][0] : null;
  const converted = money.every((cell) => cell.converted);

  const columns: ResolvedColumn[] = [
    {
      header: single ? `${header} (${single}${converted ? ', converted' : ''})` : header,
      numeric: true,
      values: cells.map(toScalar),
    },
  ];

  if (!single) {
    columns.push({
      header: `${header} currency`,
      numeric: false,
      values: cells.map((cell) =>
        cell.kind === 'money' ? { kind: 'text', value: cell.currency } : BLANK
      ),
    });
  }

  const baseCurrency = money.find((cell) => cell.base)?.base?.currency;
  if (baseCurrency) {
    columns.push({
      header: `${header} (${baseCurrency}, converted)`,
      numeric: true,
      values: cells.map((cell) =>
        cell.kind === 'money' && cell.base
          ? toMoneyScalar(cell.base.value, cell.base.currency)
          : BLANK
      ),
    });
  }

  return columns;
}

/**
 * A figure and the precision it is shown at, together — the sheet is where
 * rounding happens, and it happens once.
 *
 * This used to declare `decimals` and leave `value` at whatever precision it
 * arrived with, which left each writer to reconcile the two on its own. All
 * three did it differently and all three were defensible: the PDF applied the
 * declared decimals, the CSV ignored them and wrote 28 digits of arithmetic
 * noise (SC-174), and the XLSX applied them as a *display format* over an
 * unrounded number — so `1180/12` failed its round-trip check and was demoted
 * to a text cell that Excel's `SUM` silently skips (SC-172).
 *
 * A declared precision that the value does not already have is a fact nothing
 * can act on without disagreeing with whoever acts on it next. So the value is
 * rounded here, to the decimals declared beside it, and every writer receives a
 * figure it can only render one way. It also makes true a claim the PDF's
 * `totalsRow` already made in a comment — that the printed total is the sum of
 * the printed rows.
 *
 * Only a figure whose precision the sheet *knows* is rounded. A quantity
 * arrives with `decimals` undefined precisely because nobody has decided what
 * it should be rounded to, and a balance rounded by a default is the failure
 * `cell.ts` keeps every quantity a decimal string to avoid.
 */
function toScalar(cell: ExportCell): ExportValue {
  switch (cell.kind) {
    case 'blank':
      return BLANK;
    case 'text':
      return { kind: 'text', value: cell.value };
    case 'number':
      return {
        kind: 'number',
        value:
          cell.decimals === undefined ? cell.value : roundToDecimals(cell.value, cell.decimals),
        decimals: cell.decimals,
        style: 'plain',
      };
    case 'count':
      return { kind: 'number', value: roundToDecimals(cell.value, 0), decimals: 0, style: 'plain' };
    case 'money':
      return toMoneyScalar(cell.value, cell.currency);
    case 'percent':
      return {
        kind: 'number',
        value: roundToDecimals(cell.value, 2),
        decimals: 2,
        style: 'percent',
      };
    case 'date':
      return { kind: 'date', value: cell.value, withTime: false };
    case 'datetime':
      return { kind: 'date', value: cell.value, withTime: true };
  }
}

/**
 * Money at two decimals, unless two would write it as `0.00`.
 *
 * SC-179: a unit price below a cent is still a figure the reader multiplies by
 * the quantity beside it, and `4,200,000 × 0.00` is the row disproving its own
 * total. `moneyDecimals` extends only that figure — the column keeps its two
 * decimals for every row that can be read at two, rather than every row
 * carrying the widest row's zeros.
 */
function toMoneyScalar(value: string, currency: string): ExportValue {
  const decimals = moneyDecimals(value);
  return {
    kind: 'number',
    value: roundToDecimals(value, decimals),
    decimals,
    style: 'money',
    currency,
  };
}

/**
 * Provenance as an ordered list of label/value lines — the one description of
 * what a file is, rendered two ways.
 *
 * Split out for SC-93 item 2. It used to exist only as a workbook sheet, so the
 * CSV path had nothing to render and shipped with no provenance at all. The
 * content was never the problem; the shape was.
 */
export interface ProvenanceLine {
  label: string;
  value: string;
}

export function provenanceLines(provenance: ExportProvenance): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [
    { label: 'Exported from', value: 'Scani' },
    { label: 'Subject', value: provenance.subject },
    { label: 'Scope', value: provenance.scope },
    { label: 'Generated', value: provenance.generatedAt.toISOString() },
  ];
  if (provenance.rowCount !== undefined) {
    lines.push({ label: 'Rows', value: String(provenance.rowCount) });
  }
  lines.push(...provenance.details);
  if (provenance.amountsWithheld) {
    // Last, and phrased as an act rather than a state: whoever receives this
    // file needs to know a person removed the figures, not wonder whether the
    // export broke halfway.
    lines.push({
      label: 'Amounts',
      value: 'Withheld — every value, gain/loss and converted column was removed on purpose',
    });
  }
  return lines;
}

/** The About sheet, as a sheet: two labelled columns, so it is legible as a
 *  table rather than as a stray pair of unlabelled strings. */
export function provenanceSheet(provenance: ExportProvenance): ExportSheet {
  const rows: [string, string][] = provenanceLines(provenance).map((line): [string, string] => [
    line.label,
    line.value,
  ]);

  return {
    name: 'About',
    headers: ['Field', 'Value'],
    rows: rows.map(([label, value]) => [
      { kind: 'text', value: label } as ExportValue,
      toScalar(exportText(value)),
    ]),
    numericColumns: [false, false],
  };
}
