import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { DocumentExtraction, NewDocumentExtraction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, notExists, sql } from 'drizzle-orm';
import { Service } from 'typedi';

// One row per invoice FOUND IN a document — a single PDF can hold
// several (see `ordinal`). This table has no `userId` of its own —
// ownership is join-derived through `documents`, same precedent as
// `PaymentOccurrenceRepository` — so every method here that takes a
// user-supplied extraction id joins through `documents` rather than
// trusting the id alone.
@Service()
export class DocumentExtractionRepository extends BaseRepository<
  DocumentExtraction,
  NewDocumentExtraction
> {
  protected readonly table = schema.documentExtractions;
  protected readonly tableName = 'document_extractions';

  /**
   * Extractions still awaiting a human decision, scoped to the user via
   * `documents`. This is the review-queue read path.
   */
  async findPendingByUser(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<DocumentExtraction[]> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({ extraction: schema.documentExtractions })
        .from(schema.documentExtractions)
        .innerJoin(schema.documents, eq(schema.documentExtractions.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.documents.userId, userId),
            eq(schema.documentExtractions.reviewState, 'pending')
          )
        )
        .orderBy(asc(schema.documentExtractions.createdAt));
      return rows.map((row) => row.extraction);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find pending extractions by user');
      throw error;
    }
  }

  /**
   * Ownership-scoped single-row lookup. `document_extractions` has no
   * `userId` of its own, so this can't reuse `BaseRepository.findById`
   * — the join through `documents` IS the ownership check. Returns null
   * for both "doesn't exist" and "belongs to another user's document",
   * same precedent as `setReviewState`.
   */
  async findByIdAndUser(
    extractionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<DocumentExtraction | null> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select({ extraction: schema.documentExtractions })
        .from(schema.documentExtractions)
        .innerJoin(schema.documents, eq(schema.documentExtractions.documentId, schema.documents.id))
        .where(
          and(eq(schema.documentExtractions.id, extractionId), eq(schema.documents.userId, userId))
        )
        .limit(1);
      return row?.extraction ?? null;
    } catch (error) {
      this.logger.error({ extractionId, userId, error }, 'Failed to find extraction by id+user');
      throw error;
    }
  }

  /**
   * Every extraction found in a single document (any review state),
   * scoped to the user via `documents` — backs the document detail page,
   * which needs the full history, not just the pending ones
   * `findPendingByUser` returns.
   */
  async findByDocumentId(
    documentId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<DocumentExtraction[]> {
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({ extraction: schema.documentExtractions })
        .from(schema.documentExtractions)
        .innerJoin(schema.documents, eq(schema.documentExtractions.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.documentExtractions.documentId, documentId),
            eq(schema.documents.userId, userId)
          )
        )
        .orderBy(asc(schema.documentExtractions.ordinal));
      return rows.map((row) => row.extraction);
    } catch (error) {
      this.logger.error({ documentId, userId, error }, 'Failed to find extractions by document id');
      throw error;
    }
  }

  /**
   * Clear a document's extractions ahead of a re-parse, keeping any that a
   * `payment_occurrences.matched_extraction_id` points at.
   *
   * That FK is `ON DELETE SET NULL`, so a blanket delete would NOT error —
   * it would quietly null the link and strip the occurrence of the invoice
   * that evidences it. The `NOT EXISTS` is therefore the actual protection,
   * not a nicety the constraint would have caught anyway.
   *
   * Ownership is join-derived through `documents` (this table has no
   * `userId`), and a DELETE can't join, so the guard is a pre-check —
   * same shape as `setReviewState`. Returns [] when the document doesn't
   * exist OR belongs to another user, so neither case is distinguishable
   * to a caller probing ids.
   */
  async deleteUnlinkedByDocumentId(
    documentId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<DocumentExtraction[]> {
    try {
      const database = this.getDb(transaction);
      const [owned] = await database
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.userId, userId)))
        .limit(1);
      if (!owned) return [];

      return await database
        .delete(schema.documentExtractions)
        .where(
          and(
            eq(schema.documentExtractions.documentId, documentId),
            notExists(
              database
                .select({ one: sql`1` })
                .from(schema.paymentOccurrences)
                .where(
                  eq(schema.paymentOccurrences.matchedExtractionId, schema.documentExtractions.id)
                )
            )
          )
        )
        .returning();
    } catch (error) {
      this.logger.error({ documentId, userId, error }, 'Failed to delete unlinked extractions');
      throw error;
    }
  }

  /**
   * Move an extraction to `reviewState`, scoped to the user via
   * `documents`. Returns null (rather than throwing) when the extraction
   * doesn't exist OR belongs to a different user — `extractionId` is a
   * client-supplied tRPC input, and distinguishing the two cases would
   * let one user probe for another's ids.
   */
  async setReviewState(
    extractionId: string,
    userId: string,
    reviewState: string,
    transaction?: DatabaseTransaction
  ): Promise<DocumentExtraction | null> {
    try {
      const database = this.getDb(transaction);
      const owned = await database
        .select({ id: schema.documentExtractions.id })
        .from(schema.documentExtractions)
        .innerJoin(schema.documents, eq(schema.documentExtractions.documentId, schema.documents.id))
        .where(
          and(eq(schema.documentExtractions.id, extractionId), eq(schema.documents.userId, userId))
        )
        .limit(1);
      if (!owned[0]) return null;

      const [row] = await database
        .update(schema.documentExtractions)
        .set({ reviewState })
        .where(eq(schema.documentExtractions.id, extractionId))
        .returning();
      return row ?? null;
    } catch (error) {
      this.logger.error({ extractionId, userId, reviewState, error }, 'Failed to set review state');
      throw error;
    }
  }
}
