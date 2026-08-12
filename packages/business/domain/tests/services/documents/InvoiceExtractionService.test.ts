process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, test } from 'bun:test';
import type { AIInferenceProvider, AIResult } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { InvoiceExtractionService } from '../../../src/services/documents/InvoiceExtractionService';
import {
  INVOICE_EXTRACTION_PROMPT,
  PROMPT_VERSION,
} from '../../../src/services/documents/invoicePrompt';

// Fixtures reuse the hand-built minimal-PDF pattern from
// `pdfExtraction.test.ts` — small, portable, no binary blobs in git.
function buildPdf(objects: string[]): Uint8Array {
  const enc = new TextEncoder();
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(enc.encode(body).length);
    body += obj;
  }
  const xrefStart = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body);
}

function buildTextPdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 20 150 Td (${text}) Tj ET`;
  const contentLength = new TextEncoder().encode(content).length;
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${contentLength} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]);
}

// A page with a valid Contents stream that carries no drawable text —
// same shape `pdfExtraction.test.ts` uses for a scanned page.
function buildTextlessPdf(): Uint8Array {
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ]);
}

// Long enough to clear `MIN_TEXT_CHARS_FOR_LLM`. Routing is now decided
// by how much text the PDF actually yields, not by a per-page OCR verdict,
// so a fixture with one short line would legitimately route to vision.
// Mirrors the shape of a real invoice: header, parties, line items, total.
const TEXT_PDF = buildTextPdf(
  [
    'INVOICE  Acme Corp  123 Example Street, Springfield',
    'Invoice number INV-1001   Invoice date Aug 1, 2026   Due date Aug 15, 2026',
    'Bill to: Jane Customer, 9 Sample Road, London, United Kingdom',
    'Description               Quantity   Rate     Amount',
    'Managed hosting, monthly       1     14.99     14.99',
    'Additional storage, GB        50      0.10      5.00',
    'Subtotal 19.99   Tax 0.00   Total due 19.99 USD',
    'Payment received - thank you. Billed annually.',
  ].join('\n')
);
const SCANNED_PDF = buildTextlessPdf();

interface Calls {
  parseDocumentText: Array<{ text: string; hint?: string }>;
  parseScreenshot: Array<{
    imageBase64: string;
    mimeType: string;
    hint?: string;
    systemPrompt?: string;
  }>;
}

function makeFullProvider(
  data: unknown,
  usage?: { tokensIn: number; tokensOut: number; totalTokens: number; upstreamCostUsd?: number }
): { provider: AIInferenceProvider; calls: Calls } {
  const calls: Calls = { parseDocumentText: [], parseScreenshot: [] };
  const provider: AIInferenceProvider = {
    providerKey: 'ai-stub',
    capabilities: ['ai-inference'],
    parseScreenshot: async (input): Promise<AIResult<unknown>> => {
      calls.parseScreenshot.push(input);
      return { data, usage };
    },
    parseDocumentText: async (text: string, hint?: string): Promise<AIResult<unknown>> => {
      calls.parseDocumentText.push({ text, hint });
      return { data, usage };
    },
  };
  return { provider, calls };
}

// Deliberately omits `parseDocumentText` — the capability IS optional on
// `AIInferenceProvider`, and a provider object built without it must not
// crash `instanceof`/property-presence checks.
function makeVisionOnlyProvider(
  data: unknown,
  usage?: { tokensIn: number; tokensOut: number; totalTokens: number; upstreamCostUsd?: number }
): { provider: AIInferenceProvider; calls: Calls } {
  const calls: Calls = { parseDocumentText: [], parseScreenshot: [] };
  const provider: AIInferenceProvider = {
    providerKey: 'ai-vision-only',
    capabilities: ['ai-inference'],
    parseScreenshot: async (input): Promise<AIResult<unknown>> => {
      calls.parseScreenshot.push(input);
      return { data, usage };
    },
  };
  return { provider, calls };
}

function stubRegistry(provider: AIInferenceProvider): void {
  Container.set(ProviderRegistry, {
    getAIProviders: () => [provider],
  } as unknown as ProviderRegistry);
}

function service(): InvoiceExtractionService {
  const instance = new InvoiceExtractionService();
  Container.set(InvoiceExtractionService, instance);
  return instance;
}

afterEach(() => {
  Container.set(ProviderRegistry, new ProviderRegistry());
});

const ONE_INVOICE = {
  invoices: [
    {
      vendorNameRaw: 'Acme Corp',
      invoiceNumber: 'INV-1001',
      issueDate: '2026-08-01',
      dueDate: '2026-08-15',
      totalAmount: '19.99',
      currencyCode: 'USD',
      confidence: 0.92,
      lineItems: [{ description: 'Widget', quantity: '1', unitPrice: '19.99', amount: '19.99' }],
    },
  ],
};

const TWO_INVOICES = {
  invoices: [
    { vendorNameRaw: 'Acme Corp', totalAmount: '19.99', lineItems: [] },
    { vendorNameRaw: 'Widgets Inc', totalAmount: '5.00', lineItems: [] },
  ],
};

describe('InvoiceExtractionService — text path', () => {
  test('a text-classified PDF calls parseDocumentText and never parseScreenshot', async () => {
    const { provider, calls } = makeFullProvider(ONE_INVOICE);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(calls.parseDocumentText).toHaveLength(1);
    expect(calls.parseScreenshot).toHaveLength(0);
    expect(calls.parseDocumentText[0]?.text).toContain('Acme Corp');
    expect(result.invoices).toHaveLength(1);
  });
});

describe('InvoiceExtractionService — vision fallback', () => {
  test('falls back to parseScreenshot for a text PDF when parseDocumentText is absent', async () => {
    const { provider, calls } = makeVisionOnlyProvider(ONE_INVOICE);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(calls.parseScreenshot).toHaveLength(1);
    expect(calls.parseScreenshot[0]?.mimeType).toBe('application/pdf');
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.extractorKind).toBe('vision-llm');
  });
});

describe('InvoiceExtractionService — scanned path', () => {
  test('a scanned classification goes to parseScreenshot', async () => {
    const { provider, calls } = makeFullProvider(ONE_INVOICE);
    stubRegistry(provider);

    const result = await service().extract(SCANNED_PDF, 'application/pdf');

    expect(calls.parseScreenshot).toHaveLength(1);
    expect(calls.parseDocumentText).toHaveLength(0);
    expect(result.invoices[0]?.extractorKind).toBe('vision-llm');
  });

  // The invoice prompt has to REPLACE the provider's default holdings
  // schema on the vision path too. As a `hint` it sat underneath it and
  // every scanned invoice came back as `{holdings: []}` — the transport
  // fix alone would still have stored zero invoices.
  test('passes the invoice prompt as systemPrompt, not as a hint', async () => {
    const { provider, calls } = makeFullProvider(ONE_INVOICE);
    stubRegistry(provider);

    await service().extract(SCANNED_PDF, 'application/pdf');

    expect(calls.parseScreenshot[0]?.systemPrompt).toBe(INVOICE_EXTRACTION_PROMPT);
    expect(calls.parseScreenshot[0]?.hint).toBeUndefined();
  });

  test('a provider that cannot read the mime type surfaces its error', async () => {
    const provider: AIInferenceProvider = {
      providerKey: 'ai-no-pdf',
      capabilities: ['ai-inference'],
      parseScreenshot: async () => {
        throw new Error('ai-no-pdf: PDF input not supported by this provider (only image types)');
      },
    };
    stubRegistry(provider);

    expect(service().extract(SCANNED_PDF, 'application/pdf')).rejects.toThrow(
      'PDF input not supported'
    );
  });
});

describe('InvoiceExtractionService — multi-invoice', () => {
  test('a provider returning two invoices produces two results with ordinals 0 and 1', async () => {
    const { provider } = makeFullProvider(TWO_INVOICES);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toHaveLength(2);
    expect(result.invoices[0]?.ordinal).toBe(0);
    expect(result.invoices[0]?.vendorNameRaw).toBe('Acme Corp');
    expect(result.invoices[1]?.ordinal).toBe(1);
    expect(result.invoices[1]?.vendorNameRaw).toBe('Widgets Inc');
  });
});

describe('InvoiceExtractionService — traceability', () => {
  test('every result carries PROMPT_VERSION and its extractorKind', async () => {
    const { provider } = makeFullProvider(TWO_INVOICES);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    for (const invoice of result.invoices) {
      expect(invoice.promptVersion).toBe(PROMPT_VERSION);
      expect(invoice.extractorKind).toBe('text-llm');
    }
  });

  test('the vision path stamps extractorKind vision-llm', async () => {
    const { provider } = makeFullProvider(ONE_INVOICE);
    stubRegistry(provider);

    const result = await service().extract(SCANNED_PDF, 'application/pdf');

    expect(result.invoices[0]?.extractorKind).toBe('vision-llm');
  });
});

describe('InvoiceExtractionService — cost tracking', () => {
  test('surfaces usage.upstreamCostUsd from the provider call on the return', async () => {
    const { provider } = makeFullProvider(ONE_INVOICE, {
      tokensIn: 500,
      tokensOut: 200,
      totalTokens: 700,
      upstreamCostUsd: 0.0123,
    });
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.usage.upstreamCostUsd).toBeCloseTo(0.0123, 6);
  });

  test('defaults cost to 0 when the provider reports no usage', async () => {
    const { provider } = makeFullProvider(ONE_INVOICE);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.usage.upstreamCostUsd).toBe(0);
  });
});

describe('InvoiceExtractionService — malformed responses', () => {
  test('a null data payload yields an empty array, not a throw', async () => {
    const { provider } = makeFullProvider(null);
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toEqual([]);
  });

  test('a string data payload yields an empty array, not a throw', async () => {
    const { provider } = makeFullProvider('not json, just a string');
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toEqual([]);
  });

  test('an object missing every field yields an empty array, not a throw', async () => {
    const { provider } = makeFullProvider({});
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toEqual([]);
  });

  test('an invoice entry missing every field still yields a result with nulls', async () => {
    const { provider } = makeFullProvider({ invoices: [{}] });
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.ordinal).toBe(0);
    expect(result.invoices[0]?.totalAmount).toBeNull();
    expect(result.invoices[0]?.invoiceNumber).toBeNull();
  });

  test('no AI provider available yields an empty array, not a throw', async () => {
    Container.set(ProviderRegistry, { getAIProviders: () => [] } as unknown as ProviderRegistry);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices).toEqual([]);
    expect(result.usage.upstreamCostUsd).toBe(0);
  });

  test('a non-decimal totalAmount string never leaks into the result', async () => {
    const { provider } = makeFullProvider({
      invoices: [{ vendorNameRaw: 'Acme', totalAmount: 'nineteen dollars', lineItems: [] }],
    });
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(result.invoices[0]?.totalAmount).toBeNull();
  });
});

describe('InvoiceExtractionService — prompt authority', () => {
  // The invoice prompt has to REPLACE the provider's default system
  // prompt, not ride under it as a hint. Passed as a hint it lost to a
  // system prompt hardcoding the holdings schema, so production billed
  // for a valid `{holdings: []}` response and stored zero invoices with
  // no error anywhere. Asserting the argument position is the only way
  // to keep that from silently regressing.
  test('the invoice prompt is sent as the system prompt, not as a hint', async () => {
    const seen: Array<{ text: string; hint?: string; systemPrompt?: string }> = [];
    const provider = {
      parseScreenshot: async () => ({ data: {} }),
      parseDocumentText: async (text: string, hint?: string, systemPrompt?: string) => {
        seen.push({ text, hint, systemPrompt });
        return { data: { invoices: [] } };
      },
    };
    Container.set(ProviderRegistry, {
      getAIProviders: () => [provider],
    } as unknown as ProviderRegistry);

    await new InvoiceExtractionService().extract(TEXT_PDF, 'application/pdf');

    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).toBe(INVOICE_EXTRACTION_PROMPT);
    expect(seen[0].hint).toBeUndefined();
  });
});
