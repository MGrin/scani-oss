process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, test } from 'bun:test';
import type { CloudAICapabilities, CloudProviderClient } from '@scani/providers/core/cloud';
import { CloudAIProvider } from '@scani/providers/core/cloud';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { InvoiceExtractionService } from '../../../src/services/documents/InvoiceExtractionService';
import { INVOICE_EXTRACTION_PROMPT } from '../../../src/services/documents/invoicePrompt';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

// Tier 2/3 runs the exact same service against `CloudAIProvider` instead of
// `OpenAIProvider`. These tests drive the real proxy — only the wire is a
// stub — because the failure they guard against is silent: the cloud route
// used to normalize every response into the holdings schema, so an invoice
// came back as `{holdings: []}` and the job reported success with zero rows.

function buildTextPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const content = `BT /F1 18 Tf 20 150 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(enc.encode(body).length);
    body += obj;
  }
  const xrefStart = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body);
}

const TEXT_PDF = buildTextPdf(
  [
    'INVOICE  Neon, LLC  209 Orange Street, Wilmington DE',
    'Invoice number MYVQRL-00003   Invoice date Aug 1, 2026',
    'Description               Quantity   Rate     Amount',
    'Neon Launch plan, monthly      1     12.96     12.96',
    'Total due 12.96 USD   Balance due',
  ].join('\n')
);

const INVOICE_RESPONSE = {
  invoices: [
    {
      vendorNameRaw: 'Neon, LLC',
      invoiceNumber: 'MYVQRL-00003',
      totalAmount: '12.96',
      currencyCode: 'USD',
      paymentStatus: 'unpaid',
      lineItems: [],
    },
  ],
};

interface WireCall {
  op: string;
  args: Record<string, unknown>;
}

function cloudProvider(opts: { caps?: CloudAICapabilities; payload?: unknown }): {
  provider: CloudAIProvider;
  wire: WireCall[];
} {
  const wire: WireCall[] = [];
  const client = {
    async fetchAICapabilities(args: Record<string, unknown>) {
      wire.push({ op: 'fetchAICapabilities', args });
      return opts.caps ?? { systemPrompt: true, pdfFileInput: true };
    },
    async parseDocumentText(args: Record<string, unknown>) {
      wire.push({ op: 'parseDocumentText', args });
      return opts.payload;
    },
    async parseScreenshot(args: Record<string, unknown>) {
      wire.push({ op: 'parseScreenshot', args });
      return opts.payload;
    },
  } as unknown as CloudProviderClient;
  return { provider: new CloudAIProvider('ai-openai', client), wire };
}

function stubRegistry(provider: CloudAIProvider): void {
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

describe('InvoiceExtractionService — cloud provider (tier 2/3)', () => {
  test('a text-layer PDF takes the cheap text route and yields the invoice', async () => {
    const { provider, wire } = cloudProvider({ payload: { raw: INVOICE_RESPONSE } });
    stubRegistry(provider);

    const result = await service().extract(TEXT_PDF, 'application/pdf');

    expect(wire.map((c) => c.op)).toEqual(['fetchAICapabilities', 'parseDocumentText']);
    expect(wire[1]?.args.systemPrompt).toBe(INVOICE_EXTRACTION_PROMPT);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.vendorNameRaw).toBe('Neon, LLC');
    expect(result.invoices[0]?.totalAmount).toBe('12.96');
    expect(result.invoices[0]?.extractorKind).toBe('text-llm');
  });

  test('an image invoice goes through the vision route with the invoice schema', async () => {
    const { provider, wire } = cloudProvider({ payload: { raw: INVOICE_RESPONSE } });
    stubRegistry(provider);

    const result = await service().extract(new Uint8Array([1, 2, 3]), 'image/png');

    expect(wire.map((c) => c.op)).toEqual(['fetchAICapabilities', 'parseScreenshot']);
    expect(wire[1]?.args.systemPrompt).toBe(INVOICE_EXTRACTION_PROMPT);
    expect(result.invoices[0]?.extractorKind).toBe('vision-llm');
  });

  test('a scanned PDF against a remote without PDF support throws before the call', async () => {
    const { provider, wire } = cloudProvider({
      caps: { systemPrompt: true, pdfFileInput: false },
      payload: { raw: INVOICE_RESPONSE },
    });
    stubRegistry(provider);

    // A PDF with no text layer skips the text route, so the vision route is
    // the only one left — and the remote cannot read a PDF. Refusing is the
    // whole point: the alternative is an upstream 400 the tenant pays for.
    await expect(service().extract(new Uint8Array([1, 2, 3]), 'application/pdf')).rejects.toThrow(
      /PDF input not supported/
    );
    expect(wire.map((c) => c.op)).toEqual(['fetchAICapabilities']);
  });

  test('a data-provider too old to honour systemPrompt is refused, not silently normalized', async () => {
    const { provider } = cloudProvider({
      caps: { systemPrompt: false, pdfFileInput: false },
      payload: { portfolio: { holdings: [] } },
    });
    stubRegistry(provider);

    await expect(service().extract(TEXT_PDF, 'application/pdf')).rejects.toThrow(
      /systemPrompt not supported/
    );
  });
});
