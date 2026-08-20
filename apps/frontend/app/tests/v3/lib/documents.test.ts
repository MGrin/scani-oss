import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  compareDocuments,
  type DocumentRow,
  documentIcon,
  documentPurposeLabel,
  documentPurposeOptions,
  documentPurposesMatching,
  documentTotals,
  extractionConfidence,
  extractionOutcome,
  extractionOutcomeOptions,
  extractionSummary,
} from '../../../src/v3/lib/documents';

const t = i18n.t.bind(i18n);

function file(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    purpose: 'invoice',
    originalFilename: 'acme-october.pdf',
    mimeType: 'application/pdf',
    byteSize: 120_000,
    createdAt: '2026-08-10T09:00:00.000Z',
    extractionCount: 2,
    downloadable: true,
    ...overrides,
  };
}

describe('extractionOutcome', () => {
  /**
   * The distinction the whole surface turns on, and the one v2's Files page
   * cannot express: both of these render as "—" there.
   */
  test('a read that found nothing is not the same as a file never read', () => {
    expect(extractionOutcome(file({ extractionCount: 0 }))).toBe('nothing-found');
    expect(extractionOutcome(file({ purpose: 'screenshot', extractionCount: 0 }))).toBe('not-read');
    expect(extractionOutcome(file({ purpose: 'file-import', extractionCount: 0 }))).toBe(
      'not-read'
    );
  });

  test('an invoice with extractions has been read successfully', () => {
    expect(extractionOutcome(file())).toBe('extracted');
  });

  test('the row says the count with its noun, and pluralises it', () => {
    expect(extractionSummary(t, file({ extractionCount: 1 }))).toBe('1 invoice');
    expect(extractionSummary(t, file({ extractionCount: 4 }))).toBe('4 invoices');
    expect(extractionSummary(t, file({ extractionCount: 0 }))).toBe('Nothing found');
    expect(extractionSummary(t, file({ purpose: 'screenshot', extractionCount: 0 }))).toBe('—');
  });
});

describe('filter options', () => {
  /**
   * An option that can only ever produce the filtered-empty screen is a control
   * that lies about what the list contains — the same rule `jobBucketOptions`
   * follows.
   */
  test('only kinds actually present are offered', () => {
    const options = documentPurposeOptions([
      file({ purpose: 'invoice' }),
      file({ id: 'd2', purpose: 'screenshot' }),
      file({ id: 'd3', purpose: 'screenshot' }),
    ]);
    expect(options).toEqual([
      { value: 'invoice', label: 'Invoice' },
      { value: 'screenshot', label: 'Screenshot' },
    ]);
  });

  test('an unknown purpose still reads, rather than failing an assertion', () => {
    expect(documentPurposeLabel('bank-feed')).toBe('bank-feed');
    expect(documentPurposeOptions([file({ purpose: 'bank-feed' })])).toEqual([
      { value: 'bank-feed', label: 'bank-feed' },
    ]);
  });

  test('outcomes are offered in urgency order, not first-seen order', () => {
    const options = extractionOutcomeOptions(t, [
      file({ purpose: 'screenshot', extractionCount: 0 }),
      file({ id: 'd2', extractionCount: 0 }),
      file({ id: 'd3', extractionCount: 3 }),
    ]);
    expect(options.map((option) => option.value)).toEqual([
      'extracted',
      'nothing-found',
      'not-read',
    ]);
  });
});

