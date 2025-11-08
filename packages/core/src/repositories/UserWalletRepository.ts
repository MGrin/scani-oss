import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { NewUserWallet, UserWallet } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class UserWalletRepository extends BaseRepository<UserWallet, NewUserWallet> {
  protected readonly table = schema.userWallets;
  protected readonly tableName = 'user_wallets';

  /**
   * Find all wallets for a user
   */
  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userWallets)
        .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.isActive, true)))
        .orderBy(schema.userWallets.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find wallets by user');
      throw error;
    }
  }

  /**
   * Find wallet by address for a specific user
   */
  async findByUserAndAddress(
    userId: string,
    walletAddress: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet | undefined> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.userId, userId),
            eq(schema.userWallets.walletAddress, walletAddress),
            eq(schema.userWallets.isActive, true)
          )
        )
        .limit(1);

      return results[0];
    } catch (error) {
      this.logger.error({ userId, walletAddress, error }, 'Failed to find wallet by address');
      throw error;
    }
  }

  /**
   * Find all wallets by address (across all users)
   */
  async findByAddress(
    walletAddress: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.walletAddress, walletAddress),
            eq(schema.userWallets.isActive, true)
          )
        )
        .orderBy(schema.userWallets.createdAt);
    } catch (error) {
      this.logger.error({ walletAddress, error }, 'Failed to find wallets by address');
      throw error;
    }
  }

  /**
   * Find wallets by institution ID (networks)
   */
  async findByInstitution(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      // Query wallets where institutionIds array contains the given institutionId
      const results = await database
        .select()
        .from(schema.userWallets)
        .where(eq(schema.userWallets.isActive, true));

      // Filter in memory for JSONB array contains check
      // In production, you might want to use a raw SQL query with @> operator
      return results.filter((wallet) => {
        const institutionIds = wallet.institutionIds as string[];
        return Array.isArray(institutionIds) && institutionIds.includes(institutionId);
      });
    } catch (error) {
      this.logger.error({ institutionId, error }, 'Failed to find wallets by institution');
      throw error;
    }
  }
}
