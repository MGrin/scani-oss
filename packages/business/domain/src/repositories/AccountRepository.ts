import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Account, NewAccount } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class AccountRepository extends BaseRepository<Account, NewAccount> {
  protected readonly table = schema.accounts;
  protected readonly tableName = 'accounts';

  async findByUserInstitutionName(
    userId: string,
    institutionId: string,
    name: string,
    transaction?: DatabaseTransaction
  ): Promise<Account | null> {
    try {
      const database = this.getDb(transaction);
      const [account] = await database
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.institutionId, institutionId),
            eq(schema.accounts.name, name)
          )
        )
        .limit(1);
      return account ?? null;
    } catch (error) {
      this.logger.error(
        { userId, institutionId, name, error },
        'Failed to find account by user/institution/name'
      );
      throw error;
    }
  }

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
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true),
            eq(schema.accounts.isHidden, false)
          )
        )
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
          isHidden: schema.accounts.isHidden,
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

  /**
   * Update account fields
   */
  async updateAccount(
    accountId: string,
    data: {
      name?: string;
      typeId?: string;
      institutionId?: string;
      description?: string | null;
    },
    transaction?: DatabaseTransaction
  ): Promise<Account> {
    try {
      const database = this.getDb(transaction);
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (data.name !== undefined) updateData.name = data.name;
      if (data.typeId !== undefined) updateData.typeId = data.typeId;
      if (data.institutionId !== undefined) updateData.institutionId = data.institutionId;
      if (data.description !== undefined) updateData.description = data.description;

      const [updated] = await database
        .update(schema.accounts)
        .set(updateData)
        .where(eq(schema.accounts.id, accountId))
        .returning();

      if (!updated) {
        throw new Error(`Account with ID ${accountId} not found`);
      }

      return updated;
    } catch (error) {
      this.logger.error({ accountId, data, error }, 'Failed to update account');
      throw error;
    }
  }
}
