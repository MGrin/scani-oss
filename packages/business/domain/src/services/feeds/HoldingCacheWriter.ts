import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { Service } from 'typedi';

export interface CacheWrite {
  holdingId: string;
  balance: string;
  /**
   * The instant `last_updated` takes, when the path this replaces stamped one
   * of its own; now otherwise. Legacy history walks the ledger back to it.
   */
  lastUpdated?: Date;
}

/**
 * The one A2 writer of `holdings.balance` (D-1). Each moved path hands it
 * exactly the writes the path it replaces made, so the figure stays today's
 * until A5 swaps this body for the engine calculator.
 *
 * A holding the closed-position sweep hid is shown again by a non-zero write,
 * so none stays hidden while it holds a balance and every sum built from the
 * shown holdings agrees with the value history, which counts it (SC-1557).
 * `hidden_by` stays 'auto', so the sweep may hide it again. One its owner hid
 * is never shown.
 */
@Service()
export class HoldingCacheWriter {
  async apply(
    userId: string,
    writes: readonly CacheWrite[],
    tx: DatabaseTransaction
  ): Promise<void> {
    for (const { holdingId, balance, lastUpdated } of writes) {
      const updated = await tx
        .update(schema.holdings)
        .set({
          balance,
          lastUpdated: lastUpdated ?? new Date(),
          isHidden: sql`${schema.holdings.isHidden} AND NOT (${schema.holdings.hiddenBy} IS NOT DISTINCT FROM 'auto' AND ${balance}::numeric <> 0)`,
        })
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .returning({ id: schema.holdings.id });
      if (updated.length === 0) {
        throw new Error(`HoldingCacheWriter: user ${userId} has no holding ${holdingId}`);
      }
    }
  }
}
