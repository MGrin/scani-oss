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
  ): Promise<(Holding & { tokenSymbol: string; tokenName: string; accountName: string }) | null> {
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

  async findByUserWithDetails(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<
      Holding & { tokenId: string; balance: string; institutionName: string; accountName: string }
    >
  > {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          holding: schema.holdings,
          institutionName: schema.institutions.name,
          accountName: schema.accounts.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .where(eq(schema.holdings.userId, userId));

      return results.map((r) => ({
        ...r.holding,
        tokenId: r.holding.tokenId,
        balance: r.holding.balance,
        institutionName: r.institutionName,
        accountName: r.accountName,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find user holdings with details');
      throw error;
    }
  }
}
