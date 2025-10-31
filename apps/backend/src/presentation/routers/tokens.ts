import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TokenValidationService } from '../../application/services/TokenValidationService';
import type { DbType } from '../../infrastructure/database/connection';
import type * as schema from '../../infrastructure/database/schema';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { createComponentLogger } from '../../utils/logger';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const tokensLogger = createComponentLogger('router:tokens');

// Helper function to map provider token types to database token types
// Note: 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
function mapProviderTypeToDbType(providerType: string): string {
  switch (providerType) {
    case 'Equity':
    case 'ETF':
    case 'Mutual Fund':
    case 'Bond':
    case 'Commodity':
      // All equity-like instruments map to 'stock' type
      return 'stock';
    case 'Crypto':
    case 'Cryptocurrency':
      return 'crypto';
    default:
      return 'stock'; // Default fallback for unknown types
  }
}

/**
 * Factory function to create the tokens router with injected dependencies
 */
export function createTokensRouter(
  db: DbType,
  schemaObj: typeof schema,
  tokenValidationService: TokenValidationService
) {
  return router({
    // Get all active tokens with their types
    // KEEP
    getAll: protectedProcedure.query(async () => {
      const tokens = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          type: schemaObj.tokenTypes.code,
          typeName: schemaObj.tokenTypes.name,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
        })
        .from(schemaObj.tokens)
        .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
        .where(eq(schemaObj.tokens.isActive, true))
        .orderBy(schemaObj.tokens.symbol);
      return tokens;
    }),

    // Search tokens across database and external providers
    // KEEP
    search: protectedProcedure
      .input(
        z.object({
          query: z.string().min(1).max(20),
          limit: z.number().int().min(1).max(50).default(10),
        })
      )
      .query(async ({ input }) => {
        const query = input.query.toUpperCase();

        // First, search in our database
        const dbTokens = await db
          .select({
            id: schemaObj.tokens.id,
            symbol: schemaObj.tokens.symbol,
            name: schemaObj.tokens.name,
            typeId: schemaObj.tokens.typeId,
            type: schemaObj.tokenTypes.code,
            typeName: schemaObj.tokenTypes.name,
            decimals: schemaObj.tokens.decimals,
            iconUrl: schemaObj.tokens.iconUrl,
            isActive: schemaObj.tokens.isActive,
            source: sql<'database'>`'database'`.as('source'),
          })
          .from(schemaObj.tokens)
          .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
          .where(
            and(
              eq(schemaObj.tokens.isActive, true),
              sql`(UPPER(${schemaObj.tokens.symbol}) LIKE ${`%${query}%`} OR UPPER(${
                schemaObj.tokens.name
              }) LIKE ${`%${query}%`})`
            )
          )
          .orderBy(schemaObj.tokens.symbol)
          .limit(input.limit);

        const results: Array<{
          id?: string;
          symbol: string;
          name: string;
          typeId?: string;
          type?: string | null;
          typeName?: string | null;
          decimals?: number;
          iconUrl?: string | null;
          isActive?: boolean;
          source: 'database' | 'external';
          provider?: 'finnhub' | 'coingecko' | 'defillama';
          metadata?: Record<string, unknown>;
        }> = [...dbTokens];

        // If we have fewer than the limit from database, search external providers
        if (dbTokens.length < input.limit) {
          try {
            // Search both Finnhub and CoinGecko concurrently
            const [finnhubResults, coinGeckoResults] = await Promise.all([
              tokenValidationService.searchFinnhubTokens(query),
              tokenValidationService.searchCoinGeckoTokens(query),
            ]);

            // Combine and prioritize results: crypto tokens first for exact symbol matches
            const allProviderResults = [
              ...coinGeckoResults.map((r) => ({
                ...r,
                priority: r.metadata?.symbol.toLowerCase() === query.toLowerCase() ? 1 : 2,
              })),
              ...finnhubResults.map((r) => ({
                ...r,
                priority: r.metadata?.symbol.toLowerCase() === query.toLowerCase() ? 1 : 3,
              })),
            ];

            // Sort by priority (lower number = higher priority)
            allProviderResults.sort((a, b) => a.priority - b.priority);

            // Process all provider results in priority order
            for (const providerResult of allProviderResults) {
              if (
                providerResult.isValid &&
                providerResult.metadata &&
                results.length < input.limit
              ) {
                // Check if this external token is already in our database or results
                const alreadyExistsInDb = dbTokens.some(
                  (token) =>
                    token.symbol.toUpperCase() === providerResult.metadata!.symbol.toUpperCase()
                );

                const alreadyExistsInResults = results.some(
                  (token) =>
                    token.symbol.toUpperCase() === providerResult.metadata!.symbol.toUpperCase()
                );

                if (!alreadyExistsInDb && !alreadyExistsInResults) {
                  results.push({
                    symbol: providerResult.metadata.symbol,
                    name: providerResult.metadata.name,
                    type: mapProviderTypeToDbType(providerResult.metadata.type),
                    decimals: providerResult.metadata.type === 'Crypto' ? 18 : 2,
                    source: 'external' as const,
                    provider: providerResult.metadata.provider,
                    metadata: { ...providerResult.metadata },
                  });
                }
              }
            }

            // If we still have space and no provider results, try the old validation method as fallback
            if (
              results.length < input.limit &&
              finnhubResults.length === 0 &&
              coinGeckoResults.length === 0
            ) {
              const fallbackResult = await tokenValidationService.validateToken(query);
              if (fallbackResult.isValid && fallbackResult.metadata) {
                const alreadyExists = results.some(
                  (token) =>
                    token.symbol.toUpperCase() === fallbackResult.metadata!.symbol.toUpperCase()
                );

                if (!alreadyExists) {
                  results.push({
                    symbol: fallbackResult.metadata.symbol,
                    name: fallbackResult.metadata.name,
                    type: mapProviderTypeToDbType(fallbackResult.metadata.type),
                    decimals: fallbackResult.metadata.type === 'Crypto' ? 18 : 2,
                    source: 'external' as const,
                    provider: fallbackResult.metadata.provider,
                    metadata: { ...fallbackResult.metadata },
                  });
                }
              }
            }
          } catch (error) {
            // External provider search failed, but we still have database results
            tokensLogger.warn(
              {
                query,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'External provider search failed'
            );
          }
        }

        return results.slice(0, input.limit);
      }),

    createManyfromExternal: protectedProcedure
      .input(
        z.array(
          z.object({
            externalId: z.string().min(1),
            symbol: z
              .string()
              .min(1)
              .max(20)
              .transform((val) => val.toUpperCase()),
            metadata: z.record(z.unknown()),
            provider: z.enum(['finnhub', 'coingecko', 'defillama']),
          })
        )
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = requireAuth(ctx);

        tokensLogger.info(
          {
            count: input.length,
            symbols: input.map((t) => t.symbol),
          },
          'Creating tokens from external providers (batch)'
        );

        // Validate all metadata upfront
        for (const token of input) {
          if (!token.metadata.name || typeof token.metadata.name !== 'string') {
            throw new Error(`External token metadata for ${token.symbol} must include a name`);
          }
          if (!token.metadata.type || typeof token.metadata.type !== 'string') {
            throw new Error(`External token metadata for ${token.symbol} must include a type`);
          }
        }

        // Get all unique token type codes needed
        const uniqueTypeCodes = [
          ...new Set(input.map((t) => mapProviderTypeToDbType(t.metadata.type as string))),
        ];

        // Fetch all token types in one query
        const tokenTypes = await db
          .select()
          .from(schemaObj.tokenTypes)
          .where(
            sql`${schemaObj.tokenTypes.code} IN (${sql.join(
              uniqueTypeCodes.map((code) => sql`${code}`),
              sql`, `
            )})`
          );

        const tokenTypeMap = new Map(tokenTypes.map((tt) => [tt.code, tt]));

        // Verify all types exist
        for (const code of uniqueTypeCodes) {
          if (!tokenTypeMap.has(code)) {
            throw new Error(`Token type '${code}' not found in database`);
          }
        }

        // Check existing tokens in one query
        const symbolTypeIdPairs = input.map((t) => {
          const typeCode = mapProviderTypeToDbType(t.metadata.type as string);
          const typeId = tokenTypeMap.get(typeCode)!.id;
          return { symbol: t.symbol, typeId };
        });

        const existingTokens = await db
          .select()
          .from(schemaObj.tokens)
          .where(
            sql`(${sql.join(
              symbolTypeIdPairs.map(
                (pair) =>
                  sql`(${schemaObj.tokens.symbol} = ${pair.symbol} AND ${schemaObj.tokens.typeId} = ${pair.typeId})`
              ),
              sql` OR `
            )})`
          );

        const existingTokenMap = new Map(existingTokens.map((t) => [`${t.symbol}-${t.typeId}`, t]));

        // Create externalId mapping for input tokens
        const externalIdMap = new Map(
          input.map((t) => {
            const typeCode = mapProviderTypeToDbType(t.metadata.type as string);
            const typeId = tokenTypeMap.get(typeCode)!.id;
            return [`${t.symbol}-${typeId}`, t.externalId];
          })
        );

        // Prepare tokens to create
        const now = new Date();
        const tokensToCreate = input
          .map((token) => {
            const typeCode = mapProviderTypeToDbType(token.metadata.type as string);
            const tokenType = tokenTypeMap.get(typeCode)!;
            const key = `${token.symbol}-${tokenType.id}`;

            if (existingTokenMap.has(key)) {
              return null;
            }

            let providerSpecificData: Record<string, unknown> = {};

            if (token.provider === 'coingecko') {
              const coinGeckoId =
                (token.metadata.providerMetadata as Record<string, unknown>)?.id ||
                (token.metadata as Record<string, unknown>).coinGeckoId ||
                (token.metadata as Record<string, unknown>).id ||
                token.symbol.toLowerCase();

              providerSpecificData = {
                id: coinGeckoId as string,
                symbol: token.symbol,
                name: token.metadata.name,
              };
            } else if (token.provider === 'finnhub') {
              const finnhubSymbol =
                (token.metadata.providerMetadata as Record<string, unknown>)?.symbol ||
                (token.metadata as Record<string, unknown>).finnhubSymbol ||
                token.symbol;

              providerSpecificData = {
                symbol: finnhubSymbol as string,
                name: token.metadata.name,
                type: token.metadata.type,
              };
            }

            const providerMetadata = JSON.stringify({
              provider: token.provider,
              [token.provider]: providerSpecificData,
              validatedAt: new Date().toISOString(),
            });

            return {
              symbol: token.symbol,
              name: token.metadata.name as string,
              typeId: tokenType.id,
              decimals: typeCode === 'crypto' ? 18 : 2,
              iconUrl: null,
              providerMetadata,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);

        let createdTokens: (typeof schemaObj.tokens.$inferSelect)[] = [];

        // Batch insert if there are tokens to create
        if (tokensToCreate.length > 0) {
          createdTokens = await db.insert(schemaObj.tokens).values(tokensToCreate).returning();

          tokensLogger.info(
            {
              created: createdTokens.length,
              symbols: createdTokens.map((t) => t.symbol),
            },
            'Batch created external tokens'
          );

          // Emit events for created tokens
          for (const token of createdTokens) {
            emitEntityChange({
              type: 'entity_changed',
              entityType: 'token',
              operationType: 'create',
              entityId: token.id,
              userId: dbUser.id,
              data: {
                symbol: token.symbol,
                typeId: token.typeId,
              },
            });
          }
        }

        // Combine existing and created tokens with externalId
        const allTokens = [
          ...Array.from(existingTokenMap.values()).map((token) => ({
            ...token,
            externalId: externalIdMap.get(`${token.symbol}-${token.typeId}`),
          })),
          ...createdTokens.map((token) => ({
            ...token,
            externalId: externalIdMap.get(`${token.symbol}-${token.typeId}`),
          })),
        ];

        tokensLogger.info(
          {
            requested: input.length,
            existing: existingTokenMap.size,
            created: createdTokens.length,
            total: allTokens.length,
          },
          'Batch token creation complete'
        );

        return allTokens;
      }),

    // Create token from external provider metadata (for holding creation)
    createFromExternal: protectedProcedure
      .input(
        z.object({
          symbol: z
            .string()
            .min(1)
            .max(20)
            .transform((val) => val.toUpperCase()),
          metadata: z.record(z.unknown()),
          provider: z.enum(['finnhub', 'coingecko']),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = requireAuth(ctx);
        const { symbol, metadata, provider } = input;

        tokensLogger.info(
          {
            symbol,
            provider,
            metadata,
          },
          'Creating token from external provider'
        );

        // Validate the metadata has the required fields
        if (!metadata.name || typeof metadata.name !== 'string') {
          throw new Error('External token metadata must include a name');
        }

        if (!metadata.type || typeof metadata.type !== 'string') {
          throw new Error('External token metadata must include a type');
        }

        // Map provider type to our token type
        const mappedTypeCode = mapProviderTypeToDbType(metadata.type as string);

        // Get token type ID
        const [tokenType] = await db
          .select()
          .from(schemaObj.tokenTypes)
          .where(eq(schemaObj.tokenTypes.code, mappedTypeCode))
          .limit(1);

        if (!tokenType) {
          throw new Error(`Token type '${mappedTypeCode}' not found in database`);
        }

        // Check if token already exists with this symbol and type
        const [existingToken] = await db
          .select()
          .from(schemaObj.tokens)
          .where(
            and(eq(schemaObj.tokens.symbol, symbol), eq(schemaObj.tokens.typeId, tokenType.id))
          )
          .limit(1);

        if (existingToken) {
          tokensLogger.info(
            { tokenId: existingToken.id, symbol, typeCode: mappedTypeCode },
            'Token already exists, returning existing token'
          );
          // Return existing token instead of creating duplicate
          return existingToken;
        }

        // CRITICAL FIX: Create proper provider metadata structure for pricing service
        // The pricing service expects nested provider-specific data with proper identifiers
        let providerSpecificData: Record<string, unknown> = {};

        if (provider === 'coingecko') {
          // CoinGecko needs the 'id' field for pricing lookups
          const coinGeckoId =
            (metadata.providerMetadata as Record<string, unknown>)?.id ||
            (metadata as Record<string, unknown>).coinGeckoId ||
            (metadata as Record<string, unknown>).id;

          if (coinGeckoId && typeof coinGeckoId === 'string') {
            providerSpecificData = {
              id: coinGeckoId,
              symbol: symbol,
              name: metadata.name,
            };
            tokensLogger.info(
              { symbol, coinGeckoId },
              'Structured CoinGecko metadata with ID for pricing'
            );
          } else {
            // Fallback: use symbol as lowercase ID (CoinGecko convention)
            providerSpecificData = {
              id: symbol.toLowerCase(),
              symbol: symbol,
              name: metadata.name,
            };
            tokensLogger.warn(
              { symbol },
              'CoinGecko ID not found in metadata, using lowercase symbol as fallback'
            );
          }
        } else if (provider === 'finnhub') {
          // Finnhub needs the 'symbol' field for pricing lookups
          const finnhubSymbol =
            (metadata.providerMetadata as Record<string, unknown>)?.symbol ||
            (metadata as Record<string, unknown>).finnhubSymbol ||
            symbol;

          providerSpecificData = {
            symbol: finnhubSymbol,
            name: metadata.name,
            type: metadata.type,
          };
          tokensLogger.info({ symbol, finnhubSymbol }, 'Structured Finnhub metadata for pricing');
        }

        // Create the complete provider metadata structure
        // This structure is what the pricing service expects to read
        const providerMetadata = JSON.stringify({
          provider,
          [provider]: providerSpecificData,
          validatedAt: new Date().toISOString(),
        });

        const now = new Date();
        const tokenData = {
          symbol,
          name: metadata.name as string,
          typeId: tokenType.id,
          decimals: mappedTypeCode === 'crypto' ? 18 : 2, // Crypto tokens typically use 18 decimals
          iconUrl: null,
          providerMetadata,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        };

        tokensLogger.debug(
          {
            symbol,
            typeCode: mappedTypeCode,
            providerMetadata,
          },
          'Creating token with structured metadata'
        );

        const [createdToken] = await db.insert(schemaObj.tokens).values(tokenData).returning();

        if (!createdToken) {
          tokensLogger.error({ symbol, provider, typeId: tokenType.id }, 'Database insert failed');
          throw new Error('Failed to create external token - database insert returned no data');
        }

        if (!createdToken.id) {
          tokensLogger.error(
            { symbol, provider, createdToken },
            'Token created but has no ID - critical database error'
          );
          throw new Error('Failed to create external token - no ID assigned by database');
        }

        tokensLogger.info(
          {
            tokenId: createdToken.id,
            symbol: createdToken.symbol,
            name: createdToken.name,
            provider,
            typeId: tokenType.id,
          },
          'External token created successfully with valid ID'
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'create',
          entityId: createdToken.id,
          userId: dbUser.id,
          data: {
            symbol: createdToken.symbol,
            typeId: tokenType.id,
            provider,
          },
        });

        return createdToken;
      }),
  });
}
