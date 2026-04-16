import { and, eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { HoldingApyConfig, NewHoldingApyConfig } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

export interface ActiveApyConfigWithHolding {
  config: HoldingApyConfig;
  holdingBalance: string;
  holdingId: string;
  accountTypeCode: string;
}

@Service()
export class HoldingApyConfigRepository extends BaseRepository<
  HoldingApyConfig,
  NewHoldingApyConfig
> {
  protected readonly table = schema.holdingApyConfigs;
  protected readonly tableName = 'holding_apy_configs';

  async findByHoldingId(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<HoldingApyConfig | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.holdingApyConfigs)
      .where(eq(schema.holdingApyConfigs.holdingId, holdingId))
      .limit(1);
    return (results[0] as HoldingApyConfig) || null;
  }

  async findByHoldingIds(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, HoldingApyConfig>> {
    if (holdingIds.length === 0) return new Map();
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.holdingApyConfigs)
      .where(inArray(schema.holdingApyConfigs.holdingId, holdingIds));

    const map = new Map<string, HoldingApyConfig>();
    for (const row of results) {
      map.set(row.holdingId, row as HoldingApyConfig);
    }
    return map;
  }

  /**
   * Find all active APY configs joined with their holdings,
   * filtered to checking/savings/investment account types.
   */
  async findAllActive(transaction?: DatabaseTransaction): Promise<ActiveApyConfigWithHolding[]> {
    const database = this.getDb(transaction);
    const results = await database
      .select({
        config: schema.holdingApyConfigs,
        holdingBalance: schema.holdings.balance,
        holdingId: schema.holdings.id,
        accountTypeCode: schema.accountTypes.code,
      })
      .from(schema.holdingApyConfigs)
      .innerJoin(schema.holdings, eq(schema.holdingApyConfigs.holdingId, schema.holdings.id))
      .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
      .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .where(
        and(
          eq(schema.holdingApyConfigs.isActive, true),
          eq(schema.holdings.isActive, true),
          eq(schema.holdings.isHidden, false),
          inArray(schema.accountTypes.code, ['checking', 'savings', 'investment'])
        )
      );

    return results as ActiveApyConfigWithHolding[];
  }

  async upsertByHoldingId(
    holdingId: string,
    data: Omit<NewHoldingApyConfig, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>,
    transaction?: DatabaseTransaction
  ): Promise<HoldingApyConfig> {
    const database = this.getDb(transaction);
    const results = await database
      .insert(schema.holdingApyConfigs)
      .values({
        holdingId,
        ...data,
      })
      .onConflictDoUpdate({
        target: schema.holdingApyConfigs.holdingId,
        set: {
          ...data,
          updatedAt: new Date(),
          lastPayoutAt: new Date(), // Reset so new parameters only apply going forward
        },
      })
      .returning();

    return results[0] as HoldingApyConfig;
  }

  async deleteByHoldingId(holdingId: string, transaction?: DatabaseTransaction): Promise<boolean> {
    const database = this.getDb(transaction);
    const results = await database
      .delete(schema.holdingApyConfigs)
      .where(eq(schema.holdingApyConfigs.holdingId, holdingId))
      .returning();
    return results.length > 0;
  }

  async updateLastPayoutAt(
    id: string,
    timestamp: Date,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const database = this.getDb(transaction);
    await database
      .update(schema.holdingApyConfigs)
      .set({ lastPayoutAt: timestamp, updatedAt: new Date() })
      .where(eq(schema.holdingApyConfigs.id, id));
  }
}
