process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, test } from 'bun:test';
import type { AIInferenceProvider, AIResult } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { InvoiceExtractionService } from '../../../src/services/documents/InvoiceExtractionService';
import { INVOICE_EXTRACTION_PROMPT } from '../../../src/services/documents/invoicePrompt';

// Every case here drives the vision path with a non-PDF mime type, which
// reaches the same `normalizeInvoice` as the text path without needing
// the PDF fixture builder — the hint normalisation under test is shared.
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

function stubProvider(data: unknown): void {
  const provider: AIInferenceProvider = {
    providerKey: 'ai-stub',
    capabilities: ['ai-inference'],
    parseScreenshot: async (): Promise<AIResult<unknown>> => ({ data }),
  };
  Container.set(ProviderRegistry, {
    getAIProviders: () => [provider],
  } as unknown as ProviderRegistry);
}

function service(): InvoiceExtractionService {
  const instance = new InvoiceExtractionService();
  Container.set(InvoiceExtractionService, instance);
  return instance;
}

async function extractOne(invoice: Record<string, unknown>) {
  stubProvider({ invoices: [{ vendorNameRaw: 'Acme Corp', lineItems: [], ...invoice }] });
  const result = await service().extract(IMAGE_BYTES, 'image/png');
  const [first] = result.invoices;
  if (!first) throw new Error('expected one extracted invoice');
  return first;
}

afterEach(() => {
  Container.set(ProviderRegistry, new ProviderRegistry());
});

describe('InvoiceExtractionService — paymentStatus normalisation', () => {
  test('accepts the canonical values verbatim', async () => {
    expect((await extractOne({ paymentStatus: 'paid' })).paymentStatus).toBe('paid');
    expect((await extractOne({ paymentStatus: 'unpaid' })).paymentStatus).toBe('unpaid');
  });

  test.each([
    ['PAID', 'paid'],
    ['  Paid In Full ', 'paid'],
    ['Payment   Received', 'paid'],
    ['Settled', 'paid'],
    ['Outstanding', 'unpaid'],
    ['Balance Due', 'unpaid'],
  ])('normalises %p to %p', async (raw, expected) => {
    expect((await extractOne({ paymentStatus: raw })).paymentStatus).toBe(
      expected as 'paid' | 'unpaid'
    );
  });

  test.each([
    ['partially paid'],
    ['maybe'],
    [''],
    ['   '],
    ['paid?'],
  ])('yields null for the unrecognised value %p rather than guessing', async (raw) => {
    expect((await extractOne({ paymentStatus: raw })).paymentStatus).toBeNull();
  });

  test('yields null when the field is absent, a number, or explicitly null', async () => {
    expect((await extractOne({})).paymentStatus).toBeNull();
    expect((await extractOne({ paymentStatus: null })).paymentStatus).toBeNull();
    expect((await extractOne({ paymentStatus: 1 })).paymentStatus).toBeNull();
    expect((await extractOne({ paymentStatus: { value: 'paid' } })).paymentStatus).toBeNull();
  });
});

describe('InvoiceExtractionService — billingPeriod normalisation', () => {
  test.each([
    ['week', 'week'],
    ['Weekly', 'week'],
    ['per week', 'week'],
    ['month', 'month'],
    ['Monthly', 'month'],
    ['PER  MONTH', 'month'],
    ['quarter', 'quarter'],
    ['Quarterly', 'quarter'],
    ['year', 'year'],
    ['Yearly', 'year'],
    ['Annual', 'year'],
    ['annually', 'year'],
    [' Per Year ', 'year'],
  ])('normalises %p to %p', async (raw, expected) => {
    expect((await extractOne({ billingPeriod: raw })).billingPeriod).toBe(
      expected as 'week' | 'month' | 'quarter' | 'year'
    );
  });

  test.each([
    ['biweekly'],
    ['every 2 months'],
    ['one-off'],
    ['12 months'],
    [''],
  ])('yields null for the unsupported cadence %p', async (raw) => {
    expect((await extractOne({ billingPeriod: raw })).billingPeriod).toBeNull();
  });

  test('yields null when the field is absent, a number, or explicitly null', async () => {
    expect((await extractOne({})).billingPeriod).toBeNull();
    expect((await extractOne({ billingPeriod: null })).billingPeriod).toBeNull();
    expect((await extractOne({ billingPeriod: 12 })).billingPeriod).toBeNull();
  });
});

describe('InvoiceExtractionService — payment hints alongside the rest of the invoice', () => {
  test('a fully-populated paid annual invoice keeps both hints and its other fields', async () => {
    const invoice = await extractOne({
      vendorNameRaw: '1Password',
      invoiceNumber: 'INV-2026-07',
      issueDate: '2026-07-26',
      totalAmount: '95.88',
      currencyCode: 'USD',
      paymentStatus: 'Paid',
      billingPeriod: 'annual',
    });

    expect(invoice.paymentStatus).toBe('paid');
    expect(invoice.billingPeriod).toBe('year');
    expect(invoice.vendorNameRaw).toBe('1Password');
    expect(invoice.totalAmount).toBe('95.88');
    expect(invoice.currencyCode).toBe('USD');
  });

  test('a garbage hint does not discard the invoice or its other fields', async () => {
    const invoice = await extractOne({
      totalAmount: '19.99',
      paymentStatus: 'ummm',
      billingPeriod: 'sometimes',
    });

    expect(invoice.paymentStatus).toBeNull();
    expect(invoice.billingPeriod).toBeNull();
    expect(invoice.totalAmount).toBe('19.99');
  });

  test('each invoice in a multi-invoice document gets its own hints', async () => {
    stubProvider({
      invoices: [
        { vendorNameRaw: 'Acme', lineItems: [], paymentStatus: 'paid', billingPeriod: 'yearly' },
        { vendorNameRaw: 'Widgets', lineItems: [], paymentStatus: 'due' },
      ],
    });

    const { invoices } = await service().extract(IMAGE_BYTES, 'image/png');

    expect(invoices).toHaveLength(2);
    expect(invoices[0]?.paymentStatus).toBe('paid');
    expect(invoices[0]?.billingPeriod).toBe('year');
    expect(invoices[1]?.paymentStatus).toBe('unpaid');
    expect(invoices[1]?.billingPeriod).toBeNull();
  });
});

describe('invoicePrompt — payment hint contract', () => {
  test('the prompt declares both fields and their allowed values', () => {
    expect(INVOICE_EXTRACTION_PROMPT).toContain('"paymentStatus"');
    expect(INVOICE_EXTRACTION_PROMPT).toContain('"billingPeriod"');
    expect(INVOICE_EXTRACTION_PROMPT).toContain('"week" | "month" | "quarter" | "year" | null');
  });

  test('the prompt tells the model to use null rather than infer a paid status', () => {
    expect(INVOICE_EXTRACTION_PROMPT).toContain('do NOT infer "paid"');
  });
});
