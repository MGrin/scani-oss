import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { HoldingExclusion, NewHoldingExclusion } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, or } from 'drizzle-orm';
import { Service } from 'typedi';

interface ExclusionKey {
  institutionId: string;
  externalId: string;
}

// Records tokens a user explicitly rejected for a wallet chain so the
// `wallet-balances` cron never auto-re-creates them. See the
// `holding_exclusions` table comment.
@Service()
export class HoldingExclusionRepository extends BaseRepository<
  HoldingExclusion,
  NewHoldingExclusion
> {
  protected readonly table = schema.holdingExclusions;
  protected readonly tableName = 'holding_exclusions';

  /** Insert exclusions, skipping any that already exist. */
  async recordExclusions(
    userId: string,
    entries: ExclusionKey[],
    reason: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (entries.length === 0) return;
    const database = this.getDb(transaction);
    await database
      .insert(schema.holdingExclusions)
      .values(
        entries.map((e) => ({
          userId,
          institutionId: e.institutionId,
          externalId: e.externalId,
          reason,
        }))
      )
      .onConflictDoNothing();
  }

  /** Delete exclusions for the given keys — used when a user re-adds a token. */
  async removeExclusions(
    userId: string,
    entries: ExclusionKey[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (entries.length === 0) return;
    const database = this.getDb(transaction);
    await database
      .delete(schema.holdingExclusions)
      .where(
        and(
          eq(schema.holdingExclusions.userId, userId),
          or(
            ...entries.map((e) =>
              and(
                eq(schema.holdingExclusions.institutionId, e.institutionId),
                eq(schema.holdingExclusions.externalId, e.externalId)
              )
            )
          )
        )
      );
  }

  /**
   * Return the set of `institutionId:externalId` keys the user has
   * excluded, for cheap in-memory filtering during the cron sweep.
   */
  async findKeysByUser(userId: string, transaction?: DatabaseTransaction): Promise<Set<string>> {
    const database = this.getDb(transaction);
    const rows = await database
      .select({
        institutionId: schema.holdingExclusions.institutionId,
        externalId: schema.holdingExclusions.externalId,
      })
      .from(schema.holdingExclusions)
      .where(eq(schema.holdingExclusions.userId, userId));
    return new Set(rows.map((r) => `${r.institutionId}:${r.externalId}`));
  }
}
