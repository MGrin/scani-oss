import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewToken, Token } from '../../domain/entities';
import type { DatabaseTransaction, ITokenRepository } from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

/**
 * Token Repository
 *
 * CRITICAL BUG FIXES:
 * - Proper provider metadata structure for all token types
 * - Correct CoinGecko ID storage and retrieval
 * - Finnhub metadata handling
 */
@Service()
export class TokenRepository extends BaseRepository<Token, NewToken> implements ITokenRepository {
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

  async findByCoinGeckoId(
    coinGeckoId: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    // Search in provider metadata JSON for CoinGecko ID
    // The metadata is stored as: {"provider":"coingecko","coingecko":{"id":"bitcoin",...}}
    const results = await database
      .select()
      .from(schema.tokens)
      .where(sql`${schema.tokens.providerMetadata}::jsonb->'coingecko'->>'id' = ${coinGeckoId}`)
      .limit(1);

    return results[0] || null;
  }

  async findBySymbols(symbols: string[], transaction?: DatabaseTransaction): Promise<Token[]> {
    if (symbols.length === 0) return [];

    const database = this.getDb(transaction);
    const upperSymbols = symbols.map((s) => s.toUpperCase());
    const results = await database
      .select()
      .from(schema.tokens)
      .where(inArray(schema.tokens.symbol, upperSymbols));

    return results;
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

  async searchTokens(
    query: string,
    limit: number,
    transaction?: DatabaseTransaction
  ): Promise<Token[]> {
    const database = this.getDb(transaction);
    const upperQuery = query.toUpperCase();

    const results = await database
      .select()
      .from(schema.tokens)
      .where(
        and(
          eq(schema.tokens.isActive, true),
          sql`(UPPER(${schema.tokens.symbol}) LIKE ${`%${upperQuery}%`} OR UPPER(${schema.tokens.name}) LIKE ${`%${upperQuery}%`})`
        )
      )
      .orderBy(schema.tokens.symbol)
      .limit(limit);

    return results;
  }

  /**
   * Find token by symbol and type code
   */
  async findBySymbolAndTypeCode(
    symbol: string,
    typeCode: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select({ token: schema.tokens })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(
        and(eq(schema.tokens.symbol, symbol.toUpperCase()), eq(schema.tokenTypes.code, typeCode))
      )
      .limit(1);

    return results[0]?.token || null;
  }

  /**
   * Find token by ID with type information
   */
  async findByIdWithType(
    tokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Token & { type: { id: string; code: string } | null }) | null> {
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
        typeInfo: {
          id: schema.tokenTypes.id,
          code: schema.tokenTypes.code,
        },
      })
      .from(schema.tokens)
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(eq(schema.tokens.id, tokenId))
      .limit(1);

    if (!results[0]) return null;

    const { typeInfo, ...tokenData } = results[0];
    return {
      ...tokenData,
      type: typeInfo?.id ? typeInfo : null,
    } as Token & { type: { id: string; code: string } | null };
  }
}
