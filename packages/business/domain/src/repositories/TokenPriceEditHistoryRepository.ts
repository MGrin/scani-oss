import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewTokenPriceEditHistory, TokenPriceEditHistory } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Service } from 'typedi';

export interface TokenPriceEditHistoryWithEditor extends TokenPriceEditHistory {
  editorEmail: string | null;
  editorName: string | null;
  baseCurrencySymbol: string | null;
}

@Service()
export class TokenPriceEditHistoryRepository extends BaseRepository<
  TokenPriceEditHistory,
  NewTokenPriceEditHistory
> {
  protected readonly table = schema.tokenPriceEditHistory;
  protected readonly tableName = 'token_price_edit_history';

  async create(
    input: NewTokenPriceEditHistory,
    transaction?: DatabaseTransaction
  ): Promise<TokenPriceEditHistory> {
    const database = this.getDb(transaction);
    const [row] = await database.insert(schema.tokenPriceEditHistory).values(input).returning();
    if (!row) {
      throw new Error('Failed to insert token_price_edit_history row');
    }
    return row;
  }

  async findByTokenId(
    tokenId: string,
    limit = 50,
    transaction?: DatabaseTransaction
  ): Promise<TokenPriceEditHistoryWithEditor[]> {
    const database = this.getDb(transaction);
    const baseTokens = alias(schema.tokens, 'base_tokens');
    const rows = await database
      .select({
        id: schema.tokenPriceEditHistory.id,
        tokenId: schema.tokenPriceEditHistory.tokenId,
        baseTokenId: schema.tokenPriceEditHistory.baseTokenId,
        previousPrice: schema.tokenPriceEditHistory.previousPrice,
        newPrice: schema.tokenPriceEditHistory.newPrice,
        editedByUserId: schema.tokenPriceEditHistory.editedByUserId,
        reason: schema.tokenPriceEditHistory.reason,
        createdAt: schema.tokenPriceEditHistory.createdAt,
        editorEmail: schema.users.email,
        editorName: schema.users.name,
        baseCurrencySymbol: baseTokens.symbol,
      })
      .from(schema.tokenPriceEditHistory)
      .leftJoin(schema.users, eq(schema.users.id, schema.tokenPriceEditHistory.editedByUserId))
      .leftJoin(baseTokens, eq(baseTokens.id, schema.tokenPriceEditHistory.baseTokenId))
      .where(eq(schema.tokenPriceEditHistory.tokenId, tokenId))
      .orderBy(desc(schema.tokenPriceEditHistory.createdAt))
      .limit(limit);
    return rows;
  }

  async findByUserId(
    userId: string,
    limit = 100,
    transaction?: DatabaseTransaction
  ): Promise<TokenPriceEditHistory[]> {
    const database = this.getDb(transaction);
    return database
      .select()
      .from(schema.tokenPriceEditHistory)
      .where(eq(schema.tokenPriceEditHistory.editedByUserId, userId))
      .orderBy(desc(schema.tokenPriceEditHistory.createdAt))
      .limit(limit);
  }
}
