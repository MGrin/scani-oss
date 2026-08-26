import { getCloudClient } from '@scani/cloud-client/runtime';
import type { DbType } from '@scani/db/connection';
import type * as schema from '@scani/db/schema';
import { TokenPriceRepository } from '@scani/domain/repositories/TokenPriceRepository';
import { CurrencyConverter, TokenPriceHistoryService, TokenService } from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { isFiatCode } from '@scani/providers/core/utils/fiat-codes';
import { emitEntityChange } from '@scani/realtime';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import Container from 'typedi';
import { z } from 'zod';
import { LruCache } from '../../lib/lru-cache';
import { enqueueCurrencyRateRefresh } from '../lib/currency-rate-refresh';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const tokensLogger = createComponentLogger('router:tokens');
const tokenService = Container.get(TokenService);
const tokenPriceHistoryService = Container.get(TokenPriceHistoryService);
const tokenPriceRepository = Container.get(TokenPriceRepository);

const CUSTOM_TOKEN_TYPE_CODES = ['private-company', 'other'] as const;

import { SCAM_PROBABILITY_THRESHOLD } from '@scani/domain/lib/constants';
import { strictInput } from '../lib/strict-input';

// Cache for external provider search results (avoids hammering
// CoinGecko/Finnhub). LRU + TTL — type-ahead users churn the cache
// continuously; LRU keeps the hot 100 queries warm rather than
// FIFO-evicting them as new typeahead chars come in. 1-hour TTL is
// long enough that "USDC", "ETH", "BTC" etc. stay cached across an
// entire user session.
const searchCache = new LruCache<string, unknown[]>({
  maxEntries: 100,
  ttlMs: 60 * 60 * 1000,
});

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
 * Factory function to create the tokens router with injected dependencies.
 *
 * External-provider search (Finnhub stocks, CoinGecko crypto) is delegated
 * to data-provider's `tokens.search` tRPC procedure — the api app holds no
 * upstream API keys. The DB search step stays local since the api owns
 * its own tokens table.
 */
