/**
 * Documents tRPC router.
 *
 * Ingestion itself (`DocumentIngestionService.ingest`) runs on the
 * worker via the `document-parse` job — this router only enqueues and
 * exposes the review queue the ingestion produces
 * (`document_extractions` rows awaiting a human accept/reject decision).
 *
 * `enqueueParse` mirrors `screenshots.ts`'s `assertOwnedKey`: the client
 * uploads to R2 via `storage.getUploadUrl({ purpose: 'document' })`
 * first, which scopes the returned key to
 * `temp/document/{userId}/{uuid}.{ext}`. Re-verifying that prefix here
 * stops a leaked key (logs, client telemetry, replay) from getting
 * another user's file parsed into the caller's own documents.
 */

import { randomUUID } from 'node:crypto';
import type { Document, DocumentExtraction, DocumentSourceKind } from '@scani/db/schema';
import { DOCUMENT_PURPOSES } from '@scani/db/schema';
import {
  DocumentExtractionRepository,
  type DocumentListCursor,
  type DocumentListItem,
  DocumentRepository,
  type ExtractionOccurrenceLink,
} from '@scani/domain/repositories';
import {
  DocumentDeletionService,
  DocumentDownloadService,
  DocumentReparseService,
  DocumentRetentionService,
} from '@scani/domain/services';
import { DOCUMENT_PARSE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

function assertOwnedDocumentKey(key: string, userId: string): void {
  const expectedPrefix = `temp/document/${userId}/`;
  if (!key.startsWith(expectedPrefix) || key.includes('..')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Upload key does not belong to the current user',
    });
  }
}

// Names what depends on the document rather than just refusing: "detach or
// delete the payment first" is only actionable if the user can tell which
// payment it is.
function describeBlockers(blockers: ExtractionOccurrenceLink[]): string {
  const named = blockers
    .slice(0, 3)
    .map((link) => `${link.vendorName} due ${link.dueDate}`)
    .join(', ');
  const rest = blockers.length > 3 ? ` and ${blockers.length - 3} more` : '';
  const subject =
    blockers.length === 1 ? 'An invoice in this document is' : 'Invoices in this document are';
  return (
    `${subject} attached to ${blockers.length} scheduled payment${blockers.length === 1 ? '' : 's'} ` +
    `(${named}${rest}). Deleting the document would leave ${blockers.length === 1 ? 'that payment' : 'those payments'} ` +
    'with no invoice behind it. Detach or delete the payment first, then delete this document.'
  );
}

function serializeExtraction(extraction: DocumentExtraction) {
  return {
    ...extraction,
    createdAt: extraction.createdAt.toISOString(),
  };
}

function serializeDocument(document: Document) {
  return {
    ...document,
    createdAt: document.createdAt.toISOString(),
  };
}

const MAX_LIST_LIMIT = 100;

// Keyset cursor: `(createdAt, id)`, opaque to the client so the ordering
// key can change without breaking a bookmarked page. Base64 rather than
// signed — it encodes only the caller's own row position, and the query
// is scoped to `ctx.userId` regardless of what the cursor says.
function encodeCursor(document: Document): string {
  return Buffer.from(`${document.createdAt.toISOString()}|${document.id}`, 'utf-8').toString(
    'base64url'
  );
}

function decodeCursor(cursor: string): DocumentListCursor {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
  const parsed = createdAt ? new Date(createdAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || !id) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed cursor' });
  }
  return { createdAt: parsed, id };
}

// Deliberately NOT the whole row: `r2Key` and `contentHash` are internal
// (a key is the thing the presigner signs) and the list is a list.
function serializeListItem(item: DocumentListItem, isRetained: (key: string) => boolean) {
  const { document } = item;
  return {
    id: document.id,
    purpose: document.purpose,
    originalFilename: document.originalFilename,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    createdAt: document.createdAt.toISOString(),
    extractionCount: item.extractionCount,
    // Files ingested before retention shipped (and the rare row whose
    // retention failed) have no object left, so the UI can grey the
    // download out instead of handing the user a URL that 404s.
    downloadable: isRetained(document.r2Key),
  };
}

