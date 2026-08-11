/**
 * Orchestrates "a file arrived" (upload or forward) into a `documents` row
 * plus zero or more `document_extractions` rows — the seam between the
 * async job system and the AI extraction call.
 *
 * Content-hash dedup gates the AI call, not just the DB write: the same
 * invoice PDF forwarded twice (an upload, then the same file arriving by
 * email) must not be billed twice. `DocumentRepository.findByContentHash`
 * runs BEFORE `InvoiceExtractionService.extract` for exactly that reason —
 * see `DocumentIngestionService.test.ts` for the assertion that `extract`
 * is never called on a duplicate.
 */

import { createHash } from 'node:crypto';
import type { Document, DocumentExtraction, DocumentSourceKind } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { DocumentExtractionRepository } from '../../repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../repositories/DocumentRepository';
import { InvoiceExtractionService } from './InvoiceExtractionService';

export interface IngestDocumentInput {
  userId: string;
  bytes: Uint8Array;
  mimeType: string;
  r2Key: string;
  originalFilename: string;
  sourceKind: DocumentSourceKind;
}

export interface DocumentIngestionResult {
  document: Document;
  extractions: DocumentExtraction[];
  /** True when this call short-circuited on a content-hash match. */
  deduped: boolean;
  upstreamCostUsd: number;
}

@Service()
export class DocumentIngestionService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly extractions = Container.get(DocumentExtractionRepository);
  private readonly extractionService = Container.get(InvoiceExtractionService);

  async ingest(input: IngestDocumentInput): Promise<DocumentIngestionResult> {
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');

    const existing = await this.documents.findByContentHash(input.userId, contentHash);
    if (existing) {
      return { document: existing, extractions: [], deduped: true, upstreamCostUsd: 0 };
    }

    const { invoices, usage } = await this.extractionService.extract(input.bytes, input.mimeType);

    const document = await this.documents.create({
      userId: input.userId,
      r2Key: input.r2Key,
      contentHash,
      mimeType: input.mimeType,
      byteSize: input.bytes.length,
      originalFilename: input.originalFilename,
      sourceKind: input.sourceKind,
    });

    const createdExtractions: DocumentExtraction[] = [];
    for (const invoice of invoices) {
      const extraction = await this.extractions.create({
        documentId: document.id,
        ordinal: invoice.ordinal,
        vendorNameRaw: invoice.vendorNameRaw,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        totalAmount: invoice.totalAmount,
        currencyCode: invoice.currencyCode,
        lineItems: invoice.lineItems,
        confidence: invoice.confidence === null ? null : String(invoice.confidence),
        promptVersion: invoice.promptVersion,
        extractorKind: invoice.extractorKind,
      });
      createdExtractions.push(extraction);
    }

    return {
      document,
      extractions: createdExtractions,
      deduped: false,
      upstreamCostUsd: usage.upstreamCostUsd,
    };
  }
}
