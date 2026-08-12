import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Document, DocumentPurpose, NewDocument } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/** One row of the "every file you've uploaded" list. */
export interface DocumentListItem {
  document: Document;
  /** Invoices found in the file. Always 0 for purposes that aren't parsed for invoices. */
  extractionCount: number;
}

/** Keyset position: the last row of the previous page. */
export interface DocumentListCursor {
  createdAt: Date;
  id: string;
}

export interface ListDocumentsOptions {
  userId: string;
  purpose?: DocumentPurpose;
  limit: number;
  cursor?: DocumentListCursor;
}

// One row per uploaded FILE. `findByContentHash` backs the dedup that
// stops the same invoice PDF being re-scanned (and re-billed to AI
// spend) twice by the same user — see the partial `(user_id,
// content_hash) WHERE purpose = 'invoice'` unique on the table itself,
// which is the actual enforcement; this method is how callers check
// ahead of an insert without relying on catching the constraint
// violation. `findByPurposeAndContentHash` is the same question for the
// purposes that unique deliberately does NOT cover.
@Service()
export class DocumentRepository extends BaseRepository<Document, NewDocument> {
  protected readonly table = schema.documents;
  protected readonly tableName = 'documents';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Document[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.userId, userId))
        .orderBy(schema.documents.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find documents by user');
      throw error;
    }
  }

  async findByContentHash(
    userId: string,
    contentHash: string,
    transaction?: DatabaseTransaction
  ): Promise<Document | undefined> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select()
        .from(schema.documents)
        .where(
          and(eq(schema.documents.userId, userId), eq(schema.documents.contentHash, contentHash))
        )
        .limit(1);
      return row;
    } catch (error) {
      this.logger.error({ userId, contentHash, error }, 'Failed to find document by content hash');
      throw error;
    }
  }

  /**
   * The same bytes, already uploaded by this user for the same purpose.
   *
   * Screenshots and imports are outside the partial `(user_id,
   * content_hash) WHERE purpose = 'invoice'` unique on purpose — a hard
   * constraint there would fail the INSERT on the retry after a failed
   * import, which is exactly the flow that has to work. Scoping the
   * lookup by `purpose` keeps an invoice and a screenshot that share
   * bytes as the two separate files they are.
   */
  async findByPurposeAndContentHash(
    userId: string,
    purpose: DocumentPurpose,
    contentHash: string,
    transaction?: DatabaseTransaction
  ): Promise<Document | null> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.userId, userId),
            eq(schema.documents.purpose, purpose),
            eq(schema.documents.contentHash, contentHash)
          )
        )
        .limit(1);
      return row ?? null;
    } catch (error) {
      this.logger.error(
        { userId, purpose, contentHash, error },
        'Failed to find document by purpose+content hash'
      );
      throw error;
    }
  }

  /**
   * One page of the user's uploaded files, newest first.
   *
   * Keyset (not OFFSET) pagination on `(created_at, id)`: two files
   * uploaded in the same millisecond are ordered by id, so a cursor can
   * neither skip nor repeat a row while the user keeps uploading. Reads
   * `limit + 1` so the caller can tell "more pages" from "exactly full".
   *
   * The extraction count is a correlated subquery rather than a join +
   * GROUP BY: it stays 0 rather than dropping the row for the purposes
   * that never produce extractions, which is most of them.
   */
  async listByUser(
    options: ListDocumentsOptions,
    transaction?: DatabaseTransaction
  ): Promise<DocumentListItem[]> {
    const { userId, purpose, limit, cursor } = options;
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({
          document: schema.documents,
          // Table-qualified by hand: interpolating the *columns* renders
          // them bare (`WHERE "document_id" = "id"`), and `id` then binds to
          // `document_extractions` rather than the outer `documents` row —
          // a correlation that silently counts nothing.
          extractionCount: sql<number>`(
            SELECT count(*)::int FROM ${schema.documentExtractions}
            WHERE ${schema.documentExtractions}."document_id" = ${schema.documents}."id"
          )`.as('extraction_count'),
        })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.userId, userId),
            purpose ? eq(schema.documents.purpose, purpose) : undefined,
            cursor
              ? or(
                  lt(schema.documents.createdAt, cursor.createdAt),
                  and(
                    eq(schema.documents.createdAt, cursor.createdAt),
                    lt(schema.documents.id, cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(schema.documents.createdAt), desc(schema.documents.id))
        .limit(limit + 1);
      return rows.map((row) => ({
        document: row.document,
        extractionCount: Number(row.extractionCount ?? 0),
      }));
    } catch (error) {
      this.logger.error({ userId, purpose, error }, 'Failed to list documents by user');
      throw error;
    }
  }

  /**
   * Same precedent as `PaymentRepository.findByIdAndUser`: returns null
   * when the document doesn't exist OR belongs to a different user —
   * `documentId` is a client-supplied tRPC input, and distinguishing the
   * two cases would let one user probe for another's ids.
   */
  async findByIdAndUser(
    documentId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Document | null> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select()
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.userId, userId)))
        .limit(1);
      return row ?? null;
    } catch (error) {
      this.logger.error({ documentId, userId, error }, 'Failed to find document by id+user');
      throw error;
    }
  }
}
