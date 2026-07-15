import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewToken, Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gt, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class TokenRepository extends BaseRepository<Token, NewToken> {
  protected readonly table = schema.tokens;
  protected readonly tableName = 'tokens';

  async findBySymbol(symbol: string, transaction?: DatabaseTransaction): Promise<Token | null> {
    const database = this.getDb(transaction);
    // Symbol is NOT unique — the same ticker can legitimately exist as
    // multiple rows (e.g. `USD` as a fiat token AND a scam lookalike
    // with `isScamProbability = 1`). Without a deterministic tiebreak,
    // `.limit(1)` returned either one depending on Postgres's internal
    // heap order, which is both flaky in tests and lets scam tokens
    // occasionally win in prod imports. Prefer the most-legit row
    // (lowest scam probability), then the newest — newer user-created
    // tokens take priority over older seeded lookalikes.
    const results = await database
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, symbol.toUpperCase()))
      .orderBy(asc(schema.tokens.isScamProbability), desc(schema.tokens.createdAt))
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
      .orderBy(asc(schema.tokens.isScamProbability), desc(schema.tokens.createdAt))
      .limit(1);

    return results[0] || null;
  }

  /**
   * Find a token by the 3-tuple unique constraint added in migration
   * 0055: `(symbol, typeId, marketSegment)`. The marketSegment column
   * lets the same symbol exist on multiple exchanges (`AAPL` on US
   * vs `AAPL.L` on the LSE), so the new federated identity flow
   * disambiguates by all three components.
   *
   * Pass `marketSegment: null` for crypto/fiat (no market segmentation).
   */
  async findByIdentityTuple(
    symbol: string,
    typeId: string,
    marketSegment: string | null,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    const segmentCondition =
      marketSegment === null
        ? sql`${schema.tokens.marketSegment} IS NULL`
        : eq(schema.tokens.marketSegment, marketSegment);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(
        and(
          eq(schema.tokens.symbol, symbol.toUpperCase()),
          eq(schema.tokens.typeId, typeId),
          segmentCondition
        )
      )
      .orderBy(asc(schema.tokens.isScamProbability), desc(schema.tokens.createdAt))
      .limit(1);
    return results[0] || null;
  }

  /**
   * Find a token by its EVM contract identity stored in
   * `providerMetadata.etherscan.{chainId,contractAddress}`. The
   * jsonb expression index `tokens_etherscan_contract_idx` (added in
   * migration 0055) keeps this fast even at scale.
   *
   * Returns null when no row matches; never throws on malformed JSON
   * (postgres-side jsonb operators degrade to NULL match).
   */
  async findByEvmContract(
    chainId: number,
    contractAddress: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    const lower = contractAddress.toLowerCase();
    const results = await database
      .select()
      .from(schema.tokens)
      .where(
        sql`${schema.tokens.providerMetadata}->'etherscan'->>'chainId' = ${String(chainId)}
            AND lower(${schema.tokens.providerMetadata}->'etherscan'->>'contractAddress') = ${lower}`
      )
      .orderBy(asc(schema.tokens.isScamProbability), desc(schema.tokens.createdAt))
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
   * PERFORMANCE: Batch fetch tokens with their types
   * Avoids N+1 query problem when fetching multiple tokens with type info
   */
  async findManyWithTypes(
    tokenIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Array<Token & { typeCode: string | null }>> {
    if (tokenIds.length === 0) return [];

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
        isScamProbability: schema.tokens.isScamProbability,
        isActive: schema.tokens.isActive,
        createdAt: schema.tokens.createdAt,
        updatedAt: schema.tokens.updatedAt,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.tokens)
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(inArray(schema.tokens.id, tokenIds));

    return results as Array<Token & { typeCode: string | null }>;
  }

  /**
   * Find a token whose symbol starts with the given prefix followed by a dot.
   * Used for deduplication: e.g., IBKR imports "XEQT" and we search for "XEQT.%" to find "XEQT.TO".
   */
  async findBySymbolPrefixAndType(
    symbolPrefix: string,
    typeId: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    const database = this.getDb(transaction);
    const results = await database
      .select()
      .from(schema.tokens)
      .where(
        and(
          like(schema.tokens.symbol, `${symbolPrefix.toUpperCase()}.%`),
          eq(schema.tokens.typeId, typeId)
        )
      )
      .limit(1);

    return results[0] || null;
  }

  async createMany(tokensData: NewToken[], transaction?: DatabaseTransaction): Promise<Token[]> {
    const database = this.getDb(transaction);
    const results = await database.insert(schema.tokens).values(tokensData).returning();
    return results;
  }

  // Promote a (symbol, type, NULL) row's marketSegment in place when a
  // segmented import would otherwise create a duplicate. Used by
  // TokenIdentityService's self-healing path. Returns the updated row.
  async updateMarketSegment(
    tokenId: string,
    marketSegment: string,
    transaction?: DatabaseTransaction
  ): Promise<Token> {
    const database = this.getDb(transaction);
    const [updated] = await database
      .update(schema.tokens)
      .set({ marketSegment, updatedAt: new Date() })
      .where(eq(schema.tokens.id, tokenId))
      .returning();
    if (!updated) {
      throw new Error(`updateMarketSegment: token ${tokenId} not found`);
    }
    return updated as Token;
  }

  // Token IDs whose `unpriceable_until` is still in the future. The
  // historical-price-backfill skips these so we don't re-ask providers
  // for tokens (typically obscure SPL memes, low-liquidity custom
  // tokens) that have repeatedly returned no data.
  async findUnpriceableTokenIds(at: Date, transaction?: DatabaseTransaction): Promise<Set<string>> {
    const database = this.getDb(transaction);
    const rows = await database
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(
        and(isNotNull(schema.tokens.unpriceableUntil), gt(schema.tokens.unpriceableUntil, at))
      );
    return new Set(rows.map((r) => r.id));
  }

  // Apply the result of a backfill pass: tokens whose entire requested
  // range came back empty get an `unpriceable_until` cooldown; tokens
  // that returned at least one quote have any prior cooldown cleared.
  // Both lists also bump `last_pricing_attempt_at`.
  async applyPricingResults(
    opts: {
      markUnpriceable: string[];
      clearUnpriceable: string[];
      cooldownMs: number;
      now?: Date;
    },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const database = this.getDb(transaction);
    const now = opts.now ?? new Date();
    const cooldownUntil = new Date(now.getTime() + opts.cooldownMs);
    if (opts.markUnpriceable.length > 0) {
      await database
        .update(schema.tokens)
        .set({ unpriceableUntil: cooldownUntil, lastPricingAttemptAt: now })
        .where(inArray(schema.tokens.id, opts.markUnpriceable));
    }
    if (opts.clearUnpriceable.length > 0) {
      await database
        .update(schema.tokens)
        .set({ unpriceableUntil: null, lastPricingAttemptAt: now })
        .where(inArray(schema.tokens.id, opts.clearUnpriceable));
    }
  }
}
