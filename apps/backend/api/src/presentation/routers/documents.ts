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
import { DocumentExtractionRepository, DocumentRepository } from '@scani/domain/repositories';
import { DocumentReparseService } from '@scani/domain/services';
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
      const plan = await Container.get(DocumentReparseService).prepare(
        input.documentId,
        ctx.userId
      );
      if (!plan) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }

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
