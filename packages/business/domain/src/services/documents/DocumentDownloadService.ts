/**
 * Hands back a short-lived, presigned GET for a file the user uploaded —
 * any purpose, invoice or not.
 *
 * Ownership is the `findByIdAndUser` lookup, and it is the ONLY thing
 * standing between a guessed uuid and someone else's bank statement: the
 * presigned URL itself carries the bucket's authority, so it must never
 * be minted before the row is proven to be the caller's. `not-found`
 * covers both "no such document" and "not yours", same precedent as the
 * rest of the documents layer — distinguishing them would let one user
 * probe for another's ids.
 *
 * `file-missing` is a real state, not an error: every document ingested
 * before retention shipped points at a `temp/` key that R2 swept within
 * 24h. Presigning that key would return a URL that 404s, so the retained
 * -prefix test decides instead — the same `isRetained` guard the parse
 * path uses, for the same reason: where the object lives is the fact,
 * not a flag a caller can get wrong.
 */

import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { DocumentRepository } from '../../repositories/DocumentRepository';
import { DocumentRetentionService } from './DocumentRetentionService';

/** Long enough to start a download on a slow connection, short enough that a leaked URL dies fast. */
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export type DocumentDownloadOutcome =
  /** Doesn't exist, or belongs to another user — the caller must not distinguish them. */
  | { outcome: 'not-found' }
  /** Uploaded before retention, or its retention failed: there is no object left to serve. */
  | { outcome: 'file-missing'; document: Document }
  | { outcome: 'ready'; document: Document; url: string; expiresAt: Date };

@Service()
export class DocumentDownloadService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly retention = Container.get(DocumentRetentionService);
  private readonly storage = Container.get(StorageFacade);

  async presign(documentId: string, userId: string): Promise<DocumentDownloadOutcome> {
    const document = await this.documents.findByIdAndUser(documentId, userId);
    if (!document) return { outcome: 'not-found' };
    if (!this.retention.isRetained(document.r2Key)) return { outcome: 'file-missing', document };

    const url = await this.storage.presignDownload(document.r2Key, DOWNLOAD_TTL_SECONDS);
    return {
      outcome: 'ready',
      document,
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    };
  }
}
