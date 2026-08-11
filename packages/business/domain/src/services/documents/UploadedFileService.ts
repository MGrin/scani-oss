/**
 * Records an upload that is NOT an invoice — a portfolio screenshot, a
 * bank statement — as a `documents` row, and promotes its object out of
 * `temp/` so the file survives the job that read it.
 *
 * Invoices reach `documents` through `DocumentIngestionService`, which
 * has to create the row itself (the content-hash dedup gates the AI call,
 * and the extractions hang off the row it returns). Screenshots and
 * imports have no extraction step, so their whole "this file now exists
 * in the user's account" story is this service: hash, row, retain.
 *
 * **Dedup is a lookup, never a constraint.** The `(user_id, content_hash)`
 * unique is partial — `WHERE purpose = 'invoice'` — so a re-upload here
 * can never fail an INSERT. That is deliberate: the flow that matters is
 * a user re-uploading the same CSV after an import failed, and a
 * constraint violation there would kill the retry. Reusing the existing
 * row instead keeps `documents` honest as "one row per uploaded FILE"
 * (the file-import currency-picker path consumes one upload twice and
 * would otherwise list it twice) while the retry proceeds normally.
 *
 * Retention failure is logged, not thrown: the caller's real work (a
 * parse, an import) has either already run or is about to, and losing the
 * kept copy of a file must not fail it. The row still points at the temp
 * key, which reads as "not downloadable" everywhere — same degraded state
 * as every document ingested before retention shipped.
 */

import { createHash } from 'node:crypto';
import type { Document, DocumentPurpose, DocumentSourceKind } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { DocumentRepository } from '../../repositories/DocumentRepository';
import { DocumentRetentionService } from './DocumentRetentionService';

const logger = createComponentLogger('service:uploaded-file');

export interface RecordUploadedFileInput {
  userId: string;
  purpose: Exclude<DocumentPurpose, 'invoice'>;
  /** The bytes the job just read — hashed here so callers never re-read the object. */
  bytes: Uint8Array;
  mimeType: string;
  /** The `temp/` key the file was uploaded to. */
  r2Key: string;
  originalFilename: string;
  sourceKind?: DocumentSourceKind;
}

@Service()
export class UploadedFileService {
  private readonly documents = Container.get(DocumentRepository);
  private readonly retention = Container.get(DocumentRetentionService);

  async record(input: RecordUploadedFileInput): Promise<Document> {
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');

    const existing = await this.documents.findByPurposeAndContentHash(
      input.userId,
      input.purpose,
      contentHash
    );
    // A reused row whose earlier retention failed is retried against the
    // key THIS upload landed on: the bytes are identical by definition,
    // and the row's own (temp) key is very likely swept by now.
    if (existing) {
      return this.retention.isRetained(existing.r2Key)
        ? existing
        : this.retain({ ...existing, r2Key: input.r2Key });
    }

    const document = await this.documents.create({
      userId: input.userId,
      purpose: input.purpose,
      r2Key: input.r2Key,
      contentHash,
      mimeType: input.mimeType,
      byteSize: input.bytes.length,
      originalFilename: input.originalFilename,
      sourceKind: input.sourceKind ?? 'upload',
    });

    return this.retain(document);
  }

  private async retain(document: Document): Promise<Document> {
    try {
      return await this.retention.retain(document);
    } catch (error) {
      logger.error(
        {
          documentId: document.id,
          r2Key: document.r2Key,
          error: error instanceof Error ? error.message : error,
        },
        'Upload recorded but the file could not be retained'
      );
      return document;
    }
  }
}
