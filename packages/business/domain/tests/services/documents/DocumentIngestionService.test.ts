process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import { DocumentExtractionRepository } from '../../../src/repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentIngestionService } from '../../../src/services/documents/DocumentIngestionService';
import { InvoiceExtractionService } from '../../../src/services/documents/InvoiceExtractionService';

const DOC_ID = 'doc-1';

function makeService(opts: {
  existingDocument?: unknown;
  extractResult?: { invoices: unknown[]; usage: { upstreamCostUsd: number } };
  createdDocument?: unknown;
  createdExtractions?: unknown[];
}) {
  const findByContentHash = mock(async () => opts.existingDocument);
  const documentsCreate = mock(async () => opts.createdDocument ?? { id: DOC_ID });
  Container.set(DocumentRepository, {
    findByContentHash,
    create: documentsCreate,
  } as unknown as DocumentRepository);

  const extractionsCreate = mock(async (data: Record<string, unknown>) => ({
    id: `ext-${data.ordinal}`,
    ...data,
  }));
  Container.set(DocumentExtractionRepository, {
    create: extractionsCreate,
  } as unknown as DocumentExtractionRepository);

  const extract = mock(
    async () => opts.extractResult ?? { invoices: [], usage: { upstreamCostUsd: 0 } }
  );
  Container.set(InvoiceExtractionService, { extract } as unknown as InvoiceExtractionService);

  const instance = new DocumentIngestionService();
  Container.set(DocumentIngestionService, instance);
  return { instance, findByContentHash, documentsCreate, extractionsCreate, extract };
}

const bytes = new TextEncoder().encode('%PDF-1.4 fake invoice bytes');

describe('DocumentIngestionService.ingest', () => {
  test('a duplicate content hash returns the existing document and never calls the extraction service', async () => {
    const existingDocument = { id: DOC_ID, userId: 'user-1', contentHash: 'irrelevant' };
    const { instance, extract, documentsCreate, extractionsCreate } = makeService({
      existingDocument,
    });

    const result = await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/a.pdf',
      originalFilename: 'invoice.pdf',
      sourceKind: 'upload',
    });

    expect(result.deduped).toBe(true);
    expect(result.document).toBe(existingDocument);
    expect(result.extractions).toEqual([]);
    expect(result.upstreamCostUsd).toBe(0);

    // The whole point: no AI spend, no new rows, on the second submission.
    expect(extract).not.toHaveBeenCalled();
    expect(documentsCreate).not.toHaveBeenCalled();
    expect(extractionsCreate).not.toHaveBeenCalled();
  });

  test('a re-submission of the same bytes hashes to the same value and still skips extraction', async () => {
    const existingDocument = { id: DOC_ID, userId: 'user-1', contentHash: 'irrelevant' };
    const { instance, extract, findByContentHash } = makeService({ existingDocument });

    await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/upload.pdf',
      originalFilename: 'invoice.pdf',
      sourceKind: 'upload',
    });
    await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/forward.pdf',
      originalFilename: 'invoice-forwarded.pdf',
      sourceKind: 'email',
    });

    expect(findByContentHash).toHaveBeenCalledTimes(2);
    const [, firstHash] = findByContentHash.mock.calls[0] ?? [];
    const [, secondHash] = findByContentHash.mock.calls[1] ?? [];
    expect(firstHash).toBe(secondHash);
    expect(extract).not.toHaveBeenCalled();
  });

  test('a new content hash calls the extraction service exactly once and persists one row per invoice', async () => {
    const invoices = [
      {
        ordinal: 0,
        vendorNameRaw: 'Acme Utilities',
        invoiceNumber: 'INV-1',
        issueDate: '2026-08-01',
        dueDate: '2026-08-15',
        totalAmount: '42.50',
        currencyCode: 'USD',
        lineItems: [],
        confidence: 0.9,
        promptVersion: 'v1',
        extractorKind: 'text-llm',
      },
      {
        ordinal: 1,
        vendorNameRaw: 'Acme Utilities',
        invoiceNumber: 'INV-2',
        issueDate: '2026-08-02',
        dueDate: null,
        totalAmount: '10.00',
        currencyCode: 'USD',
        lineItems: [],
        confidence: null,
        promptVersion: 'v1',
        extractorKind: 'text-llm',
      },
    ];
    const { instance, extract, documentsCreate, extractionsCreate } = makeService({
      existingDocument: undefined,
      extractResult: { invoices, usage: { upstreamCostUsd: 0.002 } },
      createdDocument: { id: DOC_ID, userId: 'user-1' },
    });

    const result = await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/a.pdf',
      originalFilename: 'invoice.pdf',
      sourceKind: 'upload',
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(documentsCreate).toHaveBeenCalledTimes(1);
    expect(extractionsCreate).toHaveBeenCalledTimes(2);
    expect(result.deduped).toBe(false);
    expect(result.extractions).toHaveLength(2);
    expect(result.upstreamCostUsd).toBe(0.002);
  });

  test('a new document with zero extracted invoices still persists the document but no extraction rows', async () => {
    const { instance, extract, documentsCreate, extractionsCreate } = makeService({
      existingDocument: undefined,
      extractResult: { invoices: [], usage: { upstreamCostUsd: 0 } },
      createdDocument: { id: DOC_ID, userId: 'user-1' },
    });

    const result = await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/a.pdf',
      originalFilename: 'invoice.pdf',
      sourceKind: 'upload',
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(documentsCreate).toHaveBeenCalledTimes(1);
    expect(extractionsCreate).not.toHaveBeenCalled();
    expect(result.extractions).toEqual([]);
  });

  test('the payment hints reach the extraction row, nulls included', async () => {
    const { instance, extractionsCreate } = makeService({
      existingDocument: undefined,
      extractResult: {
        invoices: [
          {
            ordinal: 0,
            vendorNameRaw: '1Password',
            invoiceNumber: null,
            issueDate: '2026-07-26',
            dueDate: null,
            totalAmount: '95.88',
            currencyCode: 'USD',
            paymentStatus: 'paid',
            billingPeriod: 'year',
            lineItems: [],
            confidence: 0.9,
            promptVersion: 'invoice-extraction-v2',
            extractorKind: 'text-llm',
          },
          {
            ordinal: 1,
            vendorNameRaw: 'Unreadable Ltd',
            invoiceNumber: null,
            issueDate: null,
            dueDate: null,
            totalAmount: null,
            currencyCode: null,
            paymentStatus: null,
            billingPeriod: null,
            lineItems: [],
            confidence: null,
            promptVersion: 'invoice-extraction-v2',
            extractorKind: 'text-llm',
          },
        ],
        usage: { upstreamCostUsd: 0 },
      },
      createdDocument: { id: DOC_ID, userId: 'user-1' },
    });

    await instance.ingest({
      userId: 'user-1',
      bytes,
      mimeType: 'application/pdf',
      r2Key: 'documents/user-1/a.pdf',
      originalFilename: 'invoice.pdf',
      sourceKind: 'upload',
    });

    expect(extractionsCreate.mock.calls[0]?.[0]).toMatchObject({
      paymentStatus: 'paid',
      billingPeriod: 'year',
    });
    // An unknown hint must persist as NULL, not be dropped from the insert
    // — a missing key and an explicit null read the same downstream only
    // if the column defaults to null, which is a coincidence, not a contract.
    expect(extractionsCreate.mock.calls[1]?.[0]).toMatchObject({
      paymentStatus: null,
      billingPeriod: null,
    });
  });
});
