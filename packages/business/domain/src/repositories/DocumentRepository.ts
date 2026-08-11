import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Document, NewDocument } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';

// One row per uploaded FILE. `findByContentHash` backs the dedup that
// stops the same invoice PDF being re-scanned (and re-billed to AI
// spend) twice by the same user — see the `(user_id, content_hash)`
// unique on the table itself, which is the actual enforcement; this
// method is how callers check ahead of an insert without relying on
// catching the constraint violation.
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
