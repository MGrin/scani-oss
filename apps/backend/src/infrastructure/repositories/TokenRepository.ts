import { and, eq, or } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewToken, Token } from '../../domain/entities';
import * as schema from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class TokenRepository extends BaseRepository<Token, NewToken> {
  protected readonly table = schema.tokens;
  protected readonly tableName = 'tokens';

  async findBySymbol(symbol: string, transaction?: DatabaseTransaction): Promise<Token | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, symbol.toUpperCase()))
      .limit(1);

    return results[0] || null;
  }

  async findBySymbolAndType(
    symbol: string,
    typeId: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(and(eq(schema.tokens.symbol, symbol.toUpperCase()), eq(schema.tokens.typeId, typeId)))
      .limit(1);

    return results[0] || null;
  }

  async findByType(typeCode: string, transaction?: DatabaseTransaction): Promise<Token[]> {
    const database = this.getDb(transaction);
    const results = await database
      .select({
        tokens: schema.tokens,
      })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(and(eq(schema.tokenTypes.code, typeCode), eq(schema.tokens.isActive, true)));

    return results.map((r) => r.tokens);
  }

  async findWithType(
    tokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Token & { typeCode: string | null }) | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        typeId: schema.tokens.typeId,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
        providerMetadata: schema.tokens.providerMetadata,
        isActive: schema.tokens.isActive,
        createdAt: schema.tokens.createdAt,
        updatedAt: schema.tokens.updatedAt,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.tokens)
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(eq(schema.tokens.id, tokenId))
      .limit(1);

    return (results[0] as Token & { typeCode: string | null }) || null;
  }

  /**
   * Find tokens by multiple symbol-type pairs
   */
  async findBySymbolTypePairs(
    pairs: Array<{ symbol: string; typeId: string }>,
    transaction?: DatabaseTransaction
  ): Promise<Token[]> {
    if (pairs.length === 0) {
      return [];
    }

    const database = this.getDb(transaction);
    const conditions = pairs.map((pair) =>
      and(
        eq(schema.tokens.symbol, pair.symbol.toUpperCase()),
        eq(schema.tokens.typeId, pair.typeId)
      )
    );

    const results = await database
      .select()
      .from(schema.tokens)
      .where(or(...conditions));

    return results;
  }

  /**
   * Create multiple tokens in a batch
   */
  async createMany(tokensData: NewToken[], transaction?: DatabaseTransaction): Promise<Token[]> {
    const database = this.getDb(transaction);
    const results = await database.insert(schema.tokens).values(tokensData).returning();
    return results;
  }
}
