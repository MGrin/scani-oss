import { describe, expect, test } from 'bun:test';
import {
  compareDocuments,
  type DocumentListItem,
  documentPurposeLabel,
  matchesDocumentSearch,
} from '../../../src/v2/lib/documents';

function makeDocument(overrides: Partial<DocumentListItem> = {}): DocumentListItem {
  return {
    id: 'doc-1',
    purpose: 'invoice',
    originalFilename: 'invoice.pdf',
    mimeType: 'application/pdf',
    byteSize: 1000,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('documentPurposeLabel', () => {
  test('every purpose the list can filter on has a label', () => {
    expect(documentPurposeLabel('invoice')).toBe('Invoice');
    expect(documentPurposeLabel('screenshot')).toBe('Screenshot');
    expect(documentPurposeLabel('file-import')).toBe('Import');
  });

  // The API can add a purpose before this page knows about it; a raw value
  // reads better in the Kind column than an empty badge.
  test('an unknown purpose falls back to its raw value', () => {
    expect(documentPurposeLabel('email')).toBe('email');
  });
});

describe('matchesDocumentSearch', () => {
  test('matches the filename case-insensitively', () => {
    const item = makeDocument({ originalFilename: 'Hetzner-Invoice-04.pdf' });
    expect(matchesDocumentSearch(item, 'hetzner')).toBe(true);
    expect(matchesDocumentSearch(item, 'aws')).toBe(false);
  });

  // Filenames out of a phone camera ("IMG_4821.png") say nothing, so the kind
  // has to be searchable too.
  test('matches the kind label', () => {
    const item = makeDocument({ purpose: 'screenshot', originalFilename: 'IMG_4821.png' });
    expect(matchesDocumentSearch(item, 'screenshot')).toBe(true);
  });
});

describe('compareDocuments', () => {
  const older = makeDocument({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z', byteSize: 10 });
  const newer = makeDocument({ id: 'b', createdAt: '2026-08-01T00:00:00.000Z', byteSize: 90 });

  test('newest first is the default the page asks for', () => {
    expect(compareDocuments(newer, older, 'uploaded', 'desc')).toBeLessThan(0);
    expect(compareDocuments(newer, older, 'uploaded', 'asc')).toBeGreaterThan(0);
  });

  test('size sorts numerically, not as a formatted string', () => {
    const big = makeDocument({ byteSize: 2_000_000 });
    const small = makeDocument({ byteSize: 900_000 });
    expect(compareDocuments(small, big, 'size', 'asc')).toBeLessThan(0);
  });

  test('name and kind sort alphabetically', () => {
    const a = makeDocument({ originalFilename: 'a.pdf', purpose: 'file-import' });
    const b = makeDocument({ originalFilename: 'b.pdf', purpose: 'screenshot' });
    expect(compareDocuments(a, b, 'name', 'asc')).toBeLessThan(0);
    expect(compareDocuments(a, b, 'kind', 'asc')).toBeLessThan(0);
  });

  test('an unknown sort field leaves the order alone', () => {
    expect(compareDocuments(older, newer, 'nope', 'asc')).toBe(0);
  });
});
