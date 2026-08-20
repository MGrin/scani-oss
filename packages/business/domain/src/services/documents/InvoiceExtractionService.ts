/**
 * Text-first invoice extraction through the AI provider abstraction.
 *
 * A PDF whose text layer actually carries the invoice goes through
 * `parseDocumentText` on the extracted markdown (cheap, no vision
 * pricing). Anything else — an image upload, a genuinely scanned PDF, or
 * a provider that doesn't implement the optional `parseDocumentText`
 * capability — falls back to `parseScreenshot`.
 *
 * The fallback hands the provider the ORIGINAL file, not a rendered page
 * image — there is no PDF-page-to-image renderer here. That is fine
 * because a provider that declares PDF support uploads it as a document
 * part (see `supportsPdfFileInput` in `_chat-completions.ts`); one that
 * doesn't throws, and this service surfaces that rather than storing an
 * empty extraction. Sending a PDF as an image part is what produced
 * `invalid_image_format` in production on 2026-08-11.
 *
 * `usage` is accumulated across every provider call this method makes so
 * a future multi-call path (e.g. one call per scanned page) keeps
 * reporting an accurate total instead of silently under-counting.
 *
 * Total by design, same discipline as `reviewDetail.ts`: an AI response
 * that is `null`, a bare string, or an object with none of the expected
 * fields degrades to zero invoices rather than throwing — a bad response
 * from a paid API call should not fail the whole extraction job.
 */

import type { ExtractionBillingPeriod, ExtractionPaymentStatus } from '@scani/db/schema';
import type { AIInferenceProvider, AIResult, AIUsage } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { isValidDecimalString } from '@scani/shared';
import { Container, Service } from 'typedi';
import { INVOICE_EXTRACTION_PROMPT, PROMPT_VERSION } from './invoicePrompt';
import { extractText } from './pdfExtraction';

export type ExtractorKind = 'text-llm' | 'vision-llm';

export interface ExtractedLineItem {
  description: string;
  /** Decimal string, or null when the model didn't report it. Never a JS float. */
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
}

export interface ExtractedInvoice {
  ordinal: number;
  vendorNameRaw: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  /** Decimal string. Never parsed into a JS float — see CLAUDE.md money rule. */
  totalAmount: string | null;
  currencyCode: string | null;
  /** Null whenever the document didn't say — never inferred. Downstream
      (the paid-invoice → recurring-payment bridge) treats null as
      "unknown", which is not the same decision as "unpaid". */
  paymentStatus: ExtractionPaymentStatus | null;
  billingPeriod: ExtractionBillingPeriod | null;
  lineItems: ExtractedLineItem[];
  confidence: number | null;
  promptVersion: string;
  extractorKind: ExtractorKind;
}

export interface InvoiceExtractionUsage {
  upstreamCostUsd: number;
}

export interface InvoiceExtractionResult {
  invoices: ExtractedInvoice[];
  usage: InvoiceExtractionUsage;
}

const PDF_MIME_TYPE = 'application/pdf';
/**
 * Below this, the text layer is a page title rather than a document, and
 * vision is worth paying for. Calibrated against a real two-page invoice:
 * its content page yielded 880 characters, its trailer page 14. Anything
 * carrying a vendor, an amount and a date clears this comfortably.
 */
const MIN_TEXT_CHARS_FOR_LLM = 200;

const EMPTY_RESULT: InvoiceExtractionResult = { invoices: [], usage: { upstreamCostUsd: 0 } };

