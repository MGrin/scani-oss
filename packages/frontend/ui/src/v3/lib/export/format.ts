import { importChunk } from '../../../lib/lazy-chunk';
import { type CsvSeparator, defaultCsvSeparator, toCsvBlob } from './csv';
import { type ExportProvenance, type ExportSheet, provenanceSheet } from './workbook';

/**
 * The two formats a list offers, what each one is for, and the fact that the
 * choice is remembered.
 *
 * PDF is deliberately absent from a *list* export, and that is a decision
 * rather than an omission — see `docs/features/exports.md`. A PDF of 200 rows
 * is a worse CSV: it cannot be sorted, filtered, summed or re-imported, and it
 * takes a page-layout engine to produce. PDF belongs to reports, where layout
 * carries meaning.
 */

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export function exportFormatLabel(format: ExportFormat): string {
  if (format === 'csv') return 'CSV (.csv)';
  if (format === 'xlsx') return 'Excel (.xlsx)';
  return 'PDF (.pdf)';
}

export function exportFormatDetail(format: ExportFormat): string {
  if (format === 'csv') return 'Plain text. Opens anywhere, imports into anything.';
  if (format === 'xlsx') return 'Numbers stay numbers, headers stay put while you scroll.';
  // Said in terms of what it is *for*, because the other two are better at
  // everything else: a PDF cannot be sorted, summed or re-imported, and the
  // reason to choose it is that you are sending it to a person.
  return 'A statement to send to an accountant, a bank or a landlord.';
}

/**
 * PDF is rendered by the server, so this package cannot produce one on its own
 * — it has no network client and should not grow one.
 *
 * The app registers a renderer once at boot and every surface picks it up.
 * A service locator, deliberately and narrowly: the alternative is threading a
 * renderer prop through `V3DataView` and out to twelve list configs for a
 * capability that is a property of the *application*, not of any list. It also
 * degrades correctly — `apps/frontend/cloud` mounts the same list component and
 * has no PDF endpoint, so it simply never registers one and PDF is not offered
 * there rather than being offered and failing.
 */
export type PdfRenderer = (workbook: ExportWorkbook) => Promise<Blob>;

let pdfRenderer: PdfRenderer | null = null;

export function registerPdfRenderer(renderer: PdfRenderer): void {
  pdfRenderer = renderer;
}

export function pdfAvailable(): boolean {
  return pdfRenderer !== null;
}

/** The formats a surface can offer right now. PDF appears only where a renderer
 *  has been registered, so the menu never shows a choice that cannot be made. */
export function availableExportFormats(): readonly ExportFormat[] {
  return pdfAvailable() ? (['csv', 'xlsx', 'pdf'] as const) : (['csv', 'xlsx'] as const);
}

/**
 * Everything one export writes: the data, and the description of it.
 *
 * Provenance is a **field**, not `sheets[1]`. It used to be appended to the
 * sheet list, which meant the CSV writer — which can only take one table — had
 * no way to tell the description apart from the data and dropped it on the
 * floor along with everything else after the first entry. That is SC-93 item 2,
 * and the positional coupling was the whole cause: the content already existed
 * and simply had nowhere to go.
 */
export interface ExportWorkbook {
  sheets: readonly ExportSheet[];
  provenance: ExportProvenance;
}

/**
 * A CSV holds exactly one table, so a multi-set export is XLSX or nothing —
 * but it holds a *preamble* fine, and now carries one.
 *
 * **The XLSX writer arrives on demand** (SC-132 #6). `write-excel-file` is
 * 59.6 KB of the bundle and is reached only by someone who picks Excel — the
 * default is CSV, and most readers never open the format menu at all. This
 * function was already `async` for the PDF path, so deferring it costs the
 * call site nothing.
 *
 * The failure is the point of `importChunk`: a chunk fetched on a phone
 * minutes after the page loaded can simply not arrive. Every caller already
 * wraps this in `try/catch` → `showErrorToast`, so a `ChunkLoadError` surfaces
 * as a sentence about the connection. **An export button that silently does
 * nothing is worse than a slow one** — that is the standard SC-93 set for this
 * path, and a swallowed rejection here would break it.
 */
export async function toExportBlob(
  workbook: ExportWorkbook,
  format: ExportFormat,
  separator: CsvSeparator
): Promise<Blob> {
  if (format === 'pdf') {
    if (!pdfRenderer) throw new Error('PDF export is not available here');
    return pdfRenderer(workbook);
  }
  if (format === 'csv') {
    const first = workbook.sheets[0];
    if (!first) throw new Error('Nothing to export');
    return toCsvBlob(first, separator, workbook.provenance);
  }
  const { toXlsxBlob } = await importChunk(() => import('./xlsx'), {
    chunk: 'Excel writer',
  });
  // About last: it is a caption, and a workbook that opens on its own metadata
  // makes the reader click before seeing their data.
  return toXlsxBlob([...workbook.sheets, provenanceSheet(workbook.provenance)]);
}

const FORMAT_KEY = 'scani-v3-export-format';
const SEPARATOR_KEY = 'scani-v3-export-separator';
const HIDE_AMOUNTS_KEY = 'scani-v3-export-hide-amounts';

/**
 * The last choice, remembered.
 *
 * Both settings are properties of the reader's *spreadsheet*, not of the list
 * they happen to be on — someone whose Excel wants semicolons wants them on
 * every surface, forever. Re-picking them on each export would be the interface
 * asking a question it already knows the answer to.
 *
 * Read through a whitelist, like `useViewPreference`: a value written by an
 * older build resolves to the default rather than reaching a writer that no
 * longer handles it.
 */
/**
 * Read against **every** format, not the currently available ones.
 *
 * The renderer registers in an effect at the app root, and effects run
 * child-first — so a list's export sheet reads this while `pdfAvailable()` is
 * still false on the very first render after a reload. Filtering here threw the
 * reader's remembered `pdf` away and silently sent them a CSV, which is exactly
 * the kind of quiet wrong answer this module keeps being asked not to give.
 *
 * `ExportSheet` clamps to what it is actually offering, so an unavailable
 * format still cannot be chosen — the check belongs at the point of use, where
 * it knows the answer, not at the point of reading.
 */
export function readExportFormat(): ExportFormat {
  return readPreference(FORMAT_KEY, ['csv', 'xlsx', 'pdf'], 'csv');
}

export function writeExportFormat(format: ExportFormat): void {
  writePreference(FORMAT_KEY, format);
}

export function readCsvSeparator(): CsvSeparator {
  return readPreference<CsvSeparator>(SEPARATOR_KEY, [',', ';'], defaultCsvSeparator());
}

export function writeCsvSeparator(separator: CsvSeparator): void {
  writePreference(SEPARATOR_KEY, separator);
}

/**
 * Whether to withhold the amounts — remembered, and **defaulting to off**.
 *
 * Remembered because someone who shares files without figures tends to do it
 * again. Off by default because the two mistakes are not symmetrical: an
 * unwanted money-less file is an annoyance the reader sees immediately, and a
 * silently money-less file is one they send to an accountant. Only an explicit
 * `'1'` turns it on, so a corrupt or half-written value reads as off.
 */
export function readHideAmounts(): boolean {
  return readPreference(HIDE_AMOUNTS_KEY, ['0', '1'], '0') === '1';
}

export function writeHideAmounts(hide: boolean): void {
  writePreference(HIDE_AMOUNTS_KEY, hide ? '1' : '0');
}

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return allowed.find((option) => option === raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private-mode quota error must not stop the export the reader asked for.
  }
}
