import { and, eq, ne } from 'drizzle-orm';
import { Service } from 'typedi';
import type { Holding, NewHolding, Token } from '../../domain/entities';
import type { DatabaseTransaction, IHoldingRepository } from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class HoldingRepository
  extends BaseRepository<Holding, NewHolding>
  implements IHoldingRepository
{
  protected readonly table = schema.holdings;
  protected readonly tableName = 'holdings';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.userId, userId))
        .orderBy(schema.holdings.lastUpdated);

      return results;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find holdings by user');
      throw error;
    }
  }

  async findByAccount(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.accountId, accountId), eq(schema.holdings.userId, userId)))
        .orderBy(schema.holdings.lastUpdated);

      return results;
    } catch (error) {
      this.logger.error({ accountId, userId, error }, 'Failed to find holdings by account');
      throw error;
    }
  }

  async findByToken(
    tokenId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.tokenId, tokenId), eq(schema.holdings.userId, userId)))
        .orderBy(schema.holdings.lastUpdated);

      return results;
    } catch (error) {
      this.logger.error({ tokenId, userId, error }, 'Failed to find holdings by token');
      throw error;
    }
  }

  async findByAccountAndToken(
    accountId: string,
    tokenId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);

      const conditions = [
        eq(schema.holdings.accountId, accountId),
        eq(schema.holdings.tokenId, tokenId),
        eq(schema.holdings.userId, userId),
      ];

      if (excludeId) {
        conditions.push(ne(schema.holdings.id, excludeId));
      }

      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(...conditions))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { accountId, tokenId, userId, excludeId, error },
        'Failed to find holding by account and token'
      );
      throw error;
    }
  }

  async findWithDetails(
    holdingId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    | (Holding & {
        tokenSymbol: string;
        tokenName: string;
        accountName: string;
      })
    | null
  > {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          holding: schema.holdings,
          tokenSymbol: schema.tokens.symbol,
          tokenName: schema.tokens.name,
          accountName: schema.accounts.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .limit(1);

      if (!results[0]) return null;

      return {
        ...results[0].holding,
        tokenSymbol: results[0].tokenSymbol,
        tokenName: results[0].tokenName,
        accountName: results[0].accountName,
      };
    } catch (error) {
      this.logger.error({ holdingId, userId, error }, 'Failed to find holding with details');
      throw error;
    }
  }

  async findWithToken(
    holdingId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Holding & { token: Token }) | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          holding: schema.holdings,
          token: schema.tokens,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
        .limit(1);

      if (!results[0]) return null;

      return {
        ...results[0].holding,
        token: results[0].token,
      };
    } catch (error) {
      this.logger.error({ holdingId, userId, error }, 'Failed to find holding with token');
      throw error;
    }
  }

  async findUserHoldingsWithTokens(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Array<Holding & { token: Token }>> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          holding: schema.holdings,
          token: schema.tokens,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(eq(schema.holdings.userId, userId));

      return results.map((r) => ({
        ...r.holding,
        token: r.token,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find user holdings with tokens');
      throw error;
    }
  }

  // Alias for compatibility with PortfolioValuationService
  async findByUserWithTokens(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Array<Holding & { token: Token }>> {
    return this.findUserHoldingsWithTokens(userId, transaction);
  }

  /**
   * Optimized query to fetch holdings with complete related data for dashboard
   * Includes: holding, token with type, account with institution
   */
  async findByUserWithCompleteDetails(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<{
      holding: Holding;
      token: Token & { typeCode: string; typeName: string };
      account: {
        id: string;
        name: string;
        institutionId: string;
        typeCode: string;
      };
      institution: { id: string; name: string; website?: string };
    }>
  > {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          // Holdings data
          holdingId: schema.holdings.id,
          holdingUserId: schema.holdings.userId,
          holdingAccountId: schema.holdings.accountId,
          holdingTokenId: schema.holdings.tokenId,
          holdingBalance: schema.holdings.balance,
          holdingLastUpdated: schema.holdings.lastUpdated,
          holdingCreatedAt: schema.holdings.createdAt,
          // Token data
          token: schema.tokens,
          tokenTypeCode: schema.tokenTypes.code,
          tokenTypeName: schema.tokenTypes.name,
          // Account data
          accountId: schema.accounts.id,
          accountName: schema.accounts.name,
          accountInstitutionId: schema.accounts.institutionId,
          accountTypeCode: schema.accountTypes.code,
          // Institution data
          institutionId: schema.institutions.id,
          institutionName: schema.institutions.name,
          institutionWebsite: schema.institutions.website,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
        .where(eq(schema.holdings.userId, userId));

      return results.map((r) => ({
        holding: {
          id: r.holdingId,
          userId: r.holdingUserId,
          accountId: r.holdingAccountId,
          tokenId: r.holdingTokenId,
          balance: r.holdingBalance,
          lastUpdated: r.holdingLastUpdated,
          createdAt: r.holdingCreatedAt,
        },
        token: {
          ...r.token,
          typeCode: r.tokenTypeCode,
          typeName: r.tokenTypeName,
        },
        account: {
          id: r.accountId,
          name: r.accountName,
          institutionId: r.accountInstitutionId,
          typeCode: r.accountTypeCode,
        },
        institution: {
          id: r.institutionId,
          name: r.institutionName,
          website: r.institutionWebsite ?? undefined,
        },
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find holdings with complete details');
      throw error;
    }
  }

  /**
   * Optimized query to fetch holdings with ALL related data including type tables
   * Used by Holdings page to minimize queries
   * Includes: holding, token+tokenType, account+accountType, institution+institutionType
   */
  async findByUserWithFullDetails(
    userId: string,
    accountId?: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<{
      holding: Holding;
      token: Token & { typeCode: string; typeName: string };
      account: {
        id: string;
        name: string;
        institutionId: string;
        typeCode: string;
        typeName: string;
      };
      institution: {
        id: string;
        name: string;
        typeCode: string;
        typeName: string;
        website: string | null;
      };
    }>
  > {
    try {
      const database = this.getDb(transaction);

      // Build where conditions
      const whereConditions = accountId
        ? and(eq(schema.holdings.userId, userId), eq(schema.holdings.accountId, accountId))
        : eq(schema.holdings.userId, userId);

      const results = await database
        .select({
          // Holdings data
          holdingId: schema.holdings.id,
          holdingUserId: schema.holdings.userId,
          holdingAccountId: schema.holdings.accountId,
          holdingTokenId: schema.holdings.tokenId,
          holdingBalance: schema.holdings.balance,
          holdingLastUpdated: schema.holdings.lastUpdated,
          holdingCreatedAt: schema.holdings.createdAt,
          // Token data with type
          token: schema.tokens,
          tokenTypeCode: schema.tokenTypes.code,
          tokenTypeName: schema.tokenTypes.name,
          // Account data with type
          accountId: schema.accounts.id,
          accountName: schema.accounts.name,
          accountInstitutionId: schema.accounts.institutionId,
          accountTypeCode: schema.accountTypes.code,
          accountTypeName: schema.accountTypes.name,
          // Institution data with type
          institutionId: schema.institutions.id,
          institutionName: schema.institutions.name,
          institutionWebsite: schema.institutions.website,
          institutionTypeCode: schema.institutionTypes.code,
          institutionTypeName: schema.institutionTypes.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .innerJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .where(whereConditions);

      return results.map((r) => ({
        holding: {
          id: r.holdingId,
          userId: r.holdingUserId,
          accountId: r.holdingAccountId,
          tokenId: r.holdingTokenId,
          balance: r.holdingBalance,
          lastUpdated: r.holdingLastUpdated,
          createdAt: r.holdingCreatedAt,
        },
        token: {
          ...r.token,
          typeCode: r.tokenTypeCode,
          typeName: r.tokenTypeName,
        },
        account: {
          id: r.accountId,
          name: r.accountName,
          institutionId: r.accountInstitutionId,
          typeCode: r.accountTypeCode,
          typeName: r.accountTypeName,
        },
        institution: {
          id: r.institutionId,
          name: r.institutionName,
          typeCode: r.institutionTypeCode,
          typeName: r.institutionTypeName,
          website: r.institutionWebsite,
        },
      }));
    } catch (error) {
      this.logger.error({ userId, accountId, error }, 'Failed to find holdings with full details');
      throw error;
    }
  }
}
