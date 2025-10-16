import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewTransaction, Transaction } from '../../domain/entities';
import type {
  DatabaseTransaction,
  ITransactionRepository,
} from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class TransactionRepository
  extends BaseRepository<Transaction, NewTransaction>
  implements ITransactionRepository
{
  protected readonly table = schema.transactions;
  protected readonly tableName = 'transactions';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Transaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.userId, userId))
        .orderBy(desc(schema.transactions.timestamp));

      return results;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find transactions by user');
      throw error;
    }
  }

  async findByHolding(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Transaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.holdingId, holdingId))
        .orderBy(desc(schema.transactions.timestamp));

      return results;
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to find transactions by holding');
      throw error;
    }
  }

  async findByAccount(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Transaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          transaction: schema.transactions,
        })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .where(
          and(eq(schema.holdings.accountId, accountId), eq(schema.transactions.userId, userId))
        )
        .orderBy(desc(schema.transactions.timestamp));

      return results.map((r) => r.transaction);
    } catch (error) {
      this.logger.error({ accountId, userId, error }, 'Failed to find transactions by account');
      throw error;
    }
  }

  async findByDateRange(
    userId: string,
    startDate: Date,
    endDate: Date,
    transaction?: DatabaseTransaction
  ): Promise<Transaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            gte(schema.transactions.timestamp, startDate),
            lte(schema.transactions.timestamp, endDate)
          )
        )
        .orderBy(desc(schema.transactions.timestamp));

      return results;
    } catch (error) {
      this.logger.error(
        { userId, startDate, endDate, error },
        'Failed to find transactions by date range'
      );
      throw error;
    }
  }

  async findByType(
    typeCode: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Transaction[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          transaction: schema.transactions,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(
          and(eq(schema.transactionTypes.code, typeCode), eq(schema.transactions.userId, userId))
        )
        .orderBy(desc(schema.transactions.timestamp));

      return results.map((r) => r.transaction);
    } catch (error) {
      this.logger.error({ typeCode, userId, error }, 'Failed to find transactions by type');
      throw error;
    }
  }

  async findWithDetails(
    transactionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Transaction & { tokenSymbol: string; typeName: string }) | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          transaction: schema.transactions,
          tokenSymbol: schema.tokens.symbol,
          typeName: schema.transactionTypes.name,
        })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(
          and(eq(schema.transactions.id, transactionId), eq(schema.transactions.userId, userId))
        )
        .limit(1);

      if (!results[0]) return null;

      return {
        ...results[0].transaction,
        tokenSymbol: results[0].tokenSymbol,
        typeName: results[0].typeName,
      };
    } catch (error) {
      this.logger.error(
        { transactionId, userId, error },
        'Failed to find transaction with details'
      );
      throw error;
    }
  }
}
