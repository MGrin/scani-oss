/**
 * The pre-flight half of "read this document again".
 *
 * Ingestion dedups on content hash so a forwarded invoice is never billed
 * to the AI twice — correct, but it also meant an already-ingested file
 * could never be re-read after the extractor improved. `documents.reparse`
 * is the escape hatch; this service is the part of it that owns domain
 * rules, leaving the router to enqueue.
 *
 * Clearing happens HERE rather than on the worker so the user sees the
 * stale extractions disappear the moment they confirm, instead of the
 * page showing both the old and new reads until the job lands.
 */

import type { Document } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { DocumentExtractionRepository } from '../../repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../repositories/DocumentRepository';

export interface DocumentReparsePlan {
  document: Document;
  /** Extractions cleared to make room for the fresh read. */
  clearedExtractionIds: string[];
  /** Extractions a payment occurrence points at, so they were kept. */
  keptExtractionIds: string[];
}

@Service()
export class DocumentReparseService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly extractions = Container.get(DocumentExtractionRepository);

  /**
   * Returns null when the document doesn't exist OR belongs to another
   * user — the caller surfaces one NOT_FOUND for both, so a `documentId`
   * arriving from tRPC can't be used to probe for another user's ids.
   */
  async prepare(documentId: string, userId: string): Promise<DocumentReparsePlan | null> {
    const document = await this.documents.findByIdAndUser(documentId, userId);
    if (!document) return null;

    const before = await this.extractions.findByDocumentId(documentId, userId);
    const cleared = await this.extractions.deleteUnlinkedByDocumentId(documentId, userId);
    const clearedIds = new Set(cleared.map((row) => row.id));

    return {
      document,
      clearedExtractionIds: cleared.map((row) => row.id),
      keptExtractionIds: before.filter((row) => !clearedIds.has(row.id)).map((row) => row.id),
    };
  }
}
