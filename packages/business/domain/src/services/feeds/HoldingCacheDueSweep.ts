import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, lte } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { HoldingCacheWriter } from './HoldingCacheWriter';

/**
 * Rewrites each holding whose cache is due: evidence was dated after the
 * moment it was written, and that instant has passed (SC-1633). A bank that
 * prints local time east of UTC puts a statement's last row hours ahead.
 */
@Service()
export class HoldingCacheDueSweep {
  private readonly writer = Container.get(HoldingCacheWriter);

  async refreshDue(tx: DatabaseTransaction, now: Date, limit: number): Promise<number> {
    const due = await tx
      .select({ id: schema.holdings.id, userId: schema.holdings.userId })
      .from(schema.holdings)
      .where(lte(schema.holdings.cacheDueAt, now))
      .orderBy(asc(schema.holdings.cacheDueAt))
      .limit(limit);
    const byUser = new Map<string, string[]>();
    for (const { id, userId } of due) byUser.set(userId, [...(byUser.get(userId) ?? []), id]);
    for (const [userId, holdingIds] of byUser) await this.writer.refresh(userId, holdingIds, tx);
    return due.length;
  }
}
