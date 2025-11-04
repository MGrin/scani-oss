import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import type { Account, NewAccount } from '../../domain/entities';

import * as schema from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class AccountRepository extends BaseRepository<Account, NewAccount> {
  protected readonly table = schema.accounts;
  protected readonly tableName = 'accounts';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Account[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          account: schema.accounts,
          type: schema.accountTypes.code,
          typeName: schema.accountTypes.name,
        })
        .from(schema.accounts)
        .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
        .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.isActive, true)))
        .orderBy(schema.accounts.name);

      return results.map((result) => ({
        ...result.account,
        type: result.type,
        typeName: result.typeName,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find accounts by user');
      throw error;
    }
  }

  /**
   * Find all wallet accounts (accounts with walletAddress in metadata)
   */
  async findWalletAccounts(transaction?: DatabaseTransaction): Promise<Account[]> {
    try {
      const database = this.getDb(transaction);
      const accounts = await database
        .select({
          id: schema.accounts.id,
          userId: schema.accounts.userId,
          name: schema.accounts.name,
          metadata: schema.accounts.metadata,
          institutionId: schema.accounts.institutionId,
          typeId: schema.accounts.typeId,
          description: schema.accounts.description,
          isActive: schema.accounts.isActive,
          createdAt: schema.accounts.createdAt,
          updatedAt: schema.accounts.updatedAt,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.isActive, true));

      // Filter accounts that have walletAddress in metadata
      return accounts.filter((account) => {
        const metadata = account.metadata as Record<string, unknown> | null;
        return metadata && typeof metadata === 'object' && 'walletAddress' in metadata;
      });
    } catch (error) {
      this.logger.error({ error }, 'Failed to find wallet accounts');
      throw error;
    }
  }

  /**
   * Update account metadata
   */
  async updateMetadata(
    accountId: string,
    metadata: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.accounts)
        .set({
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, accountId));
    } catch (error) {
      this.logger.error({ accountId, error }, 'Failed to update account metadata');
      throw error;
    }
  }
}
