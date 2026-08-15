import { FileImage, FileSpreadsheet, FileText, type LucideIcon, Paperclip } from 'lucide-react';

/**
 * The Files surface's pure half — what an uploaded file *is*, what happened to
 * it, and how the list is sliced.
 *
 * Two derived values carry this screen, and neither exists as a column:
 *
 * - **The extraction outcome.** `documents` has no parse-status column, so
 *   "did this work" has to be read off `purpose` and `extractionCount`
 *   together. v2's Files page shows the raw count and an em dash, which makes
 *   a PDF the extractor found nothing in indistinguishable from a screenshot
 *   that was never sent to it. Those are opposite outcomes: the first is a
 *   failure the user can act on with Re-parse, the second is not a failure at
 *   all.
 * - **Whether the file is still stored.** Retention shipped after ingestion
 *   did, and a failed parse deliberately keeps its upload, so `downloadable`
 *   is the difference between a row you can re-parse and one where the only
 *   honest options are delete-and-upload-again.
 */

/** The fields the list's own logic reads off a `documents.list` row. */
export interface DocumentRow {
  id: string;
  /** Widened deliberately, exactly as v2 widens it: the column is plain `text`
   *  and the API returns the raw value, so a purpose added server-side must
   *  render rather than fail a type assertion. */
  purpose: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
  /** Invoices found in the file. Always 0 for purposes that are not read by
   *  the invoice extractor. */
  extractionCount: number;
  /** False for files ingested before retention shipped, and for the rare row
   *  whose retention failed — the object is gone, the record is not. */
  downloadable: boolean;
}

const PURPOSE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  screenshot: 'Screenshot',
  'file-import': 'Import',
};

/** Falls back to the raw value so a purpose added on the API side still reads. */
export function documentPurposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? purpose;
}

/**
 * Kind options for the filter sheet, restricted to the kinds actually present
 * — the same rule `jobBucketOptions` follows. An option that can only ever
 * produce the filtered-empty screen is a control that lies about what the list
 * contains.
 */
export function documentPurposeOptions(
  documents: readonly DocumentRow[]
): { value: string; label: string }[] {
  const present = [...new Set(documents.map((document) => document.purpose))];
  return present
    .map((purpose) => ({ value: purpose, label: documentPurposeLabel(purpose) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * What the extractor made of the file.
 *
 * `not-read` is not a failure and must not read as one: a screenshot goes to
 * the screenshot parser and a CSV to the importer, and neither ever reaches
 * the invoice extractor. `nothing-found` is the one that wants an action.
 */
export type ExtractionOutcome = 'extracted' | 'nothing-found' | 'not-read';

export function extractionOutcome(document: DocumentRow): ExtractionOutcome {
  if (document.purpose !== 'invoice') return 'not-read';
  return document.extractionCount > 0 ? 'extracted' : 'nothing-found';
}

const OUTCOME_LABELS: Record<ExtractionOutcome, string> = {
  extracted: 'Invoices found',
  'nothing-found': 'Nothing found',
  'not-read': 'Not read for invoices',
};

/** The filter's own name for an outcome. The row says it more briefly — see
 *  `extractionSummary`. */
export function extractionOutcomeLabel(outcome: ExtractionOutcome): string {
  return OUTCOME_LABELS[outcome];
}

export function extractionOutcomeOptions(
  documents: readonly DocumentRow[]
): { value: string; label: string }[] {
  const present = new Set(documents.map(extractionOutcome));
  return (['extracted', 'nothing-found', 'not-read'] as const)
    .filter((outcome) => present.has(outcome))
    .map((outcome) => ({ value: outcome, label: extractionOutcomeLabel(outcome) }));
}

/**
 * The row's own one-word answer, in the value zone.
 *
 * "3 invoices" rather than a bare "3": the count is meaningless without the
 * noun, and the value zone is the only place on a phone row where the reader
 * is looking for the outcome.
 */
export function extractionSummary(document: DocumentRow): string {
  switch (extractionOutcome(document)) {
    case 'extracted':
      return `${document.extractionCount} invoice${document.extractionCount === 1 ? '' : 's'}`;
    case 'nothing-found':
      return 'Nothing found';
    default:
      return '—';
  }
}

/**
 * A file-type mark for the row's leading slot.
 *
 * Read off the MIME type rather than the purpose, because the two answer
 * different questions: purpose is why the file is here, this is what it is. A
 * spreadsheet imported as holdings and a photographed invoice are different
 * things at a glance and the same word ("Import", "Invoice") otherwise.
 */
export function documentIcon(mimeType: string): LucideIcon {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('csv') || mimeType.includes('sheet') || mimeType.includes('excel')) {
    return FileSpreadsheet;
  }
  return Paperclip;
}

export function matchesDocumentSearch(document: DocumentRow, query: string): boolean {
  return (
    document.originalFilename.toLowerCase().includes(query) ||
    documentPurposeLabel(document.purpose).toLowerCase().includes(query)
  );
}

export function compareDocuments(
  a: DocumentRow,
  b: DocumentRow,
  field: string,
  direction: string
): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'name':
      return a.originalFilename.localeCompare(b.originalFilename) * mult;
    case 'kind':
      return documentPurposeLabel(a.purpose).localeCompare(documentPurposeLabel(b.purpose)) * mult;
    case 'size':
      return (a.byteSize - b.byteSize) * mult;
    case 'uploaded':
      return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * mult;
    default:
      return 0;
  }
}

export interface DocumentTotals {
  /**
   * Bytes actually held in storage — the STORED rows only.
   *
   * This used to sum `byteSize` across every row, including the ones counted
   * as `fileMissing` directly below it, so the hero read "Stored 8.2 MB" one
   * line above "12 files are no longer stored" (SC-69 3.1). A row's
   * `byteSize` is what the file weighed when it arrived, and it stays on the
   * record after the object is gone; that is the right column to sort a list
   * by and the wrong one to add up under the word "Stored".
   */
  byteSize: number;
  /** Invoices extracted across the rows shown, not across the account. */
  extractions: number;
  /** Rows whose stored object is gone, so neither download nor re-parse can
   *  do anything for them. Excluded from `byteSize` by definition. */
  fileMissing: number;
}

/** Over the rows actually shown — this feeds `V3DataViewConfig.summary`, which
 *  receives the filtered set. */
export function documentTotals(documents: readonly DocumentRow[]): DocumentTotals {
  return documents.reduce<DocumentTotals>(
    (totals, document) => ({
      byteSize: totals.byteSize + (document.downloadable ? document.byteSize : 0),
      extractions: totals.extractions + document.extractionCount,
      fileMissing: totals.fileMissing + (document.downloadable ? 0 : 1),
    }),
    { byteSize: 0, extractions: 0, fileMissing: 0 }
  );
}

/**
 * An extraction's confidence as a percentage, or null when the extractor did
 * not record one.
 *
 * A missing confidence is not zero confidence, and rendering it as "0%" is the
 * kind of wrong number that makes a reader reject a correct extraction.
 */
export function extractionConfidence(confidence: string | number | null): number | null {
  if (confidence === null || confidence === '') return null;
  const value = Number(confidence);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
