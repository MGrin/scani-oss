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
import { DocumentRetentionService } from './DocumentRetentionService';

export interface DocumentReparsePlan {
  document: Document;
  /** Extractions cleared to make room for the fresh read. */
  clearedExtractionIds: string[];
  /** Extractions a payment occurrence points at, so they were kept. */
  keptExtractionIds: string[];
}

export type DocumentReparseOutcome =
  /** Doesn't exist, or belongs to another user — indistinguishable by design. */
  | { outcome: 'not-found' }
  /** Ingested before retention shipped: the uploaded bytes are gone for good. */
  | { outcome: 'file-missing'; document: Document }
  | { outcome: 'ready'; plan: DocumentReparsePlan };

@Service()
export class DocumentReparseService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly extractions = Container.get(DocumentExtractionRepository);
  private readonly retention = Container.get(DocumentRetentionService);

  /**
   * `file-missing` is checked BEFORE anything is cleared. A document whose
   * `r2Key` still points into `temp/` has no object behind it — the parse
   * job deleted it and R2's lifecycle rule swept the prefix — so the
   * worker's `storage.read` would fail. Clearing first and discovering
   * that afterwards would cost the user their extractions for a re-parse
   * that was never going to run.
   */
  async prepare(documentId: string, userId: string): Promise<DocumentReparseOutcome> {
    const document = await this.documents.findByIdAndUser(documentId, userId);
    if (!document) return { outcome: 'not-found' };
    if (!this.retention.isRetained(document.r2Key)) return { outcome: 'file-missing', document };

    const before = await this.extractions.findByDocumentId(documentId, userId);
    const cleared = await this.extractions.deleteUnlinkedByDocumentId(documentId, userId);
    const clearedIds = new Set(cleared.map((row) => row.id));

    return {
      outcome: 'ready',
      plan: {
        document,
        clearedExtractionIds: cleared.map((row) => row.id),
        keptExtractionIds: before.filter((row) => !clearedIds.has(row.id)).map((row) => row.id),
      },
    };
  }
}
