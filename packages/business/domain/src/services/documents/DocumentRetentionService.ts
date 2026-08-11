/**
 * Promotes a parsed upload out of the temp prefix so the file survives the
 * job that read it.
 *
 * Uploads land on `temp/document/{userId}/{uuid}.{ext}`, and the parse job
 * deletes that key the moment it finishes — plus R2's lifecycle rule sweeps
 * `temp/*` after 24h regardless. `documents.r2Key` therefore pointed at an
 * object that no longer existed for every document ever ingested: the user
 * could never see their own invoice again, and `documents.reparse` could
 * never read the bytes it needs. Retention is the fix — copy the object to
 * `documents/{userId}/{documentId}.{ext}` and repoint the row.
 *
 * `isRetained` is the other half, and it is what the parse path's cleanup
 * guards on: an object under the retained prefix must never be deleted by
 * a job that merely read it. Expressing that as a prefix test rather than
 * as "don't delete when the job says re-parse" makes it structural — a new
 * caller can't get the flag wrong and destroy a retained file.
 */

import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { DocumentRepository } from '../../repositories/DocumentRepository';

const logger = createComponentLogger('service:document-retention');

/** Permanent home for an ingested file. Never swept, never job-deleted. */
const RETAINED_KEY_PREFIX = 'documents/';

// Same shape the upload presigner allows, so a retained key can always be
// rebuilt from the temp key it was promoted from.
const EXTENSION_PATTERN = /\.([A-Za-z0-9]{1,10})$/;

@Service()
export class DocumentRetentionService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly storage = Container.get(StorageFacade);

  /** True once the file lives at its permanent key rather than in `temp/`. */
  isRetained(r2Key: string): boolean {
    return r2Key.startsWith(RETAINED_KEY_PREFIX);
  }

  retainedKeyFor(document: Pick<Document, 'id' | 'userId' | 'r2Key' | 'originalFilename'>): string {
    const ext = extensionOf(document.r2Key) ?? extensionOf(document.originalFilename);
    return `${RETAINED_KEY_PREFIX}${document.userId}/${document.id}${ext ? `.${ext}` : ''}`;
  }

  /**
   * Copy the document's object to its permanent key and persist that key on
   * the row. The temp object is deliberately NOT deleted here — the parse
   * path already owns exactly one cleanup of the key it was handed, and a
   * move that deleted the source would make a failure between copy and
   * persist unrecoverable.
   *
   * Idempotent: a document already retained (any re-parse) is returned
   * untouched, so the permanent object is never rewritten from itself.
   */
  async retain(document: Document): Promise<Document> {
    if (this.isRetained(document.r2Key)) return document;

    const retainedKey = this.retainedKeyFor(document);
    await this.storage.copy(document.r2Key, retainedKey, document.mimeType);

    const updated = await this.documents.update(document.id, { r2Key: retainedKey });
    if (!updated) {
      // The row vanished between the parse and this write. The copy is
      // orphaned rather than lost; surface it instead of pretending the
      // caller's document is now retained.
      logger.warn({ documentId: document.id, retainedKey }, 'Document gone before retention write');
      return document;
    }
    return updated;
  }
}

function extensionOf(candidate: string): string | null {
  const match = EXTENSION_PATTERN.exec(candidate);
  return match?.[1]?.toLowerCase() ?? null;
}
