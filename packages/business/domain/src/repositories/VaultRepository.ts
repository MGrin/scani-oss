import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewVault, Vault, VaultHolding } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class VaultRepository extends BaseRepository<Vault, NewVault> {
  protected readonly table = schema.vaults;
  protected readonly tableName = 'vaults';

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
          holdingsCount: sql<number>`COALESCE(COUNT(DISTINCT ${schema.vaultHoldings.holdingId}), 0)`,
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
