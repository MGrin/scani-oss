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
}
