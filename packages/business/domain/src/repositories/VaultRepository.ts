import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewVault, Vault, VaultHolding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class VaultRepository extends BaseRepository<Vault, NewVault> {
  protected readonly table = schema.vaults;
  protected readonly tableName = 'vaults';

  private async validateAllocation(
    vaultId: string,
    holdingId: string,
    percentage: number,
    tx: DatabaseTransaction
  ): Promise<void> {
    if (
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      percentage > 100 ||
      Math.abs(percentage * 100 - Math.round(percentage * 100)) > 0.000001
    )
      throw new Error('Allocation must be between 0 and 100%');
    // Preserve legacy precision. 0.00001% bounds float32 representation error at a 100% total.
    // Every writer locks the holding, including when it has no allocations yet.
    const [holding] = await tx
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId))
      .for('update');
    const vault = await this.findById(vaultId, tx);
    if (!holding || !vault || holding.userId !== vault.userId) throw new Error('Holding not found');
    const [other] = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.vaultHoldings.percentage}::double precision), 0)`,
      })
      .from(schema.vaultHoldings)
      .where(
        and(
          eq(schema.vaultHoldings.holdingId, holdingId),
          ne(schema.vaultHoldings.vaultId, vaultId)
        )
      );
    if (Number(other?.total ?? 0) + percentage > 100.00001)
      throw new Error('Total vault allocation cannot exceed 100%');
  }

  async allocationsForUser(userId: string) {
    return this.getDb()
      .select({
        holdingId: schema.vaultHoldings.holdingId,
        vaultId: schema.vaultHoldings.vaultId,
        percentage: schema.vaultHoldings.percentage,
      })
      .from(schema.vaultHoldings)
      .innerJoin(schema.holdings, eq(schema.vaultHoldings.holdingId, schema.holdings.id))
      .where(eq(schema.holdings.userId, userId));
  }

  async setAllocations(
    userId: string,
    vaultId: string,
    entries: { holdingId: string; percentage: number }[]
  ) {
    return this.getDb().transaction(async (tx) => {
      const vault = await this.findById(vaultId, tx);
      if (!vault || vault.userId !== userId) throw new Error('Vault not found');
      const ids = entries.map((e) => e.holdingId).sort();
      if (new Set(ids).size !== ids.length || ids.length > 500)
        throw new Error('Invalid allocation selection');
      if (!ids.length) return;
      const owned = await tx
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.userId, userId), inArray(schema.holdings.id, ids)))
        .orderBy(schema.holdings.id)
        .for('update');
      if (owned.length !== ids.length) throw new Error('Holding not found');
      const totals = await tx
        .select({
          holdingId: schema.vaultHoldings.holdingId,
          total: sql<number>`coalesce(sum(${schema.vaultHoldings.percentage}::double precision), 0)`,
        })
        .from(schema.vaultHoldings)
        .where(
          and(
            inArray(schema.vaultHoldings.holdingId, ids),
            ne(schema.vaultHoldings.vaultId, vaultId)
          )
        )
        .groupBy(schema.vaultHoldings.holdingId);
      const allocated = new Map(totals.map((row) => [row.holdingId, Number(row.total)]));
      for (const { holdingId, percentage } of entries) {
        if (
          !Number.isFinite(percentage) ||
          percentage < 0 ||
          percentage > 100 ||
          Math.abs(percentage * 100 - Math.round(percentage * 100)) > 0.000001
        )
          throw new Error('Allocation requires at most two decimal places between 0 and 100%');
        if ((allocated.get(holdingId) ?? 0) + percentage > 100.00001)
          throw new Error('Total vault allocation cannot exceed 100%');
      }
      const removals = entries
        .filter((entry) => entry.percentage === 0)
        .map((entry) => entry.holdingId);
      if (removals.length)
        await tx
          .delete(schema.vaultHoldings)
          .where(
            and(
              eq(schema.vaultHoldings.vaultId, vaultId),
              inArray(schema.vaultHoldings.holdingId, removals)
            )
          );
      const additions = entries
        .filter((entry) => entry.percentage > 0)
        .map((entry) => ({ vaultId, ...entry }));
      if (additions.length)
        await tx
          .insert(schema.vaultHoldings)
          .values(additions)
          .onConflictDoUpdate({
            target: [schema.vaultHoldings.vaultId, schema.vaultHoldings.holdingId],
            set: { percentage: sql`excluded.percentage` },
          });
    });
  }

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Vault[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.vaults)
        .where(and(eq(schema.vaults.userId, userId), eq(schema.vaults.isActive, true)))
        .orderBy(schema.vaults.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find vaults by user');
      throw error;
    }
  }

  async findByUserWithHoldingsCounts(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Array<Vault & { holdingsCount: number }>> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          id: schema.vaults.id,
          userId: schema.vaults.userId,
          name: schema.vaults.name,
          description: schema.vaults.description,
          targetAmount: schema.vaults.targetAmount,
          currencyId: schema.vaults.currencyId,
          currentAmount: schema.vaults.currentAmount,
          color: schema.vaults.color,
          iconName: schema.vaults.iconName,
          isActive: schema.vaults.isActive,
          createdAt: schema.vaults.createdAt,
          updatedAt: schema.vaults.updatedAt,
          // `::int` for the same reason as GroupRepository (SC-88): an
          // uncast COUNT is a bigint, which arrives as a string.
          holdingsCount: sql<number>`COALESCE(COUNT(DISTINCT ${schema.vaultHoldings.holdingId}), 0)::int`,
        })
        .from(schema.vaults)
        .leftJoin(schema.vaultHoldings, eq(schema.vaults.id, schema.vaultHoldings.vaultId))
        .where(and(eq(schema.vaults.userId, userId), eq(schema.vaults.isActive, true)))
        .groupBy(
          schema.vaults.id,
          schema.vaults.userId,
          schema.vaults.name,
          schema.vaults.description,
          schema.vaults.targetAmount,
          schema.vaults.currencyId,
          schema.vaults.currentAmount,
          schema.vaults.color,
          schema.vaults.iconName,
          schema.vaults.isActive,
          schema.vaults.createdAt,
          schema.vaults.updatedAt
        )
        .orderBy(schema.vaults.createdAt);

      return results as Array<Vault & { holdingsCount: number }>;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find vaults with holdings counts');
      throw error;
    }
  }

  async findVaultHoldings(
    vaultId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<{
      vaultHolding: VaultHolding;
      holding: schema.Holding;
      token: schema.Token;
      account: schema.Account;
      institution: schema.Institution;
    }>
  > {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          vaultHolding: schema.vaultHoldings,
          holding: schema.holdings,
          token: schema.tokens,
          account: schema.accounts,
          institution: schema.institutions,
        })
        .from(schema.vaultHoldings)
        .innerJoin(schema.holdings, eq(schema.vaultHoldings.holdingId, schema.holdings.id))
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .where(eq(schema.vaultHoldings.vaultId, vaultId));

      return results;
    } catch (error) {
      this.logger.error({ vaultId, error }, 'Failed to find vault holdings');
      throw error;
    }
  }

  async attachHolding(
    vaultId: string,
    holdingId: string,
    percentage: number,
    transaction?: DatabaseTransaction
  ): Promise<VaultHolding> {
    if (!transaction)
      return this.getDb().transaction((tx) =>
        this.attachHolding(vaultId, holdingId, percentage, tx)
      );
    await this.validateAllocation(vaultId, holdingId, percentage, transaction);
    try {
      const database = this.getDb(transaction);
      const [result] = await database
        .insert(schema.vaultHoldings)
        .values({ vaultId, holdingId, percentage })
        .returning();

      if (!result) {
        throw new Error('Failed to attach holding to vault');
      }

      return result;
    } catch (error) {
      this.logger.error(
        { vaultId, holdingId, percentage, error },
        'Failed to attach holding to vault'
      );
      throw error;
    }
  }

  async detachHolding(
    vaultId: string,
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (!transaction)
      return this.getDb().transaction((tx) => this.detachHolding(vaultId, holdingId, tx));
    await transaction
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId))
      .for('update');
    try {
      const database = this.getDb(transaction);
      await database
        .delete(schema.vaultHoldings)
        .where(
          and(
            eq(schema.vaultHoldings.vaultId, vaultId),
            eq(schema.vaultHoldings.holdingId, holdingId)
          )
        );
    } catch (error) {
      this.logger.error({ vaultId, holdingId, error }, 'Failed to detach holding from vault');
      throw error;
    }
  }

  async detachAllHoldingsForHolding(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    if (!transaction)
      return this.getDb().transaction((tx) => this.detachAllHoldingsForHolding(holdingId, tx));
    await transaction
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId))
      .for('update');
    try {
      const database = this.getDb(transaction);
      // Find affected vault IDs before deleting
      const affected = await database
        .select({ vaultId: schema.vaultHoldings.vaultId })
        .from(schema.vaultHoldings)
        .where(eq(schema.vaultHoldings.holdingId, holdingId));

      const vaultIds = affected.map((a) => a.vaultId);

      await database
        .delete(schema.vaultHoldings)
        .where(eq(schema.vaultHoldings.holdingId, holdingId));

      return vaultIds;
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to detach all holdings for holding');
      throw error;
    }
  }

  async updateHoldingPercentage(
    vaultId: string,
    holdingId: string,
    percentage: number,
    transaction?: DatabaseTransaction
  ): Promise<VaultHolding | null> {
    if (!transaction)
      return this.getDb().transaction((tx) =>
        this.updateHoldingPercentage(vaultId, holdingId, percentage, tx)
      );
    await this.validateAllocation(vaultId, holdingId, percentage, transaction);
    try {
      const database = this.getDb(transaction);
      const [result] = await database
        .update(schema.vaultHoldings)
        .set({ percentage })
        .where(
          and(
            eq(schema.vaultHoldings.vaultId, vaultId),
            eq(schema.vaultHoldings.holdingId, holdingId)
          )
        )
        .returning();

      return result || null;
    } catch (error) {
      this.logger.error(
        { vaultId, holdingId, percentage, error },
        'Failed to update vault holding percentage'
      );
      throw error;
    }
  }

  async findVaultsByHoldingId(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Array<{ vault: Vault; percentage: number }>> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          vault: schema.vaults,
          percentage: schema.vaultHoldings.percentage,
        })
        .from(schema.vaultHoldings)
        .innerJoin(schema.vaults, eq(schema.vaultHoldings.vaultId, schema.vaults.id))
        .where(eq(schema.vaultHoldings.holdingId, holdingId));

      return results;
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to find vaults by holding');
      throw error;
    }
  }

  async updateCurrentAmount(
    vaultId: string,
    amount: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.vaults)
        .set({ currentAmount: amount, updatedAt: new Date() })
        .where(eq(schema.vaults.id, vaultId));
    } catch (error) {
      this.logger.error({ vaultId, amount, error }, 'Failed to update vault current amount');
      throw error;
    }
  }
}
