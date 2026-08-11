/**
 * Text-first PDF routing: classify a PDF as `text` or `scanned` without a
 * vision model, and pull markdown out of the pages that don't need one.
 *
 * Most vendor invoices (AWS, Netflix, utilities, SaaS) are text-based PDFs.
 * Running every upload through vision pricing to read text a native parser
 * can already see is wasted spend. `@firecrawl/pdf-inspector` tells us,
 * per page, whether the text layer is trustworthy (`pagesNeedingOcr`) —
 * that field is the routing signal, not a length or byte-sniffing guess a
 * scanned PDF with a thin OCR text layer could fool.
 *
 * This runs inside a job. A PDF that fails to parse — corrupt upload, or
 * not a PDF at all despite the extension — is not a reason to fail the
 * job; it's a reason to fall back to the vision path, which is why both
 * functions below are total: `classifyDocument` degrades to `scanned` and
 * `extractText` degrades to `''` rather than throwing.
 */

import { classifyPdf, extractPagesMarkdown } from '@firecrawl/pdf-inspector';

export interface DocumentClassification {
  kind: 'text' | 'scanned';
  pageCount: number;
  pagesNeedingOcr: number[];
}

const UNCLASSIFIABLE: DocumentClassification = {
  kind: 'scanned',
  pageCount: 0,
  pagesNeedingOcr: [],
};

export function classifyDocument(bytes: Uint8Array): DocumentClassification {
  try {
    const { pageCount, pagesNeedingOcr } = classifyPdf(Buffer.from(bytes));
    return {
      kind: pagesNeedingOcr.length > 0 ? 'scanned' : 'text',
      pageCount,
      pagesNeedingOcr,
    };
  } catch {
    // Not a PDF, or the parser rejected it outright — recoverable by
    // routing to vision, unlike an uncaught throw inside a job.
    return UNCLASSIFIABLE;
  }
}

export function extractText(bytes: Uint8Array): string {
  try {
    const { pages } = extractPagesMarkdown(Buffer.from(bytes));
    return pages.map((page) => page.markdown).join('\n\n');
  } catch {
    return '';
  }
}
