import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';

export interface CacheWrite {
  holdingId: string;
  balance: string;
}

/**
 * The one A2 writer of `holdings.balance` (D-1). Each moved path hands it
 * exactly the writes the path it replaces made, so the figure stays today's
 * until A5 swaps this body for the engine calculator.
 */
@Service()
export class HoldingCacheWriter {
  async apply(
    userId: string,
    writes: readonly CacheWrite[],
    tx: DatabaseTransaction
  ): Promise<void> {
    for (const { holdingId, balance } of writes) {
      const updated = await tx
        .update(schema.holdings)
        .set({ balance, lastUpdated: new Date() })
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .returning({ id: schema.holdings.id });
      if (updated.length === 0) {
        throw new Error(`HoldingCacheWriter: user ${userId} has no holding ${holdingId}`);
      }
    }
  }
}
