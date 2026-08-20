import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  asDocumentParseSummary,
  DocumentParseResult,
} from '../../../src/v3/components/jobs/DocumentParseResult';
import { resolveV3ReviewRenderer } from '../../../src/v3/lib/job-result';

/**
 * The surface v3's invoice upload actually lands on, and the one place in v3
 * that produces `?fromExtraction=` without depending on a screen v3 has not
 * built yet.
 *
 * Rendered statically, like every other v3 surface test: this component takes
 * no tRPC hook, which is what keeps the assertion about the link rather than
 * about a mocked client.
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<StaticRouter location="/jobs/job-1">{node}</StaticRouter>);
}

const SUMMARY = {
  documentId: 'doc-1',
  deduped: false,
  invoiceCount: 1,
  upstreamCostUsd: 0.01,
  extractions: [
    {
      id: 'ext-1',
      vendorNameRaw: 'Hetzner Online GmbH',
      invoiceNumber: 'R0012345',
      totalAmount: '129.40',
      currencyCode: 'EUR',
    },
  ],
};

describe('DocumentParseResult', () => {
  test('links each extraction to the prefilled payment form', () => {
    const html = render(<DocumentParseResult result={SUMMARY} />);
    expect(html).toContain('/payments/recurring/new?fromExtraction=ext-1');
    expect(html).toContain('Hetzner Online GmbH');
    expect(html).toContain('R0012345');
  });

  test('the amount is rendered in the invoice currency, not defaulted', () => {
    const html = render(<DocumentParseResult result={SUMMARY} />);
    expect(html).toContain('129.40');
    expect(html).not.toContain('$129.40');
  });

  /**
   * A total with no currency stays a bare number. Defaulting it to USD — which
   * is what v2 does — turns "the extractor could not read the currency" into a
   * specific and possibly wrong claim about money, on the one screen that
   * exists for a human to catch exactly that.
   */
  test('a total with no currency is not given one', () => {
    const html = render(
      <DocumentParseResult
        result={{
          ...SUMMARY,
          extractions: [{ ...SUMMARY.extractions[0], currencyCode: null }],
        }}
      />
    );
    expect(html).toContain('129.40');
    expect(html).not.toContain('$');
    expect(html).not.toContain('€');
  });

  test('every extraction gets its own link when a file holds several', () => {
    const html = render(
      <DocumentParseResult
        result={{
          ...SUMMARY,
          invoiceCount: 2,
          extractions: [
            SUMMARY.extractions[0],
            { ...SUMMARY.extractions[0], id: 'ext-2', vendorNameRaw: 'Fastmail' },
          ],
        }}
      />
    );
    expect(html).toContain('fromExtraction=ext-1');
    expect(html).toContain('fromExtraction=ext-2');
  });

  /**
   * A deduped upload found nothing new, so there is no extraction to act on —
   * but the original document is the whole content of that message, and v2's
   * own comment says so. Offering no way to reach it is the failure this branch
   * is here to avoid.
   */
  test('a deduped file still reaches the original document', () => {
    const html = render(<DocumentParseResult result={{ ...SUMMARY, deduped: true }} />);
    expect(html).toContain('/documents/doc-1');
    expect(html).not.toContain('fromExtraction');
  });

  test('a file with no invoices says so and offers the file', () => {
    const html = render(
      <DocumentParseResult result={{ ...SUMMARY, invoiceCount: 0, extractions: [] }} />
    );
    expect(html).toContain('No invoices in this file');
    expect(html).toContain('/documents/doc-1');
  });

  test('an unrecognised payload renders a message rather than throwing', () => {
    expect(render(<DocumentParseResult result={{ nope: true }} />)).toContain(
      'without a result we recognise'
    );
    expect(render(<DocumentParseResult result={null} />)).toContain(
      'without a result we recognise'
    );
  });
});

describe('asDocumentParseSummary', () => {
  test('narrows only the shape the worker actually returns', () => {
    expect(asDocumentParseSummary(SUMMARY)).not.toBeNull();
    expect(asDocumentParseSummary({ documentId: 'd', deduped: false })).toBeNull();
    expect(asDocumentParseSummary({ documentId: 'd', extractions: [] })).toBeNull();
    expect(asDocumentParseSummary({ deduped: false, extractions: [] })).toBeNull();
    expect(asDocumentParseSummary('nope')).toBeNull();
    expect(asDocumentParseSummary(undefined)).toBeNull();
  });
});

describe('resolveV3ReviewRenderer', () => {
  /**
   * The override is one job kind wide on purpose. Every other renderer is v2's,
   * unchanged, because a review renderer is the result contract with the worker
   * — forking seven of them to restyle padding is the duplication this registry
   * exists to avoid.
   */
  test('overrides document-parse and delegates the rest', () => {
    expect(resolveV3ReviewRenderer('document-parse').kind).toBe('document-parse');
    const html = renderToStaticMarkup(
      <StaticRouter location="/jobs/job-1">
        {resolveV3ReviewRenderer('document-parse').render({
          result: SUMMARY,
          jobId: 'job-1',
          reviewOutcome: null,
          actionTakenAt: null,
        })}
      </StaticRouter>
    );
    expect(html).toContain('fromExtraction=ext-1');

    for (const kind of ['wallet-import', 'exchange-import', 'screenshot-parse', 'file-import']) {
      expect(resolveV3ReviewRenderer(kind).kind).toBe(kind);
    }
    expect(resolveV3ReviewRenderer('holding-price-update').kind).toBe('__fallback__');
  });
});