describe('documentTotals', () => {
  test('adds up only the rows it is given — it feeds the filtered summary', () => {
    const totals = documentTotals([
      file({ byteSize: 1000, extractionCount: 2 }),
      file({ id: 'd2', byteSize: 500, extractionCount: 1 }),
    ]);
    expect(totals).toEqual({ byteSize: 1500, extractions: 3, fileMissing: 0 });
  });

  /**
   * The hero says "Stored". It used to add `byteSize` across every row —
   * including the ones the sentence directly beneath it counts as no longer
   * stored — so `/documents` rendered "Stored 8.2 MB" one line above "12 files
   * are no longer stored" (SC-69 3.1). A row keeps its `byteSize` after the
   * object is deleted, which is right for sorting a list and wrong for a
   * total under that word.
   */
  test('a file that is no longer stored contributes no bytes to the stored total', () => {
    const totals = documentTotals([
      file({ byteSize: 1000 }),
      file({ id: 'd2', byteSize: 500, extractionCount: 1, downloadable: false }),
    ]);
    expect(totals).toEqual({ byteSize: 1000, extractions: 3, fileMissing: 1 });
  });

  test('every file gone is zero bytes stored, not the weight they used to be', () => {
    const totals = documentTotals([
      file({ byteSize: 1000, extractionCount: 0, downloadable: false }),
      file({ id: 'd2', byteSize: 500, extractionCount: 0, downloadable: false }),
    ]);
    expect(totals).toEqual({ byteSize: 0, extractions: 0, fileMissing: 2 });
  });

  test('an empty set is zeroes rather than a throw', () => {
    expect(documentTotals([])).toEqual({ byteSize: 0, extractions: 0, fileMissing: 0 });
  });
});

describe('extractionConfidence', () => {
  /**
   * "Not recorded" and "0%" are opposite claims about the same extraction, and
   * showing the second when the first is true is what makes a reviewer reject
   * a correct invoice.
   */
  test('a missing confidence is not zero confidence', () => {
    expect(extractionConfidence(null)).toBeNull();
    expect(extractionConfidence('')).toBeNull();
    expect(extractionConfidence('not-a-number')).toBeNull();
    expect(extractionConfidence('0')).toBe(0);
  });

  test('a decimal string becomes a whole percentage', () => {
    expect(extractionConfidence('0.925')).toBe(93);
    expect(extractionConfidence(0.5)).toBe(50);
  });
});

describe('search and sort', () => {
  /**
   * The half of the search the server cannot do (SC-244). The filename half
   * moved to `documents.list`; the KIND half stays here because the labels are
   * this app's copy, and the third case is why no server-side transformation
   * of the enum value could have stood in for it.
   */
  test('a term matches a kind by its LABEL, which is not its stored value', () => {
    expect(documentPurposesMatching('invoice')).toEqual(['invoice']);
    expect(documentPurposesMatching('SCREEN')).toEqual(['screenshot']);
    // Displayed as "Import". A server matching the value would answer
    // `file-import` here and miss it for "import"; this answers both correctly.
    expect(documentPurposesMatching('import')).toEqual(['file-import']);
    expect(documentPurposesMatching('file')).toEqual([]);
    expect(documentPurposesMatching('kraken')).toEqual([]);
    expect(documentPurposesMatching('  ')).toEqual([]);
  });

  test('every sort field the surface offers actually orders', () => {
    const a = file({ originalFilename: 'a.pdf', byteSize: 1, createdAt: '2026-01-01T00:00:00Z' });
    const b = file({
      id: 'd2',
      originalFilename: 'b.pdf',
      byteSize: 2,
      createdAt: '2026-02-01T00:00:00Z',
    });
    for (const field of ['name', 'size', 'uploaded']) {
      expect(compareDocuments(a, b, field, 'asc')).toBeLessThan(0);
      expect(compareDocuments(a, b, field, 'desc')).toBeGreaterThan(0);
    }
    expect(compareDocuments(a, b, 'unknown-field', 'asc')).toBe(0);
  });

  test('kind sorts by the label, not by the stored value', () => {
    // 'file-import' sorts before 'invoice' as a raw string; "Import" sorts
    // before "Invoice" as a label too, so the case that proves it is the pair
    // whose raw order and label order disagree.
    const screenshot = file({ purpose: 'screenshot' });
    const fileImport = file({ id: 'd2', purpose: 'file-import' });
    expect(compareDocuments(fileImport, screenshot, 'kind', 'asc')).toBeLessThan(0);
  });
});

describe('documentIcon', () => {
  /** Read off the MIME type, because purpose answers a different question. */
  test('the mark distinguishes a photographed invoice from a PDF one', () => {
    expect(documentIcon('image/heic')).not.toBe(documentIcon('application/pdf'));
    expect(documentIcon('text/csv')).not.toBe(documentIcon('application/pdf'));
    expect(documentIcon('application/octet-stream')).toBeDefined();
  });
});