@Service()
export class InvoiceExtractionService {
  async extract(bytes: Uint8Array, mimeType: string): Promise<InvoiceExtractionResult> {
    const provider = this.getProvider();
    if (!provider) return EMPTY_RESULT;

    if (mimeType === PDF_MIME_TYPE && provider.parseDocumentText) {
      // Route on the text we can ACTUALLY read, not on whether every page
      // has a trustworthy text layer. `classifyDocument` collapses
      // `pagesNeedingOcr` into a document-level boolean, so a two-page
      // invoice whose second page is a 14-character "Launch Plan" trailer
      // was classified `scanned` — throwing away 880 characters of
      // perfectly readable invoice on page one and sending the raw PDF to
      // a vision endpoint that rejects PDFs outright. Judging the
      // extracted markdown directly also sidesteps having to align
      // `pagesNeedingOcr`'s indexing with `extractPagesMarkdown`'s.
      const markdown = extractText(bytes).trim();
      if (markdown.length >= MIN_TEXT_CHARS_FOR_LLM) {
        // Passed as the SYSTEM prompt, not a hint. As a hint it sat
        // underneath the provider's default prompt, which hardcodes the
        // holdings schema — so every invoice came back as
        // `{holdings: []}`: valid JSON, billed, wrong shape, and zero
        // invoices stored without an error anywhere.
        const result = await provider.parseDocumentText(
          markdown,
          undefined,
          INVOICE_EXTRACTION_PROMPT
        );
        return toExtractionResult([result], 'text-llm');
      }
    }

    const imageBase64 = Buffer.from(bytes).toString('base64');
    // systemPrompt, not hint — for the same reason as the text path above.
    // A hint sits under the provider's default holdings schema, so the
    // vision path returned `{holdings: []}` even once the transport worked.
    const result = await provider.parseScreenshot({
      imageBase64,
      mimeType,
      systemPrompt: INVOICE_EXTRACTION_PROMPT,
    });
    return toExtractionResult([result], 'vision-llm');
  }

  /**
   * First registered AI provider, same "no available provider is a
   * degraded result, not a crash" posture as `AIRouter.getProviders()` —
   * this service doesn't chain across multiple providers because a
   * partial invoice extraction from provider B after provider A
   * half-parsed the document would be worse than a clean empty result
   * the caller can retry.
   */
  private getProvider(): AIInferenceProvider | null {
    try {
      const providers = Container.get(ProviderRegistry).getAIProviders();
      return providers[0] ?? null;
    } catch {
      return null;
    }
  }
}

function toExtractionResult(
  results: Array<AIResult<unknown>>,
  extractorKind: ExtractorKind
): InvoiceExtractionResult {
  const invoices = results.flatMap((result) => normalizeInvoices(result.data, extractorKind));
  const upstreamCostUsd = results.reduce((sum, result) => sum + costOf(result.usage), 0);
  return { invoices, usage: { upstreamCostUsd } };
}

function costOf(usage: AIUsage | undefined): number {
  return typeof usage?.upstreamCostUsd === 'number' ? usage.upstreamCostUsd : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Only a real calendar day in `YYYY-MM-DD` survives.
 *
 * `issue_date` / `due_date` are postgres `date` columns, and postgres is
 * far more permissive than the contract: it parses `'August 10, 2026'`
 * happily and reads `'03/04/2026'` through whatever `DateStyle` the
 * session happens to carry — so a model that answered in prose or in an
 * ambiguous numeric format would be *stored*, in the wrong slot, with no
 * error anywhere. Rejecting here keeps "the model ignored the format
 * rule" indistinguishable from "the document had no date", which is the
 * honest reading: neither one tells us which day the bill is due.
 *
 * The round-trip check is what rejects `2026-02-30` and `2026-13-01`;
 * the regex alone accepts both.
 */
function asIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.trim()
    ? null
    : value.trim();
}

/** Only a string that Decimal.js can parse passes through — a JS number
    from a model that ignored the prompt's "as a string" instruction is
    rejected rather than silently re-stringified, since that number may
    have already lost precision by the time it reached this process. */
function asDecimalString(value: unknown): string | null {
  return typeof value === 'string' && isValidDecimalString(value) ? value : null;
}