export function createTokensRouter(db: DbType, schemaObj: typeof schema) {
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

    /**
     * FX rates from each of `currencyTokenIds` into the caller's base
     * currency, with the moment each rate is from.
     *
     * This is the *only* way a frontend surface converts money. It goes
     * through the same `CurrencyConverter` every portfolio valuation
     * uses — so a converted total on the Money tab and a converted
     * holding on the dashboard can never disagree about a rate.
     *
     * **It reads storage and never fetches (SC-222).** It used to end in a
     * live exchangerate-api call for any pair the price graph could not
     * answer, and that call sits behind an outflow limiter of two requests
     * per sixty seconds whose acquire *sleeps*. Measured against production:
     * 78–180 ms warm, **7.2 s** once the converter's ten-minute memory cache
     * expired, **26 s** for three pairs with nothing stored — one blocked
     * user request paying for the backfill nobody had run. A pair we cannot
     * answer is queued for the worker to fetch and returned as `null` now.
     *
     * `rate: null` means the pair has no resolvable rate *right now*.
     * Callers MUST show the un-convertible part rather than dropping it
     * from a total: silently omitting it understates what the user owes,
     * which is worse than the per-currency list this replaced.
     */
    getBaseCurrencyRates: protectedProcedure
      .input(strictInput(z.object({ currencyTokenIds: z.array(z.string().uuid()).max(25) })))
      .query(async ({ ctx, input }) => {
        const { dbUser } = await requireAuth(ctx);
        const [base] = dbUser.baseCurrencyId
          ? await tokenService.getTokensByIds([dbUser.baseCurrencyId])
          : [];
        if (!base) return { baseTokenId: null, baseSymbol: null, rates: [] };

        const uniqueIds = Array.from(new Set(input.currencyTokenIds));
        const tokens = await tokenService.getTokensByIds(uniqueIds);
        const tokenById = new Map(tokens.map((token) => [token.id, token]));
        const at = new Date();
        const converter = Container.get(CurrencyConverter);

        const rates = await Promise.all(
          uniqueIds.map(async (currencyTokenId) => {
            const token = tokenById.get(currencyTokenId);
            if (!token) {
              return { currencyTokenId, symbol: null, rate: null, asOf: null };
            }
            const detail = await converter.getStoredRateDetail(token, base, at);
            return {
              currencyTokenId,
              symbol: token.symbol,
              rate: detail?.rate ?? null,
              asOf: detail?.asOf.toISOString() ?? null,
            };
          })
        );

        // Fire-and-forget: the answer above does not wait on it, and a queue
        // that is down must not turn a partial figure into a failed request.
        void enqueueCurrencyRateRefresh(
          dbUser.id,
          base,
          rates.flatMap((rate) => {
            const token = rate.rate === null ? tokenById.get(rate.currencyTokenId) : undefined;
            return token ? [token] : [];
          })
        );

        return { baseTokenId: base.id, baseSymbol: base.symbol, rates };
      }),

    // Search tokens across database and external providers
    // KEEP
    search: protectedProcedure
      .input(
        strictInput(
          z.object({
            query: z.string().min(1).max(20),
            limit: z.number().int().min(1).max(50).default(10),
          })
        )
      )
      .query(async ({ input }) => {
        const query = input.query.toUpperCase();
        // Escape LIKE metacharacters so a user-supplied query like
        // `_____` doesn't become a wildcard that matches any 5-char
        // symbol. We use `\` as the escape character via `ESCAPE`.
        const likePattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;

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
              sql`(UPPER(${schemaObj.tokens.symbol}) LIKE ${likePattern} ESCAPE '\\' OR UPPER(${
                schemaObj.tokens.name
              }) LIKE ${likePattern} ESCAPE '\\')`
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
          decimals?: number | null;
          iconUrl?: string | null;
          isActive?: boolean;
          source: 'database' | 'external';
          provider?: 'finnhub' | 'coingecko' | 'defillama';
          metadata?: Record<string, unknown>;
        }> = [...dbTokens];

        // Fiat ISO-4217 short-circuit: when the query is a fiat code
        // (USD, EUR, GBP, …) and the DB already has the canonical
        // fiat row for it, skip Finnhub. Without this, Finnhub returns
        // niche US-listed equities whose ticker happens to be a 3-letter
        // currency code (USD = ProShares Ultra Semiconductors,
        // EUR = ProShares Ultra Euro, …) and they pollute the search
        // results — the screenshot-parse + manual-token-add UIs were
        // showing "USD ProShares Ultra Semiconductors" instead of cash.
        const isFiatQuery = isFiatCode(query);
        const dbHasFiatHit =
          isFiatQuery &&
          dbTokens.some((t) => t.symbol.toUpperCase() === query && t.type === 'fiat');

        // External providers — delegated to data-provider's tokens.search
        // tRPC procedure. The api app holds zero upstream API keys; all
        // Finnhub / CoinGecko credentials live on data-provider only.
        if (dbTokens.length < input.limit && !dbHasFiatHit) {
          try {
            const cached = searchCache.get(query);
            if (cached) {
              results.push(...(cached as typeof results).slice(0, input.limit - dbTokens.length));
              return results;
            }

            const cloudClient = getCloudClient();
            // No SCANI_CLOUD_URL → no data-provider → DB-only search.
            // Returning early keeps the user-facing search responsive
            // instead of throwing "cloud client not configured".
            if (!cloudClient) return results;
            const externalResults = await cloudClient.tokens.search.query({
              query,
              limit: input.limit,
            });

            // Sort: exact symbol matches first, then for fiat-coded
            // queries push non-fiat external hits down (Finnhub's
            // USD/EUR/GBP equities don't deserve top billing on a fiat
            // search), then crypto before stocks.
            const sorted = [...externalResults].sort((a, b) => {
              const aExact = a.symbol.toLowerCase() === query.toLowerCase() ? 0 : 1;
              const bExact = b.symbol.toLowerCase() === query.toLowerCase() ? 0 : 1;
              if (aExact !== bExact) return aExact - bExact;
              if (isFiatQuery) {
                const aFiat = (a.type ?? '').toLowerCase() === 'fiat' ? 0 : 1;
                const bFiat = (b.type ?? '').toLowerCase() === 'fiat' ? 0 : 1;
                if (aFiat !== bFiat) return aFiat - bFiat;
              }
              const cryptoRank = (p: string) => (p === 'coingecko' ? 0 : 1);
              return cryptoRank(a.provider) - cryptoRank(b.provider);
            });

            for (const item of sorted) {
              if (results.length >= input.limit) break;
              const symbolUpper = item.symbol.toUpperCase();
              const alreadyInDb = dbTokens.some((t) => t.symbol.toUpperCase() === symbolUpper);
              const alreadyInResults = results.some((t) => t.symbol.toUpperCase() === symbolUpper);
              if (alreadyInDb || alreadyInResults) continue;
              const provider = item.provider as 'finnhub' | 'coingecko' | 'defillama';
              results.push({
                symbol: item.symbol,
                name: item.name,
                type: mapProviderTypeToDbType(item.type),
                decimals: item.type === 'Crypto' ? 18 : 2,
                source: 'external' as const,
                provider,
                metadata: {
                  symbol: item.symbol,
                  name: item.name,
                  type: item.type,
                  currency: item.currency,
                  exchange: item.exchange,
                  provider,
                  ...(item.providerMetadata ?? {}),
                },
              });
            }

            const externalCacheable = results.filter((r) => r.source === 'external');
            if (externalCacheable.length > 0) {
              // LruCache handles size cap + LRU eviction internally.
              searchCache.set(query, externalCacheable);
            }
          } catch (error) {
            tokensLogger.warn(
              {
                query,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'data-provider tokens.search failed; returning database results only'
            );
          }
        }

        return results.slice(0, input.limit);
      }),

    createManyfromExternal: protectedProcedure
      .input(
        strictInput(
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
        strictInput(
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
      .input(strictInput(z.object({ tokenId: z.string().uuid() })))
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
          .set({ isScamProbability: 1.0, scamScoreSource: 'user', updatedAt: new Date() })
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
      .input(strictInput(z.object({ tokenId: z.string().uuid() })))
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
          .set({ isScamProbability: 0, scamScoreSource: 'user', updatedAt: new Date() })
          .where(eq(schemaObj.tokens.id, input.tokenId));

        tokensLogger.info(
          { userId: dbUser.id, tokenId: token.id, symbol: token.symbol },
          'Token unmarked as scam by user'
        );

        emitEntityChange({
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
        strictInput(
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
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        try {
          const createdToken = await tokenPriceHistoryService.createCustomToken(
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
        strictInput(
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
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = await requireAuth(ctx);

        try {
          const result = await tokenPriceHistoryService.updateCustomTokenPrice({
            tokenId: input.tokenId,
            newPrice: input.newPrice,
            baseCurrencyCode: input.baseCurrencyCode,
            reason: input.reason,
            userId: dbUser.id,
          });

          emitEntityChange({
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
        strictInput(
          z.object({
            tokenId: z.string().uuid(),
            limit: z.number().int().min(1).max(200).default(50),
          })
        )
      )
      .query(async ({ input }) => {
        return await tokenPriceHistoryService.getPriceEditHistory(input.tokenId, input.limit);
      }),

    /**
     * List custom tokens (types private-company and other) with the price
     * that is actually in force for them and the base currency it was
     * recorded in. Used by the /tokens catalog page.
     *
     * "In force", not "the latest manual price": this used to ask
     * `findLatestManualPricesForTokensAnyBase`, while every valuation asks
     * `findLatestPricesForTokensAnyBase` through `PricingService`. Two lookups
     * over one table give two answers whenever the latest row is not a manual
     * one — /tokens said "Never priced" about a token the holdings peek was
     * pricing at €14.75 and the home screen was calling 8% of net worth
     * (SC-77 2). One lookup, one answer. `source` comes back with it so the
     * peek can say whether a human set the number or a provider did; for a
     * private-company token those are very different claims.
     */
    listCustom: protectedProcedure.query(async ({ ctx }) => {
      const { dbUser } = await requireAuth(ctx);
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

      // The reader's own base currency is the tie-break, exactly as it is in
      // `PortfolioValuationService`: when a token carries prices against
      // several bases, both surfaces pick the same row.
      const priceMap = await tokenPriceRepository.findLatestPricesForTokensAnyBase(
        tokenRows.map((t) => t.id),
        dbUser.baseCurrencyId ?? ''
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
          latestPriceSource: latest?.source ?? null,
          latestPriceBaseCurrency: latest?.baseTokenId
            ? (baseTokenSymbolMap.get(latest.baseTokenId) ?? null)
            : null,
        };
      });
    }),
  });
}
