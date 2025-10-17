import { eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';
import type { AccountType, InstitutionType, TokenType } from '../../domain/entities';
import type {
  DatabaseTransaction,
  IAccountTypeRepository,
  IInstitutionTypeRepository,
  ITokenTypeRepository,
} from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

// =============================================================================
// InstitutionTypeRepository
// =============================================================================

@Service()
export class InstitutionTypeRepository
  extends BaseRepository<InstitutionType, Partial<InstitutionType>>
  implements IInstitutionTypeRepository
{
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

  async findActive(transaction?: DatabaseTransaction): Promise<InstitutionType[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.isActive, true))
        .orderBy(schema.institutionTypes.displayOrder, schema.institutionTypes.name);

      return results;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find active institution types');
      throw error;
    }
  }
}

// =============================================================================
// AccountTypeRepository
// =============================================================================

@Service()
export class AccountTypeRepository
  extends BaseRepository<AccountType, Partial<AccountType>>
  implements IAccountTypeRepository
{
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

  async findActive(transaction?: DatabaseTransaction): Promise<AccountType[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.isActive, true))
        .orderBy(schema.accountTypes.displayOrder, schema.accountTypes.name);

      return results;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find active account types');
      throw error;
    }
  }
}

// =============================================================================
// TokenTypeRepository
// =============================================================================

@Service()
export class TokenTypeRepository
  extends BaseRepository<TokenType, Partial<TokenType>>
  implements ITokenTypeRepository
{
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

  async findActive(transaction?: DatabaseTransaction): Promise<TokenType[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.isActive, true))
        .orderBy(schema.tokenTypes.displayOrder, schema.tokenTypes.name);

      return results;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find active token types');
      throw error;
    }
  }

  async findByIds(ids: string[], transaction?: DatabaseTransaction): Promise<TokenType[]> {
    try {
      if (ids.length === 0) {
        return [];
      }

      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(inArray(schema.tokenTypes.id, ids));

      return results;
    } catch (error) {
      this.logger.error({ ids, error }, 'Failed to find token types by IDs');
      throw error;
    }
  }
}
