/**
 * Pulls a PDF's text layer out as markdown, so most vendor invoices (AWS,
 * Netflix, utilities, SaaS) never touch vision pricing to read text a
 * native parser can already see.
 *
 * There used to be a `classifyDocument` here that turned
 * `pagesNeedingOcr` into a document-level `text | scanned` verdict. It was
 * removed: one weak page flipped the whole document to `scanned`, which
 * discarded a fully readable first page and routed a PDF to a vision
 * endpoint that rejects PDFs. The caller now judges the extracted text
 * directly, which is both the real question and immune to the two
 * functions in `@firecrawl/pdf-inspector` disagreeing about page indexing.
 *
 * This runs inside a job, so it is total: a corrupt upload — or something
 * that isn't a PDF despite its extension — degrades to `''` and lets the
 * caller fall back, rather than throwing inside a worker.
 */

import { extractPagesMarkdown } from '@firecrawl/pdf-inspector';

export function extractText(bytes: Uint8Array): string {
  try {
    const { pages } = extractPagesMarkdown(Buffer.from(bytes));
    return pages.map((page) => page.markdown).join('\n\n');
  } catch {
    return '';
  }
}
