import { eq, isNotNull } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewUser, Token, User } from '../../domain/entities';
import type { DatabaseTransaction, IUserRepository } from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class UserRepository extends BaseRepository<User, NewUser> implements IUserRepository {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';

  async findByEmail(email: string, transaction?: DatabaseTransaction): Promise<User | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ email, error }, 'Failed to find user by email');
      throw error;
    }
  }

  async findWithBaseCurrency(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(User & { baseCurrency: Token | null }) | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          user: schema.users,
          baseCurrency: schema.tokens,
        })
        .from(schema.users)
        .leftJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!results[0]) return null;

      return {
        ...results[0].user,
        baseCurrency: results[0].baseCurrency,
      };
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find user with base currency');
      throw error;
    }
  }

  async findUsersWithBaseCurrency(transaction?: DatabaseTransaction): Promise<User[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.users)
        .where(isNotNull(schema.users.baseCurrencyId));

      return results;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find users with base currency');
      throw error;
    }
  }
}
