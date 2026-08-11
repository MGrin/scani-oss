/**
 * Shape and presentation of an uploaded file, shared by the Files list and
 * its detail page.
 *
 * `purpose` names why the file entered the system — an invoice sent to the
 * extractor, a screenshot of a portfolio, a CSV/spreadsheet import — which
 * is the only thing that distinguishes two PDFs on the list.
 */

export const DOCUMENT_PURPOSES = ['invoice', 'screenshot', 'file-import'] as const;

export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number];

export interface DocumentListItem {
  id: string;
  purpose: DocumentPurpose;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
  /** Only invoices are parsed, so this is absent on every other purpose. */
  extractionCount?: number;
}

const PURPOSE_LABELS: Record<DocumentPurpose, string> = {
  invoice: 'Invoice',
  screenshot: 'Screenshot',
  'file-import': 'Import',
};

/** Falls back to the raw value so a purpose added on the API side still reads. */
export function documentPurposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose as DocumentPurpose] ?? purpose;
}

export const DOCUMENT_PURPOSE_FILTER_OPTIONS = [
  { value: 'invoice', label: 'Invoices' },
  { value: 'screenshot', label: 'Screenshots' },
  { value: 'file-import', label: 'Imports' },
];

export function matchesDocumentSearch(item: DocumentListItem, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    item.originalFilename.toLowerCase().includes(needle) ||
    documentPurposeLabel(item.purpose).toLowerCase().includes(needle)
  );
}

export function compareDocuments(
  a: DocumentListItem,
  b: DocumentListItem,
  field: string,
  direction: 'asc' | 'desc'
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
