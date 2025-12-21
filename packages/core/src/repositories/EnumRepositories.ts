import { eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { AccountType, InstitutionType, TokenType } from '../domain/entities';
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

  /**
   * Find multiple token types by their codes
   */
  async findByCodes(codes: string[], transaction?: DatabaseTransaction): Promise<TokenType[]> {
    try {
      if (codes.length === 0) {
        return [];
      }

      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(inArray(schema.tokenTypes.code, codes));

      return results;
    } catch (error) {
      this.logger.error({ codes, error }, 'Failed to find token types by codes');
      throw error;
    }
  }
}

@Service()
export class ScheduleTypeRepository extends BaseRepository<
  schema.ScheduleType,
  Partial<schema.ScheduleType>
> {
  protected readonly table = schema.scheduleTypes;
  protected readonly tableName = 'schedule_types';

  async findByCode(
    code: string,
    transaction?: DatabaseTransaction
  ): Promise<schema.ScheduleType | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.scheduleTypes)
        .where(eq(schema.scheduleTypes.code, code))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find schedule type by code');
      throw error;
    }
  }
}

@Service()
export class ScheduleStepTypeRepository extends BaseRepository<
  schema.ScheduleStepType,
  Partial<schema.ScheduleStepType>
> {
  protected readonly table = schema.scheduleStepTypes;
  protected readonly tableName = 'schedule_step_types';

  async findByCode(
    code: string,
    transaction?: DatabaseTransaction
  ): Promise<schema.ScheduleStepType | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.scheduleStepTypes)
        .where(eq(schema.scheduleStepTypes.code, code))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find schedule step type by code');
      throw error;
    }
  }
}
