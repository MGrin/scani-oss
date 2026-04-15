import type { DbType } from '@scani/core/database/connection';
import type * as schema from '@scani/core/database/schema';
import { TokenService } from '@scani/core/services/TokenService';
import type { TokenValidationService } from '@scani/core/services/TokenValidationService';
import { createComponentLogger } from '@scani/core/utils/logger';
import { and, eq, lt, sql } from 'drizzle-orm';
import Container from 'typedi';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const tokensLogger = createComponentLogger('router:tokens');
const tokenService = Container.get(TokenService);

// Scam token probability threshold - tokens above this are filtered from UI
// Import the shared threshold from core config
import { SCAM_PROBABILITY_THRESHOLD } from '@scani/core/config/tokens';

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
     * Flag a crypto token as a scam, contributing to the global scam detection.
     *
     * Authorization rule: the caller must have held this token in one of their
     * own accounts at some point (hidden or visible). This is an anti-abuse
     * measure — without it, any authenticated user could poison the catalog
     * by marking arbitrary legitimate tokens as scam.
     *
     * Side effect: bumps `is_scam_probability` to 1.0 on the token row. Once
     * a token crosses SCAM_PROBABILITY_THRESHOLD it is filtered out of the
     * getAll / search endpoints everywhere in the app.
     *
     * Scope: crypto tokens only. Fiat / stock markings don't make sense here.
     */
    markAsScam: protectedProcedure
      .input(z.object({ tokenId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        // Verify the user has (or has had) a holding of this token.
        const userHasHeldThisToken = await db
          .select({ id: schemaObj.holdings.id })
          .from(schemaObj.holdings)
          .where(
            and(
              eq(schemaObj.holdings.userId, dbUser.id),
              eq(schemaObj.holdings.tokenId, input.tokenId)
            )
          )
          .limit(1);

        if (userHasHeldThisToken.length === 0) {
          tokensLogger.warn(
            { userId: dbUser.id, tokenId: input.tokenId },
            'Rejected markAsScam: user has never held this token'
          );
          throw new Error(
            'You can only mark a token as scam if you have held it in one of your accounts'
          );
        }

        // Verify the token is crypto. We don't flag fiat / stocks this way.
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

        if (token.typeCode !== 'crypto') {
          throw new Error('Only crypto tokens can be marked as scam');
        }

        // Bump scam probability to 1.0 — definitively over the threshold.
        await db
          .update(schemaObj.tokens)
          .set({
            isScamProbability: 1.0,
            updatedAt: new Date(),
          })
          .where(eq(schemaObj.tokens.id, input.tokenId));

        tokensLogger.info(
          {
            userId: dbUser.id,
            tokenId: token.id,
            symbol: token.symbol,
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
  });
}
