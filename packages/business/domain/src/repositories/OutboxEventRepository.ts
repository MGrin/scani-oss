import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { Service } from 'typedi';

export interface UnpublishedOutboxEvent {
  id: number;
  userId: string | null;
  type: string;
  payload: unknown;
  createdAt: Date;
}

@Service()
export class OutboxEventRepository {
  async insert(
    tx: DatabaseTransaction,
    row: { userId: string; type: string; payload: unknown }
  ): Promise<number> {
    const [inserted] = await tx
      .insert(schema.outboxEvents)
      .values(row)
      .returning({ id: schema.outboxEvents.id });
    return inserted!.id;
  }

  /** Oldest first: id order is commit order per user, which is the order a client applies. */
  async findUnpublished(limit: number): Promise<UnpublishedOutboxEvent[]> {
    return getDb()
      .select({
        id: schema.outboxEvents.id,
        userId: schema.outboxEvents.userId,
        type: schema.outboxEvents.type,
        payload: schema.outboxEvents.payload,
        createdAt: schema.outboxEvents.createdAt,
      })
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.publishedAt))
      .orderBy(asc(schema.outboxEvents.id))
      .limit(limit);
  }

  async markPublished(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    await getDb()
      .update(schema.outboxEvents)
      .set({ publishedAt: new Date() })
      .where(inArray(schema.outboxEvents.id, [...ids]));
  }

  /** Deletes up to `limit` rows published before `cutoff`, oldest first. Returns how many. */
  async prunePublished(cutoff: Date, limit: number): Promise<number> {
    const db = getDb();
    const doomed = db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        and(isNotNull(schema.outboxEvents.publishedAt), lt(schema.outboxEvents.publishedAt, cutoff))
      )
      .orderBy(asc(schema.outboxEvents.id))
      .limit(limit);
    const deleted = await db
      .delete(schema.outboxEvents)
      .where(inArray(schema.outboxEvents.id, doomed))
      .returning({ id: schema.outboxEvents.id });
    return deleted.length;
  }
}