export const documentsRouter = router({
  /**
   * Enqueue the `document-parse` job for an already-uploaded file.
   * `sourceKind` is always `'upload'` here — email-forwarded documents
   * (the other `DocumentSourceKind`) arrive through a separate,
   * non-tRPC ingestion path, not this user-initiated endpoint.
   */
  enqueueParse: protectedProcedure
    .input(
      z.object({
        r2Key: z.string().min(1),
        mimeType: z.string().min(1),
        originalFilename: z.string().min(1).max(255),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertOwnedDocumentKey(input.r2Key, ctx.userId);
      const jobId = await Container.get(BullMqEnqueueService).add(DOCUMENT_PARSE, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Key: input.r2Key,
        mimeType: input.mimeType,
        originalFilename: input.originalFilename,
        sourceKind: 'upload',
      });
      return { jobId };
    }),

  /**
   * Re-run the current extractor over a document already on file.
   *
   * `ingest` returns early on a content-hash match and never calls the AI,
   * so a file that has been read once can otherwise never be read again —
   * this is the escape hatch out of that dedup, not a hole in it: the
   * document is loaded by (id, user), the extractions that no payment
   * points at are cleared, and the job carries `reparseOf` so the worker
   * attaches the new read to the same `documents` row.
   *
   * `requestId` is minted here rather than accepted from the client: the
   * job's id folds in the r2Key and the requestId, and a re-parse reuses
   * the document's own r2Key — a client that replayed its previous
   * requestId would have its re-parse silently swallowed by BullMQ's
   * jobId dedup.
   *
   * Returns `{ jobId }` exactly like `enqueueParse`, so the SPA tracks a
   * re-parse on the same job page as the original upload.
   */
  reparse: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const outcome = await Container.get(DocumentReparseService).prepare(
        input.documentId,
        ctx.userId
      );
      if (outcome.outcome === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      if (outcome.outcome === 'file-missing') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'The original file is no longer stored, so it cannot be read again. ' +
            'Delete this document and upload the file again.',
        });
      }

      const { plan } = outcome;
      const jobId = await Container.get(BullMqEnqueueService).add(DOCUMENT_PARSE, {
        userId: ctx.userId,
        requestId: randomUUID(),
        r2Key: plan.document.r2Key,
        mimeType: plan.document.mimeType,
        originalFilename: plan.document.originalFilename,
        sourceKind: plan.document.sourceKind as DocumentSourceKind,
        reparseOf: plan.document.id,
      });
      return { jobId };
    }),

  /**
   * Delete a document, its extractions (FK cascade), and its stored object.
   *
   * Refuses with CONFLICT when a `payment_occurrences.matched_extraction_id`
   * points at one of the extractions. That FK is ON DELETE SET NULL, so the
   * database would accept the delete and silently strip a settled occurrence
   * of its evidence — the refusal, and the names in its message, are the only
   * thing that stops it.
   *
   * A missing stored object never blocks the row: documents ingested before
   * file retention shipped have no object left, and deleting the row is what
   * frees `(user_id, content_hash)` so the same file can be uploaded and
   * parsed fresh instead of hitting dedup.
   */
  delete: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(DocumentDeletionService).delete(
        input.documentId,
        ctx.userId
      );
      if (result.outcome === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      if (result.outcome === 'blocked') {
        throw new TRPCError({ code: 'CONFLICT', message: describeBlockers(result.blockers) });
      }
      return {
        documentId: input.documentId,
        storageObjectRemoved: result.storageObjectRemoved,
      };
    }),

  /**
   * Every file the caller has uploaded — invoices, screenshots, bank
   * statements — newest first.
   *
   * Keyset-paginated, never unbounded: `limit` caps at 100 and the reply
   * carries `nextCursor` (null on the last page). The repository reads
   * `limit + 1` rows to tell "there is more" from "exactly full" without
   * a second COUNT.
   */
  list: protectedProcedure
    .input(
      z.object({
        purpose: z.enum(DOCUMENT_PURPOSES).optional(),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(25),
        cursor: z.string().min(1).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await Container.get(DocumentRepository).listByUser({
        userId: ctx.userId,
        purpose: input.purpose,
        limit: input.limit,
        cursor: input.cursor ? decodeCursor(input.cursor) : undefined,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const isRetained = (key: string) => Container.get(DocumentRetentionService).isRetained(key);
      const last = page.at(-1);

      return {
        items: page.map((item) => serializeListItem(item, isRetained)),
        nextCursor: hasMore && last ? encodeCursor(last.document) : null,
      };
    }),

  /**
   * A short-lived presigned GET for a retained file, any purpose.
   *
   * The URL carries the bucket's own authority, so it is minted only
   * after `DocumentDownloadService` has proven the row belongs to the
   * caller. PRECONDITION_FAILED (not NOT_FOUND) when the object is gone:
   * the record exists and the user can still see and delete it, there is
   * just nothing left to serve.
   */
  getDownloadUrl: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await Container.get(DocumentDownloadService).presign(
        input.documentId,
        ctx.userId
      );
      if (result.outcome === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      if (result.outcome === 'file-missing') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The original file is no longer stored, so it cannot be downloaded.',
        });
      }
      return {
        url: result.url,
        expiresAt: result.expiresAt.toISOString(),
        originalFilename: result.document.originalFilename,
        mimeType: result.document.mimeType,
      };
    }),

  /** Extractions still awaiting an accept/reject decision, scoped to the caller. */
  listExtractions: protectedProcedure.query(async ({ ctx }) => {
    const rows = await Container.get(DocumentExtractionRepository).findPendingByUser(ctx.userId);
    return rows.map(serializeExtraction);
  }),

  /**
   * A single document plus every extraction found in it, scoped to the
   * caller — backs `/documents/:id`, the page every extraction row in the
   * review feed (`ReviewFeedService`) links to.
   */
  get: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const document = await Container.get(DocumentRepository).findByIdAndUser(
        input.documentId,
        ctx.userId
      );
      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      const extractions = await Container.get(DocumentExtractionRepository).findByDocumentId(
        input.documentId,
        ctx.userId
      );
      return {
        document: serializeDocument(document),
        extractions: extractions.map(serializeExtraction),
      };
    }),

  /**
   * A single extraction by its own id, scoped to the caller — what the
   * review feed's "turn this into a recurring payment" form pre-fills
   * from before calling `payments.createFromExtraction`. Separate from
   * `get` because a review-feed row carries an extraction id, not the
   * document id `get` needs; `document.id` comes back on the row for
   * callers that then want the file itself.
   *
   * Returns the full extraction row (every column, `createdAt` as an ISO
   * string), so columns added to `document_extractions` later surface
   * here without touching this endpoint.
   */
  getExtraction: protectedProcedure
    .input(z.object({ extractionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const extraction = await Container.get(DocumentExtractionRepository).findByIdAndUser(
        input.extractionId,
        ctx.userId
      );
      if (!extraction) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Extraction not found' });
      }
      return serializeExtraction(extraction);
    }),

  /**
   * `setReviewState` returns null for both "doesn't exist" and "belongs
   * to another user's document" (ownership is join-derived through
   * `documents` — see the repository's own doc comment), so both cases
   * surface as the same NOT_FOUND here.
   */
  acceptExtraction: protectedProcedure
    .input(z.object({ extractionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await Container.get(DocumentExtractionRepository).setReviewState(
        input.extractionId,
        ctx.userId,
        'accepted'
      );
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Extraction not found' });
      return serializeExtraction(row);
    }),

  rejectExtraction: protectedProcedure
    .input(z.object({ extractionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await Container.get(DocumentExtractionRepository).setReviewState(
        input.extractionId,
        ctx.userId,
        'rejected'
      );
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Extraction not found' });
      return serializeExtraction(row);
    }),
});