/** Models paraphrase rather than echo the enum ("Paid in full",
    "annually"), so a small synonym table sits in front of the exact
    match. Anything outside it is null, not a nearest guess: a wrong
    'paid' marks a live bill as settled, and a wrong period puts the next
    charge on the wrong date. */
const PAYMENT_STATUS_SYNONYMS: Record<string, ExtractionPaymentStatus> = {
  paid: 'paid',
  'paid in full': 'paid',
  settled: 'paid',
  'payment received': 'paid',
  unpaid: 'unpaid',
  outstanding: 'unpaid',
  due: 'unpaid',
  'balance due': 'unpaid',
};

const BILLING_PERIOD_SYNONYMS: Record<string, ExtractionBillingPeriod> = {
  week: 'week',
  weekly: 'week',
  'per week': 'week',
  month: 'month',
  monthly: 'month',
  'per month': 'month',
  quarter: 'quarter',
  quarterly: 'quarter',
  'per quarter': 'quarter',
  year: 'year',
  yearly: 'year',
  annual: 'year',
  annually: 'year',
  'per year': 'year',
};

function canonicalise(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function asPaymentStatus(value: unknown): ExtractionPaymentStatus | null {
  const key = canonicalise(value);
  return key ? (PAYMENT_STATUS_SYNONYMS[key] ?? null) : null;
}

function asBillingPeriod(value: unknown): ExtractionBillingPeriod | null {
  const key = canonicalise(value);
  return key ? (BILLING_PERIOD_SYNONYMS[key] ?? null) : null;
}

function asConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeLineItem(raw: unknown): ExtractedLineItem | null {
  const rec = asRecord(raw);
  const description = asString(rec?.description);
  if (!description) return null;
  return {
    description,
    quantity: asDecimalString(rec?.quantity),
    unitPrice: asDecimalString(rec?.unitPrice),
    amount: asDecimalString(rec?.amount),
  };
}

/** `raw` may itself be missing every field — that still yields a single
    entry with nulls, not a dropped invoice, so the caller sees "the model
    tried and gave us nothing useful" rather than "the model returned
    fewer invoices than it saw" (those two failures need different fixes). */
function normalizeInvoice(
  raw: unknown,
  ordinal: number,
  extractorKind: ExtractorKind
): ExtractedInvoice | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const lineItemsRaw = Array.isArray(rec.lineItems) ? rec.lineItems : [];
  const lineItems: ExtractedLineItem[] = [];
  for (const item of lineItemsRaw) {
    const lineItem = normalizeLineItem(item);
    if (lineItem) lineItems.push(lineItem);
  }

  return {
    ordinal,
    vendorNameRaw: asString(rec.vendorNameRaw) ?? '',
    invoiceNumber: asString(rec.invoiceNumber),
    issueDate: asIsoDate(rec.issueDate),
    dueDate: asIsoDate(rec.dueDate),
    totalAmount: asDecimalString(rec.totalAmount),
    currencyCode: asString(rec.currencyCode),
    paymentStatus: asPaymentStatus(rec.paymentStatus),
    billingPeriod: asBillingPeriod(rec.billingPeriod),
    lineItems,
    confidence: asConfidence(rec.confidence),
    promptVersion: PROMPT_VERSION,
    extractorKind,
  };
}

/** Accepts either `{ invoices: [...] }` (the documented contract) or a
    bare top-level array, in case a provider's JSON mode strips the
    wrapper key. Anything else — `null`, a string, `{}` with no
    `invoices` key — has no invoice list to walk and yields `[]`. */
function normalizeInvoices(raw: unknown, extractorKind: ExtractorKind): ExtractedInvoice[] {
  const record = asRecord(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(record?.invoices) ? record.invoices : [];

  const invoices: ExtractedInvoice[] = [];
  list.forEach((item: unknown, ordinal: number) => {
    const invoice = normalizeInvoice(item, ordinal, extractorKind);
    if (invoice) invoices.push(invoice);
  });
  return invoices;
}
