import { eq } from 'drizzle-orm';
import { Service } from 'typedi';
import type { AccountType, InstitutionType, TokenType } from '../../domain/entities';
import * as schema from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class InstitutionTypeRepository extends BaseRepository<
  InstitutionType,
  Partial<InstitutionType>
> {
  protected readonly table = schema.institutionTypes;
  protected readonly tableName = 'institution_types';

  async findByCode(
    code: string,
    transaction?: DatabaseTransaction
  ): Promise<InstitutionType | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.code, code))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find institution type by code');
      throw error;
    }
  }
}

@Service()
export class AccountTypeRepository extends BaseRepository<AccountType, Partial<AccountType>> {
  protected readonly table = schema.accountTypes;
  protected readonly tableName = 'account_types';

  async findByCode(code: string, transaction?: DatabaseTransaction): Promise<AccountType | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, code))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find account type by code');
      throw error;
    }
  }
}

@Service()
export class TokenTypeRepository extends BaseRepository<TokenType, Partial<TokenType>> {
  protected readonly table = schema.tokenTypes;
  protected readonly tableName = 'token_types';

  async findByCode(code: string, transaction?: DatabaseTransaction): Promise<TokenType | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, code))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find token type by code');
      throw error;
    }
  }
}
