import type { DbType } from '@scani/db/connection';
import type * as schema from '@scani/db/schema';
import { TokenPriceRepository } from '@scani/domain/repositories/TokenPriceRepository';
import { TokenService } from '@scani/domain/services/TokenService';
import type { TokenValidationService } from '@scani/domain/services/TokenValidationService';
import { createComponentLogger } from '@scani/logging';
import { emitEntityChange } from '@scani/realtime';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import Container from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const tokensLogger = createComponentLogger('router:tokens');
const tokenService = Container.get(TokenService);
const tokenPriceRepository = Container.get(TokenPriceRepository);

const CUSTOM_TOKEN_TYPE_CODES = ['private-company', 'other'] as const;

// Scam token probability threshold - tokens above this are filtered from UI
// Import the shared threshold from core config
import { SCAM_PROBABILITY_THRESHOLD } from '@scani/domain/config/tokens';

// Cache for external provider search results (avoids hammering CoinGecko/Finnhub)
const searchCache = new Map<string, { results: unknown[]; expiresAt: number }>();
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
        .where(
          and(
            eq(schemaObj.tokens.isActive, true),
            lt(schemaObj.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD)
          )
        )
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
              lt(schemaObj.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
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
            // Check search cache first
            const cached = searchCache.get(query);
            if (cached && cached.expiresAt > Date.now()) {
              results.push(
                ...(cached.results as typeof results).slice(0, input.limit - dbTokens.length)
              );
              return results;
            }

            // Search both Finnhub and CoinGecko concurrently. Use
            // `allSettled` so one provider timing out or throwing
            // (no API key, rate limit, network hiccup) doesn't block
            // the other. Each provider also has a 3s fetch timeout
            // internally, so this promise resolves in ≤3s worst case.
            const [finnhubSettled, coinGeckoSettled] = await Promise.allSettled([
              tokenValidationService.searchFinnhubTokens(query),
              tokenValidationService.searchCoinGeckoTokens(query),
            ]);
            const finnhubResults =
              finnhubSettled.status === 'fulfilled' ? finnhubSettled.value : [];
            const coinGeckoResults =
              coinGeckoSettled.status === 'fulfilled' ? coinGeckoSettled.value : [];
            if (finnhubSettled.status === 'rejected') {
              tokensLogger.warn(
                { query, reason: String(finnhubSettled.reason) },
                'Finnhub search failed — continuing with other results'
              );
            }
            if (coinGeckoSettled.status === 'rejected') {
              tokensLogger.warn(
                { query, reason: String(coinGeckoSettled.reason) },
                'CoinGecko search failed — continuing with other results'
              );
            }

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
            // Cache external results for future searches
            const externalResults = results.filter((r) => r.source === 'external');
            if (externalResults.length > 0) {
              searchCache.set(query, {
                results: externalResults,
                expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
              });
              // Evict oldest entries if cache grows too large
              if (searchCache.size > 500) {
                const firstKey = searchCache.keys().next().value;
                if (firstKey) searchCache.delete(firstKey);
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
        const { dbUser } = await requireAuth(ctx);

        // Delegate to service for business logic
        const allTokens = await tokenService.createManyFromExternal(input, dbUser.id);

        // Emit events for created tokens (filter out existing ones)
        const createdTokens = allTokens.filter((t) =>
          input.some((i) => i.symbol === t.symbol && !t.externalId)
        );

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
        const { dbUser } = await requireAuth(ctx);
        const { symbol, metadata, provider } = input;

        // Delegate to service for business logic
        const createdToken = await tokenService.createFromExternal(
          symbol,
          metadata,
          provider,
          dbUser.id
        );

        // Emit entity change event
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'create',
          entityId: createdToken.id,
          userId: dbUser.id,
          data: {
            symbol: createdToken.symbol,
            typeId: createdToken.typeId,
            provider,
          },
        });

        return createdToken;
      }),

    /**
     * Flag a token as a scam (global). Sets `is_scam_probability = 1.0` on
     * the token row; the token then falls out of `tokens.getAll`/`search`
     * (which filter < SCAM_PROBABILITY_THRESHOLD) and the frontend renders
     * a scam badge wherever it's still shown (owned holdings, job result
     * pages, etc.).
     *
     * Authorization: any authenticated user. Scoped this broadly by product
     * decision — it's a small-user-base trust model. Abuse is surfaced via
     * the audit-style log line below + the existing token entity-change WS
     * event.
     */
    markAsScam: protectedProcedure
      .input(z.object({ tokenId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        const [token] = await db
          .select({
            id: schemaObj.tokens.id,
            symbol: schemaObj.tokens.symbol,
            typeCode: schemaObj.tokenTypes.code,
          })
          .from(schemaObj.tokens)
          .leftJoin(schemaObj.tokenTypes, eq(schemaObj.tokens.typeId, schemaObj.tokenTypes.id))
          .where(eq(schemaObj.tokens.id, input.tokenId))
          .limit(1);

        if (!token) {
          throw new Error('Token not found');
        }

        await db
          .update(schemaObj.tokens)
          .set({ isScamProbability: 1.0, updatedAt: new Date() })
          .where(eq(schemaObj.tokens.id, input.tokenId));

        tokensLogger.info(
          {
            userId: dbUser.id,
            tokenId: token.id,
            symbol: token.symbol,
            type: token.typeCode,
          },
          'Token marked as scam by user'
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'update',
          entityId: token.id,
          userId: dbUser.id,
          data: { scamProbability: 1.0 },
        });

        return { success: true as const, tokenId: token.id };
      }),

    /**
     * Reverse `markAsScam` — resets `is_scam_probability` to 0. Same
     * authorization: any authenticated user. Used by the undo path in the
     * ScamActionButton confirmation dialog.
     */
    unmarkAsScam: protectedProcedure
      .input(z.object({ tokenId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        const [token] = await db
          .select({ id: schemaObj.tokens.id, symbol: schemaObj.tokens.symbol })
          .from(schemaObj.tokens)
          .where(eq(schemaObj.tokens.id, input.tokenId))
          .limit(1);

        if (!token) {
          throw new Error('Token not found');
        }

        await db
          .update(schemaObj.tokens)
          .set({ isScamProbability: 0, updatedAt: new Date() })
          .where(eq(schemaObj.tokens.id, input.tokenId));

        tokensLogger.info(
          { userId: dbUser.id, tokenId: token.id, symbol: token.symbol },
          'Token unmarked as scam by user'
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'token',
          operationType: 'update',
          entityId: token.id,
          userId: dbUser.id,
          data: { scamProbability: 0 },
        });

        return { success: true as const, tokenId: token.id };
      }),

    /**
     * Create a custom token (private-company / other) with an initial
     * manual price in the base currency the user chose. Custom tokens
     * are shared globally (any user can see them) and any user can edit
     * the price later via `updateCustomPrice`. The initial price is
     * recorded in both `token_prices` and `token_price_edit_history`.
     */
    createCustom: protectedProcedure
      .input(
        z.object({
          symbol: z
            .string()
            .min(1)
            .max(20)
            .transform((val) => val.toUpperCase()),
          name: z.string().min(1).max(200),
          typeCode: z.enum(CUSTOM_TOKEN_TYPE_CODES),
          manualPrice: z.number().positive(),
          baseCurrencyCode: z
            .string()
            .min(1)
            .max(10)
            .transform((val) => val.toUpperCase()),
          priceDescription: z.string().max(500).optional(),
          description: z.string().max(2000).optional(),
          decimals: z.number().int().min(0).max(18).default(2),
          iconUrl: z.string().url().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        try {
          const createdToken = await tokenService.createCustomToken(
            {
              symbol: input.symbol,
              name: input.name,
              typeCode: input.typeCode,
              manualPrice: input.manualPrice,
              baseCurrencyCode: input.baseCurrencyCode,
              priceDescription: input.priceDescription,
              description: input.description,
              decimals: input.decimals,
              iconUrl: input.iconUrl ?? null,
            },
            dbUser.id
          );

          emitEntityChange({
            type: 'entity_changed',
            entityType: 'token',
            operationType: 'create',
            entityId: createdToken.id,
            userId: dbUser.id,
            data: {
              symbol: createdToken.symbol,
              typeId: createdToken.typeId,
              custom: true,
            },
          });

          return createdToken;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          if (message.toLowerCase().includes('already exists')) {
            throw new TRPCError({ code: 'CONFLICT', message });
          }
          throw error;
        }
      }),

    /**
     * Append a manual price update to a custom token. Writes a new row to
     * `token_prices` (source='manual') and a row to
     * `token_price_edit_history` atomically. Rejects non-custom tokens.
     */
    updateCustomPrice: protectedProcedure
      .input(
        z.object({
          tokenId: z.string().uuid(),
          newPrice: z.number().positive(),
          baseCurrencyCode: z
            .string()
            .min(1)
            .max(10)
            .transform((val) => val.toUpperCase()),
          reason: z.string().min(1).max(500).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        try {
          const result = await tokenService.updateCustomTokenPrice({
            tokenId: input.tokenId,
            newPrice: input.newPrice,
            baseCurrencyCode: input.baseCurrencyCode,
            reason: input.reason,
            userId: dbUser.id,
          });

          emitEntityChange({
            type: 'entity_changed',
            entityType: 'token',
            operationType: 'update',
            entityId: result.token.id,
            userId: dbUser.id,
            data: {
              symbol: result.token.symbol,
              previousPrice: result.previousPrice,
              newPrice: result.newPrice,
              manualPriceUpdate: true,
            },
          });

          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          if (message.includes('not a custom token')) {
            throw new TRPCError({ code: 'BAD_REQUEST', message });
          }
          if (message.includes('not found')) {
            throw new TRPCError({ code: 'NOT_FOUND', message });
          }
          throw error;
        }
      }),

    /**
     * Return the edit history of a custom token's price, with the
     * editor's email/name for display.
     */
    getPriceEditHistory: protectedProcedure
      .input(
        z.object({
          tokenId: z.string().uuid(),
          limit: z.number().int().min(1).max(200).default(50),
        })
      )
      .query(async ({ input }) => {
        return await tokenService.getPriceEditHistory(input.tokenId, input.limit);
      }),

    /**
     * List custom tokens (types private-company and other) with their
     * latest manual price and the base currency that price was recorded
     * in. Used by the /tokens catalog page.
     */
    listCustom: protectedProcedure.query(async () => {
      const customTypes = await db
        .select({ id: schemaObj.tokenTypes.id, code: schemaObj.tokenTypes.code })
        .from(schemaObj.tokenTypes)
        .where(inArray(schemaObj.tokenTypes.code, CUSTOM_TOKEN_TYPE_CODES as unknown as string[]));

      if (customTypes.length === 0) return [];

      const customTypeIds = customTypes.map((t) => t.id);
      const customTypeCodeById = new Map(customTypes.map((t) => [t.id, t.code]));

      const tokenRows = await db
        .select({
          id: schemaObj.tokens.id,
          symbol: schemaObj.tokens.symbol,
          name: schemaObj.tokens.name,
          typeId: schemaObj.tokens.typeId,
          decimals: schemaObj.tokens.decimals,
          iconUrl: schemaObj.tokens.iconUrl,
          isActive: schemaObj.tokens.isActive,
          createdAt: schemaObj.tokens.createdAt,
          updatedAt: schemaObj.tokens.updatedAt,
        })
        .from(schemaObj.tokens)
        .where(
          and(inArray(schemaObj.tokens.typeId, customTypeIds), eq(schemaObj.tokens.isActive, true))
        )
        .orderBy(schemaObj.tokens.symbol);

      if (tokenRows.length === 0) return [];

      const priceMap = await tokenPriceRepository.findLatestManualPricesForTokensAnyBase(
        tokenRows.map((t) => t.id)
      );

      const baseTokenIds = Array.from(
        new Set(
          Array.from(priceMap.values())
            .map((p) => p.baseTokenId)
            .filter((id): id is string => !!id)
        )
      );
      const baseTokenSymbolMap = new Map<string, string>();
      if (baseTokenIds.length > 0) {
        const baseTokens = await db
          .select({ id: schemaObj.tokens.id, symbol: schemaObj.tokens.symbol })
          .from(schemaObj.tokens)
          .where(inArray(schemaObj.tokens.id, baseTokenIds));
        for (const b of baseTokens) baseTokenSymbolMap.set(b.id, b.symbol);
      }

      return tokenRows.map((t) => {
        const latest = priceMap.get(t.id);
        return {
          ...t,
          typeCode: customTypeCodeById.get(t.typeId) ?? null,
          latestPrice: latest?.price ?? null,
          latestPriceAt: latest?.timestamp ?? null,
          latestPriceBaseCurrency: latest?.baseTokenId
            ? (baseTokenSymbolMap.get(latest.baseTokenId) ?? null)
            : null,
        };
      });
    }),
  });
}
