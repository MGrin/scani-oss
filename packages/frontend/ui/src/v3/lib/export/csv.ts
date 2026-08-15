import {
  type ExportProvenance,
  type ExportSheet,
  type ExportValue,
  provenanceLines,
} from './workbook';

/**
 * RFC 4180 CSV, and the separator decision SC-89 asked to be made deliberately.
 *
 * **The decimal point never moves.** Every figure this app writes uses `.` as
 * its decimal mark, in every locale, in every file. SC-75 fixed the input
 * direction — a European reader typing `1,50` — by parsing both marks; the
 * output direction is fixed the other way, by never emitting the ambiguous one.
 * A file containing `1,50` cannot be told apart from a file containing two
 * fields, and no amount of quoting rescues a reader who has already guessed
 * wrong. So the ambiguity is removed at the source rather than negotiated.
 *
 * **The field separator does move, because it has to.** Excel splits a CSV on
 * the *system list separator*, not on the comma: on a machine set to a language
 * that writes `1,50`, the list separator is `;` and a comma-separated file
 * opens as one column of text. That is the same defect as SC-75 wearing
 * different clothes — the file is right and the reader is wrong about it — and
 * the only cure is to write the separator that reader's Excel expects. So the
 * export offers both, defaults from the browser's own locale
 * (`defaultCsvSeparator`), and says which one it is using in the sheet.
 *
 * The two decisions are independent on purpose: `;` as a separator with `.` as
 * a decimal is unambiguous in every parser, whereas `;` *plus* `,` decimals
 * would put the ambiguity back for anyone who opens the file outside Excel.
 *
 * **Preamble.** Since SC-93 the file opens with `#`-marked provenance lines —
 * what this is, the scope that produced it, when it was taken, and whether the
 * amounts were withheld. The rule this replaced said a CSV must be "only a
 * header row and data rows", on the grounds that a preamble makes Numbers
 * import junk rows. That cost is real and it is the wrong trade: these files
 * exist to be *sent to someone*, and a file that cannot say what it is or when
 * it was taken is worth less than one with two extra lines at the top. Every
 * bank CSV does this. A parser opts out with `comment='#'`; a spreadsheet shows
 * two labelled rows above the table, which is what a reader wants anyway.
 *
 * The marker is `#` on **every** preamble line, including the blank separator,
 * so no line is ambiguous and a naive reader that does not strip them still
 * gets a file whose first column says what it is looking at.
 *
 * **BOM.** `toCsvBlob` prefixes U+FEFF. Without it Excel on Windows reads a
 * UTF-8 file as the system code page, and every vendor with an accent in its
 * name — `Société`, `Müller` — arrives mangled. Numbers and every other reader
 * skip the BOM silently. `toCsv` returns the text *without* it so a test can
 * assert on the content rather than on the preamble.
 */

export type CsvSeparator = ',' | ';';

/**
 * The separator this reader's spreadsheet is most likely to expect.
 *
 * Derived from the browser's own number formatting rather than from a list of
 * countries: if `Intl` writes one and a half as `1,5` for this user, their
 * Excel's list separator is `;`. That is the actual rule Windows applies, read
 * from the same place Windows reads it, and it needs no table to maintain.
 */
export function defaultCsvSeparator(locale?: string): CsvSeparator {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
    const decimal = parts.find((part) => part.type === 'decimal')?.value;
    return decimal === ',' ? ';' : ',';
  } catch {
    return ',';
  }
}

/**
 * Characters that turn a text cell into a formula when Excel or Sheets opens
 * the file. A cell reading `=1+1` is evaluated; one reading `@SUM(A1)` can
 * become a remote call in older Excel. Vendor names, account names and document
 * titles are all user-supplied strings that land in text cells, so the
 * mitigation belongs here rather than in a review of every surface.
 *
 * A leading apostrophe is the standard neutraliser — Excel strips it on
 * display, and it is visible enough in a plain-text read that nobody mistakes
 * the value for corrupted. `-` is *not* in the set: a lone dash and a negative
 * figure are both ordinary content, and prefixing them would damage far more
 * cells than it protected.
 */
const FORMULA_LEAD = /^[=+@\t\r]/;

function escapeField(raw: string, separator: CsvSeparator): string {
  const needsQuotes =
    raw.includes(separator) ||
    raw.includes('"') ||
    raw.includes('\n') ||
    raw.includes('\r') ||
    raw !== raw.trim();
  const escaped = raw.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * One cell as CSV text. Figures lose every ornament: no symbol, no grouping, no
 * sign but a leading `-`. The header carries the currency, and — since SC-174 —
 * the `%` for a percent column, which is the one unit no writer can put in the
 * cell without turning the figure into text.
 *
 * **Ornament is all they lose.** The digits are the sheet's, exactly: a figure
 * arrives from `toScalar` already rounded to the decimals it declares, so this
 * writes the same number the XLSX displays and the PDF prints. It used to write
 * `value.value` raw while the other two applied the declared precision, which is
 * how a `Gain / loss` column reached a reader as `35.13513513513512` — twelve
 * digits of float noise under a header that did not even say percent.
 */
export function csvField(value: ExportValue): string {
  switch (value.kind) {
    case 'blank':
      return '';
    case 'text':
      return FORMULA_LEAD.test(value.value) ? `'${value.value}` : value.value;
    case 'number':
      return value.value;
    case 'date':
      // Date-only stays date-only. `2026-01-31T00:00:00.000Z` in a column of
      // dates is a timestamp the reader has to strip, and its `00:00Z` is a
      // fact about our storage rather than about the transaction.
      return value.withTime ? value.value : value.value.slice(0, 10);
  }
}

export const CSV_COMMENT = '#';

/**
 * The provenance block, as comment lines.
 *
 * Not escaped as CSV fields: these are prose, they are marked as comments, and
 * quoting them would put stray `"` characters in front of a human reader to
 * satisfy a parser that has already been told to skip the lines. What they do
 * get is newline stripping — a filter value containing a line break would
 * otherwise silently end the comment and inject a row.
 */
export function csvPreamble(provenance: ExportProvenance): string[] {
  return [
    ...provenanceLines(provenance).map(
      ({ label, value }) => `${CSV_COMMENT} ${label}: ${value.replace(/[\r\n]+/g, ' ')}`
    ),
    CSV_COMMENT,
  ];
}

export function toCsv(
  sheet: ExportSheet,
  separator: CsvSeparator = ',',
  provenance?: ExportProvenance
): string {
  const lines = provenance ? csvPreamble(provenance) : [];
  lines.push(sheet.headers.map((header) => escapeField(header, separator)).join(separator));
  for (const row of sheet.rows) {
    lines.push(row.map((cell) => escapeField(csvField(cell), separator)).join(separator));
  }
  // CRLF per RFC 4180, and a trailing one so the last row is a complete record
  // — a file ending mid-line makes some parsers drop it.
  return `${lines.join('\r\n')}\r\n`;
}

export function toCsvBlob(
  sheet: ExportSheet,
  separator: CsvSeparator = ',',
  provenance?: ExportProvenance
): Blob {
  // The BOM stays first, ahead of the preamble: it is a byte-order mark, not a
  // line, and Excel only honours it at offset zero. The `Société` case verified
  // in SC-89 regresses the moment anything gets in front of it.
  return new Blob([`\uFEFF${toCsv(sheet, separator, provenance)}`], {
    type: 'text/csv;charset=utf-8',
  });
}
