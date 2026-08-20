import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { DocumentsList } from '../../../src/v3/components/documents/DocumentsList';
import { DocumentTotalsSummary } from '../../../src/v3/components/documents/DocumentTotalsSummary';
import {
  ExtractionRecord,
  type ExtractionRecordItem,
} from '../../../src/v3/components/documents/ExtractionRecord';
import type { DocumentRow } from '../../../src/v3/lib/documents';

/**
 * Files, rendered as the phone list — same harness and same reasoning as
 * `more-surfaces.test.tsx`: `renderToStaticMarkup` has no `window`, so
 * `useIsDesktop()` resolves false, and `StaticRouter` is required because
 * `V3DataView` reads the location unconditionally.
 *
 * None of these three components touches a tRPC hook. The queries live on
 * `FilesPage` and the mutations on the detail header, which is what keeps the
 * list assertable without a client.
 */
function render(node: React.ReactNode, path = '/documents'): string {
  return renderToStaticMarkup(<StaticRouter location={path}>{node}</StaticRouter>);
}

const noop = () => {};

const FILES: DocumentRow[] = [
  {
    id: 'doc-1',
    purpose: 'invoice',
    originalFilename: 'acme-october.pdf',
    mimeType: 'application/pdf',
    byteSize: 240_000,
    createdAt: '2026-08-10T09:00:00.000Z',
    extractionCount: 2,
    downloadable: true,
  },
  {
    id: 'doc-2',
    purpose: 'invoice',
    originalFilename: 'blurry-photo.heic',
    mimeType: 'image/heic',
    byteSize: 1_800_000,
    createdAt: '2026-08-09T09:00:00.000Z',
    extractionCount: 0,
    downloadable: true,
  },
  {
    id: 'doc-3',
    purpose: 'file-import',
    originalFilename: 'kraken-2026.csv',
    mimeType: 'text/csv',
    byteSize: 4_000,
    createdAt: '2026-08-08T09:00:00.000Z',
    extractionCount: 0,
    downloadable: false,
  },
];

describe('the Files list', () => {
  test('every file is a row, whatever brought it in', () => {
    const html = render(
      <DocumentsList documents={FILES} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
    );
    expect(html).toInclude('acme-october.pdf');
    expect(html).toInclude('blurry-photo.heic');
    expect(html).toInclude('kraken-2026.csv');
  });

  /**
   * The claim the surface exists to make. v2 renders the raw count with an em
   * dash for everything else, so a PDF the extractor found nothing in is
   * indistinguishable from a CSV that was never sent to it — opposite outcomes,
   * only one of which anyone can act on.
   */
  test('a read that found nothing reads differently from a file never read', () => {
    const html = render(
      <DocumentsList documents={FILES} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
    );
    expect(html).toInclude('2 invoices');
    expect(html).toInclude('Nothing found');
  });

  test('a file whose stored copy is gone says so on the row', () => {
    const html = render(
      <DocumentsList documents={FILES} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
    );
    expect(html).toInclude('file removed');
  });

  test('the empty screen offers the upload, and offers it inside v3', () => {
    const html = render(
      <DocumentsList documents={[]} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
    );
    expect(html).toInclude('No files yet');
    expect(html).toInclude('/documents/upload');
  });

  test('nothing has settled yet is not the same as owning no files', () => {
    const html = render(
      <DocumentsList
        documents={[]}
        query={{ ...SETTLED_QUERY_STATE, isLoading: true }}
        onSearch={() => {}}
      />
    );
    expect(html).not.toInclude('No files yet');
  });
});

describe('the Files summary', () => {
  test('adds up the rows it was handed, which is the filtered set', () => {
    const html = renderToStaticMarkup(<DocumentTotalsSummary documents={FILES} />);
    expect(html).toInclude('Stored');
    expect(html).toInclude('Invoices found');
    expect(html).toInclude('no longer stored');
  });

  test('a set with no extractions does not show a figure of zero', () => {
    const html = renderToStaticMarkup(
      <DocumentTotalsSummary documents={[FILES[2] as DocumentRow]} />
    );
    expect(html).not.toInclude('Invoices found');
  });
});

const EXTRACTION: ExtractionRecordItem = {
  id: 'ex-1',
  vendorNameRaw: 'Acme Hosting',
  invoiceNumber: 'INV-42',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  totalAmount: '129.00',
  currencyCode: 'EUR',
  paymentStatus: 'unpaid',
  confidence: '0.91',
  reviewState: 'pending',
};

describe('an extracted invoice', () => {
  test('a pending one offers the decision; a decided one does not', () => {
    const pending = renderToStaticMarkup(
      <ExtractionRecord
        extraction={EXTRACTION}
        onApprove={noop}
        onReject={noop}
        isRejecting={false}
      />
    );
    expect(pending).toInclude('Approve');
    expect(pending).toInclude('Reject');

    const accepted = renderToStaticMarkup(
      <ExtractionRecord
        extraction={{ ...EXTRACTION, reviewState: 'accepted' }}
        onApprove={noop}
        onReject={noop}
        isRejecting={false}
      />
    );
    expect(accepted).not.toInclude('Approve');
  });

  /**
   * v2 defaults a missing currency to USD, which turns "the extractor could not
   * tell" into a specific and possibly wrong claim about money — the one
   * mistake this screen exists to let a human catch.
   */
  test('a total with no currency stays a bare number', () => {
    const html = renderToStaticMarkup(
      <ExtractionRecord
        extraction={{ ...EXTRACTION, currencyCode: null }}
        onApprove={noop}
        onReject={noop}
        isRejecting={false}
      />
    );
    expect(html).not.toInclude('$');
    expect(html).toInclude('129');
  });

  /**
   * Which fields the extractor failed to read is the thing a reviewer is
   * checking for, so a row that vanishes when it is empty hides exactly that.
   */
  test('a field the extractor failed to read keeps its row, said in words', () => {
    const html = renderToStaticMarkup(
      <ExtractionRecord
        extraction={{ ...EXTRACTION, invoiceNumber: null, dueDate: null, confidence: null }}
        onApprove={noop}
        onReject={noop}
        isRejecting={false}
      />
    );
    expect(html).toInclude('No invoice number');
    expect(html).toInclude('Due date');
    expect(html).toInclude('Not recorded');
  });

  test('the review state is said once, in words rather than as a column value', () => {
    const html = renderToStaticMarkup(
      <ExtractionRecord
        extraction={{ ...EXTRACTION, reviewState: 'accepted' }}
        onApprove={noop}
        onReject={noop}
        isRejecting={false}
      />
    );
    expect(html).toInclude('Accepted');
    expect(html).not.toInclude('>accepted<');
  });
});
