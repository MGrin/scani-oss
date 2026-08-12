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
 *
 * `reparseOf` is the deliberate escape hatch out of that dedup. Without it
 * a file, once ingested, could never be read again — not even after the
 * extractor learns to read a field it used to miss. It skips the hash
 * lookup rather than deleting the `documents` row, so the file keeps its
 * identity (and its `(user_id, content_hash)` unique) across re-parses.
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
  /**
   * A `documents.id` to re-extract into. Set, the content-hash dedup is
   * skipped and the new extractions attach to that document instead of
   * creating a second row for the same bytes.
   */
  reparseOf?: string;
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

    // Resolved BEFORE the extraction call: a bad `reparseOf` must cost
    // nothing, and the id is client-supplied all the way from tRPC.
    const target = input.reparseOf
      ? await this.loadReparseTarget(input.reparseOf, input.userId)
      : null;

    if (!target) {
      const existing = await this.documents.findByContentHash(input.userId, contentHash);
      if (existing) {
        return { document: existing, extractions: [], deduped: true, upstreamCostUsd: 0 };
      }
    }

    const { invoices, usage } = await this.extractionService.extract(input.bytes, input.mimeType);

    const document =
      target ??
      (await this.documents.create({
        userId: input.userId,
        purpose: 'invoice',
        r2Key: input.r2Key,
        contentHash,
        mimeType: input.mimeType,
        byteSize: input.bytes.length,
        originalFilename: input.originalFilename,
        sourceKind: input.sourceKind,
      }));

    // `(document_id, ordinal)` is unique, and a re-parse runs against a
    // document that may still hold extractions a payment was built from —
    // those survive the pre-parse cleanup and keep their ordinals. Fresh
    // invoices are therefore appended past the highest survivor rather
    // than restarting at 0, which would collide.
    const ordinalBase = target ? await this.nextOrdinal(target.id, input.userId) : 0;

    const createdExtractions: DocumentExtraction[] = [];
    for (const invoice of invoices) {
      const extraction = await this.extractions.create({
        documentId: document.id,
        ordinal: ordinalBase + invoice.ordinal,
        vendorNameRaw: invoice.vendorNameRaw,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        totalAmount: invoice.totalAmount,
        currencyCode: invoice.currencyCode,
        paymentStatus: invoice.paymentStatus,
        billingPeriod: invoice.billingPeriod,
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

  private async loadReparseTarget(documentId: string, userId: string): Promise<Document> {
    const document = await this.documents.findByIdAndUser(documentId, userId);
    if (!document) {
      // `findByIdAndUser` returns null for both "gone" and "someone
      // else's", and so does this — the job payload reaches here from a
      // client-supplied id, so the two must stay indistinguishable.
      throw new Error(`Document ${documentId} not found for re-parse`);
    }
    return document;
  }

  private async nextOrdinal(documentId: string, userId: string): Promise<number> {
    const surviving = await this.extractions.findByDocumentId(documentId, userId);
    return surviving.reduce((max, row) => Math.max(max, row.ordinal + 1), 0);
  }
}
