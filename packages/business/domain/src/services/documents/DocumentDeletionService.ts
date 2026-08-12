/**
 * Deleting an uploaded file, its extractions, and its stored object.
 *
 * Two rules make this more than a `DELETE`:
 *
 * 1. **Refuse when a payment depends on it.** `payment_occurrences
 *    .matched_extraction_id` is `ON DELETE SET NULL`, so the database would
 *    accept this delete happily and quietly strip a settled occurrence of
 *    the invoice that evidences it. The pre-check is the only thing
 *    standing between the user and that silent loss, so it names what
 *    depends on the document rather than just saying no.
 *
 * 2. **A missing object must not block the row.** Every document ingested
 *    before retention shipped points at a `temp/` key that was deleted
 *    seconds after the parse. Those rows are exactly the ones users need to
 *    delete — freeing the `(user_id, content_hash)` unique is what lets the
 *    same PDF be uploaded again and parsed fresh instead of hitting dedup.
 *    The row therefore goes first and the object is best-effort after it.
 */

import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import {
  DocumentExtractionRepository,
  type ExtractionOccurrenceLink,
} from '../../repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../repositories/DocumentRepository';

const logger = createComponentLogger('service:document-deletion');

export type DocumentDeletionOutcome =
  /** Doesn't exist, or belongs to another user — the caller must not distinguish them. */
  | { outcome: 'not-found' }
  | { outcome: 'blocked'; blockers: ExtractionOccurrenceLink[] }
  | { outcome: 'deleted'; document: Document; storageObjectRemoved: boolean };

@Service()
export class DocumentDeletionService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly extractions = Container.get(DocumentExtractionRepository);
  private readonly storage = Container.get(StorageFacade);

  async delete(documentId: string, userId: string): Promise<DocumentDeletionOutcome> {
    const document = await this.documents.findByIdAndUser(documentId, userId);
    if (!document) return { outcome: 'not-found' };

    const blockers = await this.extractions.findOccurrenceLinksByDocumentId(documentId, userId);
    if (blockers.length > 0) return { outcome: 'blocked', blockers };

    // `document_extractions.document_id` is ON DELETE CASCADE, so this one
    // row takes the extractions with it.
    await this.documents.delete(documentId);

    let storageObjectRemoved = false;
    try {
      await this.storage.delete(document.r2Key);
      storageObjectRemoved = true;
    } catch (error) {
      logger.warn(
        {
          documentId,
          r2Key: document.r2Key,
          error: error instanceof Error ? error.message : error,
        },
        'Document row deleted but its stored object could not be removed'
      );
    }

    return { outcome: 'deleted', document, storageObjectRemoved };
  }
}
